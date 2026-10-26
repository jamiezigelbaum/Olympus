package main

// Every message and every piece of media is kept (owner, 2026-10-26); the
// one safeguard is for the computer itself: a floor of free space on the
// volume the media folders are on, the larger of diskFloorMinBytes and
// diskFloorShare of the volume.
//
//   - A download is not started below the floor, and one already running
//     stops when the volume falls below it (the temp writer checks as it
//     writes). Its message is still spooled at once, with its media "waiting
//     for disk space" (download_status mediaWaitingStatus).
//   - What the later download needs is kept as `media/waiting/<stem>.json`
//     (the message's file stem): where the media is, the keys to open it,
//     and the digest of the line spooled for the message. Never the line's
//     words or names: an entry Olympus never grants holds nothing Secret.
//   - Waiting media is downloaded only after Olympus has judged its message
//     not Secret (owner, 2026-10-26). Olympus then writes a grant beside the
//     entry, `<stem>.grant`: the line it judged, and that line's digest. A
//     Secret message never gets one, so its media never touches disk.
//   - Every minute, once the volume is above the floor again, each granted
//     entry whose grant matches it (the same digest, the same message) is
//     downloaded in the order it waited, and the message is spooled again
//     from the grant's line with its media: Olympus fills the waiting child
//     from that line. An entry without a matching grant is not downloaded.
//     One that does not fit is skipped, so the smaller ones after it still
//     go; one that fails for a passing reason (the network) stays; only one
//     that can never be fetched (gone from WhatsApp's servers, failing its
//     hash) is spooled as failed. The entry and its grant go only once the
//     line is written and fsynced, so a crash at any point leaves at most a
//     granted download, kept or made again (the same bytes reuse the file).
//   - An entry never granted is dropped after waitingEntryKeep: by then
//     WhatsApp's servers no longer hold its media anyway.
//   - A waiting entry is written whole or not at all (a temp renamed into
//     place); the bridge sweeps a temp a killed bridge left at start and on
//     every pass.
//   - The capture status receipt says media is waiting for disk space, with
//     no count, while any entry waits and the volume is below the floor, or a
//     granted download is still to be made. An entry waiting only for
//     Olympus's judgment is not a disk problem.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
)

const (
	mediaWaitingStatus  = "waiting_for_disk"
	mediaWaitingDirName = "waiting"
	mediaGrantSuffix    = ".grant"
	mediaWaitingTempAge = time.Minute
	// An entry never granted is dropped after this: WhatsApp's servers keep media for less.
	waitingEntryKeep   = 30 * 24 * time.Hour
	diskFloorMinBytes  = 5 * 1024 * 1024 * 1024
	diskFloorShare     = 20 // one twentieth: 5% of the volume
	mediaRetryInterval = time.Minute
)

// The volume a new queue reads (tests give it one with room).
var defaultVolumeSpace = volumeSpace

// How many bytes a download writes between two checks of the floor.
var diskCheckEveryBytes int64 = 64 * 1024 * 1024

var errWaitingForDisk = errors.New("waiting for disk space")

// diskFloor is the free space the volume keeps: the larger of 5 GB and 5% of it.
func diskFloor(total uint64) uint64 {
	share := total / diskFloorShare
	if share > diskFloorMinBytes {
		return share
	}
	return diskFloorMinBytes
}

// mediaWaitQueue is the one floor and the one list of waiting downloads the
// three media stores share.
type mediaWaitQueue struct {
	dir    string
	space  func(dir string) (free uint64, total uint64, err error)
	status *captureStatus
	mu     sync.Mutex
}

func newMediaWaitQueue(stateDir string) *mediaWaitQueue {
	return &mediaWaitQueue{dir: filepath.Join(stateDir, "media", mediaWaitingDirName), space: defaultVolumeSpace}
}

// hasRoom says whether the volume holding dir is above the floor. A volume
// whose space cannot be read is never paused for it.
func (q *mediaWaitQueue) hasRoom(dir string) bool {
	if q == nil || q.space == nil {
		return true
	}
	free, total, err := q.space(existingAncestor(dir))
	if err != nil || total == 0 {
		return true
	}
	return free >= diskFloor(total)
}

