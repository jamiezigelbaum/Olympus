//go:build !darwin && !linux

package main

import "errors"

func holdBridgeSessionLock(_ string) (func(), error) {
	return nil, errors.New("session_lock_unsupported")
}
