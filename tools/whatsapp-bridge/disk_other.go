//go:build !linux && !darwin

package main

import "errors"

// volumeSpace is unknown here: the floor cannot be checked, so downloads are never paused for it.
func volumeSpace(string) (uint64, uint64, error) {
	return 0, 0, errors.New("volume space is not known on this system")
}
