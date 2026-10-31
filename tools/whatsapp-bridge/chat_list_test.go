package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
)

func TestChatListIncludesContactsAndGroupsWithoutCap(t *testing.T) {
	contacts := map[types.JID]types.ContactInfo{}
	for n := 1; n <= 225; n++ {
		contacts[types.NewJID(strconv.FormatInt(15550000000+int64(n), 10), types.DefaultUserServer)] = types.ContactInfo{FullName: "Contact"}
	}
	contacts[types.NewJID("invalid\nuser", types.DefaultUserServer)] = types.ContactInfo{FullName: "Excluded"}
	contacts[types.NewJID("status", "broadcast")] = types.ContactInfo{FullName: "Excluded"}
	contacts[types.NewJID("", types.DefaultUserServer)] = types.ContactInfo{FullName: "Excluded"}
	groups := []*types.GroupInfo{{JID: types.NewJID("120363123456789012", types.GroupServer), GroupName: types.GroupName{Name: "Group\nName"}}, nil}
	receipt := chatListReceipt(contacts, groups)
	if receipt.Event != "dialogs" || receipt.Coverage != "contacts_and_joined_groups" || len(receipt.Dialogs) != 226 {
		t.Fatalf("receipt = %#v", receipt)
	}
	for _, dialog := range receipt.Dialogs {
		if dialog.ChatScope == "whatsapp.personal:chat:120363123456789012@g.us" && (dialog.Title != "Group Name" || dialog.Kind != "group") {
			t.Fatalf("group = %#v", dialog)
		}
	}
}

func TestListChatsRejectsUnpairedSessionWithoutConnecting(t *testing.T) {
	container, err := openSessionContainer(filepath.Join(t.TempDir(), sessionDBName))
	if err != nil {
		t.Fatal(err)
	}
	defer container.Close()
	if err = runListChatsMode(context.Background(), container); err == nil || err.Error() != "session_not_paired" {
		t.Fatalf("err = %v", err)
	}
}

func TestListChatsDispatchDoesNotCaptureOrCreateSpool(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv(stateDirEnv, stateDir)
	t.Setenv(nativeCaptureEnv, "true")
	t.Setenv(instanceIDEnv, "invalid-but-irrelevant")
	// Seed an existing database: listing must never create a fresh linked-device store.
	container, err := openSessionContainer(filepath.Join(stateDir, sessionDBName))
	if err != nil {
		t.Fatal(err)
	}
	container.Close()
	calls := 0
	err = run([]string{"--list-chats"}, bridgeDeps{listChats: func(_ string, _ *sqlstore.Container) error { calls++; return nil }})
	if err != nil || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	if _, err = os.Stat(filepath.Join(stateDir, spoolDirName)); !os.IsNotExist(err) {
		t.Fatalf("listing created a spool: %v", err)
	}
}

func TestListChatsRequiresExistingStoreAndExclusiveMode(t *testing.T) {
	t.Setenv(stateDirEnv, t.TempDir())
	for _, args := range [][]string{{"--list-chats", "--pair-only"}, {"--list-chats", "--capture-approved"}} {
		if err := run(args, bridgeDeps{}); err == nil || err.Error() != "incompatible_modes" {
			t.Fatalf("args=%v err=%v", args, err)
		}
	}
	if err := run([]string{"--list-chats"}, bridgeDeps{}); err == nil || err.Error() != "session_not_paired" {
		t.Fatalf("missing store err=%v", err)
	}
}
