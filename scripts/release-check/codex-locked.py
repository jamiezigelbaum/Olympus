#!/usr/bin/env python3
"""Keep the copied Codex login exclusive until any refresh is written back."""
import fcntl
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

real, scoped, timeout, *command = sys.argv[1:]
lock_path = os.path.join(os.path.dirname(real), '.release-check-codex.lock')
# The inode is intentionally never removed: unlinking it can split waiters into
# separate locks. The kernel releases a crashed holder's lock automatically.
with open(lock_path, 'a') as lock:
    os.chmod(lock_path, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    shutil.copyfile(real, scoped)
    os.chmod(scoped, 0o600)
    def digest(path):
        with open(path, 'rb') as source:
            return hashlib.sha256(source.read()).digest()
    original = digest(scoped)
    try:
        # Inherit the lock so a killed supervisor cannot release it while Codex
        # is still using the copied token.
        result = subprocess.run(command, timeout=float(timeout), pass_fds=(lock.fileno(),))
        code = result.returncode
    except subprocess.TimeoutExpired:
        code = 124
    if digest(scoped) != original and os.path.exists(real) and digest(real) == original:
        fd, staged = tempfile.mkstemp(prefix='.release-check-auth-', dir=os.path.dirname(real))
        try:
            with os.fdopen(fd, 'wb') as target, open(scoped, 'rb') as source:
                shutil.copyfileobj(source, target)
            os.replace(staged, real)
        finally:
            if os.path.exists(staged):
                os.unlink(staged)
    sys.exit(code if code >= 0 else 1)
