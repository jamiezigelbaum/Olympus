// PROTOTYPE: Linux network confinement launcher for the zkAPI private lane.
//
// Not shipped, not wired into any production code path. It exists to prove the
// design in docs/design/linux-zkapi-confinement.md on a real host. If the
// design is accepted the launcher moves into the zkapi fork and is rebuilt
// there with the pinned toolchain; nothing here is the shipped artifact.
//
// Process tree:
//
//	stage0 (host namespace)  creates the control channel and the authenticated
//	                         API socket, clones stage1 into a new user, network
//	                         and PID namespace, HARDENS ITSELF, and only then
//	                         releases stage1 with a "go" message. It carries the
//	                         private status descriptor and dials the host side
//	                         of the Tor bridge.
//	stage1 (namespace, PID 1) waits for "go", brings loopback up, listens on the
//	                         Tor bridge port, drops every capability, hardens
//	                         itself, starts stage2 and reaps. When stage1 dies
//	                         the kernel kills every process in the namespace:
//	                         the lifetime boundary of the whole session.
//	stage2 (namespace)       sets no_new_privs, applies Landlock and seccomp on
//	                         its own thread, closes inherited descriptors and
//	                         execs the daemon. Everything the daemon starts
//	                         inherits all of it.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// prototype is true only in this tree. The ablation and fault switches below
// let the test matrix switch one layer off, or force a failure, to show what
// each layer is for and that failures refuse; the shipped launcher has none.
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

func fault(name string) bool {
	return prototype && os.Getenv("ZKAPI_CONFINE_PROTOTYPE_FAULT") == name
}

// emitFn delivers one launcher event. In stage0 it writes the private status
// descriptor; in stage1 it goes over the control channel to stage0.
var emitFn func(map[string]any)

func emit(event map[string]any) {
	if emitFn != nil {
		emitFn(event)
	}
}

var statusFile *os.File

func emitStatus(event map[string]any) {
	b, _ := json.Marshal(event)
	if statusFile != nil {
		fmt.Fprintf(statusFile, "zkapi-confine: %s\n", b)
	}
}

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
	case "holdlisten", "sleeper", "escape":
		code = helper(os.Args[1], os.Args[2:])
	case "dumpfilter":
		for i, p := range []profile{profileStage0, profileStage1, profileStage2} {
			prog, err := buildFilter(p)
			if err != nil {
				fmt.Println(err)
				continue
			}
			fmt.Printf("# profile %d, %d instructions\n", i, len(prog))
			for n, f := range prog {
				fmt.Printf("%3d: code=%#04x jt=%d jf=%d k=%#x\n", n, f.Code, f.Jt, f.Jf, f.K)
			}
		}
	case "noop":
		time.Sleep(500 * time.Millisecond) // long enough to be bound to its instance
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		code = 64
	}
	os.Exit(code)
}

func exitCode(state *os.ProcessState) int {
	if state == nil {
		return 70
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return state.ExitCode()
}

func forwardSignals(pid int) {
	ch := make(chan os.Signal, 8)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT)
	go func() {
		for s := range ch {
			_ = syscall.Kill(pid, s.(syscall.Signal))
		}
	}()
}

// ------------------------------------------------------------------ stage0

