package main

// Pairing's history sync (#852). WhatsApp sends a newly linked device recent
// history as history-sync notifications. Their blobs are deleted from the
// server once downloaded, so a notification nobody handles is history lost.
//
// - The capture daemon turns each HistorySync event into spool lines for the
//   chats the owner allowed, exactly like live messages.
// - The pair-only run exits seconds after pairing, before the owner has chosen
//   chats. It downloads nothing: it keeps each notification in the private
//   state dir, and the capture daemon reads them at its next start, with the
//   owner's chat choice in force.

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const (
	historyPendingDir = "history-pending"
	// A kept notification whose blob is still unreadable after this long is
	// gone from WhatsApp's servers; stop retrying it.
	historyPendingMaxAge = 7 * 24 * time.Hour
)

// historyMessageParser is the one SDK call history capture needs, so tests can
// stand in for the client.
type historyMessageParser func(chat types.JID, msg *waHistorySync.HistorySyncMsg) (*events.Message, bool)

func clientHistoryParser(client *whatsmeow.Client) historyMessageParser {
	return func(chat types.JID, msg *waHistorySync.HistorySyncMsg) (*events.Message, bool) {
		web := msg.GetMessage()
		if web == nil {
			return nil, false
		}
		evt, err := client.ParseWebMessage(chat, web)
		return evt, err == nil && evt != nil
	}
}

// captureHistorySync spools every message of an allowed chat in one history
// blob and returns how many were spooled. Out-of-scope chats are skipped
// before any parsing, by the same rule and community lookup live messages use.
func captureHistorySync(data *waHistorySync.HistorySync, allowed map[string]struct{}, isCommunity communityLookup, parse historyMessageParser, record func(*events.Message) (spoolRecord, bool), spool func(spoolRecord)) int {
	spooled := 0
	for _, conversation := range data.GetConversations() {
		chat, err := types.ParseJID(conversation.GetID())
		if err != nil || chat.IsEmpty() || !captureAllowed(chat, allowed, isCommunity) {
			continue
		}
		for _, msg := range conversation.GetMessages() {
			evt, ok := parse(chat, msg)
			if !ok {
				continue
			}
			if rec, ok := record(evt); ok {
				spool(rec)
				spooled++
			}
		}
	}
	return spooled
}

func spoolHistorySync(ctx context.Context, client *whatsmeow.Client, audioStore *audioMediaStore, writer *spoolWriter, allowed map[string]struct{}, data *waHistorySync.HistorySync) {
	n := captureHistorySync(data, allowed, communityLookupFor(ctx, client), clientHistoryParser(client),
		func(evt *events.Message) (spoolRecord, bool) { return recordFromMessage(ctx, client, audioStore, evt) },
		writer.enqueueWait)
	log.Printf("olympus-whatsapp-bridge: history sync (%s, chunk %d): %d messages from allowed chats", data.GetSyncType(), data.GetChunkOrder(), n)
}

// historySyncNotificationOf is the history-sync notification a message carries,
// if any. Only the owner's own device sends them.
func historySyncNotificationOf(evt *events.Message) *waE2E.HistorySyncNotification {
	if evt == nil || !evt.Info.IsFromMe {
		return nil
	}
	msg := evt.Message
	if inner := msg.GetDeviceSentMessage().GetMessage(); inner != nil {
		msg = inner
	}
	return msg.GetProtocolMessage().GetHistorySyncNotification()
}

// keepHistorySyncNotification writes one notification to the private state
// dir (0700, like the session store, which holds the same kind of keys).
func keepHistorySyncNotification(stateDir, messageID string, notif *waE2E.HistorySyncNotification) error {
	dir := filepath.Join(stateDir, historyPendingDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := proto.Marshal(notif)
	if err != nil {
		return err
	}
	name := safeHistoryFileName(messageID)
	tmp := filepath.Join(dir, "."+name+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, name))
}

func safeHistoryFileName(messageID string) string {
	var b strings.Builder
	for _, r := range messageID {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		b.WriteString("notification")
	}
	return b.String() + ".pb"
}

type keptHistoryNotification struct {
	path  string
	notif *waE2E.HistorySyncNotification
	age   time.Duration
}

func readKeptHistoryNotifications(stateDir string, now time.Time) []keptHistoryNotification {
	dir := filepath.Join(stateDir, historyPendingDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var kept []keptHistoryNotification
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".pb") || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		var notif waE2E.HistorySyncNotification
		if err != nil || proto.Unmarshal(data, &notif) != nil {
			_ = os.Remove(path)
			continue
		}
		age := time.Duration(0)
		if info, err := entry.Info(); err == nil {
			age = now.Sub(info.ModTime())
		}
		kept = append(kept, keptHistoryNotification{path: path, notif: &notif, age: age})
	}
	return kept
}

// drainKeptHistory reads what the pair-only run kept. A blob that downloads is
// spooled and deleted from the server; one that fails is retried at the next
// start until it is a week old.
func drainKeptHistory(ctx context.Context, client *whatsmeow.Client, audioStore *audioMediaStore, writer *spoolWriter, allowed map[string]struct{}, stateDir string) {
	for _, kept := range readKeptHistoryNotifications(stateDir, time.Now()) {
		data, err := client.DownloadHistorySync(ctx, kept.notif, false)
		if err != nil {
			log.Printf("olympus-whatsapp-bridge: kept history sync could not be read yet (%v)", err)
			if kept.age > historyPendingMaxAge {
				_ = os.Remove(kept.path)
			}
			continue
		}
		spoolHistorySync(ctx, client, audioStore, writer, allowed, data)
		if kept.notif.InitialHistBootstrapInlinePayload == nil {
			_ = client.DeleteMedia(ctx, whatsmeow.MediaHistory, kept.notif.GetDirectPath(), kept.notif.GetFileEncSHA256(), kept.notif.GetEncHandle())
		}
		_ = os.Remove(kept.path)
	}
}

// enqueueWait spools a history line without dropping it: history arrives in
// its own goroutine, never on the live event loop, so it may wait for room.
func (w *spoolWriter) enqueueWait(rec spoolRecord) {
	w.records <- rec
}

// keepHistoryForCapture makes a short-lived connection (pairing, listing
// chats) keep history-sync notifications instead of downloading and deleting
// their blobs, which would lose that history before capture runs.
func keepHistoryForCapture(client *whatsmeow.Client, stateDir string) {
	client.ManualHistorySyncDownload = true
	client.AddEventHandler(func(raw any) {
		evt, ok := raw.(*events.Message)
		if !ok {
			return
		}
		if notif := historySyncNotificationOf(evt); notif != nil {
			if err := keepHistorySyncNotification(stateDir, string(evt.Info.ID), notif); err != nil {
				log.Printf("olympus-whatsapp-bridge: could not keep a history sync for capture (%v)", err)
			}
		}
	})
}
