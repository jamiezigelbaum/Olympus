//go:build linux || darwin

package main

import "syscall"

// volumeSpace is the free space a non-root writer has, and the size, of the volume holding dir.
func volumeSpace(dir string) (free uint64, total uint64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dir, &stat); err != nil {
		return 0, 0, err
	}
	block := uint64(stat.Bsize)
	return stat.Bavail * block, stat.Blocks * block, nil
}
