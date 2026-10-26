package main

// Every message and every piece of media is kept (owner, 2026-10-26); the
// one safeguard is for the computer itself: a floor of free space on the
// volume the media folders are on, the larger of diskFloorMinBytes and
// diskFloorShare of the volume.
//
//   - A download is not started below the floor, and one already running
//     stops when the volume falls below it (the temp writer checks as it
//     writes). Its message is still spooled, with its media "waiting for
//     disk space" (download_status mediaWaitingStatus).
//   - The line is kept beside the media as `media/waiting/<stem>.json` (the
//     message's file stem). The bridge alone writes, changes and removes
//     these entries.
//   - Every minute, while any is waiting and the volume is above the floor
//     again, the waiting downloads are made in the order they waited, and
//     each message is spooled again with its media: Olympus fills the
//     waiting child from that line. One that does not fit is skipped, so the
//     smaller ones after it still go; one that fails for a passing reason
//     (the network) stays waiting; only one that can never be fetched (gone
//     from WhatsApp's servers, failing its hash) is spooled as failed. An
//     entry is removed only once its line is written and fsynced.
//   - Olympus clears a Secret message by asking, never by touching the entry:
//     it writes a clear request beside it, `<stem>.clear-<how>` (remove: the
//     media is Secrets; names or content: the words are), made exclusively
//     and fsynced, never removed by Olympus. The bridge applies every request
//     it finds before a download and again right before spooling: `remove`
//     drops the entry and what was downloaded for it; the others clear the
//     words in the entry and the line. A request that lands after that last
//     look is still met: Olympus checks every line it reads against the
//     requests, clears the line and deletes the media it names. So a request
//     always wins, whatever the interleaving, and nothing depends on two
//     processes excluding each other.
//   - A request is retired by the bridge alone, once its entry is gone and
//     it is older than clearRequestKeep (no line for that stem can follow).
//   - A waiting entry is written whole or not at all (a temp renamed into
//     place); the bridge sweeps a temp a killed bridge left at start and on
//     every pass.
//   - The capture status receipt says media is waiting, with no count, for
//     as long as any entry remains.

import (
	"context"
	"encoding/base64"
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
	clearRequestPrefix = ".clear-"
	// A request outlives its entry this long, so no line Olympus has yet to read misses it.
	clearRequestKeep    = 24 * time.Hour
	mediaWaitingTempAge = time.Minute
	mediaWaitingStatus  = "waiting_for_disk"
	mediaWaitingDirName = "waiting"
	diskFloorMinBytes   = 5 * 1024 * 1024 * 1024
	diskFloorShare      = 20 // one twentieth: 5% of the volume
	mediaRetryInterval  = time.Minute
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

func (q *mediaWaitQueue) pathOf(rec spoolRecord) string {
	return filepath.Join(q.dir, mediaFileStem(rec.ChatJID, rec.ID)+".json")
}

// save keeps a waiting message's line until its media can be downloaded.
func (q *mediaWaitQueue) save(rec spoolRecord) {
	if q == nil {
		return
	}
	payload, err := json.Marshal(rec)
	if err == nil {
		if err = os.MkdirAll(q.dir, 0o700); err == nil {
			err = writeFileAtomicPrivate(q.pathOf(rec), payload)
		}
	}
	if err != nil {
		log.Printf("olympus-whatsapp-bridge: could not keep a message's media waiting for disk space: %v", err)
	}
	q.report()
}

// waiting is the waiting lines, oldest first.
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
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".json") {
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

// report tells the capture status whether any media is waiting.
func (q *mediaWaitQueue) report() {
	if q == nil || q.status == nil {
		return
	}
	q.status.setMediaWaiting(len(q.waiting()) > 0)
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

// clearHow ranks what a clear request asks: removing the media and the
// entry is more than clearing the names, which is more than clearing the words.
var clearHow = map[string]int{"content": 1, "names": 2, "remove": 3}

// clearRequestOf is the most any clear request for this entry asks, or "".
func (q *mediaWaitQueue) clearRequestOf(stem string) string {
	strongest := ""
	for how := range clearHow {
		if _, err := os.Stat(filepath.Join(q.dir, stem+clearRequestPrefix+how)); err == nil && clearHow[how] > clearHow[strongest] {
			strongest = how
		}
	}
	return strongest
}

// applyClear clears a record as a request asks (not `remove`, which drops it).
func applyClear(rec *spoolRecord, how string) {
	if how != "content" && how != "names" {
		return
	}
	rec.Text = ""
	rec.PreviewTitle = ""
	rec.PreviewDescription = ""
	rec.PreviewURL = ""
	rec.Mentions = nil
	if how == "names" {
		rec.ChatName = ""
		rec.SenderName = ""
		rec.SenderContactName = ""
	}
	rec.SecretRedacted = true
}

// retireRequests removes the clear requests whose entry is gone and that are
// past clearRequestKeep: no line for their stem can follow.
func (q *mediaWaitQueue) retireRequests(now time.Time) {
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		at := strings.Index(name, clearRequestPrefix)
		if at <= 0 || !entry.Type().IsRegular() {
			continue
		}
		stem := name[:at]
		if _, err := os.Stat(filepath.Join(q.dir, stem+".json")); err == nil {
			continue
		}
		if info, err := entry.Info(); err == nil && now.Sub(info.ModTime()) >= clearRequestKeep {
			_ = os.Remove(filepath.Join(q.dir, name))
		}
	}
}

// readEntry reads a waiting entry; ok is false for one that is gone or cannot be read.
func readEntry(path string) (spoolRecord, bool) {
	var rec spoolRecord
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &rec) != nil {
		return rec, false
	}
	return rec, true
}

