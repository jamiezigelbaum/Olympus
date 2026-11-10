package main

import (
	"testing"

	"go.mau.fi/whatsmeow/store"
)

func TestNewerWAVersionOnlyMovesForward(t *testing.T) {
	pinned := store.WAVersionContainer{2, 3000, 1027000000}
	cases := []struct {
		candidate store.WAVersionContainer
		want      bool
	}{
		{store.WAVersionContainer{2, 3000, 1029000000}, true},
		{store.WAVersionContainer{2, 3001, 0}, true},
		{pinned, false},
		{store.WAVersionContainer{2, 2999, 1099999999}, false},
		{store.WAVersionContainer{}, false},
	}
	for _, c := range cases {
		if got := newerWAVersion(c.candidate, pinned); got != c.want {
			t.Fatalf("newerWAVersion(%v) = %v, want %v", c.candidate, got, c.want)
		}
	}
}
