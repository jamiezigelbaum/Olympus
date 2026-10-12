package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

func errName(e error) string {
	if e == nil {
		return "ok"
	}
	if en, ok := e.(syscall.Errno); ok {
		switch en {
		case syscall.EPERM:
			return "EPERM"
		case syscall.EACCES:
			return "EACCES"
		case syscall.ENOSYS:
			return "ENOSYS"
		case syscall.EAFNOSUPPORT:
			return "EAFNOSUPPORT"
		case syscall.EINVAL:
			return "EINVAL"
		case syscall.EFAULT:
			return "EFAULT"
		case syscall.ENOENT:
			return "ENOENT"
		case syscall.ESRCH:
			return "ESRCH"
		case syscall.ENXIO:
			return "ENXIO"
		case syscall.EISCONN:
			return "EISCONN"
		case syscall.EPIPE:
			return "EPIPE"
		case syscall.ECONNREFUSED:
			return "ECONNREFUSED"
		}
		return "errno" + fmt.Sprint(int(en))
	}
	return "error"
}

func rawErr(r uintptr, e syscall.Errno) error {
	if e != 0 {
		return e
	}
	return nil
}

func sock(domain, typ, proto int) error {
	fd, err := syscall.Socket(domain, typ, proto)
	if err == nil {
		syscall.Close(fd)
	}
	return err
}

