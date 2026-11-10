package main

import (
	"errors"
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func approvedFor(t *testing.T, scope string) map[string]struct{} {
	t.Helper()
	t.Setenv(allowedChatsEnv, scope)
	allowed, err := approvedCaptureChats(true)
	if err != nil {
		t.Fatalf("approvedCaptureChats(%q) = %v", scope, err)
	}
	return allowed
}

// #1075: a one-to-one chat started after pairing is read when One-to-one is
// on, and not when only single chats were picked.
func TestKindGrantReadsANewOneToOneChatAndPickedChatsDoNot(t *testing.T) {
	newChat := types.NewJID("15550001111", types.DefaultUserServer)
	newLidChat := types.NewJID("987654321", types.HiddenUserServer)
	byKind := approvedFor(t, "kind:dm")
	if !captureAllowed(newChat, byKind, nil) || !captureAllowed(newLidChat, byKind, nil) {
		t.Fatal("a one-to-one chat started later was not read with One-to-one on")
	}
	if captureAllowed(types.NewJID("120363000000000001", types.GroupServer), byKind, nil) {
		t.Fatal("a group was read with only One-to-one on")
	}
	picked := approvedFor(t, "15550002222@s.whatsapp.net")
	if captureAllowed(newChat, picked, nil) {
		t.Fatal("a new one-to-one chat was read when only single chats were picked")
	}
	if !captureAllowed(types.NewJID("15550002222", types.DefaultUserServer), picked, nil) {
		t.Fatal("the picked chat was not read")
	}
}

func TestKindGrantTellsCommunitiesFromGroupsAndFailsClosed(t *testing.T) {
	plain := types.NewJID("120363000000000001", types.GroupServer)
	inCommunity := types.NewJID("120363000000000002", types.GroupServer)
	lookups := 0
	lookup := func(chat types.JID) (bool, error) {
		lookups++
		if chat == inCommunity {
			return true, nil
		}
		if chat == plain {
			return false, nil
		}
		return false, errors.New("offline")
	}
	groups := approvedFor(t, "kind:group")
	if !captureAllowed(plain, groups, lookup) || captureAllowed(inCommunity, groups, lookup) {
		t.Fatal("Groups on must read plain groups and not community groups")
	}
	communities := approvedFor(t, "kind:community")
	if captureAllowed(plain, communities, lookup) || !captureAllowed(inCommunity, communities, lookup) {
		t.Fatal("Communities on must read community groups and not plain groups")
	}
	unknown := types.NewJID("120363000000000003", types.GroupServer)
	if captureAllowed(unknown, groups, lookup) || captureAllowed(unknown, communities, lookup) || captureAllowed(plain, groups, nil) {
		t.Fatal("a group whose community membership is unknown must not be read")
	}
	before := lookups
	both := approvedFor(t, "kind:group,kind:community")
	if !captureAllowed(unknown, both, lookup) || lookups != before {
		t.Fatal("with Groups and Communities on, every group is read without asking WhatsApp")
	}
}

func TestStatusBroadcastIsNeverMatchedByAKind(t *testing.T) {
	allowed := approvedFor(t, "kind:dm,kind:group,kind:community")
	if captureAllowed(types.StatusBroadcastJID, allowed, func(types.JID) (bool, error) { return true, nil }) {
		t.Fatal("status broadcast matched a kind")
	}
	if chatCaptureAllowed("status@broadcast", allowed) {
		t.Fatal("status broadcast matched a kind by string")
	}
}

func TestKindTokensAreValidatedStrictly(t *testing.T) {
	for _, scope := range []string{"kind:", "kind:channel", "kind:bot", "kind:DM", "kinds:dm", "kind:dm:x", "kind:*"} {
		t.Setenv(allowedChatsEnv, scope)
		if _, err := approvedCaptureChats(true); err == nil || err.Error() != "invalid_approved_chat_scope" {
			t.Fatalf("approvedCaptureChats(%q) error = %v", scope, err)
		}
	}
	mixed := approvedFor(t, "kind:group, 15550002222@s.whatsapp.net")
	if _, ok := mixed["kind:group"]; !ok || len(mixed) != 2 {
		t.Fatalf("mixed scope = %v", mixed)
	}
}

func TestCommunityCacheAsksOncePerGroupAndRetriesFailures(t *testing.T) {
	group := types.NewJID("120363000000000009", types.GroupServer)
	calls := 0
	fail := true
	cache := newCommunityCache(func(types.JID) (*types.GroupInfo, error) {
		calls++
		if fail {
			return nil, errors.New("offline")
		}
		info := &types.GroupInfo{}
		info.LinkedParentJID = types.NewJID("120363000000000010", types.GroupServer)
		return info, nil
	})
	if _, err := cache.isCommunity(group); err == nil {
		t.Fatal("a failed lookup answered")
	}
	fail = false
	for i := 0; i < 3; i++ {
		if yes, err := cache.isCommunity(group); err != nil || !yes {
			t.Fatalf("isCommunity = %v, %v", yes, err)
		}
	}
	if calls != 2 {
		t.Fatalf("lookups = %d, want 2 (one failure, then one remembered answer)", calls)
	}
}

func TestChatListReportsCommunities(t *testing.T) {
	plain := &types.GroupInfo{JID: types.NewJID("120363000000000001", types.GroupServer)}
	plain.Name = "Plain"
	parent := &types.GroupInfo{JID: types.NewJID("120363000000000002", types.GroupServer)}
	parent.Name = "Neighbours"
	parent.IsParent = true
	linked := &types.GroupInfo{JID: types.NewJID("120363000000000003", types.GroupServer)}
	linked.Name = "Neighbours: announcements"
	linked.LinkedParentJID = parent.JID
	kinds := map[string]string{}
	for _, dialog := range chatListReceipt(nil, []*types.GroupInfo{plain, parent, linked}).Dialogs {
		kinds[dialog.Title] = dialog.Kind
	}
	if kinds["Plain"] != "group" || kinds["Neighbours"] != "community" || kinds["Neighbours: announcements"] != "community" {
		t.Fatalf("kinds = %v", kinds)
	}
}
