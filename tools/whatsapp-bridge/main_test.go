package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// nativeInstance and otherNativeInstance are canonical lower-case UUIDs; the
// daemon refuses anything else.
const (
	nativeInstance  = "019f6ff4-2fb0-70a3-91dd-3ef3ada9354f"
	otherInstance   = "019f6ff4-2fb0-70a3-91dd-3ef3ada93550"
	rejectedPhonish = "15551230003@s.whatsapp.net"
)

func TestNativeCaptureRequiresExplicitModeFlag(t *testing.T) {
	for _, explicit := range []string{"1", "true", "TRUE", " Yes ", "on"} {
		t.Run("explicit "+explicit, func(t *testing.T) {
			t.Setenv(nativeCaptureEnv, explicit)
			t.Setenv(instanceIDEnv, nativeInstance)
			config, err := readNativeCaptureConfig()
			if err != nil {
				t.Fatalf("explicit native mode rejected: %v", err)
			}
			if !config.Active || config.InstanceID != nativeInstance {
				t.Fatalf("config = %#v, want active native capture for %s", config, nativeInstance)
			}
		})
	}
	for _, disabled := range []string{"", "0", "false", "no"} {
		t.Run("disabled "+disabled, func(t *testing.T) {
			t.Setenv(nativeCaptureEnv, disabled)
			t.Setenv(instanceIDEnv, nativeInstance)
			config, err := readNativeCaptureConfig()
			if err != nil {
				t.Fatalf("manual mode must never error on the nonce: %v", err)
			}
			if config.Active {
				t.Fatalf("config = %#v, want native capture inactive", config)
			}
		})
	}
}

// An ordinary pairing run can inherit a source worker's nonce through its
// environment. That must never move it off the manual QR path.
func TestInheritedServiceNonceAloneDoesNotActivateNativeCapture(t *testing.T) {
	t.Setenv(instanceIDEnv, nativeInstance)
	config, err := readNativeCaptureConfig()
	if err != nil {
		t.Fatalf("inherited nonce rejected manual mode: %v", err)
	}
	if config.Active {
		t.Fatalf("config = %#v, want native capture inactive with only %s set", config, instanceIDEnv)
	}
	if config.InstanceID != "" {
		t.Fatalf("inactive config carried an instance id: %#v", config)
	}
}

func TestNativeCaptureRejectsNonCanonicalInstanceNonce(t *testing.T) {
	tests := []struct {
		name   string
		nonce  string
		reason string
	}{
		{name: "missing", nonce: "", reason: "unset nonce"},
		{name: "whitespace only", nonce: "   ", reason: "blank nonce"},
		{name: "not a uuid", nonce: "not-an-instance", reason: "opaque string"},
		{name: "uppercase", nonce: strings.ToUpper(nativeInstance), reason: "non-canonical case"},
		{name: "padded", nonce: " " + nativeInstance + "\n", reason: "surrounding whitespace"},
		{name: "braced", nonce: "{" + nativeInstance + "}", reason: "braced form"},
		{name: "urn", nonce: "urn:uuid:" + nativeInstance, reason: "urn form"},
		{name: "bad separator", nonce: strings.Replace(nativeInstance, "-", "_", 1), reason: "wrong separator"},
		{name: "non hex digit", nonce: strings.Replace(nativeInstance, "f", "z", 1), reason: "non-hex digit"},
		{name: "short", nonce: nativeInstance[:35], reason: "truncated"},
		{name: "long", nonce: nativeInstance + "f", reason: "over-long"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(nativeCaptureEnv, "true")
			t.Setenv(instanceIDEnv, test.nonce)
			config, err := readNativeCaptureConfig()
			if err == nil {
				t.Fatalf("nonce %q (%s) was accepted: %#v", test.nonce, test.reason, config)
			}
			if config.Active {
				t.Fatalf("rejected nonce %q still produced an active config", test.nonce)
			}
			if !strings.Contains(err.Error(), instanceIDEnv) || !strings.Contains(err.Error(), "UUID") {
				t.Fatalf("error %q must name %s and the required UUID shape", err, instanceIDEnv)
			}
			trimmed := strings.TrimSpace(test.nonce)
			if trimmed != "" && strings.Contains(err.Error(), trimmed) {
				t.Fatalf("error %q echoed the rejected nonce", err)
			}
		})
	}
}

// trackedFactory records whether a capture client was ever built. Tests wire it
// in so "refused before provider connection" is observable instead of implied.
func trackedFactory() (sessionFactory, *int32) {
	var calls int32
	return func(device *store.Device, logger waLog.Logger) *whatsmeow.Client {
		atomic.AddInt32(&calls, 1)
		return whatsmeow.NewClient(device, logger)
	}, &calls
}

