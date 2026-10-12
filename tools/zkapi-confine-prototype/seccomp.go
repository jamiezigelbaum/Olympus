package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const (
	retAllow     = 0x7fff0000
	retKillProc  = 0x80000000
	retErrnoBase = 0x00050000
	auditArchX86 = 0xC000003E
	auditArchArm = 0xC00000B7
	bpfLdAbsW    = 0x20
	bpfJeqK      = 0x15
	bpfJgeK      = 0x35
	bpfAndK      = 0x54
	bpfRetK      = 0x06
	x32Bit       = 0x40000000
	cloneNewMask = 0x7E020080 // NEWNS|NEWCGROUP|NEWUTS|NEWIPC|NEWUSER|NEWPID|NEWNET|NEWTIME
	afUnix       = 1
	afInet       = 2
	afNetlink    = 16
	sockTypeMask = 0xf
	sockStream   = 1
	ipprotoTCP   = 6
	secSetFilter = 1
	secGetAction = 2
	secTsync     = 1
)

type sockFilter struct {
	Code uint16
	Jt   uint8
	Jf   uint8
	K    uint32
}

type sockFprog struct {
	Len    uint16
	_      [6]byte
	Filter *sockFilter
}

// Syscall numbers, cross-checked against golang.org/x/sys/unix zsysnum files.
var sysNums = map[string][2]uint32{ // {amd64, arm64}
	"socket": {41, 198}, "socketpair": {53, 199}, "ptrace": {101, 117},
	"process_vm_readv": {310, 270}, "process_vm_writev": {311, 271}, "pidfd_getfd": {438, 438},
	"kcmp": {312, 272}, "unshare": {272, 97}, "setns": {308, 268}, "clone": {56, 220}, "clone3": {435, 435},
	"io_uring_setup": {425, 425}, "io_uring_enter": {426, 426}, "io_uring_register": {427, 427},
	"mount": {165, 40}, "umount2": {166, 39}, "pivot_root": {155, 41}, "chroot": {161, 51},
	"mount_setattr": {442, 442}, "move_mount": {429, 429}, "open_tree": {428, 428},
	"fsopen": {430, 430}, "fsconfig": {431, 431}, "fsmount": {432, 432}, "fspick": {433, 433},
	"open_by_handle_at": {304, 265}, "bpf": {321, 280}, "perf_event_open": {298, 241},
	"userfaultfd": {323, 282}, "kexec_load": {246, 104}, "kexec_file_load": {320, 294},
	"init_module": {175, 105}, "finit_module": {313, 273}, "delete_module": {176, 106},
	"reboot": {169, 142}, "keyctl": {250, 219}, "add_key": {248, 217}, "request_key": {249, 218},
	"swapon": {167, 224}, "swapoff": {168, 225}, "acct": {163, 89},
}

var denyEPERM = []string{
	"ptrace", "process_vm_readv", "process_vm_writev", "pidfd_getfd", "kcmp",
	"unshare", "setns",
	"io_uring_setup", "io_uring_enter", "io_uring_register",
	"mount", "umount2", "pivot_root", "chroot", "mount_setattr", "move_mount", "open_tree",
	"fsopen", "fsconfig", "fsmount", "fspick", "open_by_handle_at",
	"bpf", "perf_event_open", "userfaultfd",
	"kexec_load", "kexec_file_load", "init_module", "finit_module", "delete_module", "reboot",
	"keyctl", "add_key", "request_key", "swapon", "swapoff", "acct",
}

type asm struct {
	ins    []sockFilter
	labels map[string]int
	fix    []struct {
		idx    int
		jt, jf string
	}
}

func newAsm() *asm            { return &asm{labels: map[string]int{}} }
func (a *asm) label(n string) { a.labels[n] = len(a.ins) }
func (a *asm) ld(off uint32)  { a.ins = append(a.ins, sockFilter{Code: bpfLdAbsW, K: off}) }
func (a *asm) and(k uint32)   { a.ins = append(a.ins, sockFilter{Code: bpfAndK, K: k}) }
func (a *asm) ret(v uint32)   { a.ins = append(a.ins, sockFilter{Code: bpfRetK, K: v}) }
func (a *asm) jump(code uint16, k uint32, jt, jf string) {
	a.fix = append(a.fix, struct {
		idx    int
		jt, jf string
	}{len(a.ins), jt, jf})
	a.ins = append(a.ins, sockFilter{Code: code, K: k})
}
func (a *asm) resolve() ([]sockFilter, error) {
	for _, f := range a.fix {
		for which, name := range [2]string{f.jt, f.jf} {
			off := 0
			if name != "" {
				t, ok := a.labels[name]
				if !ok {
					return nil, fmt.Errorf("seccomp: unknown label %q", name)
				}
				off = t - (f.idx + 1)
				if off < 0 || off > 255 {
					return nil, fmt.Errorf("seccomp: jump to %q out of range", name)
				}
			}
			if which == 0 {
				a.ins[f.idx].Jt = uint8(off)
			} else {
				a.ins[f.idx].Jf = uint8(off)
			}
		}
	}
	return a.ins, nil
}

func archIndex() (int, uint32, error) {
	switch runtime.GOARCH {
	case "amd64":
		return 0, auditArchX86, nil
	case "arm64":
		return 1, auditArchArm, nil
	}
	return 0, 0, fmt.Errorf("seccomp: unsupported architecture %s", runtime.GOARCH)
}

