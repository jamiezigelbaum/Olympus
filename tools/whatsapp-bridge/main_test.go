package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func TestOperationalLogsDoNotExposeWhatsAppIdentifiers(t *testing.T) {
	line := existingSessionConnectedLogLine()
	for _, sensitive := range []string{"15551230003", "@s.whatsapp.net", "@lid"} {
		if strings.Contains(line, sensitive) {
			t.Fatalf("operational log contains identifier %q: %q", sensitive, line)
		}
	}
}

func TestQRStdoutCanBeDisabledForServiceMode(t *testing.T) {
	t.Setenv(qrStdoutEnv, "false")
	if qrStdoutEnabled() {
		t.Fatal("QR stdout should be disabled in service mode")
	}
	t.Setenv(qrStdoutEnv, "true")
	if !qrStdoutEnabled() {
		t.Fatal("QR stdout should remain available for an intentional foreground pairing run")
	}
}

type fakeContacts map[types.JID]types.ContactInfo

func (f fakeContacts) GetContact(_ context.Context, user types.JID) (types.ContactInfo, error) {
	info, ok := f[user]
	if !ok {
		return types.ContactInfo{}, nil
	}
	return info, nil
}

type fakeLIDs map[types.JID]types.JID

func (f fakeLIDs) GetPNForLID(_ context.Context, lid types.JID) (types.JID, error) {
	pn, ok := f[lid]
	if !ok {
		return types.JID{}, nil
	}
	return pn, nil
}

type failingLIDs struct{}

func (failingLIDs) GetPNForLID(_ context.Context, lid types.JID) (types.JID, error) {
	return types.JID{}, fmt.Errorf("no mapping for %s", lid)
}

type fakeDownloader struct {
	bytes []byte
	err   error
	calls int
}

func (f *fakeDownloader) Download(_ context.Context, _ whatsmeow.DownloadableMessage) ([]byte, error) {
	f.calls += 1
	return f.bytes, f.err
}

func TestChatDisplayNameKeepsPhoneJIDContactPath(t *testing.T) {
	chat := types.JID{User: "15551230001", Server: types.DefaultUserServer}
	name := chatDisplayNameFromStores(context.Background(), fakeContacts{
		chat: {Found: true, FullName: "Jane Doe"},
	}, nil, chat)
	if name != "Jane Doe" {
		t.Fatalf("name = %q, want Jane Doe", name)
	}
}

func TestChatDisplayNameResolvesLIDThroughPhoneContact(t *testing.T) {
	lid := types.JID{User: "98765430001111", Server: types.HiddenUserServer}
	pn := types.JID{User: "15551230001", Server: types.DefaultUserServer}
	name := chatDisplayNameFromStores(context.Background(), fakeContacts{
		pn: {Found: true, FullName: "Jane Doe"},
	}, fakeLIDs{
		lid: pn,
	}, lid)
	if name != "Jane Doe" {
		t.Fatalf("name = %q, want Jane Doe", name)
	}
}

func TestChatDisplayNameLeavesUnmappedLIDUnnamed(t *testing.T) {
	lid := types.JID{User: "98765430001111", Server: types.HiddenUserServer}
	name := chatDisplayNameFromStores(context.Background(), fakeContacts{}, failingLIDs{}, lid)
	if name != "" {
		t.Fatalf("name = %q, want empty fallback", name)
	}
}