func existingAncestor(dir string) string {
	for current := dir; ; current = filepath.Dir(current) {
		if _, err := os.Stat(current); err == nil || filepath.Dir(current) == current {
			return current
		}
	}
}

// waitingEntry is what a later download needs, and nothing the message said.
type waitingEntry struct {
	// The digest of the line spooled for the message (lineDigest): a grant names it.
	LineSHA256           string `json:"line_sha256"`
	ChatJID              string `json:"chat_jid"`
	ID                   string `json:"id"`
	MediaType            string `json:"media_type"`
	MediaMime            string `json:"media_mime,omitempty"`
	MediaDurationSeconds uint32 `json:"media_duration_seconds,omitempty"`
	MediaKey             string `json:"media_key,omitempty"`
	MediaDirectPath      string `json:"media_direct_path,omitempty"`
	MediaFileSHA256      string `json:"media_file_sha256,omitempty"`
	MediaFileEncSHA256   string `json:"media_file_enc_sha256,omitempty"`
	MediaKeyTimestamp    int64  `json:"media_key_timestamp,omitempty"`
}

// mediaGrant is Olympus's leave to download a waiting entry's media: the line
// it judged not Secret, and that line's digest.
type mediaGrant struct {
	LineSHA256 string `json:"line_sha256"`
	Line       string `json:"line"`
}

// lineDigest is the digest of a spool line as the spool writer writes it (without its newline).
func lineDigest(line []byte) string {
	sum := sha256.Sum256(line)
	return hex.EncodeToString(sum[:])
}

func (q *mediaWaitQueue) pathOf(rec spoolRecord) string {
	return filepath.Join(q.dir, mediaFileStem(rec.ChatJID, rec.ID)+".json")
}

// grantPathOf is where Olympus writes an entry's grant.
func grantPathOf(entryPath string) string {
	return strings.TrimSuffix(entryPath, ".json") + mediaGrantSuffix
}

// save keeps what a waiting message's download needs, and the digest of the
// line spooled for it (the same encoding the spool writer uses).
func (q *mediaWaitQueue) save(rec spoolRecord) {
	if q == nil {
		return
	}
	line, err := json.Marshal(rec)
	if err == nil {
		entry := waitingEntry{
			LineSHA256:           lineDigest(line),
			ChatJID:              rec.ChatJID,
			ID:                   rec.ID,
			MediaType:            rec.MediaType,
			MediaMime:            rec.MediaMime,
			MediaDurationSeconds: rec.MediaDurationSeconds,
			MediaKey:             rec.MediaKey,
			MediaDirectPath:      rec.MediaDirectPath,
			MediaFileSHA256:      rec.MediaFileSHA256,
			MediaFileEncSHA256:   rec.MediaFileEncSHA256,
			MediaKeyTimestamp:    rec.MediaKeyTimestamp,
		}
		var payload []byte
		if payload, err = json.Marshal(entry); err == nil {
			if err = os.MkdirAll(q.dir, 0o700); err == nil {
				err = writeFileAtomicPrivate(q.pathOf(rec), payload)
			}
		}
	}
	if err != nil {
		log.Printf("olympus-whatsapp-bridge: could not keep a message's media waiting for disk space: %v", err)
	}
	q.report()
}

// waiting is the waiting entries, oldest first.
func (q *mediaWaitQueue) waiting() []string {
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return nil
	}
	type named struct {
		path string
		at   time.Time
	}
	var found []named
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".json") || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		found = append(found, named{path: filepath.Join(q.dir, entry.Name()), at: info.ModTime()})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].at.Before(found[j].at) })
	paths := make([]string, 0, len(found))
	for _, each := range found {
		paths = append(paths, each.path)
	}
	return paths
}

