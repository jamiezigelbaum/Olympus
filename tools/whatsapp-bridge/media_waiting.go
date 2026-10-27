package main

// Every message and every piece of media is kept (owner, 2026-10-26); the
// one safeguard is for the computer itself: a floor of free space on the
// volume the media folders are on, the larger of diskFloorMinBytes and
// diskFloorShare of the volume.
//
//   - A download is not started below the floor, and one already running
//     stops when the volume falls below it (the temp writer checks as it
//     writes). Its message is still spooled at once, with its media "waiting
//     for disk space" (download_status mediaWaitingStatus) and everything a
//     later download needs (where the media is, its keys and hashes, its
//     type and size). That line is the only record: the bridge keeps no list
//     of waiting media and writes nothing more for it.
//   - Waiting media is fetched only by Olympus (owner, 2026-10-26: Olympus
//     asks the bridge for the exact message version, receives the bytes into
//     its own folder, re-checks the judgment before indexing, and keys
//     everything by version). The bridge answers that one call
//     (media_serve.go) and keeps no state for it.
//   - The capture status receipt says media is waiting for disk space, with
//     no count, while a capture or a download has met the floor and the
//     volume is still below it.

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
)

const (
	mediaWaitingStatus = "waiting_for_disk"
	diskFloorMinBytes  = 5 * 1024 * 1024 * 1024
	diskFloorShare     = 20 // one twentieth: 5% of the volume
	// How often the status looks again whether the volume has room.
	diskWatchInterval = time.Minute
)

// The volume a new floor reads (tests give it one with room).
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

// mediaFloor is the one floor the three media stores share.
type mediaFloor struct {
	dir    string
	space  func(dir string) (free uint64, total uint64, err error)
	status *captureStatus
	mu     sync.Mutex
	// A capture or a download met the floor since the volume last had room.
	metFloor bool
}

func newMediaFloor(stateDir string) *mediaFloor {
	return &mediaFloor{dir: filepath.Join(stateDir, "media"), space: defaultVolumeSpace}
}

// hasRoom says whether the volume holding dir is above the floor. A volume
// whose space cannot be read is never paused for it.
func (q *mediaFloor) hasRoom(dir string) bool {
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

// noteWaiting is told when a capture or a download met the floor: the status says so.
func (q *mediaFloor) noteWaiting() {
	if q == nil {
		return
	}
	q.mu.Lock()
	q.metFloor = true
	q.mu.Unlock()
	if q.status != nil {
		q.status.setMediaWaiting(true)
	}
}

// watch clears the status once the volume has room again, every interval until ctx ends.
func (q *mediaFloor) watch(ctx context.Context) {
	if q == nil {
		return
	}
	ticker := time.NewTicker(diskWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			q.look()
		}
	}
}

// look says in the status whether media waits for disk space: the floor was met and the volume is still below it.
func (q *mediaFloor) look() {
	room := q.hasRoom(q.dir)
	q.mu.Lock()
	if room {
		q.metFloor = false
	}
	waiting := q.metFloor
	q.mu.Unlock()
	if q.status != nil {
		q.status.setMediaWaiting(waiting)
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

// downloadRequestOf is the download Olympus asks for, from the fields the message's spool line carried.
func downloadRequestOf(rec downloadRequest) mediaRequest {
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
