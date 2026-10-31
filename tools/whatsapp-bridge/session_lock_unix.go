//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// Take the same flock as the pairing/capture spawner. Keep the inode after
// release so a contender never locks a replacement file beside an existing lock.
func holdBridgeSessionLock(stateDir string) (func(), error) {
	fd, err := syscall.Open(filepath.Join(stateDir, "bridge.lock"), syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, errors.New("session_lock_failed")
	}
	file := os.NewFile(uintptr(fd), "bridge.lock")
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("session_lock_failed")
	}
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errors.New("session_busy")
		}
		return nil, errors.New("session_lock_failed")
	}
	return func() { _ = file.Close() }, nil
}