func TestRecordFromMessageDownloadsAudioAndKeepsRetryFields(t *testing.T) {
	dir := t.TempDir()
	downloader := &fakeDownloader{bytes: []byte("voice-bytes")}
	store := &audioMediaStore{
		dir:          filepath.Join(dir, "media", "audio"),
		maxFileBytes: audioMediaMaxFileBytes,
		quotaBytes:   audioMediaQuotaBytes,
		downloader:   downloader,
	}

	rec, ok := recordFromMessage(context.Background(), nil, store, audioEvent("voice:1", audioMessage(10)))
	if !ok {
		t.Fatal("expected audio message to be spooled")
	}

	if downloader.calls != 1 {
		t.Fatalf("Download calls = %d, want 1", downloader.calls)
	}
	if rec.MediaType != "audio" || rec.DownloadStatus != "ok" {
		t.Fatalf("unexpected media fields: media_type=%q download_status=%q", rec.MediaType, rec.DownloadStatus)
	}
	if rec.MediaPath == "" {
		t.Fatal("expected media_path for successful download")
	}
	if filepath.Base(rec.MediaPath) != "voice_1.ogg" {
		t.Fatalf("media filename = %q, want voice_1.ogg", filepath.Base(rec.MediaPath))
	}
	if rec.MediaMime != "audio/ogg; codecs=opus" || rec.MediaDurationSeconds != 7 || rec.MediaSizeBytes != int64(len(downloader.bytes)) {
		t.Fatalf("unexpected metadata: %#v", rec)
	}
	if rec.MediaKey != "AQID" || rec.MediaFileSHA256 != "BAUG" || rec.MediaFileEncSHA256 != "BwgJ" || rec.MediaDirectPath != "/mms/audio" {
		t.Fatalf("retry fields were not persisted: %#v", rec)
	}
	info, err := os.Stat(rec.MediaPath)
	if err != nil {
		t.Fatalf("stat media: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("media mode = %o, want 0600", info.Mode().Perm())
	}
	parent, err := os.Stat(filepath.Dir(rec.MediaPath))
	if err != nil {
		t.Fatalf("stat media dir: %v", err)
	}
	if parent.Mode().Perm() != 0o700 {
		t.Fatalf("media dir mode = %o, want 0700", parent.Mode().Perm())
	}
}

func TestRecordFromMessageTooLargeAudioSkipsDownloadButKeepsSpoolRecord(t *testing.T) {
	downloader := &fakeDownloader{bytes: []byte("should-not-download")}
	store := &audioMediaStore{
		dir:          filepath.Join(t.TempDir(), "media", "audio"),
		maxFileBytes: 5,
		quotaBytes:   audioMediaQuotaBytes,
		downloader:   downloader,
	}

	rec, ok := recordFromMessage(context.Background(), nil, store, audioEvent("voice-2", audioMessage(6)))
	if !ok {
		t.Fatal("expected oversized audio to degrade to a spool record")
	}
	if downloader.calls != 0 {
		t.Fatalf("Download calls = %d, want 0", downloader.calls)
	}
	if rec.DownloadStatus != "too_large" || rec.MediaPath != "" || rec.MediaSizeBytes != 6 {
		t.Fatalf("unexpected oversized fields: %#v", rec)
	}
	if rec.MediaKey == "" || rec.MediaDirectPath == "" {
		t.Fatalf("expected retry fields on oversized record: %#v", rec)
	}
}

func TestRecordFromMessageFailedDownloadKeepsMetadataOnlyRecord(t *testing.T) {
	store := &audioMediaStore{
		dir:          filepath.Join(t.TempDir(), "media", "audio"),
		maxFileBytes: audioMediaMaxFileBytes,
		quotaBytes:   audioMediaQuotaBytes,
		downloader:   &fakeDownloader{err: errors.New("network unavailable")},
	}

	rec, ok := recordFromMessage(context.Background(), nil, store, audioEvent("voice-3", audioMessage(4)))
	if !ok {
		t.Fatal("expected failed download to degrade to a spool record")
	}
	if rec.DownloadStatus != "failed:download" || rec.MediaPath != "" {
		t.Fatalf("unexpected failed-download fields: %#v", rec)
	}
	if rec.MediaType != "audio" || rec.Text != "" {
		t.Fatalf("unexpected metadata-only shape: %#v", rec)
	}
}

func TestAudioMediaStoreEvictsOldestFilesWithinQuota(t *testing.T) {
	dir := t.TempDir()
	audioDir := filepath.Join(dir, "media", "audio")
	if err := os.MkdirAll(audioDir, 0o700); err != nil {
		t.Fatal(err)
	}
	old1 := filepath.Join(audioDir, "old-1.ogg")
	old2 := filepath.Join(audioDir, "old-2.ogg")
	if err := os.WriteFile(old1, []byte("1111"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old2, []byte("2222"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := os.Chtimes(old1, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(old2, now.Add(-1*time.Hour), now.Add(-1*time.Hour)); err != nil {
		t.Fatal(err)
	}
	store := &audioMediaStore{
		dir:          audioDir,
		maxFileBytes: audioMediaMaxFileBytes,
		quotaBytes:   8,
		downloader:   &fakeDownloader{bytes: []byte("33333")},
	}

	rec := store.capture(context.Background(), "new-voice", audioMessage(5))
	if rec.DownloadStatus != "ok" {
		t.Fatalf("capture status = %q, want ok", rec.DownloadStatus)
	}
	if _, err := os.Stat(old1); !os.IsNotExist(err) {
		t.Fatalf("oldest file still present or stat failed with non-not-exist error: %v", err)
	}
	if _, err := os.Stat(old2); !os.IsNotExist(err) {
		t.Fatalf("second-oldest file still present or stat failed with non-not-exist error: %v", err)
	}
	if _, err := os.Stat(rec.MediaPath); err != nil {
		t.Fatalf("new protected media file missing: %v", err)
	}
}

func TestResolveMentionsInTextRewritesRawLIDTokens(t *testing.T) {
	text, mentions := resolveMentionsInText(
		"@98765430009999 please pick Sam up with @98765430001111",
		[]string{"98765430009999@lid", "98765430001111@lid"},
		func(jid types.JID) string {
			switch jid.User {
			case "98765430009999":
				return "you"
			case "98765430001111":
				return "Jane Doe"
			default:
				return ""
			}
		},
	)

	if text != "@you please pick Sam up with @Jane Doe" {
		t.Fatalf("text = %q", text)
	}
	if mentions["98765430009999"] != "you" || mentions["98765430001111"] != "Jane Doe" {
		t.Fatalf("mentions = %#v", mentions)
	}
}

func TestResolveMentionsInTextLeavesUnknownMentionsRaw(t *testing.T) {
	text, mentions := resolveMentionsInText(
		"@98765430009999 and @111222333444",
		[]string{"98765430009999@lid", "111222333444@lid"},
		func(jid types.JID) string {
			if jid.User == "98765430009999" {
				return "you"
			}
			return ""
		},
	)

	if text != "@you and @111222333444" {
		t.Fatalf("text = %q", text)
	}
	if len(mentions) != 1 || mentions["98765430009999"] != "you" {
		t.Fatalf("mentions = %#v", mentions)
	}
}

func TestRecordFromMessageStoresResolvedMentionMap(t *testing.T) {
	text := "@98765430009999 pick Sam up"
	rec, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		&events.Message{
			Info: types.MessageInfo{
				MessageSource: types.MessageSource{
					Chat:   types.JID{User: "12036303990000000000", Server: types.GroupServer},
					Sender: types.JID{User: "98765430001111", Server: types.HiddenUserServer},
				},
				ID:        types.MessageID("mention-1"),
				PushName:  "Jane",
				Timestamp: time.Date(2026, 7, 9, 7, 29, 1, 0, time.UTC),
			},
			Message: &waE2E.Message{
				ExtendedTextMessage: &waE2E.ExtendedTextMessage{
					Text: &text,
					ContextInfo: &waE2E.ContextInfo{
						MentionedJID: []string{"98765430009999@lid"},
					},
				},
			},
		},
	)
	if !ok {
		t.Fatal("expected extended-text message to be spooled")
	}
	if rec.Text != text {
		t.Fatalf("text = %q, want unresolved text without a client store", rec.Text)
	}
	if rec.Mentions != nil {
		t.Fatalf("mentions = %#v, want nil without a client store", rec.Mentions)
	}
}

func TestRecordFromMessageCapturesSanitizedLinkPreview(t *testing.T) {
	text := "https://maps.example/restaurant"
	title := "Bar\x00ouk"
	description := "Meet near\nlx factory"
	matchedText := "https://maps.example/restaurant"
	rec, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		&events.Message{
			Info: types.MessageInfo{
				MessageSource: types.MessageSource{
					Chat:   types.JID{User: "12036303990000000000", Server: types.GroupServer},
					Sender: types.JID{User: "98765430001111", Server: types.HiddenUserServer},
				},
				ID:        types.MessageID("preview-1"),
				PushName:  "Jane",
				Timestamp: time.Date(2026, 7, 24, 20, 15, 0, 0, time.UTC),
			},
			Message: &waE2E.Message{
				ExtendedTextMessage: &waE2E.ExtendedTextMessage{
					Text:        &text,
					Title:       &title,
					Description: &description,
					MatchedText: &matchedText,
				},
			},
		},
	)
	if !ok {
		t.Fatal("expected extended-text message to be spooled")
	}
	if rec.Text != text {
		t.Fatalf("text = %q, want %q", rec.Text, text)
	}
	if rec.PreviewTitle != "Barouk" {
		t.Fatalf("preview title = %q, want Barouk", rec.PreviewTitle)
	}
	if rec.PreviewDescription != "Meet nearlx factory" {
		t.Fatalf("preview description = %q, want controls stripped", rec.PreviewDescription)
	}
	if rec.PreviewURL != matchedText {
		t.Fatalf("preview url = %q, want %q", rec.PreviewURL, matchedText)
	}
}

func TestSanitizePreviewFieldBoundsBytesWithoutSplittingUTF8(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		maxBytes int
		want     string
	}{
		{
			name:     "ascii truncation",
			value:    strings.Repeat("a", previewTitleMaxBytes+1),
			maxBytes: previewTitleMaxBytes,
			want:     strings.Repeat("a", previewTitleMaxBytes),
		},
		{
			name:     "description truncation",
			value:    strings.Repeat("b", previewDescriptionMaxBytes+1),
			maxBytes: previewDescriptionMaxBytes,
			want:     strings.Repeat("b", previewDescriptionMaxBytes),
		},
		{
			name:     "url truncation",
			value:    strings.Repeat("c", previewURLMaxBytes+1),
			maxBytes: previewURLMaxBytes,
			want:     strings.Repeat("c", previewURLMaxBytes),
		},
		{
			name:     "multibyte truncation",
			value:    strings.Repeat("é", 129),
			maxBytes: previewTitleMaxBytes,
			want:     strings.Repeat("é", 128),
		},
		{
			name:     "control stripping",
			value:    "\tBar\x00ou\nk\r",
			maxBytes: previewTitleMaxBytes,
			want:     "Barouk",
		},
		{
			name:     "non-positive bound",
			value:    "Barouk",
			maxBytes: 0,
			want:     "",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := sanitizePreviewField(test.value, test.maxBytes)
			if got != test.want {
				t.Fatalf("sanitizePreviewField() = %q, want %q", got, test.want)
			}
			if len(got) > test.maxBytes && test.maxBytes > 0 {
				t.Fatalf("sanitized length = %d, want <= %d bytes", len(got), test.maxBytes)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("sanitized value is not valid UTF-8: %q", got)
			}
		})
	}
}

func TestRecordFromMessageWithoutPreviewKeepsOptionalFieldsAbsent(t *testing.T) {
	text := "ordinary extended text"
	rec, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		&events.Message{
			Info: types.MessageInfo{
				MessageSource: types.MessageSource{
					Chat:   types.JID{User: "15551234567", Server: types.DefaultUserServer},
					Sender: types.JID{User: "15551234567", Server: types.DefaultUserServer},
				},
				ID:        types.MessageID("no-preview"),
				Timestamp: time.Date(2026, 7, 24, 20, 30, 0, 0, time.UTC),
			},
			Message: &waE2E.Message{
				ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: &text},
			},
		},
	)
	if !ok || rec.Text != text {
		t.Fatalf("ordinary extended text did not pass through: ok=%v rec=%#v", ok, rec)
	}
	encoded, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal spool record: %v", err)
	}
	for _, field := range []string{"preview_title", "preview_description", "preview_url"} {
		if strings.Contains(string(encoded), `"`+field+`"`) {
			t.Fatalf("absent preview field %q was serialized: %s", field, encoded)
		}
	}
}

