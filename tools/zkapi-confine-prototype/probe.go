package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
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
func probe(targets []string) int {
	res := map[string]string{}
	// targets: the launcher's own pids (stage1, stage0) the caller names; the
	// daemon-side parent is the caller itself and is not a launcher process.
	pids := []int{}
	for _, t := range targets {
		var n int
		if _, err := fmt.Sscanf(t, "%d", &n); err == nil && n > 1 {
			pids = append(pids, n)
		}
	}
	for len(pids) < 2 {
		pids = append(pids, 1)
	}
	ppid, gpid := pids[0], pids[1]
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
	if fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0); err == nil {
		syscall.Close(fds[0])
		syscall.Close(fds[1])
		res["socketpair_unix"] = "ok"
	} else {
		set("socketpair_unix", err)
	}
	set("ptrace_attach_launcher", rawErr2(syscall.RawSyscall6(syscall.SYS_PTRACE, 16, uintptr(ppid), 0, 0, 0, 0)))
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
	set("clone3", rawErr2(syscall.RawSyscall(435, 0, 0, 0)))
	cmd := exec.Command("/proc/self/exe", "noop")
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET}
	set("clone_newuser_exec", cmd.Run())
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
	b, _ := json.Marshal(res)
	fmt.Println(string(b))
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

