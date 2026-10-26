package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func captionEvent(id string, message *waE2E.Message) *events.Message {
	chat := types.JID{User: "15551234567", Server: types.DefaultUserServer}
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: chat},
			ID:            types.MessageID(id),
			Timestamp:     time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC),
		},
		Message: message,
	}
}

func TestRecordFromMessageKeepsMediaCaptions(t *testing.T) {
	cases := []struct {
		name      string
		message   *waE2E.Message
		mediaType string
	}{
		{"image", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("the harbour at dusk")}}, "image"},
		{"video", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Caption: proto.String("the harbour at dusk")}}, "video"},
		{"video note", &waE2E.Message{PtvMessage: &waE2E.VideoMessage{Caption: proto.String("the harbour at dusk")}}, "video_note"},
		{"document", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{Caption: proto.String("the harbour at dusk")}}, "document"},
		{"wrapped document", &waE2E.Message{DocumentWithCaptionMessage: &waE2E.FutureProofMessage{
			Message: &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{Caption: proto.String("the harbour at dusk")}},
		}}, "document"},
	}
	for _, tc := range cases {
		rec, ok := recordFromMessage(context.Background(), nil, nil, captionEvent("cap-"+tc.mediaType, tc.message))
		if !ok {
			t.Fatalf("%s: the captioned message did not reach the spool", tc.name)
		}
		if rec.Text != "the harbour at dusk" || rec.MediaType != tc.mediaType {
			t.Fatalf("%s: text=%q media=%q", tc.name, rec.Text, rec.MediaType)
		}
	}
}

func TestRecordFromMessageMediaWithoutCaptionKeepsEmptyText(t *testing.T) {
	rec, ok := recordFromMessage(context.Background(), nil, nil, captionEvent("plain-photo", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	if !ok || rec.Text != "" || rec.MediaType != "image" {
		t.Fatalf("ok=%v rec=%#v", ok, rec)
	}
}

func TestCaptionMentionsAreResolved(t *testing.T) {
	message := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:     proto.String("look @98765430001111"),
		ContextInfo: &waE2E.ContextInfo{MentionedJID: []string{"98765430001111@lid"}},
	}}
	if got := mentionedJIDsFromMessage(message); len(got) != 1 || got[0] != "98765430001111@lid" {
		t.Fatalf("caption mentions = %v", got)
	}
}

func readCaptureStatus(t *testing.T, spoolDir string) captureStatusReceipt {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(spoolDir, captureStatusName))
	if err != nil {
		t.Fatalf("capture status receipt: %v", err)
	}
	var receipt captureStatusReceipt
	if err := json.Unmarshal(raw, &receipt); err != nil {
		t.Fatalf("capture status receipt %q: %v", raw, err)
	}
	return receipt
}

func TestFullSpoolQueueCountsEachDroppedMessage(t *testing.T) {
	spoolDir := t.TempDir()
	// A writer that is never run: its queue fills and stays full.
	writer := newSpoolWriter(spoolDir)
	for i := 0; i < spoolQueueSize+3; i++ {
		writer.enqueue(spoolRecord{ID: "m"})
	}
	writer.status.write()
	receipt := readCaptureStatus(t, spoolDir)
	if receipt.DroppedMessages != 3 || receipt.LastDroppedAt == "" {
		t.Fatalf("receipt = %#v, want 3 drops with a time", receipt)
	}

	// A restart carries the count instead of resetting it.
	restarted := newSpoolWriter(spoolDir)
	restarted.status.recordDrop()
	restarted.status.write()
	if got := readCaptureStatus(t, spoolDir).DroppedMessages; got != 4 {
		t.Fatalf("after restart dropped = %d, want 4", got)
	}
}

func TestCaptureStatusTellsConnectedCaptureFromStopped(t *testing.T) {
	spoolDir := t.TempDir()
	clock := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	status := newCaptureStatus(spoolDir)
	status.now = func() time.Time { return clock }

	status.write()
	if receipt := readCaptureStatus(t, spoolDir); receipt.Connected || receipt.ConnectedThrough != "" {
		t.Fatalf("never connected, receipt = %#v", receipt)
	}

	status.setConnected(true)
	clock = clock.Add(10 * time.Minute)
	status.write()
	receipt := readCaptureStatus(t, spoolDir)
	if !receipt.Connected || receipt.ConnectedThrough != "2026-10-25T09:10:00Z" {
		t.Fatalf("connected heartbeat, receipt = %#v", receipt)
	}

	clock = clock.Add(5 * time.Minute)
	status.setConnected(false)
	clock = clock.Add(time.Hour)
	status.write()
	receipt = readCaptureStatus(t, spoolDir)
	if receipt.Connected || receipt.ConnectedThrough != "2026-10-25T09:15:00Z" || receipt.UpdatedAt != "2026-10-25T10:15:00Z" {
		t.Fatalf("after disconnect, receipt = %#v", receipt)
	}
}

func TestCaptureStatusCarriesNoIdentifiers(t *testing.T) {
	spoolDir := t.TempDir()
	writer := newSpoolWriter(spoolDir)
	go writer.run()
	handleEvent(context.Background(), nil, nil, writer, make(chan string, 1), nil, nil, &events.Connected{})
	handleEvent(context.Background(), nil, nil, writer, make(chan string, 1), nil, nil, captionEvent("x-1", &waE2E.Message{Conversation: proto.String("hello there")}))
	writer.close()
	raw, err := os.ReadFile(filepath.Join(spoolDir, captureStatusName))
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"15551234567", "hello", "x-1"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("capture status receipt carries %q: %s", leak, raw)
		}
	}
	var receipt captureStatusReceipt
	if err := json.Unmarshal(raw, &receipt); err != nil || receipt.Kind != captureStatusKind || receipt.Connected || receipt.ConnectedThrough == "" {
		t.Fatalf("final receipt = %s (%v)", raw, err)
	}
	files, _ := filepath.Glob(filepath.Join(spoolDir, "*.jsonl"))
	if len(files) != 1 {
		t.Fatalf("spool files = %v", files)
	}
}