func TestRecordFromMessageCapturesReactionTargetAndToken(t *testing.T) {
	rec, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		reactionEvent("reaction-1", reactionMessage("👍", "target-1", "12036303990000000000@g.us", 1769000000000)),
	)
	if !ok {
		t.Fatal("expected reaction message to be spooled")
	}
	if rec.MediaType != "reaction" || rec.Text != "" {
		t.Fatalf("reaction line must stay an empty-text media_type record: %#v", rec)
	}
	if rec.ReactionTargetID != "target-1" || rec.ReactionTargetChatJID != "12036303990000000000@g.us" {
		t.Fatalf("reaction target not captured: %#v", rec)
	}
	if rec.ReactionKey != "👍" || rec.ReactionRemoved {
		t.Fatalf("reaction token not captured: key=%q removed=%v", rec.ReactionKey, rec.ReactionRemoved)
	}
	if rec.ReactionSenderTimestampMS != 1769000000000 {
		t.Fatalf("reaction sender timestamp = %d, want 1769000000000", rec.ReactionSenderTimestampMS)
	}
	// Old connector builds require these fields to count the line as valid.
	if rec.ID == "" || rec.ChatJID == "" || rec.SenderJID == "" || rec.SenderName == "" || rec.Timestamp == "" {
		t.Fatalf("required spool fields must stay populated on a reaction line: %#v", rec)
	}
}

