// olympus-whatsapp-bridge: READ-ONLY personal-WhatsApp capture daemon.
//
// Connects to WhatsApp as a linked device (whatsmeow, unofficial client — a
// risk the owner explicitly accepted) and appends one JSON line per incoming or
// outgoing message to a local spool. The TypeScript side
// (src/workers/whatsapp/live-connector.ts) reads the spool; the shared
// connector-store machinery does storage and search. This process is the ONLY
// part of Olympus that talks to WhatsApp.
//
// READ-ONLY GUARANTEE: this daemon never sends messages, never marks chats
// read, and exposes no control surface (no sockets, no HTTP, no IPC). It
// imports whatsmeow only to receive. The protocol-level acks whatsmeow emits
// internally to keep the session alive are the unavoidable minimum; nothing
// here calls SendMessage, MarkRead, SendPresence, or any other outbound API.
// Keep it that way: a capture daemon with a send path is an attack surface.
//
// Spool format: ${state dir}/spool/YYYY-MM-DD.jsonl, one JSON object per line:
//
//	{"id","chat_jid","chat_name","sender_jid","sender_name","from_me",
//	 "timestamp" (RFC3339), "text", "mentions" (only when mentions resolve),
//	 "preview_title","preview_description","preview_url" (only when present),
//	 "media_type" (only on non-text lines),
//	 "reaction_target_id","reaction_target_chat_jid","reaction_key",
//	 "reaction_removed","reaction_sender_timestamp_ms" (reaction lines only)}
//
// Files are named by RECEIVE date (UTC wall clock), not message timestamp, so
// only the newest file ever grows — that append-only ordering is what makes
// the TypeScript connector's "file:line" cursor resumable. Non-text payloads
// (images, voice notes, documents, ...) are recorded with empty text and a
// media_type note; protocol-only noise (key distribution, receipts) is not
// spooled at all. Batches are fsynced before the writer sleeps. Restarts can
// re-deliver recent offline messages; downstream ingest dedupes on the
// WhatsApp message id, so duplicate spool lines are harmless.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	_ "github.com/mattn/go-sqlite3"
	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

const (
	stateDirEnv     = "OLYMPUS_WHATSAPP_STATE_DIR"
	qrStdoutEnv     = "OLYMPUS_WHATSAPP_QR_STDOUT"
	defaultStateRel = ".local/share/olympus/whatsapp-live"
	spoolDirName    = "spool"
	qrFileName      = "qr.txt"
	sessionDBName   = "session.db"

	spoolQueueSize    = 4096
	connectBackoffMin = 2 * time.Second
	connectBackoffMax = 5 * time.Minute

	audioMediaMaxFileBytes = 25 * 1024 * 1024
	audioMediaQuotaBytes   = 5 * 1024 * 1024 * 1024

	previewTitleMaxBytes       = 256
	previewDescriptionMaxBytes = 1024
	previewURLMaxBytes         = 1024

	// The connector turns reaction_key into a shared reaction token, which the
	// store caps at 64 CHARACTERS (UTF-16 code units). A UTF-8 rune is never
	// shorter in bytes than in UTF-16 code units, so a 64-BYTE bound here can
	// never emit a token the store would refuse.
	reactionKeyMaxBytes           = 64
	reactionTargetIDMaxBytes      = 128
	reactionTargetChatJIDMaxBytes = 256
)