// report tells the capture status whether media waits for disk space: an
// entry waits while the volume is below the floor, or a granted one is still
// to be fetched (an entry waiting only for Olympus's judgment is not a disk
// problem).
func (q *mediaWaitQueue) report() {
	if q == nil || q.status == nil {
		return
	}
	waiting := false
	low := !q.hasRoom(q.dir)
	for _, path := range q.waiting() {
		if low {
			waiting = true
			break
		}
		if entry, ok := readEntry(path); ok {
			if _, granted := grantFor(path, entry); granted {
				waiting = true
				break
			}
		}
	}
	q.status.setMediaWaiting(waiting)
}

// sweepTemps removes the temps of waiting entries a killed bridge never
// renamed into place (`.<stem>.json.tmp<random>`): all of them at start, when
// none is being written (minAge 0), and on every pass those past
// mediaWaitingTempAge (an entry is renamed into place at once).
func (q *mediaWaitQueue) sweepTemps(minAge time.Duration) {
	if q == nil {
		return
	}
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !isWaitingTemp(entry.Name()) {
			continue
		}
		if info, err := entry.Info(); err == nil && time.Since(info.ModTime()) >= minAge {
			_ = os.Remove(filepath.Join(q.dir, entry.Name()))
		}
	}
}

// isWaitingTemp says whether a name is the temp of a waiting entry's write (writeFileAtomicPrivate).
func isWaitingTemp(name string) bool {
	return strings.HasPrefix(name, ".") && strings.Contains(name, ".json.tmp")
}

// readEntry reads a waiting entry; ok is false for one that is gone or cannot be read.
func readEntry(path string) (waitingEntry, bool) {
	var entry waitingEntry
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &entry) != nil || entry.LineSHA256 == "" {
		return entry, false
	}
	return entry, true
}

// grantFor is the line an entry's grant gives leave to spool again with its
// media, when there is a grant and it matches the entry: the same digest, a
// line with that digest, and the same message.
func grantFor(entryPath string, entry waitingEntry) (spoolRecord, bool) {
	var rec spoolRecord
	raw, err := os.ReadFile(grantPathOf(entryPath))
	if err != nil {
		return rec, false
	}
	var grant mediaGrant
	if json.Unmarshal(raw, &grant) != nil || grant.LineSHA256 != entry.LineSHA256 || lineDigest([]byte(grant.Line)) != entry.LineSHA256 {
		return rec, false
	}
	if json.Unmarshal([]byte(grant.Line), &rec) != nil || rec.ID != entry.ID || rec.ChatJID != entry.ChatJID {
		return rec, false
	}
	return rec, true
}

// dropEntry removes an entry and its grant, the grant last.
func dropEntry(path string) {
	_ = os.Remove(path)
	_ = os.Remove(grantPathOf(path))
}

// run retries the waiting downloads every interval until ctx ends.
func (q *mediaWaitQueue) run(ctx context.Context, store *audioMediaStore, writer *spoolWriter) {
	if q == nil {
		return
	}
	q.report()
	ticker := time.NewTicker(mediaRetryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			q.retry(ctx, store, func(rec spoolRecord) error { return writer.writeDurably(ctx, rec) })
		}
	}
}

// permanentDownloadError says whether a download can never succeed (its
// media gone from WhatsApp's servers, or not what its hashes say); any other
// failure is passing, and the media keeps waiting.
func permanentDownloadError(err error) bool {
	var httpErr whatsmeow.DownloadHTTPError
	if errors.As(err, &httpErr) && httpErr.Response != nil {
		switch httpErr.Response.StatusCode {
		case 403, 404, 410:
			return true
		}
	}
	for _, permanent := range []error{
		whatsmeow.ErrNoURLPresent, whatsmeow.ErrUnknownMediaType, whatsmeow.ErrMediaNotAvailableOnPhone,
		whatsmeow.ErrInvalidMediaHMAC, whatsmeow.ErrInvalidMediaEncSHA256, whatsmeow.ErrInvalidMediaSHA256,
		whatsmeow.ErrInvalidUnencryptedMediaSHA256,
	} {
		if errors.Is(err, permanent) {
			return true
		}
	}
	return false
}