// stage0 runs in the host namespace. It does nothing but create the
// namespaces, harden itself before releasing stage1, serve the two bridges and
// wait.
func stage0(args []string) int {
	cfg, err := parseConfig(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "zkapi-confine:", err)
		return 64
	}
	// The private status descriptor must be a real, open descriptor.
	var st syscall.Stat_t
	if err := syscall.Fstat(3, &st); err != nil {
		fmt.Fprintln(os.Stderr, "zkapi-confine: --status-fd 3 is not open")
		return 64
	}
	statusFile = os.NewFile(3, "status")
	emitFn = emitStatus
	if err := markCloexec(); err != nil || fault("cloexec") {
		if err == nil {
			err = fmt.Errorf("injected failure")
		}
		return refuse("descriptor_sanitize_failed", err)
	}
	// If the supervising watchdog dies, the whole tree follows it.
	ppid := os.Getppid()
	_, _, _ = syscall.RawSyscall(syscall.SYS_PRCTL, prSetPdeathsig, uintptr(syscall.SIGKILL), 0)
	if os.Getppid() != ppid {
		return refuse("supervisor_gone", nil)
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
	exposed, err := openExpose(cfg)
	if err != nil {
		return refuse("bridge_unavailable", err)
	}
	defer closeExpose(exposed)
	hostFile, nsFile, err := newCtlPair()
	if err != nil {
		return refuse("internal", err)
	}
	hostNS, _ := os.Readlink("/proc/self/ns/net")
	cmd := exec.Command("/proc/self/exe", append([]string{"__stage1"}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.ExtraFiles = []*os.File{nsFile}
	cmd.Env = append(os.Environ(), "ZKAPI_CONFINE_HOST_NETNS="+hostNS)
	sp := &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if !ablated("netns") {
		uid, gid := os.Getuid(), os.Getgid()
		sp.Cloneflags = syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET
		if !ablated("pidns") {
			sp.Cloneflags |= syscall.CLONE_NEWPID
		}
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
	nsFile.Close()
	stage1Pid := cmd.Process.Pid
	ctl := newCtl(hostFile)
	stop := func() {
		_ = syscall.Kill(stage1Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}

	// Harden before stage1 is allowed to do anything. A failure here is a
	// refusal: stage1 never gets its "go", and is killed.
	var layers []string
	if !ablated("harden0") {
		if fault("harden-stage0") {
			err = fmt.Errorf("injected failure")
		} else {
			layers, err = hardenSelf(profileStage0, cfg)
		}
		if err != nil {
			stop()
			return refuse("launcher_hardening_failed", err)
		}
	}
	if err := ctl.send(map[string]any{"t": "go"}, nil); err != nil {
		stop()
		return refuse("internal", err)
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		stop()
		return refuse("internal", err)
	}
	for _, b := range exposed {
		go exposeLoop(b, token, ctl)
	}
	forwardSignals(stage1Pid)

	hostPorts := map[int]int{}
	for _, r := range cfg.reach {
		hostPorts[r.nsPort] = r.hostPort
	}
	readyEmitted := false
	loopDone := make(chan struct{})
	go func() {
		defer close(loopDone)
		for {
			msg, f, err := ctl.recv()
			if err != nil {
				return
			}
			switch msg["t"] {
			case "reach":
				port, _ := msg["nsPort"].(float64)
				hp, ok := hostPorts[int(port)]
				if f == nil {
					continue
				}
				if !ok {
					f.Close()
					continue
				}
				go dialAndPump(f, fmt.Sprintf("127.0.0.1:%d", hp))
			case "event":
				ev, _ := msg["event"].(map[string]any)
				if ev == nil {
					continue
				}
				if ev["event"] == "ready" {
					full, herr := completeReady(ev, stage1Pid, layers, token)
					if herr != nil {
						emit(map[string]any{"event": "refused", "code": "instance_binding_failed", "detail": herr.Error()})
						_ = syscall.Kill(stage1Pid, syscall.SIGKILL)
						return
					}
					readyEmitted = true
					emit(full)
					continue
				}
				emit(ev)
			default:
				if f != nil {
					f.Close()
				}
			}
		}
	}()
	werr := cmd.Wait()
	select {
	case <-loopDone:
	case <-time.After(time.Second):
	}
	code := exitCode(cmd.ProcessState)
	if !readyEmitted && code != 78 {
		emit(map[string]any{"event": "refused", "code": "launcher_exited", "detail": fmt.Sprintf("exit %d before ready", code)})
	}
	_ = werr
	return code
}

// completeReady turns stage1's account (pids as stage1 sees them) into the
// event the supervisor receives: host-visible pids bound to the process
// instances by start time and PID-namespace identity, plus the token.
func completeReady(ev map[string]any, stage1Pid int, stage0Layers []string, token []byte) (map[string]any, error) {
	nsPid, _ := ev["daemonNsPid"].(float64)
	if nsPid < 2 {
		return nil, fmt.Errorf("no daemon pid reported")
	}
	// The launcher is non-dumpable, so its ns links cannot be read; the daemon
	// is its direct child and dumpable again after exec. Find it by parent and
	// by its pid inside the namespace, then read the namespace identity from it.
	var daemonHost int
	for i := 0; i < 100 && daemonHost == 0; i++ {
		daemonHost = hostPidFor(stage1Pid, int(nsPid))
		if daemonHost == 0 {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if daemonHost == 0 {
		return nil, fmt.Errorf("daemon pid %d not found under the launcher", int(nsPid))
	}
	out := map[string]any{}
	for k, v := range ev {
		if k != "daemonNsPid" {
			out[k] = v
		}
	}
	out["launcherPid"] = stage1Pid
	out["launcherStart"] = startTime(stage1Pid)
	out["daemonPid"] = daemonHost
	out["daemonStart"] = startTime(daemonHost)
	out["stage0Layers"] = stage0Layers
	out["apiToken"] = hex.EncodeToString(token)
	return out, nil
}

// hostPidFor finds the process, as the host sees it, that is a direct child of
// parent and has nsPid as its last (innermost) PID.
func hostPidFor(parent, nsPid int) int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
		if err != nil {
			continue
		}
		var ppid int
		var nspid []string
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PPid:") {
				ppid, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:")))
			}
			if strings.HasPrefix(line, "NSpid:") {
				nspid = strings.Fields(strings.TrimPrefix(line, "NSpid:"))
			}
		}
		if ppid == parent && len(nspid) >= 1 && nspid[len(nspid)-1] == strconv.Itoa(nsPid) {
			return pid
		}
	}
	return 0
}

// startTime is field 22 of /proc/<pid>/stat (clock ticks since boot): with the
// pid it names one process instance for the life of the boot.
func startTime(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return ""
	}
	s := string(b)
	f := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
	if len(f) < 20 {
		return ""
	}
	return f[19]
}

// ------------------------------------------------------------------ stage1

// stage1 runs inside the new namespaces as PID 1 with the same uid. Its
// capabilities last only until loopback is up.
func stage1(args []string) int {
	ctl := newCtl(os.NewFile(3, "ctl"))
	emitFn = func(ev map[string]any) { _ = ctl.send(map[string]any{"t": "event", "event": ev}, nil) }
	cfg, err := parseConfig(args)
	if err != nil {
		return refuse("bad_arguments", err)
	}
	if err := markCloexec(); err != nil || fault("cloexec1") {
		if err == nil {
			err = fmt.Errorf("injected failure")
		}
		return refuse("descriptor_sanitize_failed", err)
	}
	// Nothing runs until stage0 has hardened itself and says so.
	if msg, _, err := ctl.recv(); err != nil || msg["t"] != "go" {
		return 78
	}
	if fault("silent") {
		time.Sleep(time.Hour)
	}
	netns := !ablated("netns")
	if netns {
		hostNS := os.Getenv("ZKAPI_CONFINE_HOST_NETNS")
		ownNS, _ := os.Readlink("/proc/self/ns/net")
		if hostNS == "" || ownNS == "" || hostNS == ownNS {
			return refuse("namespace_unavailable", fmt.Errorf("not in a new network namespace"))
		}
		if !ablated("pidns") && os.Getpid() != 1 {
			return refuse("namespace_unavailable", fmt.Errorf("not PID 1 of a new PID namespace"))
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
	var reachListeners []net.Listener
	closeReach := func() {
		for _, l := range reachListeners {
			l.Close()
		}
	}
	defer closeReach()
	var reached []string
	for _, r := range cfg.reach {
		l, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", r.nsPort))
		if err != nil {
			return refuse("bridge_unavailable", err)
		}
		reachListeners = append(reachListeners, l)
		reached = append(reached, strconv.Itoa(r.nsPort))
	}

	layers := []string{}
	if netns {
		layers = append(layers, "netns")
		if !ablated("pidns") {
			layers = append(layers, "pidns")
		}
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
	self, _ := os.Executable()
	proc, err := os.StartProcess("/proc/self/exe", append([]string{self, "__stage2"}, args...), &os.ProcAttr{
		Env:   os.Environ(),
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr, w},
		Sys:   &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL},
	})
	if err != nil {
		return refuse("internal", err)
	}
	w.Close()
	daemonPid := proc.Pid
	// As PID 1 this stage is the reaper: every orphan of the daemon lands here.
	exited := make(chan int, 1)
	go func() {
		for {
			var ws syscall.WaitStatus
			pid, err := syscall.Wait4(-1, &ws, 0, nil)
			if err == syscall.EINTR {
				continue
			}
			if err != nil {
				exited <- 70
				return
			}
			if pid == daemonPid {
				if ws.Signaled() {
					exited <- 128 + int(ws.Signal())
				} else {
					exited <- ws.ExitStatus()
				}
				return
			}
		}
	}()
	forwardSignals(daemonPid)

	// stage2 reports what it applied, then execs; the pipe closes on exec.
	rep := readReport(r)
	if !rep.OK {
		<-exited
		return refuse(rep.Code, fmt.Errorf("%s", rep.Detail))
	}
	for i, l := range reachListeners {
		go reachLoop(l, cfg.reach[i].nsPort, ctl)
	}
	apiPorts := map[string]int{}
	for _, e := range cfg.expose {
		apiPorts[e.name] = e.port
	}
	go func() {
		for {
			msg, f, err := ctl.recv()
			if err != nil {
				return
			}
			if msg["t"] == "api" && f != nil {
				name, _ := msg["bridge"].(string)
				if port, ok := apiPorts[name]; ok {
					go dialAndPump(f, fmt.Sprintf("127.0.0.1:%d", port))
					continue
				}
			}
			if f != nil {
				f.Close()
			}
		}
	}()
	exposedNames := []string{}
	for _, e := range cfg.expose {
		exposedNames = append(exposedNames, e.name)
	}
	emit(map[string]any{
		"event":         "ready",
		"daemonNsPid":   daemonPid,
		"landlockAbi":   rep.ABI,
		"layers":        append(layers, rep.Layers...),
		"bridgesExpose": exposedNames,
		"bridgesReach":  reached,
	})
	return <-exited
}

// ------------------------------------------------------------------ stage2

// stage2 applies the restrictions on the one thread that will exec.
func stage2(args []string) int {
	report := os.NewFile(3, "report")
	fail := func(code string, err error) int {
		writeReport(report, stageReport{OK: false, Code: code, Detail: err.Error()})
		return 78
	}
	cfg, err := parseConfig(args)
	if err != nil {
		return fail("bad_arguments", err)
	}
	if err := markCloexec(); err != nil {
		return fail("descriptor_sanitize_failed", err)
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
	r, w, err := os.Pipe()
	if err != nil {
		return 70
	}
	cmd := exec.Command(self, "run", "--status-fd", "3", "--connect-port", "1", "--", self, "noop")
	cmd.ExtraFiles = []*os.File{w}
	runErr := cmd.Run()
	w.Close()
	data, _ := io.ReadAll(r)
	var ready, refused map[string]any
	for _, line := range strings.Split(string(data), "\n") {
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
	if ready != nil && runErr == nil {
		b, _ := json.Marshal(map[string]any{"ok": true, "landlockAbi": ready["landlockAbi"], "layers": ready["layers"], "stage0Layers": ready["stage0Layers"]})
		fmt.Println(string(b))
		return 0
	}
	if refused == nil {
		refused = map[string]any{"code": "namespace_unavailable", "detail": fmt.Sprint(runErr)}
	}
	b, _ := json.Marshal(map[string]any{"ok": false, "code": refused["code"], "detail": refused["detail"]})
	fmt.Println(string(b))
	return 78
}