func TestNativeCaptureRefusesUnpairedStoreBeforeConnecting(t *testing.T) {
	stateDir := t.TempDir()
	spoolDir := filepath.Join(stateDir, spoolDirName)
	factory, calls := trackedFactory()
	container, err := openSessionContainer(filepath.Join(stateDir, sessionDBName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = container.Close() })

	_, _, _, err = startNativeCapture(stateDir, spoolDir, nativeCaptureConfig{
		Active:     true,
		InstanceID: nativeInstance,
	}, nil, container, factory)
	if err == nil {
		t.Fatal("unpaired store must refuse to start native capture")
	}
	for _, want := range []string{"unpaired", "pair it manually", nativeCaptureEnv} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q must tell the operator about %q", err, want)
		}
	}
	if strings.Contains(err.Error(), nativeInstance) {
		t.Fatalf("error %q leaked the service instance nonce", err)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("capture client constructed %d times, want 0 before a paired store", got)
	}
	if _, err := os.Stat(filepath.Join(stateDir, readinessName)); !os.IsNotExist(err) {
		t.Fatalf("readiness receipt exists after a refused start: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, qrFileName)); !os.IsNotExist(err) {
		t.Fatalf("QR artifact exists after a refused native start: %v", err)
	}
}

func TestNativeCaptureRefusalPrecedesSpoolSideEffects(t *testing.T) {
	stateDir := t.TempDir()
	factory, calls := trackedFactory()
	container, err := openSessionContainer(filepath.Join(stateDir, sessionDBName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = container.Close() })
	// Deliberately point the spool at an unwritable path: native mode must
	// refuse before it touches capture state at all.
	if _, _, _, err := startNativeCapture(stateDir, filepath.Join(stateDir, "missing", spoolDirName), nativeCaptureConfig{
		Active:     true,
		InstanceID: nativeInstance,
	}, nil, container, factory); err == nil {
		t.Fatal("unpaired store must refuse before opening capture state")
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("capture client constructed %d times, want 0", got)
	}
}

func TestNativeReadinessWaitsForAuthenticatedSession(t *testing.T) {
	stateDir := t.TempDir()
	authenticated := false
	fatalEvents := make(chan string, 1)
	publish := nativeReadinessPublisher(stateDir, nativeInstance, func() bool { return authenticated }, fatalEvents)
	publish()
	if _, err := os.Stat(filepath.Join(stateDir, readinessName)); !os.IsNotExist(err) {
		t.Fatal("unauthenticated session published readiness")
	}
	authenticated = true
	publish()
	if _, err := os.Stat(filepath.Join(stateDir, readinessName)); err != nil {
		t.Fatal(err)
	}
	if len(fatalEvents) != 0 {
		t.Fatal("unexpected readiness failure")
	}
}

func TestMalformedNativeModeNeverFallsBackToPairing(t *testing.T) {
	t.Setenv(nativeCaptureEnv, "tru")
	t.Setenv(instanceIDEnv, nativeInstance)
	if _, err := readNativeCaptureConfig(); err == nil {
		t.Fatal("malformed native mode was accepted")
	}
}

func TestNativeReadinessReceiptCarriesIdentityOnly(t *testing.T) {
	stateDir := t.TempDir()
	if err := writeReadinessReceipt(stateDir, nativeInstance); err != nil {
		t.Fatalf("writeReadinessReceipt: %v", err)
	}
	path := filepath.Join(stateDir, readinessName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat readiness: %v", err)
	}
	if info.Mode().Perm() != readinessFileMode {
		t.Fatalf("readiness mode = %o, want %o", info.Mode().Perm(), readinessFileMode)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read readiness: %v", err)
	}
	var receipt map[string]any
	if err := json.Unmarshal(raw, &receipt); err != nil {
		t.Fatalf("readiness is not valid JSON: %v", err)
	}
	if receipt["kind"] != whatsappCaptureReadinessKind {
		t.Fatalf("kind = %v, want %s", receipt["kind"], whatsappCaptureReadinessKind)
	}
	if receipt["instance_id"] != nativeInstance {
		t.Fatalf("instance_id = %v, want %s", receipt["instance_id"], nativeInstance)
	}
	if receipt["paired"] != true || receipt["connected"] != true {
		t.Fatalf("receipt must assert paired+connected: %s", raw)
	}
	pid, ok := receipt["pid"].(float64)
	if !ok || int(pid) != os.Getpid() {
		t.Fatalf("pid = %v, want %d", receipt["pid"], os.Getpid())
	}
	// Closed shape: no identifier, key material, or captured content may appear.
	if len(receipt) != 5 {
		t.Fatalf("unexpected receipt fields: %s", raw)
	}
	for _, forbidden := range []string{"@s.whatsapp.net", "@lid", "@g.us", "15551230003", "media_key", "session", "phone", "jid", "text"} {
		if strings.Contains(strings.ToLower(string(raw)), strings.ToLower(forbidden)) {
			t.Fatalf("readiness contains %q: %s", forbidden, raw)
		}
	}
}

