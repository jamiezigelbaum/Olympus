package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	capSetpcap  = 8
	capNetAdmin = 12

	prSetPdeathsig  = 1
	prSetDumpable   = 4
	prCapbsetDrop   = 24
	prSetNoNewPrivs = 38
	prCapAmbient    = 47
	prCapAmbientClr = 4

	minLandlockABI = 4

	sysCloseRange       = 436
	sysLandlockCreate   = 444
	sysLandlockAddRule  = 445
	sysLandlockRestrict = 446
)

func allThreads(trap, a1, a2, a3 uintptr) error {
	_, _, e := syscall.AllThreadsSyscall(trap, a1, a2, a3)
	if e != 0 {
		return e
	}
	return nil
}

// markCloexec makes every inherited descriptor above stderr close on exec, so
// nothing the supervisor left open can reach the daemon. A failure is an error
// the caller must turn into a refusal: a descriptor left open is a way out.
func markCloexec() error {
	const closeRangeCloexec = 4
	forceFallback := fault("cloexec-fb") || fault("cloexec-fb-fail")
	if !forceFallback {
		if _, _, e := syscall.RawSyscall(sysCloseRange, 3, ^uintptr(0), closeRangeCloexec); e == 0 {
			return nil
		}
	}
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return fmt.Errorf("cannot sanitize inherited descriptors: %w", err)
	}
	injected := fault("cloexec-fb-fail")
	for _, ent := range entries {
		fd, err := strconv.Atoi(ent.Name())
		if err != nil || fd <= 2 {
			continue
		}
		var e syscall.Errno
		if injected {
			e, injected = syscall.EPERM, false
		} else if _, _, e2 := syscall.RawSyscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_SETFD, syscall.FD_CLOEXEC); e2 != 0 {
			e = e2
		}
		// EBADF: the descriptor ReadDir itself used, already closed. Anything
		// else leaves a descriptor open across exec, which is a way out.
		if e != 0 && e != syscall.EBADF {
			return fmt.Errorf("cannot mark descriptor %d close-on-exec: %w", fd, e)
		}
	}
	return nil
}

// ---------------------------------------------------------------- loopback

type ifreq struct {
	name  [16]byte
	flags uint16
	_     [22]byte
}

func loopbackUp() error {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var req ifreq
	copy(req.name[:], "lo")
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.SIOCGIFFLAGS, uintptr(unsafe.Pointer(&req))); e != 0 {
		return e
	}
	req.flags |= syscall.IFF_UP
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.SIOCSIFFLAGS, uintptr(unsafe.Pointer(&req))); e != 0 {
		return e
	}
	return nil
}

// disableIPv6 turns IPv6 off in this namespace. A host kernel without IPv6 has
// no such files, which is the same outcome.
func disableIPv6() error {
	for _, name := range []string{"all", "default", "lo"} {
		path := "/proc/sys/net/ipv6/conf/" + name + "/disable_ipv6"
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := os.WriteFile(path, []byte("1"), 0); err != nil {
			return fmt.Errorf("disable ipv6 (%s): %w", name, err)
		}
	}
	return nil
}

func onlyLoopback() error {
	ifs, err := net.Interfaces()
	if err != nil {
		return err
	}
	if len(ifs) != 1 || ifs[0].Name != "lo" || ifs[0].Flags&net.FlagUp == 0 {
		return fmt.Errorf("expected only an up loopback interface, found %d interfaces", len(ifs))
	}
	return nil
}

// ------------------------------------------------------------ capabilities

type capHeader struct {
	version uint32
	pid     int32
}
type capData struct{ effective, permitted, inheritable uint32 }

func lastCap() int {
	b, err := os.ReadFile("/proc/sys/kernel/cap_last_cap")
	if err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			return n
		}
	}
	return 40
}