func TestRecordFromMessageRecordsReactionRemovalWithoutLeakingAKey(t *testing.T) {
	rec, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		reactionEvent("reaction-2", reactionMessage("", "target-1", "12036303990000000000@g.us", 1769000001000)),
	)
	if !ok {
		t.Fatal("expected reaction removal to be spooled")
	}
	if !rec.ReactionRemoved {
		t.Fatal("empty reaction text must be recorded as an explicit removal")
	}
	if rec.ReactionKey != "" {
		t.Fatalf("removal must not carry a reaction key: %q", rec.ReactionKey)
	}
	encoded, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal spool record: %v", err)
	}
	if strings.Contains(string(encoded), `"reaction_key"`) {
		t.Fatalf("absent reaction_key was serialized: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"reaction_removed":true`) {
		t.Fatalf("removal flag missing from the spool line: %s", encoded)
	}
}

func TestRecordFromMessageSanitizesAndBoundsTheReactionToken(t *testing.T) {
	// A control character would split the single-line rendered form the store
	// derives, and an over-length token is refused outright by the shared
	// reaction bounds — neither may reach the spool.
	rec, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		reactionEvent("reaction-3", reactionMessage("\t👍\x00\n", "target-1", "12036303990000000000@g.us", 0)),
	)
	if !ok {
		t.Fatal("expected reaction message to be spooled")
	}
	if rec.ReactionKey != "👍" {
		t.Fatalf("reaction key = %q, want control characters stripped", rec.ReactionKey)
	}

	long, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		reactionEvent("reaction-4", reactionMessage(strings.Repeat("é", 64), "target-1", "12036303990000000000@g.us", 0)),
	)
	if !ok {
		t.Fatal("expected over-length reaction to be spooled")
	}
	if len(long.ReactionKey) > reactionKeyMaxBytes {
		t.Fatalf("reaction key length = %d bytes, want <= %d", len(long.ReactionKey), reactionKeyMaxBytes)
	}
	if !utf8.ValidString(long.ReactionKey) {
		t.Fatalf("bounded reaction key is not valid UTF-8: %q", long.ReactionKey)
	}
	// The store counts UTF-16 code units, which are never more numerous than
	// the UTF-8 bytes the daemon bounds.
	if utf8.RuneCountInString(long.ReactionKey) != 32 {
		t.Fatalf("bounded reaction key = %d runes, want 32 whole runes", utf8.RuneCountInString(long.ReactionKey))
	}
}

