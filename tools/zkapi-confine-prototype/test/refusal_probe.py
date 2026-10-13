# Read-only refusal probe: the same steps the launcher takes to build its
# namespace (new user+network namespace, identity uid map, loopback up),
# done with stock python3 and nothing written to disk.
import ctypes, os, sys, fcntl, struct, socket, json
libc = ctypes.CDLL(None, use_errno=True)
CLONE_NEWUSER, CLONE_NEWNET = 0x10000000, 0x40000000
def sysctl(p):
    try: return open(p).read().strip()
    except Exception as e: return "unreadable"
def label():
    try: return open("/proc/self/attr/current").read().strip()
    except Exception: return "n/a"
def capeff():
    for l in open("/proc/self/status"):
        if l.startswith("CapEff"): return l.split()[1]
out = {"host_label_before": label(), "restrict_sysctl": sysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")}
r, w = os.pipe()
pid = os.fork()
if pid == 0:
    res = {}
    uid, gid = os.getuid(), os.getgid()
    rc = libc.unshare(CLONE_NEWUSER | CLONE_NEWNET)
    res["unshare_newuser_newnet"] = "ok" if rc == 0 else "errno %d" % ctypes.get_errno()
    res["label_in_namespace"] = label()
    res["cap_eff_in_namespace"] = capeff()
    for name, content in (("setgroups", "deny"), ("uid_map", "%d %d 1" % (uid, uid)), ("gid_map", "%d %d 1" % (gid, gid))):
        try:
            open("/proc/self/" + name, "w").write(content); res["write_" + name] = "ok"
        except Exception as e:
            res["write_" + name] = "%s" % (e.strerror or e)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        ifr = struct.pack("16sH22x", b"lo", 0)
        flags = struct.unpack("16sH22x", fcntl.ioctl(s, 0x8913, ifr))[1]
        fcntl.ioctl(s, 0x8914, struct.pack("16sH22x", b"lo", flags | 1))
        res["loopback_up"] = "ok"
    except Exception as e:
        res["loopback_up"] = "%s" % (e.strerror or e)
    os.write(w, json.dumps(res).encode()); os._exit(0)
os.waitpid(pid, 0)
out.update(json.loads(os.read(r, 65536).decode()))
out["verdict"] = "namespace usable" if out.get("loopback_up") == "ok" and out.get("write_uid_map") == "ok" else "REFUSE: namespace_unavailable"
print(json.dumps(out, indent=2))