// retry downloads the granted waiting media while the volume is above the
// floor, in the order it waited, and spools each message again, from the
// line Olympus granted, with its media. An entry without a grant that matches
// it is not downloaded. An entry and its grant go only once `spool` says the
// line is durably written.
func (q *mediaWaitQueue) retry(ctx context.Context, store *audioMediaStore, spool func(spoolRecord) error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	defer q.report()
	q.sweepTemps(mediaWaitingTempAge)
	for _, path := range q.waiting() {
		entry, ok := readEntry(path)
		if !ok {
			dropEntry(path)
			continue
		}
		rec, granted := grantFor(path, entry)
		if !granted {
			// Not judged yet, or judged Secret: nothing is downloaded. One never granted goes in time.
			if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) >= waitingEntryKeep {
				dropEntry(path)
			}
			continue
		}
		kind := store.forMediaType(entry.MediaType)
		if kind == nil {
			dropEntry(path)
			continue
		}
		if !q.hasRoom(kind.dir) {
			return
		}
		saved, size, err := kind.downloadPath(ctx, entry.ChatJID, entry.ID, entry.MediaMime, retryRequestOf(entry))
		if errors.Is(err, errWaitingForDisk) {
			// Too large for the room there is now: the smaller ones after it may still fit.
			continue
		}
		if err != nil && !permanentDownloadError(err) {
			// A passing failure (the network): it stays waiting for the next pass.
			continue
		}
		if err != nil {
			rec.DownloadStatus = "failed:" + classifyDownloadError(err)
		} else {
			rec.MediaPath = saved
			rec.MediaSizeBytes = size
			rec.DownloadStatus = "ok"
		}
		if err := spool(rec); err != nil {
			// Not written: the entry and its grant stay, and the next pass makes the line again (the
			// same bytes reuse the file saved now).
			log.Printf("olympus-whatsapp-bridge: could not spool a message whose media was waiting: %v", err)
			continue
		}
		dropEntry(path)
	}
}

// forMediaType is the store a spooled media type saves into.
func (store *audioMediaStore) forMediaType(mediaType string) *audioMediaStore {
	if store == nil {
		return nil
	}
	switch mediaType {
	case "image":
		return store.images
	case "video", "video_note":
		return store.video
	case "audio":
		return store
	}
	return nil
}

// mediaRequest is what a download needs: where the media is and the keys to open it.
type mediaRequest struct {
	directPath string
	encSHA256  []byte
	fileSHA256 []byte
	mediaKey   []byte
	mediaType  whatsmeow.MediaType
}

func requestOf(media whatsmeow.DownloadableMessage) mediaRequest {
	request := mediaRequest{
		directPath: media.GetDirectPath(),
		encSHA256:  media.GetFileEncSHA256(),
		fileSHA256: media.GetFileSHA256(),
		mediaKey:   media.GetMediaKey(),
		mediaType:  whatsmeow.GetMediaType(media),
	}
	// As whatsmeow's DownloadToFile: media with a key but no encrypted hash is not encrypted.
	if request.encSHA256 == nil && request.mediaKey != nil {
		request.mediaKey = nil
	}
	return request
}

func retryRequestOf(rec waitingEntry) mediaRequest {
	decode := func(value string) []byte {
		if value == "" {
			return nil
		}
		raw, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(raw) == 0 {
			return nil
		}
		return raw
	}
	request := mediaRequest{
		directPath: rec.MediaDirectPath,
		encSHA256:  decode(rec.MediaFileEncSHA256),
		fileSHA256: decode(rec.MediaFileSHA256),
		mediaKey:   decode(rec.MediaKey),
	}
	switch rec.MediaType {
	case "image":
		request.mediaType = whatsmeow.MediaImage
	case "video", "video_note":
		request.mediaType = whatsmeow.MediaVideo
	default:
		request.mediaType = whatsmeow.MediaAudio
	}
	if request.encSHA256 == nil && request.mediaKey != nil {
		request.mediaKey = nil
	}
	return request
}
