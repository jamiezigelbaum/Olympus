//go:build !linux && !darwin

package main

// bootID is unknown here: a temp's writer is then told only by its pid.
func bootID() string { return "" }