// probe runs raw syscalls the confinement must refuse and reports the errno of
// each, as a single JSON object. It is the exec'd-child half of the self-test
// for everything a JavaScript child cannot attempt.
//
// args: <stage1 host pid> <stage0 host pid> <host stream decoy path> <host
// datagram decoy path>. The decoys are listeners the test owns, so an attempt
// that got through would be visible to the test.
func probe(targets []string) int {
	res := map[string]string{}
	pids := []int{}
	for _, t := range targets[:min(2, len(targets))] {
		var n int
		if _, err := fmt.Sscanf(t, "%d", &n); err == nil && n > 1 {
			pids = append(pids, n)
		}
	}
	for len(pids) < 2 {
		pids = append(pids, 1)
	}
	ppid, gpid := pids[0], pids[1]
	hostStream, hostDgram := "", ""
	if len(targets) > 2 {
		hostStream = targets[2]
	}
	if len(targets) > 3 {
		hostDgram = targets[3]
	}
	set := func(k string, e error) { res[k] = errName(e) }

	set("socket_inet_stream", sock(syscall.AF_INET, syscall.SOCK_STREAM, 0))
	set("socket_inet6", sock(syscall.AF_INET6, syscall.SOCK_STREAM, 0))
	set("socket_inet_dgram", sock(syscall.AF_INET, syscall.SOCK_DGRAM, 0))
	set("socket_inet_raw", sock(syscall.AF_INET, syscall.SOCK_RAW, 1))
	set("socket_unix", sock(syscall.AF_UNIX, syscall.SOCK_STREAM, 0))
	set("socket_unix_dgram", sock(syscall.AF_UNIX, syscall.SOCK_DGRAM, 0))
	set("socket_netlink_route", sock(syscall.AF_NETLINK, syscall.SOCK_RAW, 0))
	set("socket_netlink_generic", sock(syscall.AF_NETLINK, syscall.SOCK_RAW, 16))
	set("socket_packet", sock(syscall.AF_PACKET, syscall.SOCK_RAW, 0))
	set("socket_vsock", sock(40, syscall.SOCK_STREAM, 0))

	// Unix socket pairs: only an anonymous stream pair is allowed, and it must
	// be impossible to re-point at a host pathname socket.
	pair := func(typ int) (int, int, error) {
		fds, err := syscall.Socketpair(syscall.AF_UNIX, typ, 0)
		if err != nil {
			return -1, -1, err
		}
		return fds[0], fds[1], nil
	}
	if a, b, err := pair(syscall.SOCK_STREAM); err == nil {
		res["socketpair_unix_stream"] = "ok"
		if hostStream != "" {
			set("pair_stream_connect_host_path", syscall.Connect(a, &syscall.SockaddrUnix{Name: hostStream}))
			set("pair_stream_sendto_host_path", syscall.Sendto(a, []byte("x"), 0, &syscall.SockaddrUnix{Name: hostStream}))
			_ = syscall.Shutdown(a, syscall.SHUT_RDWR)
			set("pair_stream_connect_after_shutdown", syscall.Connect(a, &syscall.SockaddrUnix{Name: hostStream}))
		}
		syscall.Close(a)
		syscall.Close(b)
	} else {
		set("socketpair_unix_stream", err)
	}
	if a, b, err := pair(syscall.SOCK_DGRAM); err == nil {
		res["socketpair_unix_dgram"] = "ok"
		if hostDgram != "" {
			set("pair_dgram_connect_host_path", syscall.Connect(a, &syscall.SockaddrUnix{Name: hostDgram}))
			set("pair_dgram_sendto_host_path", syscall.Sendto(a, []byte("x"), 0, &syscall.SockaddrUnix{Name: hostDgram}))
		}
		syscall.Close(a)
		syscall.Close(b)
	} else {
		set("socketpair_unix_dgram", err)
		res["pair_dgram_connect_host_path"] = "no_socket"
		res["pair_dgram_sendto_host_path"] = "no_socket"
	}
	if a, b, err := pair(syscall.SOCK_SEQPACKET); err == nil {
		res["socketpair_unix_seqpacket"] = "ok"
		syscall.Close(a)
		syscall.Close(b)
	} else {
		set("socketpair_unix_seqpacket", err)
	}
	// An AF_INET stream socket cannot be pointed at a pathname either.
	if fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0); err == nil {
		if hostStream != "" {
			set("inet_connect_unix_addr", syscall.Connect(fd, &syscall.SockaddrUnix{Name: hostStream}))
		}
		syscall.Close(fd)
	}

	// Listener policy. A listen() with no bind() gets an ephemeral port that
	// Landlock's bind rule never sees; it is a private listener in the
	// namespace and unreachable from outside it (the test checks that).
	if fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0); err == nil {
		if err := syscall.Listen(fd, 1); err != nil {
			set("listen_unbound", err)
		} else if sa, err := syscall.Getsockname(fd); err == nil {
			if in, ok := sa.(*syscall.SockaddrInet4); ok {
				res["listen_unbound"] = fmt.Sprintf("listening:%d", in.Port)
			}
		}
		syscall.Close(fd)
	}

	set("ptrace_attach_launcher", rawErr2(syscall.RawSyscall6(syscall.SYS_PTRACE, 16, uintptr(ppid), 0, 0, 0, 0)))
	set("ptrace_attach_ns_init", rawErr2(syscall.RawSyscall6(syscall.SYS_PTRACE, 16, 1, 0, 0, 0, 0)))
	var iov [2]uintptr
	pvr := uintptr(310)
	io := uintptr(425)
	if archIs("arm64") {
		pvr, io = 270, 425
	}
	set("process_vm_readv_launcher", rawErr2(syscall.RawSyscall6(pvr, uintptr(ppid), uintptr(unsafe.Pointer(&iov[0])), 0, uintptr(unsafe.Pointer(&iov[0])), 0, 0)))
	set("io_uring_setup", rawErr2(syscall.RawSyscall(io, 4, 0, 0)))
	set("unshare_newuser", rawErr2(syscall.RawSyscall(unshareNum(), syscall.CLONE_NEWUSER, 0, 0)))
	set("unshare_newnet", rawErr2(syscall.RawSyscall(unshareNum(), syscall.CLONE_NEWNET, 0, 0)))
	set("unshare_newpid", rawErr2(syscall.RawSyscall(unshareNum(), syscall.CLONE_NEWPID, 0, 0)))
	set("clone3", rawErr2(syscall.RawSyscall(435, 0, 0, 0)))
	cmd := exec.Command("/proc/self/exe", "noop")
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET}
	set("clone_newuser_exec", cmd.Run())
	cmd = exec.Command("/proc/self/exe", "noop")
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWPID}
	set("clone_newpid_exec", cmd.Run())
	if f, err := os.Open("/proc/self/ns/net"); err == nil {
		set("setns_net", rawErr2(syscall.RawSyscall(setnsNum(), f.Fd(), syscall.CLONE_NEWNET, 0)))
		f.Close()
	}
	set("mount_tmpfs", syscall.Mount("none", "/tmp", "tmpfs", 0, ""))
	set("open_launcher_mem_rw", openErr(fmt.Sprintf("/proc/%d/mem", ppid), os.O_RDWR))
	set("signal_launcher", syscall.Kill(ppid, 0))
	set("ptrace_attach_stage0", rawErr2(syscall.RawSyscall6(syscall.SYS_PTRACE, 16, uintptr(gpid), 0, 0, 0, 0)))
	set("open_stage0_mem_rw", openErr(fmt.Sprintf("/proc/%d/mem", gpid), os.O_RDWR))
	set("signal_stage0", syscall.Kill(gpid, 0))
	// The PID namespace's init is the lifetime boundary of the session. The
	// daemon's own SIGKILL does not kill it; the result is whatever the kernel
	// answers, and the init must still be there afterwards.
	set("signal_ns_init_sigkill", syscall.Kill(1, syscall.SIGKILL))
	time.Sleep(100 * time.Millisecond)
	// EPERM (the signal scope) still means the init exists; only ESRCH is gone.
	if e := syscall.Kill(1, 0); e != syscall.ESRCH {
		res["ns_init_alive_after"] = "yes"
	} else {
		res["ns_init_alive_after"] = "no"
	}
	b, _ := json.Marshal(res)
	fmt.Println(string(b))
	return 0
}

