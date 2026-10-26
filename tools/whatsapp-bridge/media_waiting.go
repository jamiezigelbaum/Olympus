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
//     waiting child from that line.
//   - The capture status receipt says media is waiting, with no count.

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
			q.retry(ctx, store, writer.enqueue)
		}
	}
}

// retry makes the waiting downloads while the volume is above the floor, in
// the order they waited, and spools each message again with its media. A
// line Olympus removed meanwhile (its media judged Secrets) is never filled:
// what was downloaded for it is deleted.
func (q *mediaWaitQueue) retry(ctx context.Context, store *audioMediaStore, spool func(spoolRecord)) {
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
			return
		}
		if _, gone := os.Stat(path); gone != nil {
			// Cleared while it downloaded: the media is never kept.
			if saved != "" {
				_ = os.Remove(saved)
			}
			continue
		}
		if err != nil {
			rec.DownloadStatus = "failed:" + classifyDownloadError(err)
		} else {
			rec.MediaPath = saved
			rec.MediaSizeBytes = size
			rec.DownloadStatus = "ok"
		}
		spool(rec)
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