func TestNativeReadinessReceiptReplacesExistingFileAtomically(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, readinessName)
	if err := os.WriteFile(path, []byte("{\"kind\":\"stale\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeReadinessReceipt(stateDir, otherInstance); err != nil {
		t.Fatalf("writeReadinessReceipt over existing file: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), otherInstance) || strings.Contains(string(raw), "stale") {
		t.Fatalf("receipt was not replaced: %s", raw)
	}
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != readinessName {
		t.Fatalf("temp artifacts left behind: %v", entries)
	}
}

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

func TestPairingQRIsPrivatePNG(t *testing.T) {
	dir := t.TempDir()
	path, err := writeQRPNG("fixture-pairing-code", dir)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("pairing artifact is not PNG: %x", data[:min(8, len(data))])
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("pairing QR mode = %o, want 0600", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(dir, qrFileName)); !os.IsNotExist(err) {
		t.Fatalf("pair-only PNG writer unexpectedly created ASCII QR: %v", err)
	}
}

func TestPairingReceiptRequiresAuthenticatedPersistedMatchingDevice(t *testing.T) {
	current := types.JID{User: "current", Server: types.DefaultUserServer}
	persisted := types.JID{User: "current", Server: types.DefaultUserServer}
	other := types.JID{User: "other", Server: types.DefaultUserServer}
	if !pairingReceiptReady(true, &current, &persisted) {
		t.Fatal("matching authenticated current and persisted devices should be ready")
	}
	for name, ready := range map[string]bool{
		"not authenticated": pairingReceiptReady(false, &current, &persisted),
		"missing current":   pairingReceiptReady(true, nil, &persisted),
		"missing persisted": pairingReceiptReady(true, &current, nil),
		"different device":  pairingReceiptReady(true, &current, &other),
	} {
		if ready {
			t.Fatalf("%s unexpectedly produced a ready receipt", name)
		}
	}
}

func TestApprovedCaptureChatsFailClosedAndFilter(t *testing.T) {
	t.Setenv(allowedChatsEnv, "")
	if _, err := approvedCaptureChats(true); err == nil || err.Error() != "approved_chat_scope_required" {
		t.Fatalf("empty explicit approval error = %v", err)
	}
	t.Setenv(allowedChatsEnv, "chat-1@s.whatsapp.net, chat-2@g.us")
	allowed, err := approvedCaptureChats(true)
	if err != nil {
		t.Fatal(err)
	}
	if !chatCaptureAllowed("chat-1@s.whatsapp.net", allowed) {
		t.Fatal("approved chat was rejected")
	}
	if chatCaptureAllowed("other@s.whatsapp.net", allowed) {
		t.Fatal("unapproved chat was accepted")
	}
	t.Setenv(allowedChatsEnv, "not-a-jid")
	if _, err := approvedCaptureChats(true); err == nil || err.Error() != "invalid_approved_chat_scope" {
		t.Fatalf("invalid chat approval error = %v", err)
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

func (f *fakeDownloader) DownloadMediaWithPathToFile(_ context.Context, _ string, _, _, _ []byte, _ whatsmeow.MediaType, _ string, _ bool, file whatsmeow.File) error {
	f.calls += 1
	if f.err != nil {
		return f.err
	}
	_, err := file.Write(f.bytes)
	return err
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
		dir:        filepath.Join(dir, "media", "audio"),
		downloader: downloader,
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
	if want := mediaFileStem(rec.ChatJID, "voice:1") + ".ogg"; filepath.Base(rec.MediaPath) != want {
		t.Fatalf("media filename = %q, want %s", filepath.Base(rec.MediaPath), want)
	}
	if !regexp.MustCompile(`^voice_1-[0-9a-f]{16}\.ogg$`).MatchString(filepath.Base(rec.MediaPath)) {
		t.Fatalf("media filename = %q, want readable id plus chat-scoped hash", filepath.Base(rec.MediaPath))
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

// Every piece of media is kept (owner, 2026-10-26): a voice note said to be huge is downloaded like any other.
func TestRecordFromMessageDownloadsAudioWhateverItsStatedSize(t *testing.T) {
	downloader := &fakeDownloader{bytes: []byte("a long voice note")}
	store := &audioMediaStore{
		dir:        filepath.Join(t.TempDir(), "media", "audio"),
		downloader: downloader,
	}
	audio := audioMessage(8 * 1024 * 1024 * 1024)
	rec, ok := recordFromMessage(context.Background(), nil, store, audioEvent("voice-2", audio))
	if !ok || downloader.calls != 1 || rec.DownloadStatus != "ok" || rec.MediaPath == "" {
		t.Fatalf("record = %#v, calls = %d", rec, downloader.calls)
	}
	if rec.MediaSizeBytes != int64(len(downloader.bytes)) {
		t.Fatalf("size = %d, want the bytes received", rec.MediaSizeBytes)
	}
}

func TestRecordFromMessageFailedDownloadKeepsMetadataOnlyRecord(t *testing.T) {
	store := &audioMediaStore{
		dir:        filepath.Join(t.TempDir(), "media", "audio"),
		downloader: &fakeDownloader{err: errors.New("network unavailable")},
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

// Nothing is evicted: media saved earlier stays however much there is.
func TestAudioMediaStoreKeepsEveryEarlierFile(t *testing.T) {
	dir := t.TempDir()
	audioDir := filepath.Join(dir, "media", "audio")
	if err := os.MkdirAll(audioDir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(audioDir, "old-1.ogg")
	if err := os.WriteFile(old, []byte("1111"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &audioMediaStore{dir: audioDir, downloader: &fakeDownloader{bytes: []byte("33333")}}
	rec := store.capture(context.Background(), "15551234567@s.whatsapp.net", "new-voice", audioMessage(5))
	if rec.DownloadStatus != "ok" {
		t.Fatalf("capture status = %q, want ok", rec.DownloadStatus)
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatalf("earlier media was removed: %v", err)
	}
}

func audioEventInChat(chat types.JID, id string, audio *waE2E.AudioMessage) *events.Message {
	evt := audioEvent(id, audio)
	evt.Info.Chat = chat
	return evt
}

func newTestAudioStore(dir string, downloader *fakeDownloader) *audioMediaStore {
	return &audioMediaStore{
		dir:        dir,
		downloader: downloader,
	}
}

func readFileOrFail(t *testing.T, path string) string {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(got)
}

// A message id is unique only within its chat: the same id and MIME in two
// chats must land in two files, and the second capture must not overwrite the
// first one's audio.
func TestAudioMediaStoreKeepsSameMessageIDInTwoChatsApart(t *testing.T) {
	downloader := &fakeDownloader{bytes: []byte("first-chat-voice")}
	store := newTestAudioStore(filepath.Join(t.TempDir(), "audio"), downloader)
	chatA := types.JID{User: "15551230001", Server: types.DefaultUserServer}
	chatB := types.NewJID("120363000000000001", types.GroupServer)

	first, ok := recordFromMessage(context.Background(), nil, store, audioEventInChat(chatA, "3EB0SAMEID", audioMessage(16)))
	if !ok || first.DownloadStatus != "ok" {
		t.Fatalf("first capture: ok=%v %#v", ok, first)
	}
	downloader.bytes = []byte("second-chat-voice")
	second, ok := recordFromMessage(context.Background(), nil, store, audioEventInChat(chatB, "3EB0SAMEID", audioMessage(17)))
	if !ok || second.DownloadStatus != "ok" {
		t.Fatalf("second capture: ok=%v %#v", ok, second)
	}

	if first.MediaPath == second.MediaPath {
		t.Fatalf("both chats share media_path %q", first.MediaPath)
	}
	if got := readFileOrFail(t, first.MediaPath); got != "first-chat-voice" {
		t.Fatalf("first chat's audio = %q, want it untouched", got)
	}
	if got := readFileOrFail(t, second.MediaPath); got != "second-chat-voice" {
		t.Fatalf("second chat's audio = %q", got)
	}
}

// The chat part of the name is normalized like the TypeScript identity, so a
// re-delivered message (device suffix, case) reuses its file instead of
// writing a second copy.
func TestAudioMediaStoreReusesFileForRedeliveredMessage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "audio")
	store := newTestAudioStore(dir, &fakeDownloader{bytes: []byte("voice")})

	first := store.capture(context.Background(), "15551230001@s.whatsapp.net", "3EB0REDELIVER", audioMessage(5))
	again := store.capture(context.Background(), "15551230001:7@S.WhatsApp.net", "3EB0REDELIVER", audioMessage(5))
	if first.DownloadStatus != "ok" || again.DownloadStatus != "ok" {
		t.Fatalf("statuses = %q, %q", first.DownloadStatus, again.DownloadStatus)
	}
	if first.MediaPath != again.MediaPath {
		t.Fatalf("redelivery wrote %q, want reuse of %q", again.MediaPath, first.MediaPath)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("media dir holds %d entries, want 1 (no leftover temp files)", len(entries))
	}
}

// A file already at the computed name with different audio (an older file, or
// a hash collision) is never overwritten: the new audio takes the next free
// name and its spool line points there. Files saved under the old
// message-id-only names stay where their spool lines recorded them.
func TestAudioMediaStoreNeverOverwritesExistingFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "audio")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	chat := "15551230001@s.whatsapp.net"
	occupied := filepath.Join(dir, mediaFileStem(chat, "3EB0TAKEN")+".ogg")
	legacy := filepath.Join(dir, safeMediaFileStem("3EB0TAKEN")+".ogg")
	for path, body := range map[string]string{occupied: "someone-else", legacy: "legacy-voice"} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	store := newTestAudioStore(dir, &fakeDownloader{bytes: []byte("new-voice")})

	rec := store.capture(context.Background(), chat, "3EB0TAKEN", audioMessage(9))
	if rec.DownloadStatus != "ok" {
		t.Fatalf("capture status = %q", rec.DownloadStatus)
	}
	if want := filepath.Join(dir, mediaFileStem(chat, "3EB0TAKEN")+"-1.ogg"); rec.MediaPath != want {
		t.Fatalf("media_path = %q, want %q", rec.MediaPath, want)
	}
	if got := readFileOrFail(t, rec.MediaPath); got != "new-voice" {
		t.Fatalf("new audio = %q", got)
	}
	if got := readFileOrFail(t, occupied); got != "someone-else" {
		t.Fatalf("occupied file overwritten: %q", got)
	}
	if got := readFileOrFail(t, legacy); got != "legacy-voice" {
		t.Fatalf("legacy file overwritten: %q", got)
	}
	info, err := os.Stat(rec.MediaPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("new media mode: info=%v err=%v", info, err)
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

// --- Startup dispatch and capture scope ----------------------------------------

// dispatchRecorder stands in for every entry point run can reach, so a test can
// prove which mode a command line selects without any provider connection.
type dispatchRecorder struct {
	calls         []string
	pairStateDir  string
	pairErr       error
	nativeAllowed map[string]struct{}
	manualAllowed map[string]struct{}
}

func (r *dispatchRecorder) deps() bridgeDeps {
	return bridgeDeps{
		pairOnly: func(stateDir string, _ *sqlstore.Container) error {
			r.calls = append(r.calls, "pair-only")
			r.pairStateDir = stateDir
			return r.pairErr
		},
		native: func(_, _ string, _ nativeCaptureConfig, allowed map[string]struct{}, _ *sqlstore.Container) (*whatsmeow.Client, *spoolWriter, chan string, error) {
			r.calls = append(r.calls, "native")
			r.nativeAllowed = allowed
			return nil, nil, nil, nil
		},
		manual: func(_, _ string, allowed map[string]struct{}, _ *sqlstore.Container) (*whatsmeow.Client, *spoolWriter, chan string) {
			r.calls = append(r.calls, "manual")
			r.manualAllowed = allowed
			return nil, nil, nil
		},
		wait: func(*whatsmeow.Client, *spoolWriter, chan string) {
			r.calls = append(r.calls, "wait")
		},
	}
}

// dispatchState points the daemon at a state directory that does not exist yet,
// so a test can tell "refused before touching state" from "created state then
// refused", and clears every mode switch inherited from the environment.
func dispatchState(t *testing.T) string {
	t.Helper()
	stateDir := filepath.Join(t.TempDir(), "state")
	t.Setenv(stateDirEnv, stateDir)
	t.Setenv(nativeCaptureEnv, "")
	t.Setenv(instanceIDEnv, "")
	t.Setenv(allowedChatsEnv, "")
	// run applies a private umask to the whole process; do not leak it into
	// other tests.
	previous := syscall.Umask(0o077)
	syscall.Umask(previous)
	t.Cleanup(func() { syscall.Umask(previous) })
	return stateDir
}

func requireNoState(t *testing.T, stateDir string) {
	t.Helper()
	if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
		t.Fatalf("state dir %s exists after a refused start: %v", stateDir, err)
	}
}

func TestRunPairOnlyPairsAndNeverStartsCapture(t *testing.T) {
	stateDir := dispatchState(t)
	// Pairing must ignore the native-capture switch entirely, even a malformed
	// one inherited from a service environment.
	t.Setenv(nativeCaptureEnv, "tru")
	recorder := &dispatchRecorder{}
	if err := run([]string{"--pair-only"}, recorder.deps()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(recorder.calls, ",") != "pair-only" {
		t.Fatalf("calls = %v, want only pair-only", recorder.calls)
	}
	if recorder.pairStateDir != stateDir {
		t.Fatalf("pairing ran against %q, want %q", recorder.pairStateDir, stateDir)
	}
	if _, err := os.Stat(filepath.Join(stateDir, sessionDBName)); err != nil {
		t.Fatalf("pairing needs the session store: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, spoolDirName)); !os.IsNotExist(err) {
		t.Fatalf("pair-only created a spool dir: %v", err)
	}
}

func TestRunPairOnlyReturnsThePairingFailureCode(t *testing.T) {
	dispatchState(t)
	recorder := &dispatchRecorder{pairErr: errors.New("pairing_timeout")}
	err := run([]string{"--pair-only"}, recorder.deps())
	if err == nil || err.Error() != "pairing_timeout" {
		t.Fatalf("err = %v, want pairing_timeout", err)
	}
}

func TestRunRefusesPairOnlyTogetherWithCaptureApproved(t *testing.T) {
	stateDir := dispatchState(t)
	t.Setenv(allowedChatsEnv, "chat-1@s.whatsapp.net")
	recorder := &dispatchRecorder{}
	err := run([]string{"--pair-only", "--capture-approved"}, recorder.deps())
	if err == nil || err.Error() != "incompatible_modes" {
		t.Fatalf("err = %v, want incompatible_modes", err)
	}
	if len(recorder.calls) != 0 {
		t.Fatalf("calls = %v, want none", recorder.calls)
	}
	requireNoState(t, stateDir)
}

func TestRunCaptureApprovedFailsClosedWithoutAUsableScope(t *testing.T) {
	for _, test := range []struct {
		name  string
		scope string
		want  string
	}{
		{name: "unset", scope: "", want: "approved_chat_scope_required"},
		{name: "blank entries", scope: " , ,", want: "approved_chat_scope_required"},
		{name: "unparseable chat", scope: "chat-1@s.whatsapp.net,not-a-jid", want: "invalid_approved_chat_scope"},
	} {
		t.Run(test.name, func(t *testing.T) {
			stateDir := dispatchState(t)
			t.Setenv(allowedChatsEnv, test.scope)
			recorder := &dispatchRecorder{}
			err := run([]string{"--capture-approved"}, recorder.deps())
			if err == nil || err.Error() != test.want {
				t.Fatalf("err = %v, want %s", err, test.want)
			}
			if len(recorder.calls) != 0 {
				t.Fatalf("calls = %v, want capture never started", recorder.calls)
			}
			requireNoState(t, stateDir)
		})
	}
}

func TestRunCaptureApprovedHandsTheScopeToManualCapture(t *testing.T) {
	dispatchState(t)
	t.Setenv(allowedChatsEnv, "chat-1@s.whatsapp.net, 12036303990000000000@g.us")
	recorder := &dispatchRecorder{}
	if err := run([]string{"--capture-approved"}, recorder.deps()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(recorder.calls, ",") != "manual,wait" {
		t.Fatalf("calls = %v, want manual capture then wait", recorder.calls)
	}
	if len(recorder.manualAllowed) != 2 ||
		!chatCaptureAllowed("chat-1@s.whatsapp.net", recorder.manualAllowed) ||
		!chatCaptureAllowed("12036303990000000000@g.us", recorder.manualAllowed) ||
		chatCaptureAllowed("other@s.whatsapp.net", recorder.manualAllowed) {
		t.Fatalf("manual capture got scope %v", recorder.manualAllowed)
	}
}

func TestRunCaptureApprovedHandsTheScopeToNativeCapture(t *testing.T) {
	dispatchState(t)
	t.Setenv(nativeCaptureEnv, "true")
	t.Setenv(instanceIDEnv, nativeInstance)
	t.Setenv(allowedChatsEnv, "chat-1@s.whatsapp.net")
	recorder := &dispatchRecorder{}
	if err := run([]string{"--capture-approved"}, recorder.deps()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(recorder.calls, ",") != "native,wait" {
		t.Fatalf("calls = %v, want native capture then wait", recorder.calls)
	}
	if !chatCaptureAllowed("chat-1@s.whatsapp.net", recorder.nativeAllowed) ||
		chatCaptureAllowed("other@s.whatsapp.net", recorder.nativeAllowed) {
		t.Fatalf("native capture got scope %v", recorder.nativeAllowed)
	}
}

func TestRunCaptureApprovedWholeAccountScope(t *testing.T) {
	dispatchState(t)
	t.Setenv(allowedChatsEnv, "*")
	recorder := &dispatchRecorder{}
	if err := run([]string{"--capture-approved"}, recorder.deps()); err != nil {
		t.Fatal(err)
	}
	if !chatCaptureAllowed("anyone@s.whatsapp.net", recorder.manualAllowed) {
		t.Fatalf("whole-account scope rejected a chat: %v", recorder.manualAllowed)
	}
}

// Without --capture-approved the historic behaviour stays: every chat, and the
// scope variable is not consulted even when something left it in the
// environment.
func TestRunWithoutFlagsKeepsUnscopedCapture(t *testing.T) {
	dispatchState(t)
	t.Setenv(allowedChatsEnv, "chat-1@s.whatsapp.net")
	manual := &dispatchRecorder{}
	if err := run(nil, manual.deps()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(manual.calls, ",") != "manual,wait" || manual.manualAllowed != nil {
		t.Fatalf("calls = %v scope = %v, want unscoped manual capture", manual.calls, manual.manualAllowed)
	}

	t.Setenv(nativeCaptureEnv, "true")
	t.Setenv(instanceIDEnv, nativeInstance)
	native := &dispatchRecorder{}
	if err := run(nil, native.deps()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(native.calls, ",") != "native,wait" || native.nativeAllowed != nil {
		t.Fatalf("calls = %v scope = %v, want unscoped native capture", native.calls, native.nativeAllowed)
	}
}

func TestRunRejectsUnknownFlagsWithoutStartingAnything(t *testing.T) {
	stateDir := dispatchState(t)
	recorder := &dispatchRecorder{}
	if err := run([]string{"--capture-everything"}, recorder.deps()); err == nil {
		t.Fatal("unknown flag was accepted")
	}
	if len(recorder.calls) != 0 {
		t.Fatalf("calls = %v, want none", recorder.calls)
	}
	requireNoState(t, stateDir)
}

// The TypeScript pairing code recovers a failure code from the LAST stderr line
// shaped like "olympus-whatsapp-bridge: <code>". Prove the real main prints
// that line and exits non-zero, by re-running this test binary as the daemon.
func TestMainReportsStartupFailuresAsParsableStderrCodes(t *testing.T) {
	if args := os.Getenv("OLYMPUS_BRIDGE_TEST_MAIN_ARGS"); args != "" {
		os.Args = append([]string{"olympus-whatsapp-bridge"}, strings.Fields(args)...)
		main()
		return
	}
	for _, test := range []struct {
		name string
		args string
		want string
	}{
		{name: "missing scope", args: "--capture-approved", want: "approved_chat_scope_required"},
		{name: "incompatible modes", args: "--pair-only --capture-approved", want: "incompatible_modes"},
	} {
		t.Run(test.name, func(t *testing.T) {
			stateDir := filepath.Join(t.TempDir(), "state")
			command := exec.Command(os.Args[0], "-test.run=^TestMainReportsStartupFailuresAsParsableStderrCodes$")
			command.Env = append(os.Environ(),
				"OLYMPUS_BRIDGE_TEST_MAIN_ARGS="+test.args,
				stateDirEnv+"="+stateDir,
				allowedChatsEnv+"=",
				nativeCaptureEnv+"=",
			)
			output, err := command.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() == 0 {
				t.Fatalf("daemon exit = %v, want a non-zero exit; output %q", err, output)
			}
			pattern := regexp.MustCompile(`(?m)olympus-whatsapp-bridge:\s*([a-z0-9_]+)\s*$`)
			match := pattern.FindSubmatch(output)
			if match == nil || string(match[1]) != test.want {
				t.Fatalf("stderr %q does not end in the %s code", output, test.want)
			}
			requireNoState(t, stateDir)
		})
	}
}

func textEvent(chat types.JID, id string, text string) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: chat},
			ID:            types.MessageID(id),
			PushName:      "Ada",
			Timestamp:     time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC),
		},
		Message: &waE2E.Message{Conversation: &text},
	}
}

// captureThroughHandler drives events through the real event handler and spool
// writer under the given scope, returning every record that reached the spool.
func captureThroughHandler(t *testing.T, allowed map[string]struct{}, downloader *fakeDownloader, mediaDir string, incoming ...*events.Message) []spoolRecord {
	t.Helper()
	spoolDir := t.TempDir()
	writer := newSpoolWriter(spoolDir)
	go writer.run()
	audio := &audioMediaStore{
		dir:        mediaDir,
		downloader: downloader,
	}
	for _, evt := range incoming {
		handleEvent(context.Background(), nil, audio, writer, make(chan string, 1), nil, allowed, evt)
	}
	writer.close()

	files, err := filepath.Glob(filepath.Join(spoolDir, "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var records []spoolRecord
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if line == "" {
				continue
			}
			var rec spoolRecord
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				t.Fatalf("spool line %q: %v", line, err)
			}
			records = append(records, rec)
		}
	}
	return records
}

func TestCaptureScopeOnlySpoolsApprovedChats(t *testing.T) {
	approved := types.JID{User: "15551230001", Server: types.DefaultUserServer}
	outside := types.JID{User: "15551230002", Server: types.DefaultUserServer}
	scope := map[string]struct{}{approved.String(): {}}

	records := captureThroughHandler(t, scope, &fakeDownloader{}, filepath.Join(t.TempDir(), "audio"),
		textEvent(outside, "outside-1", "private note"),
		textEvent(approved, "approved-1", "hello"),
		textEvent(outside, "outside-2", "another private note"),
		textEvent(types.JID{}, "no-chat", "no chat at all"),
	)
	if len(records) != 1 || records[0].ID != "approved-1" || records[0].ChatJID != approved.String() {
		t.Fatalf("spool = %#v, want only the approved chat's message", records)
	}
}

func TestCaptureScopeAppliesToReactions(t *testing.T) {
	group := "12036303990000000000@g.us"
	react := func() *events.Message {
		return reactionEvent("reaction-1", reactionMessage("👍", "target-1", group, 1_700_000_000_000))
	}

	denied := captureThroughHandler(t, map[string]struct{}{"15551230001@s.whatsapp.net": {}}, &fakeDownloader{}, filepath.Join(t.TempDir(), "audio"), react())
	if len(denied) != 0 {
		t.Fatalf("reaction in an unapproved chat reached the spool: %#v", denied)
	}
	allowed := captureThroughHandler(t, map[string]struct{}{group: {}}, &fakeDownloader{}, filepath.Join(t.TempDir(), "audio"), react())
	if len(allowed) != 1 || allowed[0].MediaType != "reaction" || allowed[0].ReactionKey != "👍" || allowed[0].ReactionTargetID != "target-1" {
		t.Fatalf("reaction in an approved chat = %#v, want one reaction record", allowed)
	}
}

// An out-of-scope voice note must not even be downloaded: the scope is enforced
// before any per-message work, not only at the spool write.
func TestCaptureScopeSkipsAudioDownloadForUnapprovedChats(t *testing.T) {
	downloader := &fakeDownloader{bytes: []byte("voice-bytes")}
	mediaDir := filepath.Join(t.TempDir(), "media", "audio")
	scope := map[string]struct{}{"15551230001@s.whatsapp.net": {}}

	records := captureThroughHandler(t, scope, downloader, mediaDir, audioEvent("voice:outside", audioMessage(10)))
	if len(records) != 0 {
		t.Fatalf("unapproved voice note was spooled: %#v", records)
	}
	if downloader.calls != 0 {
		t.Fatalf("unapproved voice note was downloaded %d times", downloader.calls)
	}
	if _, err := os.Stat(mediaDir); !os.IsNotExist(err) {
		t.Fatalf("media cache was created for an unapproved chat: %v", err)
	}

	scope = map[string]struct{}{"15551234567@s.whatsapp.net": {}}
	records = captureThroughHandler(t, scope, downloader, mediaDir, audioEvent("voice:inside", audioMessage(10)))
	if len(records) != 1 || records[0].DownloadStatus != "ok" || downloader.calls != 1 {
		t.Fatalf("approved voice note: records %#v, downloads %d", records, downloader.calls)
	}
}

func TestCaptureScopeWholeAccountAndUnscopedSpoolEverything(t *testing.T) {
	chats := []types.JID{
		{User: "15551230001", Server: types.DefaultUserServer},
		{User: "12036303990000000000", Server: types.GroupServer},
	}
	for name, scope := range map[string]map[string]struct{}{
		"whole account": {"*": {}},
		"no flag":       nil,
	} {
		t.Run(name, func(t *testing.T) {
			records := captureThroughHandler(t, scope, &fakeDownloader{}, filepath.Join(t.TempDir(), "audio"),
				textEvent(chats[0], "one", "hello"),
				textEvent(chats[1], "two", "hi"),
			)
			if len(records) != 2 {
				t.Fatalf("spool = %#v, want both chats", records)
			}
		})
	}
}