func num(name string, arch int) uint32 { return sysNums[name][arch] }

// buildFilter is a deny list with argument checks for the calls that matter:
// a family, type and protocol allow list for socket(), no new namespaces via
// clone(), unshare() or setns(), clone3() answered ENOSYS so libc and Go fall
// back to clone(). Everything not named is allowed: the network boundary is
// the namespace; this layer removes the rest of the ways around it.
func buildFilter(p profile) ([]sockFilter, error) {
	arch, auditArch, err := archIndex()
	if err != nil {
		return nil, err
	}
	a := newAsm()
	a.ld(4)
	a.jump(bpfJeqK, auditArch, "", "kill")
	a.ld(0)
	if arch == 0 {
		a.jump(bpfJgeK, x32Bit, "deny", "")
	}
	for _, name := range denyEPERM {
		a.jump(bpfJeqK, num(name, arch), "deny", "")
	}
	a.jump(bpfJeqK, num("clone3", arch), "enosys", "")
	a.jump(bpfJeqK, num("socket", arch), "sock", "")
	a.jump(bpfJeqK, num("socketpair", arch), "pair", "")
	a.jump(bpfJeqK, num("clone", arch), "clone", "")
	a.ret(retAllow) // nothing named matched

	a.label("clone")
	a.ld(16)
	a.and(cloneNewMask)
	a.jump(bpfJeqK, 0, "allow", "deny")

	a.label("pair")
	// Only an anonymous, already-connected AF_UNIX stream pair, and only in the
	// daemon. A datagram or seqpacket pair could be re-pointed at a host
	// pathname socket; a stream pair cannot (connect() on it is EISCONN).
	// Stage1's filter is inherited by the daemon, so it grants exactly what the
	// daemon's own filter grants; only stage0, which never starts the daemon,
	// has no pair at all.
	if p == profileStage0 {
		a.ret(retErrnoBase | uint32(syscall.EPERM))
	} else {
		a.ld(16)
		a.jump(bpfJeqK, afUnix, "pair_type", "deny")
		a.label("pair_type")
		a.ld(24)
		a.and(sockTypeMask)
		types := []uint32{sockStream}
		if prototype { // measuring which pair types the runtimes' process spawning needs
			for _, name := range strings.Split(os.Getenv("ZKAPI_CONFINE_PROTOTYPE_PAIR_ALLOW"), ",") {
				switch name {
				case "dgram":
					types = append(types, 2)
				case "seqpacket":
					types = append(types, 5)
				}
			}
		}
		for i, typ := range types {
			if i == len(types)-1 {
				a.jump(bpfJeqK, typ, "pair_proto", "deny")
			} else {
				a.jump(bpfJeqK, typ, "pair_proto", "")
			}
		}
		a.label("pair_proto")
		a.ld(32)
		a.jump(bpfJeqK, 0, "allow", "deny")
	}

	a.label("sock")
	// No AF_UNIX socket() for any stage: the bridges are descriptors passed
	// over the control channel, never sockets a stage opens by name.
	a.ld(16)
	a.jump(bpfJeqK, afInet, "sock_inet", "")
	if p == profileStage0 {
		a.ret(retErrnoBase | uint32(syscall.EPERM))
	} else {
		a.jump(bpfJeqK, afNetlink, "sock_netlink", "deny")
		// Route-table netlink only, read-only without capabilities: the
		// runtimes' interface enumeration (getifaddrs) needs it.
		a.label("sock_netlink")
		a.ld(32)
		a.jump(bpfJeqK, 0, "allow", "deny")
	}
	a.label("sock_inet")
	a.ld(24)
	a.and(sockTypeMask)
	a.jump(bpfJeqK, sockStream, "sock_inet_proto", "deny")
	a.label("sock_inet_proto")
	a.ld(32)
	a.jump(bpfJeqK, 0, "allow", "")
	a.jump(bpfJeqK, ipprotoTCP, "allow", "deny")
	a.label("allow")
	a.ret(retAllow)
	a.label("deny")
	a.ret(retErrnoBase | uint32(syscall.EPERM))
	a.label("enosys")
	a.ret(retErrnoBase | uint32(syscall.ENOSYS))
	a.label("kill")
	a.ret(retKillProc)
	return a.resolve()
}

func loadSeccomp(prog []sockFilter, tsync bool) error {
	fp := sockFprog{Len: uint16(len(prog)), Filter: &prog[0]}
	var flags uintptr
	if tsync {
		flags = secTsync
	}
	r, _, e := syscall.RawSyscall(sysSeccompNum(), secSetFilter, flags, uintptr(unsafe.Pointer(&fp)))
	if e != 0 {
		return fmt.Errorf("seccomp: %w", e)
	}
	if tsync && r != 0 {
		return fmt.Errorf("seccomp: thread %d refused the filter", r)
	}
	return nil
}

func sysSeccompNum() uintptr {
	if runtime.GOARCH == "arm64" {
		return 277
	}
	return 317
}

func seccompSupported() error {
	action := uint32(retErrnoBase)
	if _, _, e := syscall.RawSyscall(sysSeccompNum(), secGetAction, 0, uintptr(unsafe.Pointer(&action))); e != 0 {
		return e
	}
	return nil
}

func goarch() string { return runtime.GOARCH }