func TestRecordFromMessageLeavesNonReactionLinesUntouched(t *testing.T) {
	text := "ordinary conversation"
	rec, ok := recordFromMessage(
		context.Background(),
		nil,
		nil,
		&events.Message{
			Info: types.MessageInfo{
				MessageSource: types.MessageSource{
					Chat:   types.JID{User: "15551234567", Server: types.DefaultUserServer},
					Sender: types.JID{User: "15551234567", Server: types.DefaultUserServer},
				},
				ID:        types.MessageID("plain-1"),
				Timestamp: time.Date(2026, 7, 26, 9, 0, 0, 0, time.UTC),
			},
			Message: &waE2E.Message{Conversation: &text},
		},
	)
	if !ok || rec.Text != text {
		t.Fatalf("plain text did not pass through: ok=%v rec=%#v", ok, rec)
	}
	encoded, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal spool record: %v", err)
	}
	for _, field := range []string{
		"reaction_target_id",
		"reaction_target_chat_jid",
		"reaction_key",
		"reaction_removed",
		"reaction_sender_timestamp_ms",
	} {
		if strings.Contains(string(encoded), `"`+field+`"`) {
			t.Fatalf("absent reaction field %q was serialized: %s", field, encoded)
		}
	}
}

func reactionEvent(id string, reaction *waE2E.ReactionMessage) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:   types.JID{User: "12036303990000000000", Server: types.GroupServer},
				Sender: types.JID{User: "98765430001111", Server: types.HiddenUserServer},
			},
			ID:        types.MessageID(id),
			PushName:  "Jane",
			Timestamp: time.Date(2026, 7, 26, 8, 0, 0, 0, time.UTC),
		},
		Message: &waE2E.Message{ReactionMessage: reaction},
	}
}

