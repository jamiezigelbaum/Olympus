package main

import (
	"database/sql"
	"go.mau.fi/whatsmeow"
	"os"
	"path/filepath"
	"testing"
)

func TestUpgradePreservesExistingUnpairedMappingState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.db")
	current, err := openSessionContainer(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = current.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	// Recreate the immediately preceding schema: upstream v15 only adds this
	// column. Seed opaque mapping state like the existing unpaired installation.
	for _, statement := range []string{
		"ALTER TABLE whatsmeow_device DROP COLUMN companion_meta_nonce",
		"UPDATE whatsmeow_version SET version=14, compat=8",
		"INSERT INTO whatsmeow_lid_map(lid,pn) VALUES ('fixture-lid','fixture-pn')",
	} {
		if _, err = db.Exec(statement); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	upgraded, err := openSessionContainer(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	db, err = sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version, devices int
	var mapping string
	if err = db.QueryRow("SELECT version FROM whatsmeow_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 15 {
		t.Fatalf("schema version: got %d, want 15", version)
	}
	if err = db.QueryRow("SELECT pn FROM whatsmeow_lid_map WHERE lid='fixture-lid'").Scan(&mapping); err != nil {
		t.Fatal(err)
	}
	if mapping != "fixture-pn" {
		t.Fatal("existing mapping was not preserved")
	}
	if err = db.QueryRow("SELECT count(*) FROM whatsmeow_device").Scan(&devices); err != nil {
		t.Fatal(err)
	}
	if devices != 0 {
		t.Fatal("upgrade must not manufacture a paired device")
	}
}

func TestUnsupportedPasskeyStopsOfferingStaleQR(t *testing.T) {
	for _, event := range []string{whatsmeow.QRChannelEventPasskeyRequest, whatsmeow.QRChannelEventPasskeyResponse} {
		dir := t.TempDir()
		path := filepath.Join(dir, qrFileName)
		if err := os.WriteFile(path, []byte("synthetic QR"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := rejectUnsupportedPairing(event, dir); err == nil {
			t.Fatal("passkey flow must be explicitly refused")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("stale QR must be removed")
		}
	}
	dir := t.TempDir()
	path := filepath.Join(dir, qrFileName)
	if err := os.WriteFile(path, []byte("synthetic QR"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := rejectUnsupportedPairing(whatsmeow.QRChannelEventCode, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("ordinary QR flow must remain available")
	}
}
