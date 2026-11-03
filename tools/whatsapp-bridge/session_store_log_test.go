package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

// Mark's 1.3.0 pairing: listing joined groups stores each member's redacted
// phone, and a member in two groups makes the store warn about duplicates. That
// warning must never reach stdout, which carries --list-chats' JSON.
func TestSessionStoreWarningsStayOffStdout(t *testing.T) {
	container, err := openSessionContainer(filepath.Join(t.TempDir(), "session.db"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	device := container.NewDevice()
	jid := types.NewJID("15550000001", types.DefaultUserServer)
	device.ID = &jid
	device.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte{1}, AccountSignature: make([]byte, 64), AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64)}
	if err := container.PutDevice(ctx, device); err != nil {
		t.Fatal(err)
	}

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = write
	member := types.NewJID("123456789", types.HiddenUserServer)
	putErr := device.Contacts.PutManyRedactedPhones(ctx, []store.RedactedPhoneEntry{
		{JID: member, RedactedPhone: "+1∙∙∙∙∙∙∙∙01"},
		{JID: member, RedactedPhone: "+1∙∙∙∙∙∙∙∙01"},
	})
	os.Stdout = stdout
	write.Close()
	printed, _ := io.ReadAll(read)
	if putErr != nil {
		t.Fatal(putErr)
	}
	if len(printed) != 0 {
		t.Fatalf("store wrote to stdout: %q", printed)
	}
}

func TestStderrWarnLoggerKeepsWarningsAndDropsInfo(t *testing.T) {
	var out strings.Builder
	logger := stderrWarnLogger{w: &out, module: "Database"}
	logger.Infof("quiet %d", 1)
	logger.Debugf("quiet")
	logger.Sub("Upgrade").Warnf("%d duplicate contacts", 2)
	logger.Errorf("broken")
	if got := out.String(); got != "[Database/Upgrade WARN] 2 duplicate contacts\n[Database ERROR] broken\n" {
		t.Fatalf("unexpected log: %q", got)
	}
}