// honour applies a waiting entry's clear request, if any, and says whether
// the entry is still to be downloaded: `remove` drops it (the bridge owns it);
// the others clear its words in place.
func (q *mediaWaitQueue) honour(path string, rec *spoolRecord) bool {
	how := q.clearRequestOf(mediaFileStem(rec.ChatJID, rec.ID))
	if how == "remove" {
		_ = os.Remove(path)
		return false
	}
	if how != "" && !rec.SecretRedacted || how == "names" && rec.ChatName != "" {
		applyClear(rec, how)
		if payload, err := json.Marshal(rec); err == nil {
			_ = writeFileAtomicPrivate(path, payload)
		}
	}
	return true
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

// retry makes the waiting downloads while the volume is above the floor, in
// the order they waited, and spools each message again with its media. Every
// clear request is applied before a download and again right before the
// line is spooled (see the header). An entry goes only once `spool` says its
// line is durably written.
func (q *mediaWaitQueue) retry(ctx context.Context, store *audioMediaStore, spool func(spoolRecord) error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	defer q.report()
	q.sweepTemps(mediaWaitingTempAge)
	defer q.retireRequests(time.Now())
	for _, path := range q.waiting() {
		rec, ok := readEntry(path)
		if !ok {
			_ = os.Remove(path)
			continue
		}
		if !q.honour(path, &rec) {
			continue
		}
		kind := store.forMediaType(rec.MediaType)
		if kind == nil {
			_ = os.Remove(path)
			continue
		}
		if !q.hasRoom(kind.dir) {
			return
		}
		saved, size, err := kind.downloadPath(ctx, rec.ChatJID, rec.ID, rec.MediaMime, retryRequestOf(rec))
		if errors.Is(err, errWaitingForDisk) {
			// Too large for the room there is now: the smaller ones after it may still fit.
			continue
		}
		if err != nil && !permanentDownloadError(err) {
			// A passing failure (the network): it stays waiting for the next pass.
			continue
		}
		discard := func() {
			if saved != "" {
				_ = os.Remove(saved)
			}
		}
		// The last look, right before the line is spooled: what is spooled is the entry as it is now,
		// with every request made meanwhile applied.
		current, ok := readEntry(path)
		if !ok || !q.honour(path, &current) {
			discard()
			continue
		}
		if err != nil {
			current.DownloadStatus = "failed:" + classifyDownloadError(err)
		} else {
			current.MediaPath = saved
			current.MediaSizeBytes = size
			current.DownloadStatus = "ok"
		}
		if err := spool(current); err != nil {
			// Not written: the entry stays, and the next pass makes the line again.
			log.Printf("olympus-whatsapp-bridge: could not spool a message whose media was waiting: %v", err)
			discard()
			continue
		}
		_ = os.Remove(path)
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

func retryRequestOf(rec spoolRecord) mediaRequest {
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