// dropAllCapabilities empties the bounding, ambient, inheritable, permitted
// and effective sets on every thread. Bounding goes first: it needs CAP_SETPCAP.
func dropAllCapabilities() error {
	for c := 0; c <= lastCap(); c++ {
		if err := allThreads(syscall.SYS_PRCTL, prCapbsetDrop, uintptr(c), 0); err != nil {
			return fmt.Errorf("bounding set: %w", err)
		}
	}
	if err := allThreads(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientClr, 0); err != nil {
		return fmt.Errorf("ambient set: %w", err)
	}
	hdr := capHeader{version: 0x20080522}
	var data [2]capData
	if err := allThreads(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data[0])), 0); err != nil {
		return fmt.Errorf("capset: %w", err)
	}
	return verifyNoCapabilities()
}

func procStatus(key string) string {
	b, _ := os.ReadFile("/proc/self/status")
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(line, key+":"))
		}
	}
	return ""
}

func verifyNoCapabilities() error {
	for _, key := range []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"} {
		if v := procStatus(key); strings.Trim(v, "0") != "" || v == "" {
			return fmt.Errorf("%s is %q, want all zero", key, v)
		}
	}
	return nil
}

// ---------------------------------------------------------------- Landlock

type landlockAttr struct{ fs, net, scoped uint64 }

func landlockABI() (int, error) {
	r, _, e := syscall.RawSyscall(sysLandlockCreate, 0, 0, 1)
	if e != 0 {
		return 0, e
	}
	abi := int(r)
	// Prototype only: pretend an older kernel, to run the code paths an older
	// host takes (for example Ubuntu 24.04, kernel 6.8, ABI 4).
	if prototype {
		if n, err := strconv.Atoi(os.Getenv("ZKAPI_CONFINE_PROTOTYPE_ABI")); err == nil && n < abi {
			abi = n
		}
	}
	return abi, nil
}

type landlockSpec struct {
	connect, bind []int
	unixDir       string // pathname sockets under this directory stay reachable
	blockUnix     bool
	scoped        bool
	tsync         bool
}

// applyLandlock restricts the calling thread (all threads with tsync) and
// reports which rights it could handle on this kernel.
func applyLandlock(spec landlockSpec) ([]string, int, error) {
	abi, err := landlockABI()
	if err != nil {
		return nil, 0, fmt.Errorf("landlock: %w", err)
	}
	if abi < minLandlockABI {
		return nil, abi, fmt.Errorf("landlock ABI %d is below the required %d", abi, minLandlockABI)
	}
	var attr landlockAttr
	var layers []string
	if !ablated("landlock-net") {
		attr.net = 1 | 2 // BIND_TCP | CONNECT_TCP
		layers = append(layers, "landlock-net")
	}
	if spec.blockUnix && abi >= 9 && !ablated("landlock-unix") {
		attr.fs = 1 << 16 // RESOLVE_UNIX
		layers = append(layers, "landlock-unix")
	}
	if spec.scoped && abi >= 6 && !ablated("landlock-scope") {
		attr.scoped = 1 | 2 // abstract unix sockets | signals
		layers = append(layers, "landlock-scope")
	}
	if attr == (landlockAttr{}) {
		return nil, abi, nil
	}
	fd, _, e := syscall.RawSyscall(sysLandlockCreate, uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0)
	if e != 0 {
		return nil, abi, fmt.Errorf("landlock_create_ruleset: %w", e)
	}
	defer syscall.Close(int(fd))
	if attr.net != 0 {
		access := map[int]uint64{}
		for _, p := range spec.connect {
			access[p] |= 2
		}
		for _, p := range spec.bind {
			access[p] |= 1
		}
		for port, a := range access {
			rule := [2]uint64{a, uint64(port)}
			if _, _, e := syscall.RawSyscall6(sysLandlockAddRule, fd, 2, uintptr(unsafe.Pointer(&rule[0])), 0, 0, 0); e != 0 {
				return nil, abi, fmt.Errorf("landlock_add_rule port %d: %w", port, e)
			}
		}
	}
	if attr.fs != 0 && spec.unixDir != "" {
		dfd, err := syscall.Open(spec.unixDir, 0x200000|syscall.O_CLOEXEC, 0) // O_PATH
		if err != nil {
			return nil, abi, err
		}
		var rule [12]byte
		binary.LittleEndian.PutUint64(rule[0:], attr.fs)
		binary.LittleEndian.PutUint32(rule[8:], uint32(dfd))
		_, _, e := syscall.RawSyscall6(sysLandlockAddRule, fd, 1, uintptr(unsafe.Pointer(&rule[0])), 0, 0, 0)
		syscall.Close(dfd)
		if e != 0 {
			return nil, abi, fmt.Errorf("landlock_add_rule dir: %w", e)
		}
	}
	var flags uintptr
	if spec.tsync {
		flags = 1 << 3
	}
	if _, _, e := syscall.RawSyscall(sysLandlockRestrict, fd, flags, 0); e != 0 {
		return nil, abi, fmt.Errorf("landlock_restrict_self: %w", e)
	}
	return layers, abi, nil
}

