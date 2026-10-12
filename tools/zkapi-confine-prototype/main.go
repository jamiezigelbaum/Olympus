// PROTOTYPE: Linux network confinement launcher for the zkAPI private lane.
//
// Not shipped, not wired into any production code path. It exists to prove the
// design in docs/design/linux-zkapi-confinement.md on a real host. If the
// design is accepted the launcher moves into the zkapi fork and is rebuilt
// there with the pinned toolchain; nothing here is the shipped artifact.
//
// Process tree:
//
//	stage0 (host namespace)  clones stage1 into a new user+network namespace,
//	                         waits, relays the exit status. No network syscalls.
//	stage1 (namespace)       brings loopback up, opens the bridges, drops every
//	                         capability, hardens itself, starts stage2.
//	stage2 (namespace)       sets no_new_privs, applies Landlock and seccomp on
//	                         its own thread, closes inherited descriptors and
//	                         execs the daemon. Everything the daemon starts
//	                         inherits all of it.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
)

// prototype is true only in this tree. The ablation switch below lets the test
// matrix switch one layer off to show what each layer is for; the shipped
// launcher has no such switch.
const prototype = true

func init() { runtime.LockOSThread() }

func ablated(layer string) bool {
	if !prototype {
		return false
	}
	for _, name := range strings.Split(os.Getenv("ZKAPI_CONFINE_PROTOTYPE_ABLATE"), ",") {
		if name == layer {
			return true
		}
	}
	return false
}

// emit writes one status line the supervisor parses. Fixed prefix, one JSON
// object, nothing about the daemon's own output.
func emit(event map[string]any) {
	b, _ := json.Marshal(event)
	out := os.Stdout
	if statusFile != nil {
		out = statusFile
	}
	fmt.Fprintf(out, "zkapi-confine: %s\n", b)
}

// statusFile is the private events pipe (--status-fd 3). The daemon never has
// it: stage2 closes it on exec. Without it, events share stdout with the daemon.
var statusFile *os.File

func refuse(code string, err error) int {
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	emit(map[string]any{"event": "refused", "code": code, "detail": detail})
	return 78
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: zkapi-confine run|check|probe ...")
		os.Exit(64)
	}
	var code int
	switch os.Args[1] {
	case "run":
		code = stage0(os.Args[2:])
	case "__stage1":
		code = stage1(os.Args[2:])
	case "__stage2":
		code = stage2(os.Args[2:])
	case "check":
		code = check()
	case "probe":
		code = probe(os.Args[2:])
	case "noop":
		emit(map[string]any{"event": "noop"})
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		code = 64
	}
	os.Exit(code)
}

func exitCode(err error, state *os.ProcessState) int {
	if state == nil {
		return 70
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return state.ExitCode()
}

func forwardSignals(p *os.Process) {
	ch := make(chan os.Signal, 8)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT)
	go func() {
		for s := range ch {
			_ = p.Signal(s)
		}
	}()
}

