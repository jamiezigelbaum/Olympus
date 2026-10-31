//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/store/sqlstore"
)

func TestListChatsHeldSessionLockPreventsDatabaseOpenAndConnection(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv(stateDirEnv, stateDir)
	// Invalid database bytes prove the locked refusal precedes opening/migrating it.
	if err := os.WriteFile(filepath.Join(stateDir, sessionDBName), []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := holdBridgeSessionLock(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	called := false
	err = run([]string{"--list-chats"}, bridgeDeps{listChats: func(_ string, _ *sqlstore.Container) error { called = true; return nil }})
	if err == nil || err.Error() != "session_busy" || called {
		t.Fatalf("err=%v called=%v", err, called)
	}
}

func TestListChatsReleasesSessionLockAfterFailure(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv(stateDirEnv, stateDir)
	container, err := openSessionContainer(filepath.Join(stateDir, sessionDBName))
	if err != nil {
		t.Fatal(err)
	}
	container.Close()
	wanted := errors.New("listing_failed")
	err = run([]string{"--list-chats"}, bridgeDeps{listChats: func(_ string, _ *sqlstore.Container) error {
		release, lockErr := holdBridgeSessionLock(stateDir)
		if release != nil {
			release()
		}
		if lockErr == nil || lockErr.Error() != "session_busy" {
			t.Fatalf("listing did not own session lock: %v", lockErr)
		}
		return wanted
	}})
	if !errors.Is(err, wanted) {
		t.Fatal(err)
	}
	release, err := holdBridgeSessionLock(stateDir)
	if err != nil {
		t.Fatalf("listing left lock held: %v", err)
	}
	release()
}

func TestBridgeSessionLockRefusesSymlink(t *testing.T) {
	stateDir := t.TempDir()
	target := filepath.Join(stateDir, "target")
	if err := os.WriteFile(target, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(stateDir, "bridge.lock")); err != nil {
		t.Fatal(err)
	}
	release, err := holdBridgeSessionLock(stateDir)
	if release != nil {
		release()
	}
	if err == nil || err.Error() != "session_lock_failed" {
		t.Fatalf("symlink lock accepted: %v", err)
	}
}
