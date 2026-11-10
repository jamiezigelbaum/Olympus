package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func historyConversation(chat string, ids ...string) *waHistorySync.Conversation {
	conv := &waHistorySync.Conversation{ID: proto.String(chat)}
	for _, id := range ids {
		conv.Messages = append(conv.Messages, &waHistorySync.HistorySyncMsg{Message: &waWeb.WebMessageInfo{
			Key:     &waCommon.MessageKey{ID: proto.String(id)},
			Message: &waE2E.Message{Conversation: proto.String("hello " + id)},
		}})
	}
	return conv
}

func TestHistorySyncSpoolsOnlyAllowedChats(t *testing.T) {
	allowedChat := "351910000001@s.whatsapp.net"
	data := &waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{
		historyConversation(allowedChat, "a1", "a2"),
		historyConversation("120363000000000009@g.us", "g1"),
		historyConversation("", "x1"),
	}}
	parse := func(chat types.JID, msg *waHistorySync.HistorySyncMsg) (*events.Message, bool) {
		web := msg.GetMessage()
		evt := &events.Message{Message: web.GetMessage()}
		evt.Info.Chat = chat
		evt.Info.ID = types.MessageID(web.GetKey().GetID())
		return evt, true
	}
	var spooled []spoolRecord
	record := func(evt *events.Message) (spoolRecord, bool) {
		return spoolRecord{ID: string(evt.Info.ID), ChatJID: evt.Info.Chat.String(), Text: evt.Message.GetConversation()}, true
	}
	n := captureHistorySync(data, map[string]struct{}{allowedChat: {}}, parse, record, func(rec spoolRecord) { spooled = append(spooled, rec) })
	if n != 2 || len(spooled) != 2 || spooled[0].ID != "a1" || spooled[1].ChatJID != allowedChat {
		t.Fatalf("history spooled %d: %+v", n, spooled)
	}
	// All chats allowed: the group comes in too; a conversation with no id never does.
	spooled = nil
	if n := captureHistorySync(data, map[string]struct{}{"*": {}}, parse, record, func(rec spoolRecord) { spooled = append(spooled, rec) }); n != 3 {
		t.Fatalf("all-chats history spooled %d, want 3", n)
	}
}

func TestHistorySyncNotificationIsKeptForCapture(t *testing.T) {
	stateDir := t.TempDir()
	notif := &waE2E.HistorySyncNotification{DirectPath: proto.String("/v/t62/history"), FileEncSHA256: []byte{1, 2, 3}}
	evt := &events.Message{Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{HistorySyncNotification: notif}}}
	if historySyncNotificationOf(evt) != nil {
		t.Fatal("a notification not sent by the owner's own device must be ignored")
	}
	evt.Info.IsFromMe = true
	got := historySyncNotificationOf(evt)
	if got == nil {
		t.Fatal("the owner's history-sync notification was not recognised")
	}
	if err := keepHistorySyncNotification(stateDir, "3EB0/../x", got); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(stateDir, historyPendingDir, "3EB0x.pb"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("kept notification: %v %v", info, err)
	}
	kept := readKeptHistoryNotifications(stateDir, time.Now())
	if len(kept) != 1 || kept[0].notif.GetDirectPath() != "/v/t62/history" {
		t.Fatalf("read back %+v", kept)
	}
}