// stage0 runs in the host namespace. It does nothing but create the namespace
// and wait, and it is hardened so that taking it over is worthless.
func stage0(args []string) int {
	markCloexec()
	// If the supervising watchdog dies, the whole tree follows it.
	ppid := os.Getppid()
	_, _, _ = syscall.RawSyscall(syscall.SYS_PRCTL, prSetPdeathsig, uintptr(syscall.SIGKILL), 0)
	if os.Getppid() != ppid {
		return refuse("supervisor_gone", nil)
	}
	cfg, err := parseConfig(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "zkapi-confine:", err)
		return 64
	}
	if cfg.status {
		statusFile = os.NewFile(3, "status")
	}
	if !ablated("landlock") {
		abi, aerr := landlockABI()
		if aerr != nil || abi < minLandlockABI {
			detail := fmt.Sprintf("landlock ABI %d, need at least %d", abi, minLandlockABI)
			if aerr != nil {
				detail += ": " + aerr.Error()
			}
			return refuse("landlock_unavailable", fmt.Errorf("%s", detail))
		}
	}
	if err := seccompSupported(); err != nil {
		return refuse("seccomp_unavailable", err)
	}
	hostNS, _ := os.Readlink("/proc/self/ns/net")
	cmd := exec.Command("/proc/self/exe", append([]string{"__stage1"}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if statusFile != nil {
		cmd.ExtraFiles = []*os.File{statusFile}
	}
	cmd.Env = append(os.Environ(), "ZKAPI_CONFINE_HOST_NETNS="+hostNS)
	sp := &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if !ablated("netns") {
		uid, gid := os.Getuid(), os.Getgid()
		sp.Cloneflags = syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET
		sp.UidMappings = []syscall.SysProcIDMap{{ContainerID: uid, HostID: uid, Size: 1}}
		sp.GidMappings = []syscall.SysProcIDMap{{ContainerID: gid, HostID: gid, Size: 1}}
		sp.GidMappingsEnableSetgroups = false
		// Only to bring loopback up and drop the bounding set; stage1 gives
		// both away before anything untrusted runs.
		sp.AmbientCaps = []uintptr{capNetAdmin, capSetpcap}
	}
	cmd.SysProcAttr = sp
	if err := cmd.Start(); err != nil {
		return refuse("namespace_unavailable", err)
	}
	forwardSignals(cmd.Process)
	if !ablated("harden0") {
		_, _ = hardenSelf(profileStage0, nil)
	}
	werr := cmd.Wait()
	return exitCode(werr, cmd.ProcessState)
}

// stage1 runs inside the new namespace as the same uid, with capabilities that
// last only until loopback is up.
func stage1(args []string) int {
	markCloexec()
	cfg, err := parseConfig(args)
	if err != nil {
		return refuse("bad_arguments", err)
	}
	if cfg.status {
		statusFile = os.NewFile(3, "status")
	}
	netns := !ablated("netns")
	if netns {
		hostNS := os.Getenv("ZKAPI_CONFINE_HOST_NETNS")
		ownNS, _ := os.Readlink("/proc/self/ns/net")
		if hostNS == "" || ownNS == "" || hostNS == ownNS {
			return refuse("namespace_unavailable", fmt.Errorf("not in a new network namespace"))
		}
		if err := loopbackUp(); err != nil {
			return refuse("loopback_unavailable", err)
		}
		if err := onlyLoopback(); err != nil {
			return refuse("namespace_unavailable", err)
		}
	}
	os.Unsetenv("ZKAPI_CONFINE_HOST_NETNS")
	if netns && !ablated("ipv6-off") {
		// No ::1 inside the namespace at all, whatever else is or is not applied.
		if err := disableIPv6(); err != nil {
			return refuse("namespace_unavailable", err)
		}
	}
	syscall.Umask(0o077)
	br, err := openBridges(cfg)
	if err != nil {
		return refuse("bridge_unavailable", err)
	}
	defer br.close()

	layers := []string{}
	if netns {
		layers = append(layers, "netns")
		if !ablated("ipv6-off") {
			layers = append(layers, "ipv6-off")
		}
	}
	if !ablated("caps") {
		if err := dropAllCapabilities(); err != nil {
			return refuse("capabilities_not_dropped", err)
		}
		layers = append(layers, "caps")
	}
	hl, err := hardenSelf(profileStage1, cfg)
	if err != nil {
		return refuse("launcher_hardening_failed", err)
	}
	layers = append(layers, hl...)

	r, w, err := os.Pipe()
	if err != nil {
		return refuse("internal", err)
	}
	cmd := exec.Command("/proc/self/exe", append([]string{"__stage2"}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.ExtraFiles = []*os.File{w}
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if err := cmd.Start(); err != nil {
		return refuse("internal", err)
	}
	w.Close()
	forwardSignals(cmd.Process)

	// stage2 reports what it applied, then execs; the pipe closes on exec.
	rep := readReport(r)
	if !rep.OK {
		_ = cmd.Wait()
		return refuse(rep.Code, fmt.Errorf("%s", rep.Detail))
	}
	emit(map[string]any{
		"event":         "ready",
		"launcherPid":   os.Getpid(),
		"daemonPid":     cmd.Process.Pid,
		"landlockAbi":   rep.ABI,
		"layers":        append(layers, rep.Layers...),
		"bridgesExpose": br.exposed(),
		"bridgesReach":  br.reached(),
	})
	werr := cmd.Wait()
	code := exitCode(werr, cmd.ProcessState)
	return code
}

// stage2 applies the restrictions on the one thread that will exec.
func stage2(args []string) int {
	report := os.NewFile(3, "report")
	markCloexec()
	fail := func(code string, err error) int {
		writeReport(report, stageReport{OK: false, Code: code, Detail: err.Error()})
		return 78
	}
	cfg, err := parseConfig(args)
	if err != nil {
		return fail("bad_arguments", err)
	}
	if !ablated("caps") {
		if err := verifyNoCapabilities(); err != nil {
			return fail("capabilities_not_dropped", err)
		}
	}
	layers, abi, err := applyDaemonRestrictions(cfg)
	if err != nil {
		return fail("restriction_failed", err)
	}
	writeReport(report, stageReport{OK: true, ABI: abi, Layers: layers})
	err = syscall.Exec(cfg.prog[0], cfg.prog, os.Environ())
	writeReport(report, stageReport{OK: false, Code: "exec_failed", Detail: err.Error()})
	return 127
}

// check asks whether this host can run the confinement at all, by running the
// real thing around a no-op. It never starts a daemon.
func check() int {
	self, _ := os.Executable()
	cmd := exec.Command(self, "run", "--connect-port", "1", "--bind-port", "1", "--", self, "noop")
	out, err := cmd.Output()
	var ready, refused map[string]any
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.HasPrefix(line, "zkapi-confine: ") {
			continue
		}
		var ev map[string]any
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "zkapi-confine: ")), &ev) != nil {
			continue
		}
		switch ev["event"] {
		case "ready":
			ready = ev
		case "refused":
			refused = ev
		}
	}
	if ready != nil && err == nil {
		b, _ := json.Marshal(map[string]any{"ok": true, "landlockAbi": ready["landlockAbi"], "layers": ready["layers"]})
		fmt.Println(string(b))
		return 0
	}
	if refused == nil {
		refused = map[string]any{"code": "namespace_unavailable", "detail": fmt.Sprint(err)}
	}
	b, _ := json.Marshal(map[string]any{"ok": false, "code": refused["code"], "detail": refused["detail"]})
	fmt.Println(string(b))
	return 78
}