func reactionMessage(text string, targetID string, remoteJID string, senderTimestampMS int64) *waE2E.ReactionMessage {
	return &waE2E.ReactionMessage{
		Key: &waCommon.MessageKey{
			ID:        &targetID,
			RemoteJID: &remoteJID,
		},
		Text:              &text,
		SenderTimestampMS: &senderTimestampMS,
	}
}

func audioEvent(id string, audio *waE2E.AudioMessage) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:   types.JID{User: "15551234567", Server: types.DefaultUserServer},
				Sender: types.JID{User: "15551234567", Server: types.DefaultUserServer},
			},
			ID:        types.MessageID(id),
			PushName:  "Ada",
			Timestamp: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC),
		},
		Message: &waE2E.Message{AudioMessage: audio},
	}
}

func audioMessage(fileLength uint64) *waE2E.AudioMessage {
	mimetype := "audio/ogg; codecs=opus"
	directPath := "/mms/audio"
	seconds := uint32(7)
	timestamp := int64(123456789)
	return &waE2E.AudioMessage{
		Mimetype:          &mimetype,
		FileLength:        &fileLength,
		Seconds:           &seconds,
		MediaKey:          []byte{1, 2, 3},
		FileSHA256:        []byte{4, 5, 6},
		FileEncSHA256:     []byte{7, 8, 9},
		DirectPath:        &directPath,
		MediaKeyTimestamp: &timestamp,
	}
}