// spoolRecord is the wire format of one spool line. Field names are a frozen
// contract with src/workers/whatsapp/live-connector.ts — do not rename.
type spoolRecord struct {
	ID                   string            `json:"id"`
	ChatJID              string            `json:"chat_jid"`
	ChatName             string            `json:"chat_name"`
	SenderJID            string            `json:"sender_jid"`
	SenderName           string            `json:"sender_name"`
	FromMe               bool              `json:"from_me"`
	Timestamp            string            `json:"timestamp"`
	Text                 string            `json:"text"`
	Mentions             map[string]string `json:"mentions,omitempty"`
	PreviewTitle         string            `json:"preview_title,omitempty"`
	PreviewDescription   string            `json:"preview_description,omitempty"`
	PreviewURL           string            `json:"preview_url,omitempty"`
	MediaType            string            `json:"media_type,omitempty"`
	MediaPath            string            `json:"media_path,omitempty"`
	MediaMime            string            `json:"media_mime,omitempty"`
	MediaDurationSeconds uint32            `json:"media_duration_seconds,omitempty"`
	MediaSizeBytes       int64             `json:"media_size_bytes,omitempty"`
	DownloadStatus       string            `json:"download_status,omitempty"`
	MediaKey             string            `json:"media_key,omitempty"`
	MediaDirectPath      string            `json:"media_direct_path,omitempty"`
	MediaFileSHA256      string            `json:"media_file_sha256,omitempty"`
	MediaFileEncSHA256   string            `json:"media_file_enc_sha256,omitempty"`
	MediaKeyTimestamp    int64             `json:"media_key_timestamp,omitempty"`
	// Reaction payload. Present only on media_type "reaction" lines, which stay
	// empty-text records with every required field populated so an older
	// connector build still counts them as valid (it just ignores these).
	// Removal is the explicit boolean, never an empty reaction_key: "the key is
	// missing" and "this reaction was taken back" must not be the same state.
	ReactionTargetID          string `json:"reaction_target_id,omitempty"`
	ReactionTargetChatJID     string `json:"reaction_target_chat_jid,omitempty"`
	ReactionKey               string `json:"reaction_key,omitempty"`
	ReactionRemoved           bool   `json:"reaction_removed,omitempty"`
	ReactionSenderTimestampMS int64  `json:"reaction_sender_timestamp_ms,omitempty"`
}

func main() {
	// The linked-device store and every derivative written by this process are
	// secret-bearing local state. Keep safe modes even when the daemon is run
	// manually instead of through the systemd unit (which also sets UMask=0077).
	syscall.Umask(0o077)

	stateDir, err := resolveStateDir()
	if err != nil {
		log.Fatalf("olympus-whatsapp-bridge: %v", err)
	}
	spoolDir := filepath.Join(stateDir, spoolDirName)
	if err := os.MkdirAll(spoolDir, 0o700); err != nil {
		log.Fatalf("olympus-whatsapp-bridge: creating spool dir %s: %v", spoolDir, err)
	}

	ctx := context.Background()
	dbPath := filepath.Join(stateDir, sessionDBName)
	container, err := sqlstore.New(ctx, "sqlite3", "file:"+dbPath+"?_foreign_keys=on", waLog.Stdout("Database", "WARN", true))
	if err != nil {
		log.Fatalf("olympus-whatsapp-bridge: opening session store %s: %v", dbPath, err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		log.Fatalf("olympus-whatsapp-bridge: loading device from session store: %v", err)
	}

	client := whatsmeow.NewClient(device, waLog.Stdout("Client", "INFO", true))
	writer := newSpoolWriter(spoolDir)
	audioStore := newAudioMediaStore(stateDir, client)
	go writer.run()

	fatalEvents := make(chan string, 1)
	client.AddEventHandler(func(evt any) {
		handleEvent(ctx, client, audioStore, writer, fatalEvents, evt)
	})

	if client.Store.ID == nil {
		// First run: pair as a linked device. The QR channel must be opened
		// before Connect. Each fresh code always goes to ${state}/qr.txt and
		// only reaches stdout during an intentional foreground pairing run.
		qrChan, err := client.GetQRChannel(ctx)
		if err != nil {
			log.Fatalf("olympus-whatsapp-bridge: opening QR channel: %v", err)
		}
		connectWithBackoff(client)
		paired := false
		for item := range qrChan {
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				emitQR(item.Code, stateDir, qrStdoutEnabled())
			case whatsmeow.QRChannelSuccess.Event:
				paired = true
				removeQRFile(stateDir)
				log.Printf("olympus-whatsapp-bridge: paired successfully; capturing messages")
			case whatsmeow.QRChannelTimeout.Event:
				removeQRFile(stateDir)
				log.Fatalf("olympus-whatsapp-bridge: pairing timed out before the QR code was scanned; restart the daemon to get a fresh code")
			case whatsmeow.QRChannelEventError:
				removeQRFile(stateDir)
				log.Fatalf("olympus-whatsapp-bridge: pairing failed: %v", item.Error)
			default:
				log.Printf("olympus-whatsapp-bridge: pairing event %q", item.Event)
			}
		}
		if !paired {
			log.Fatalf("olympus-whatsapp-bridge: pairing did not complete; restart the daemon to retry")
		}
	} else {
		connectWithBackoff(client)
		// Never put a WhatsApp account identifier into operational logs.
		log.Print(existingSessionConnectedLogLine())
	}

	// Steady state: whatsmeow's auto-reconnect (enabled by default) handles
	// transient drops with its own backoff. We only exit on signals or on
	// fatal session events (logged out, stream replaced) — systemd's
	// Restart=always brings the daemon back, which re-enters pairing if the
	// session is gone.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case s := <-sig:
		log.Printf("olympus-whatsapp-bridge: received %v, shutting down", s)
		client.Disconnect()
		writer.close()
	case reason := <-fatalEvents:
		client.Disconnect()
		writer.close()
		log.Fatalf("olympus-whatsapp-bridge: %s", reason)
	}
}

