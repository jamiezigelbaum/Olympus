#!/usr/bin/env python3
"""Review PR 407 attacker model: an unprivileged local account fills every ephemeral port on ::1 with ordinary
outbound connections to its own listener. No privilege, no bind of the bridge's port. Prints one line per phase.
Usage: review-407-exhaust.py <ready-file>   (keeps running until killed)"""
import os, resource, socket, sys, time

ready = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'connect'   # 'connect' keeps browser connects possible; 'bind' blocks them
lo, hi = map(int, open('/proc/sys/net/ipv4/ip_local_port_range').read().split())
n = hi - lo + 1
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
try:
    resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
except Exception as e:
    print('setrlimit failed', e)
print('nofile', resource.getrlimit(resource.RLIMIT_NOFILE), 'port range', lo, hi, 'ports', n, flush=True)

held = []
if mode == 'bind':
    for p in range(lo, hi + 1):
        s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        try:
            s.bind(('::', p)); held.append(s)
        except OSError:
            s.close()
    print('bind mode holds', len(held), flush=True)
else:
    # Server in a child process (its own fd table), clients in this process.
    srv = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('::1', 0)); srv.listen(65535)
    lport = srv.getsockname()[1]
    if os.fork() == 0:
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
        except Exception:
            pass
        accepted = []
        while True:
            try:
                c, _ = srv.accept(); accepted.append(c)
            except OSError:
                time.sleep(0.01)
    # parent: dial until the kernel runs out of source ports for this destination
    fails = 0
    while len(held) < n + 10 and fails < 5:
        c = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        c.setblocking(True); c.settimeout(2)
        try:
            c.connect(('::1', lport)); held.append(c); fails = 0
        except OSError as e:
            fails += 1; c.close()
    print('connect mode holds', len(held), 'of', n, flush=True)

open(ready, 'w').write(str(len(held)))
while True:
    time.sleep(60)
