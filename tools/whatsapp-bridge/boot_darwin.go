//go:build darwin

package main

import (
	"strings"
	"syscall"
)

// bootID is this boot's session id, which a pid is unique within (empty when unreadable).
func bootID() string {
	id, err := syscall.Sysctl("kern.bootsessionuuid")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(id)
}
