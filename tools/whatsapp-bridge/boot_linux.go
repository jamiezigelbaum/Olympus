//go:build linux

package main

import (
	"os"
	"strings"
)

// bootID is this boot's id, which a pid is unique within (empty when unreadable).
func bootID() string {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