func existingSessionConnectedLogLine() string {
	return "olympus-whatsapp-bridge: connected with existing session"
}

func qrStdoutEnabled() bool {
	value, configured := os.LookupEnv(qrStdoutEnv)
	if !configured {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func resolveStateDir() (string, error) {
	if dir := os.Getenv(stateDirEnv); dir != "" {
		return dir, os.MkdirAll(dir, 0o700)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("%s is unset and the home directory is unknown: %w", stateDirEnv, err)
	}
	dir := filepath.Join(home, defaultStateRel)
	return dir, os.MkdirAll(dir, 0o700)
}

func connectWithBackoff(client *whatsmeow.Client) {
	backoff := connectBackoffMin
	for {
		err := client.Connect()
		if err == nil || errors.Is(err, whatsmeow.ErrAlreadyConnected) {
			return
		}
		log.Printf("olympus-whatsapp-bridge: connect failed (%v); retrying in %s", err, backoff)
		time.Sleep(backoff)
		backoff *= 2
		if backoff > connectBackoffMax {
			backoff = connectBackoffMax
		}
	}
}

// --- Event handling ----------------------------------------------------------

func handleEvent(ctx context.Context, client *whatsmeow.Client, audioStore *audioMediaStore, writer *spoolWriter, fatalEvents chan<- string, evt any) {
	switch v := evt.(type) {
	case *events.Message:
		if rec, ok := recordFromMessage(ctx, client, audioStore, v); ok {
			writer.enqueue(rec)
		}
	case *events.Disconnected:
		log.Printf("olympus-whatsapp-bridge: disconnected; whatsmeow auto-reconnect will retry with backoff")
	case *events.Connected:
		log.Printf("olympus-whatsapp-bridge: connected")
	case *events.LoggedOut:
		reportFatal(fatalEvents, "logged out by the phone (Linked Devices); restart the daemon and re-pair")
	case *events.StreamReplaced:
		reportFatal(fatalEvents, "stream replaced: another client connected with this session; restarting")
	}
}

func reportFatal(fatalEvents chan<- string, reason string) {
	select {
	case fatalEvents <- reason:
	default:
	}
}

func recordFromMessage(ctx context.Context, client *whatsmeow.Client, audioStore *audioMediaStore, evt *events.Message) (spoolRecord, bool) {
	text, mediaType, ok := classifyPayload(evt.Message)
	if !ok {
		return spoolRecord{}, false
	}
	text, mentions := resolveMessageMentions(ctx, client, evt.Message, text)
	info := evt.Info
	rec := spoolRecord{
		ID:         string(info.ID),
		ChatJID:    info.Chat.String(),
		ChatName:   chatDisplayName(ctx, client, info.Chat),
		SenderJID:  info.Sender.String(),
		SenderName: info.PushName,
		FromMe:     info.IsFromMe,
		Timestamp:  info.Timestamp.UTC().Format(time.RFC3339),
		Text:       text,
		Mentions:   mentions,
		MediaType:  mediaType,
	}
	rec.applyLinkPreview(evt.Message.GetExtendedTextMessage())
	rec.applyReaction(evt.Message.GetReactionMessage())
	if audio := evt.Message.GetAudioMessage(); audio != nil {
		rec.applyAudioCapture(audioStore.capture(ctx, rec.ID, audio))
	}
	return rec, true
}

func (rec *spoolRecord) applyLinkPreview(ext *waE2E.ExtendedTextMessage) {
	if ext == nil || ext.GetText() == "" {
		return
	}
	rec.PreviewTitle = sanitizePreviewField(ext.GetTitle(), previewTitleMaxBytes)
	rec.PreviewDescription = sanitizePreviewField(ext.GetDescription(), previewDescriptionMaxBytes)
	rec.PreviewURL = sanitizePreviewField(ext.GetMatchedText(), previewURLMaxBytes)
}

// applyReaction records who reacted to what. whatsmeow has no dedicated
// reaction event: the payload rides *events.Message, so the reactor is the
// envelope's sender (already on the record) and the reacted message is the
// ReactionMessage key. The daemon stays a dumb pipe — it counts nothing and
// keeps no state; the connector aggregates these lines over the whole spool.
func (rec *spoolRecord) applyReaction(reaction *waE2E.ReactionMessage) {
	if reaction == nil {
		return
	}
	key := reaction.GetKey()
	rec.ReactionTargetID = sanitizePreviewField(key.GetID(), reactionTargetIDMaxBytes)
	rec.ReactionTargetChatJID = sanitizePreviewField(key.GetRemoteJID(), reactionTargetChatJIDMaxBytes)
	// An empty ReactionMessage text IS the removal signal on the wire.
	rec.ReactionRemoved = reaction.GetText() == ""
	if !rec.ReactionRemoved {
		rec.ReactionKey = sanitizePreviewField(reaction.GetText(), reactionKeyMaxBytes)
	}
	rec.ReactionSenderTimestampMS = reaction.GetSenderTimestampMS()
}

func sanitizePreviewField(value string, maxBytes int) string {
	if value == "" || maxBytes <= 0 {
		return ""
	}
	var sanitized strings.Builder
	sanitized.Grow(min(len(value), maxBytes))
	bytesWritten := 0
	for _, r := range value {
		if unicode.IsControl(r) {
			continue
		}
		runeBytes := utf8.RuneLen(r)
		if runeBytes < 0 || bytesWritten+runeBytes > maxBytes {
			break
		}
		sanitized.WriteRune(r)
		bytesWritten += runeBytes
	}
	return strings.TrimSpace(sanitized.String())
}

func (rec *spoolRecord) applyAudioCapture(result audioCaptureResult) {
	rec.MediaMime = result.MediaMime
	rec.MediaDurationSeconds = result.MediaDurationSeconds
	rec.MediaSizeBytes = result.MediaSizeBytes
	rec.DownloadStatus = result.DownloadStatus
	rec.MediaPath = result.MediaPath
	rec.MediaKey = result.MediaKey
	rec.MediaDirectPath = result.MediaDirectPath
	rec.MediaFileSHA256 = result.MediaFileSHA256
	rec.MediaFileEncSHA256 = result.MediaFileEncSHA256
	rec.MediaKeyTimestamp = result.MediaKeyTimestamp
}

// classifyPayload returns the text of a text message, or an empty text plus a
// media_type note for non-text content. ok=false means protocol-only noise
// that should not be spooled at all.
func classifyPayload(msg *waE2E.Message) (text string, mediaType string, ok bool) {
	if msg == nil {
		return "", "", false
	}
	if t := msg.GetConversation(); t != "" {
		return t, "", true
	}
	if ext := msg.GetExtendedTextMessage(); ext != nil && ext.GetText() != "" {
		return ext.GetText(), "", true
	}
	switch {
	case msg.GetImageMessage() != nil:
		return "", "image", true
	case msg.GetVideoMessage() != nil:
		return "", "video", true
	case msg.GetPtvMessage() != nil:
		return "", "video_note", true
	case msg.GetAudioMessage() != nil:
		return "", "audio", true
	case msg.GetDocumentMessage() != nil:
		return "", "document", true
	case msg.GetStickerMessage() != nil:
		return "", "sticker", true
	case msg.GetContactMessage() != nil, msg.GetContactsArrayMessage() != nil:
		return "", "contact", true
	case msg.GetLocationMessage() != nil, msg.GetLiveLocationMessage() != nil:
		return "", "location", true
	case msg.GetPollCreationMessage() != nil,
		msg.GetPollCreationMessageV2() != nil,
		msg.GetPollCreationMessageV3() != nil:
		return "", "poll", true
	case msg.GetReactionMessage() != nil:
		return "", "reaction", true
	case msg.GetEventMessage() != nil:
		return "", "event", true
	}
	// Protocol machinery (key distribution, history sync notifications,
	// receipts): nothing a human said — keep it out of the spool.
	return "", "", false
}

type mentionResolver func(types.JID) string

func resolveMessageMentions(ctx context.Context, client *whatsmeow.Client, msg *waE2E.Message, text string) (string, map[string]string) {
	mentionedJIDs := mentionedJIDsFromMessage(msg)
	if len(mentionedJIDs) == 0 || text == "" {
		return text, nil
	}
	return resolveMentionsInText(text, mentionedJIDs, func(jid types.JID) string {
		return mentionDisplayName(ctx, client, jid)
	})
}

func mentionedJIDsFromMessage(msg *waE2E.Message) []string {
	if msg == nil {
		return nil
	}
	if ext := msg.GetExtendedTextMessage(); ext != nil {
		return ext.GetContextInfo().GetMentionedJID()
	}
	return nil
}

func resolveMentionsInText(text string, mentionedJIDs []string, resolve mentionResolver) (string, map[string]string) {
	replacements := map[string]string{}
	for _, rawJID := range mentionedJIDs {
		jid, ok := parseMentionJID(rawJID)
		if !ok || jid.User == "" {
			continue
		}
		display := strings.TrimSpace(resolve(jid))
		if display == "" {
			continue
		}
		rawToken := "@" + jid.User
		displayToken := "@" + display
		if !strings.Contains(text, rawToken) {
			continue
		}
		replacements[jid.User] = display
		text = strings.ReplaceAll(text, rawToken, displayToken)
	}
	if len(replacements) == 0 {
		return text, nil
	}
	return text, replacements
}

func parseMentionJID(raw string) (types.JID, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return types.JID{}, false
	}
	jid, err := types.ParseJID(text)
	if err == nil {
		return jid, true
	}
	if !strings.Contains(text, "@") {
		return types.JID{User: text, Server: types.HiddenUserServer}, true
	}
	return types.JID{}, false
}

func mentionDisplayName(ctx context.Context, client *whatsmeow.Client, jid types.JID) string {
	if client == nil || client.Store == nil {
		return ""
	}
	if isOwnJID(client, jid) {
		return "you"
	}
	contactJID := jid
	if jid.Server == types.HiddenUserServer && client.Store.LIDs != nil {
		if pn, err := client.Store.LIDs.GetPNForLID(ctx, jid); err == nil && pn.User != "" {
			contactJID = pn
		}
	}
	if contactJID.Server == types.DefaultUserServer && client.Store.Contacts != nil {
		contact, err := client.Store.Contacts.GetContact(ctx, contactJID)
		if err == nil && contact.Found {
			return contactInfoDisplayName(contact)
		}
	}
	return ""
}

func isOwnJID(client *whatsmeow.Client, jid types.JID) bool {
	if client == nil || client.Store == nil || jid.User == "" {
		return false
	}
	if ownLID := client.Store.GetLID(); ownLID.User != "" && ownLID.User == jid.User && ownLID.Server == jid.Server {
		return true
	}
	ownPN := client.Store.GetJID()
	return ownPN.User != "" && ownPN.User == jid.User && ownPN.Server == jid.Server
}

func contactInfoDisplayName(contact types.ContactInfo) string {
	if contact.FullName != "" {
		return contact.FullName
	}
	if contact.PushName != "" {
		return contact.PushName
	}
	if contact.BusinessName != "" {
		return contact.BusinessName
	}
	return contact.FirstName
}

// --- Audio media capture -----------------------------------------------------

type mediaDownloader interface {
	Download(ctx context.Context, msg whatsmeow.DownloadableMessage) ([]byte, error)
}

type audioMediaStore struct {
	dir          string
	maxFileBytes int64
	quotaBytes   int64
	downloader   mediaDownloader
}

type audioCaptureResult struct {
	MediaPath            string
	MediaMime            string
	MediaDurationSeconds uint32
	MediaSizeBytes       int64
	DownloadStatus       string
	MediaKey             string
	MediaDirectPath      string
	MediaFileSHA256      string
	MediaFileEncSHA256   string
	MediaKeyTimestamp    int64
}

func newAudioMediaStore(stateDir string, downloader mediaDownloader) *audioMediaStore {
	return &audioMediaStore{
		dir:          filepath.Join(stateDir, "media", "audio"),
		maxFileBytes: audioMediaMaxFileBytes,
		quotaBytes:   audioMediaQuotaBytes,
		downloader:   downloader,
	}
}

func (store *audioMediaStore) capture(ctx context.Context, messageID string, audio *waE2E.AudioMessage) audioCaptureResult {
	result := audioRetryFields(audio)
	result.MediaMime = audio.GetMimetype()
	result.MediaDurationSeconds = audio.GetSeconds()
	result.MediaSizeBytes = int64(audio.GetFileLength())
	if store == nil || store.downloader == nil {
		result.DownloadStatus = "failed:not_configured"
		return result
	}
	if result.MediaSizeBytes > store.maxFileBytes {
		result.DownloadStatus = "too_large"
		return result
	}

	bytes, err := store.downloader.Download(ctx, audio)
	if err != nil {
		result.DownloadStatus = "failed:" + classifyDownloadError(err)
		return result
	}
	result.MediaSizeBytes = int64(len(bytes))
	if result.MediaSizeBytes > store.maxFileBytes {
		result.DownloadStatus = "too_large"
		return result
	}
	path, err := store.write(messageID, result.MediaMime, bytes)
	if err != nil {
		result.DownloadStatus = "failed:" + classifyDownloadError(err)
		return result
	}
	result.MediaPath = path
	result.DownloadStatus = "ok"
	if err := store.enforceQuota(path); err != nil {
		log.Printf("olympus-whatsapp-bridge: audio media quota enforcement failed: %v", err)
	}
	return result
}

func audioRetryFields(audio *waE2E.AudioMessage) audioCaptureResult {
	return audioCaptureResult{
		MediaKey:           base64.StdEncoding.EncodeToString(audio.GetMediaKey()),
		MediaDirectPath:    audio.GetDirectPath(),
		MediaFileSHA256:    base64.StdEncoding.EncodeToString(audio.GetFileSHA256()),
		MediaFileEncSHA256: base64.StdEncoding.EncodeToString(audio.GetFileEncSHA256()),
		MediaKeyTimestamp:  audio.GetMediaKeyTimestamp(),
	}
}

func (store *audioMediaStore) write(messageID string, mediaMime string, bytes []byte) (string, error) {
	if err := os.MkdirAll(store.dir, 0o700); err != nil {
		return "", err
	}
	name := safeMediaFileStem(messageID) + extensionFromMime(mediaMime)
	path := filepath.Join(store.dir, name)
	tmp, err := os.OpenFile(path+".tmp", os.O_TRUNC|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := tmp.Write(bytes); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

type mediaFileInfo struct {
	path    string
	size    int64
	modTime time.Time
}

func (store *audioMediaStore) enforceQuota(protectedPath string) error {
	entries, err := os.ReadDir(store.dir)
	if err != nil {
		return err
	}
	var total int64
	files := make([]mediaFileInfo, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		path := filepath.Join(store.dir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		total += info.Size()
		files = append(files, mediaFileInfo{path: path, size: info.Size(), modTime: info.ModTime()})
	}
	if total <= store.quotaBytes {
		return nil
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.Before(files[j].modTime)
	})
	for _, file := range files {
		if total <= store.quotaBytes {
			break
		}
		if file.path == protectedPath {
			continue
		}
		if err := os.Remove(file.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		total -= file.size
	}
	return nil
}

func classifyDownloadError(err error) string {
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "no url") || strings.Contains(text, "url"):
		return "no_url"
	case strings.Contains(text, "too large"):
		return "too_large"
	case strings.Contains(text, "permission"):
		return "permission"
	case strings.Contains(text, "timeout") || strings.Contains(text, "deadline"):
		return "timeout"
	default:
		return "download"
	}
}

func safeMediaFileStem(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "message"
	}
	return b.String()
}

func extensionFromMime(mediaMime string) string {
	mediaType, _, err := mime.ParseMediaType(mediaMime)
	if err != nil || mediaType == "" {
		mediaType = mediaMime
	}
	switch strings.ToLower(mediaType) {
	case "audio/ogg":
		return ".ogg"
	case "audio/opus":
		return ".opus"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/mp4", "audio/x-m4a":
		return ".m4a"
	case "audio/aac":
		return ".aac"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/webm":
		return ".webm"
	}
	if extensions, err := mime.ExtensionsByType(mediaType); err == nil && len(extensions) > 0 {
		return extensions[0]
	}
	return ".bin"
}

// chatDisplayName resolves a human name for direct chats from the local
// contact store (an offline read — never a network query). Group names are
// not resolved: doing so would require live group-metadata queries, and the
// connector falls back to the chat JID when chat_name is empty.
func chatDisplayName(ctx context.Context, client *whatsmeow.Client, chat types.JID) string {
	if client == nil || client.Store == nil {
		return ""
	}
	return chatDisplayNameFromStores(ctx, client.Store.Contacts, client.Store.LIDs, chat)
}

type contactLookup interface {
	GetContact(ctx context.Context, user types.JID) (types.ContactInfo, error)
}

type lidLookup interface {
	GetPNForLID(ctx context.Context, lid types.JID) (types.JID, error)
}

func chatDisplayNameFromStores(ctx context.Context, contacts contactLookup, lids lidLookup, chat types.JID) string {
	if contacts == nil {
		return ""
	}
	switch chat.Server {
	case types.DefaultUserServer:
		return contactDisplayName(ctx, contacts, chat)
	case types.HiddenUserServer:
		if lids == nil {
			return ""
		}
		pn, err := lids.GetPNForLID(ctx, chat)
		if err != nil || pn.IsEmpty() {
			return ""
		}
		return contactDisplayName(ctx, contacts, pn)
	default:
		return ""
	}
}

func contactDisplayName(ctx context.Context, contacts contactLookup, jid types.JID) string {
	contact, err := contacts.GetContact(ctx, jid)
	if err != nil || !contact.Found {
		return ""
	}
	return contactInfoDisplayName(contact)
}

// --- Spool writer --------------------------------------------------------------

// spoolWriter serializes all spool appends through one goroutine. Each wake-up
// drains everything queued, writes the lines, then fsyncs once per batch — a
// durability/throughput trade that keeps a burst of messages from costing one
// fsync each.
type spoolWriter struct {
	spoolDir string
	records  chan spoolRecord
	done     chan struct{}

	file     *os.File
	fileDate string
}

func newSpoolWriter(spoolDir string) *spoolWriter {
	return &spoolWriter{
		spoolDir: spoolDir,
		records:  make(chan spoolRecord, spoolQueueSize),
		done:     make(chan struct{}),
	}
}

func (w *spoolWriter) enqueue(rec spoolRecord) {
	select {
	case w.records <- rec:
	default:
		// Queue full means the disk has been failing writes for thousands of
		// messages; losing this line is the lesser evil vs. blocking the
		// whatsmeow event loop.
		log.Print("olympus-whatsapp-bridge: spool queue full, dropping one message")
	}
}

func (w *spoolWriter) run() {
	defer close(w.done)
	for rec := range w.records {
		batch := []spoolRecord{rec}
	drain:
		for {
			select {
			case more, open := <-w.records:
				if !open {
					break drain
				}
				batch = append(batch, more)
			default:
				break drain
			}
		}
		if err := w.writeBatch(batch); err != nil {
			// A spool that cannot be written means capture is silently dead.
			// Exit loudly; systemd restarts us and offline sync re-delivers.
			log.Fatalf("olympus-whatsapp-bridge: spool write failed: %v", err)
		}
	}
	if w.file != nil {
		w.file.Close()
	}
}

func (w *spoolWriter) close() {
	close(w.records)
	<-w.done
}

func (w *spoolWriter) writeBatch(batch []spoolRecord) error {
	for _, rec := range batch {
		date := time.Now().UTC().Format("2006-01-02")
		if w.file == nil || date != w.fileDate {
			if err := w.rotate(date); err != nil {
				return err
			}
		}
		line, err := json.Marshal(rec)
		if err != nil {
			return fmt.Errorf("encoding spool record: %w", err)
		}
		if _, err := w.file.Write(append(line, '\n')); err != nil {
			return fmt.Errorf("appending to %s: %w", w.file.Name(), err)
		}
	}
	if err := w.file.Sync(); err != nil {
		return fmt.Errorf("fsync %s: %w", w.file.Name(), err)
	}
	return nil
}

func (w *spoolWriter) rotate(date string) error {
	if w.file != nil {
		if err := w.file.Sync(); err != nil {
			return err
		}
		w.file.Close()
	}
	path := filepath.Join(w.spoolDir, date+".jsonl")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("opening spool file %s: %w", path, err)
	}
	w.file = file
	w.fileDate = date
	return nil
}