// ------------------------------------------------------------------ profiles

type profile int

const (
	profileStage0 profile = iota
	profileStage1
	profileStage2
)

// hardenSelf protects the launcher stages themselves: no ptrace, no memory
// access by the (same-uid) daemon, no new privileges, and for stage0 and stage1
// a Landlock domain that names the only ports each may connect to. Any failure
// is returned; the caller refuses the session.
func hardenSelf(p profile, cfg *config) ([]string, error) {
	var layers []string
	if err := allThreads(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); err != nil {
		return nil, fmt.Errorf("no_new_privs: %w", err)
	}
	layers = append(layers, "nnp")
	if !ablated("dumpable") {
		if err := allThreads(syscall.SYS_PRCTL, prSetDumpable, 0, 0); err != nil {
			return nil, fmt.Errorf("dumpable: %w", err)
		}
		layers = append(layers, "launcher-undumpable")
	}
	if p != profileStage2 && cfg != nil {
		if abi, err := landlockABI(); err == nil && abi >= 8 {
			spec := landlockSpec{blockUnix: true, tsync: true}
			if p == profileStage0 {
				for _, r := range cfg.reach {
					spec.connect = append(spec.connect, r.hostPort)
				}
			} else {
				// Stage1's domain is the parent of the daemon's: a right it does not
				// grant, the daemon cannot have. It grants exactly the daemon's ports.
				spec.connect = cfg.connect
				spec.bind = cfg.bind
			}
			if l, _, err := applyLandlock(spec); err != nil {
				return nil, err
			} else if len(l) > 0 {
				layers = append(layers, "launcher-landlock")
			}
		}
	}
	if !ablated("seccomp") {
		prog, err := buildFilter(p)
		if err != nil {
			return nil, err
		}
		if err := loadSeccomp(prog, true); err != nil {
			return nil, err
		}
		layers = append(layers, "launcher-seccomp")
	}
	return layers, nil
}

// applyDaemonRestrictions runs in stage2, on the thread that will exec.
func applyDaemonRestrictions(cfg *config) ([]string, int, error) {
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); e != 0 {
		return nil, 0, fmt.Errorf("no_new_privs: %w", e)
	}
	layers := []string{"nnp"}
	spec := landlockSpec{connect: cfg.connect, bind: cfg.bind, blockUnix: true, scoped: true}
	l, abi, err := applyLandlock(spec)
	if err != nil && !ablated("landlock") {
		return nil, abi, err
	}
	layers = append(layers, l...)
	if !ablated("seccomp") {
		prog, err := buildFilter(profileStage2)
		if err != nil {
			return nil, abi, err
		}
		if err := loadSeccomp(prog, false); err != nil {
			return nil, abi, err
		}
		layers = append(layers, "seccomp")
	}
	return layers, abi, nil
}