// helper implements the small test-only subcommands the matrix drives from
// inside the confinement: a process that holds an unbound listener, and
// processes that try to outlive the session by leaving the process group or
// the session.
func helper(name string, args []string) int {
	switch name {
	case "holdlisten":
		fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
		if err == nil {
			err = syscall.Listen(fd, 1)
		}
		out := map[string]any{}
		if err != nil {
			out["error"] = errName(err)
		} else if sa, gerr := syscall.Getsockname(fd); gerr == nil {
			out["port"] = sa.(*syscall.SockaddrInet4).Port
		}
		b, _ := json.Marshal(out)
		fmt.Println(string(b))
		time.Sleep(10 * time.Minute)
	case "sleeper":
		time.Sleep(10 * time.Minute)
	case "escape":
		if len(args) < 2 {
			return 64
		}
		self, _ := os.Executable()
		var c *exec.Cmd
		switch args[0] {
		case "setsid":
			c = exec.Command(self, "sleeper", args[1])
			c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		case "setpgid":
			c = exec.Command(self, "sleeper", args[1])
			c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		case "double":
			c = exec.Command(self, "escape", "setsid", args[1])
		default:
			return 64
		}
		if err := c.Start(); err != nil {
			fmt.Println(`{"error":"` + errName(err) + `"}`)
			return 1
		}
		fmt.Printf("{\"mode\":%q,\"pid\":%d}\n", args[0], c.Process.Pid)
	}
	return 0
}

func rawErr2(_ uintptr, _ uintptr, e syscall.Errno) error {
	if e != 0 {
		return e
	}
	return nil
}

func openErr(path string, flags int) error {
	f, err := os.OpenFile(path, flags, 0)
	if err == nil {
		f.Close()
		return nil
	}
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err
	}
	return err
}

func archIs(a string) bool { return goarch() == a }

func unshareNum() uintptr {
	if archIs("arm64") {
		return 97
	}
	return 272
}

func setnsNum() uintptr {
	if archIs("arm64") {
		return 268
	}
	return 308
}
