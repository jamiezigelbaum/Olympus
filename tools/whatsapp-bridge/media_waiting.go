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
//     message's file stem, so Olympus's Secrets clearing removes it by the
//     same name and the media is never fetched for a Secret message).
//   - Every minute, while any is waiting and the volume is above the floor
//     again, the waiting downloads are made in the order they waited, and
//     each message is spooled again with its media: Olympus fills the
//     waiting child from that line. One that does not fit is skipped, so the
//     smaller ones after it still go; one that fails for a passing reason
//     (the network) stays waiting; only one that can never be fetched (gone
//     from WhatsApp's servers, failing its hash) is spooled as failed. An
//     entry is removed only once its line is written and fsynced.
//   - A waiting entry is written whole or not at all (a temp renamed into
//     place); the temp of a write a killed bridge left is swept at start,
//     and Olympus sweeps the same on every clearing.
//   - The bridge and Olympus share one lock on the waiting folder
//     (mediaWaitingLockName: made exclusively, naming its holder's pid and
//     boot; one whose holder is gone is taken over). Olympus holds it while
//     it clears or removes an entry; the bridge holds it from reading an
//     entry again, right before the message is spooled with its media,
//     until the line is written and the entry removed. So what is spooled is
//     the entry as it is then (cleared, if Olympus cleared it), and an entry
//     Olympus removed is never spooled: what was downloaded for it goes.
//   - The capture status receipt says media is waiting, with no count, for
//     as long as any entry remains.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
)

const (
	mediaWaitingLockName = ".olympus-waiting.lock"
	mediaWaitingLockWait = 30 * time.Second
	mediaWaitingStatus   = "waiting_for_disk"
	mediaWaitingDirName  = "waiting"
	diskFloorMinBytes    = 5 * 1024 * 1024 * 1024
	diskFloorShare       = 20 // one twentieth: 5% of the volume
	mediaRetryInterval   = time.Minute
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
// renamed into place (`.<stem>.json.tmp<random>`). Run before capture starts,
// when no entry is being written.
func (q *mediaWaitQueue) sweepTemps() {
	if q == nil {
		return
	}
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && isWaitingTemp(entry.Name()) {
			_ = os.Remove(filepath.Join(q.dir, entry.Name()))
		}
	}
}

// isWaitingTemp says whether a name is the temp of a waiting entry's write (writeFileAtomicPrivate).
func isWaitingTemp(name string) bool {
	return strings.HasPrefix(name, ".") && strings.Contains(name, ".json.tmp")
}

// lock takes the waiting folder's lock, shared with Olympus (see the header):
// made exclusively, naming this pid and boot. A lock whose holder is gone
// (its pid dead, or of another boot) is taken over.
func (q *mediaWaitQueue) lock() (func(), error) {
	path := filepath.Join(q.dir, mediaWaitingLockName)
	if err := os.MkdirAll(q.dir, 0o700); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(mediaWaitingLockWait)
	for {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			_, werr := fmt.Fprintf(file, "%d %s\n", os.Getpid(), bootNonce)
			cerr := file.Close()
			if werr != nil || cerr != nil {
				_ = os.Remove(path)
				return nil, errors.Join(werr, cerr)
			}
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if lockHolderGone(path) {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("the media waiting folder stayed locked")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// lockHolderGone says whether the lock's holder is no longer running: its pid dead, or of another boot.
func lockHolderGone(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	fields := strings.Fields(string(raw))
	if len(fields) != 2 {
		// Being written this moment, or not a lock this build makes: given a moment.
		info, err := os.Stat(path)
		return err == nil && time.Since(info.ModTime()) > mediaWaitingLockWait
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil {
		return true
	}
	return fields[1] != bootNonce || (pid != os.Getpid() && !processAlive(pid))
}

// publish spools a waiting message with its media, fenced against Olympus's
// clearing by the shared lock: the entry is read again under it, and what is
// spooled is the entry as it is now. An entry that is gone is never spooled,
// and what was downloaded for it is deleted. The entry goes only once the
// line is written. Says whether it was spooled.
func (q *mediaWaitQueue) publish(path string, result func(rec *spoolRecord), saved string, spool func(spoolRecord) error) bool {
	unlock, err := q.lock()
	if err != nil {
		log.Printf("olympus-whatsapp-bridge: could not lock the media waiting folder: %v", err)
		return false
	}
	defer unlock()
	discard := func() {
		if saved != "" {
			_ = os.Remove(saved)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		// Removed meanwhile (its media judged Secrets): the media is never kept.
		discard()
		return false
	}
	var rec spoolRecord
	if json.Unmarshal(raw, &rec) != nil {
		discard()
		_ = os.Remove(path)
		return false
	}
	result(&rec)
	if err := spool(rec); err != nil {
		// Not written: the entry stays, and the next pass makes the line again.
		log.Printf("olympus-whatsapp-bridge: could not spool a message whose media was waiting: %v", err)
		discard()
		return false
	}
	_ = os.Remove(path)
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
// the order they waited, and spools each message again with its media. A
// line Olympus removed meanwhile (its media judged Secrets) is never filled:
// what was downloaded for it is deleted. An entry goes only once `spool` says
// its line is durably written.
func (q *mediaWaitQueue) retry(ctx context.Context, store *audioMediaStore, spool func(spoolRecord) error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	defer q.report()
	for _, path := range q.waiting() {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var rec spoolRecord
		if json.Unmarshal(raw, &rec) != nil {
			_ = os.Remove(path)
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
		failed := err
		q.publish(path, func(rec *spoolRecord) {
			if failed != nil {
				rec.DownloadStatus = "failed:" + classifyDownloadError(failed)
				return
			}
			rec.MediaPath = saved
			rec.MediaSizeBytes = size
			rec.DownloadStatus = "ok"
		}, saved, spool)
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