// --- Pairing QR ---------------------------------------------------------------

func emitQR(code string, stateDir string, showOnStdout bool) {
	if showOnStdout {
		fmt.Println("Scan this QR with WhatsApp on the phone: Settings > Linked Devices > Link a Device")
		qrterminal.GenerateHalfBlock(code, qrterminal.L, os.Stdout)
	}

	path := filepath.Join(stateDir, qrFileName)
	file, err := os.OpenFile(path, os.O_TRUNC|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		log.Printf("olympus-whatsapp-bridge: cannot write %s: %v", path, err)
		return
	}
	defer file.Close()
	// Plain block characters (no ANSI escapes) so `cat qr.txt` works anywhere.
	qrterminal.GenerateWithConfig(code, qrterminal.Config{
		Level:     qrterminal.L,
		Writer:    file,
		BlackChar: "██",
		WhiteChar: "  ",
		QuietZone: 2,
	})
	fmt.Fprintln(file, "Scan with WhatsApp: Settings > Linked Devices > Link a Device")
	log.Printf("olympus-whatsapp-bridge: QR code written to %s (codes rotate ~every 20s; re-read the file if scanning fails)", path)
}

func removeQRFile(stateDir string) {
	if err := os.Remove(filepath.Join(stateDir, qrFileName)); err != nil && !os.IsNotExist(err) {
		log.Printf("olympus-whatsapp-bridge: could not remove qr.txt: %v", err)
	}
}
