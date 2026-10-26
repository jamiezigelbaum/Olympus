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
//     of waiting media.
//   - Waiting media is downloaded only after Olympus has judged its message
//     not Secret (owner, 2026-10-26), and only when Olympus asks: Olympus
//     alone decides what is fetched. It writes `media/fetch/<stem>.json`
//     (the message's file stem) once the message it stored is judged not
//     Secret and the disk is above the floor, and removes it once it no
//     longer wants the media.
//   - Every minute, while the volume is above the floor, the bridge
//     downloads each request that has no answer yet into
//     `media/fetched/<stem>.part`, fsyncs it, renames it to `<stem><ext>`
//     and fsyncs the folder. Media that can never be fetched (gone from
//     WhatsApp's servers, failing its hash) is answered `<stem>.failed`
//     instead. A passing failure (the network) is left for the next pass.
//     Nothing is spooled for it, and nothing else is kept: a crash at any
//     point leaves the request, and the next pass downloads it again.
//   - Olympus reads the answer into its stored item and removes the answer
//     and the request; whatever it no longer wants (a message turned Secret,
//     another version, a request it withdrew) it deletes, whenever the
//     download finished.
//   - The capture status receipt says media is waiting for disk space, with
//     no count, while the volume is below the floor and media waits: a
//     capture met the floor, or a request cannot be downloaded for it.

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
	mediaFetchDirName   = "fetch"
	mediaFetchedDirName = "fetched"
	mediaPartSuffix     = ".part"
	mediaFailedSuffix   = ".failed"
	diskFloorMinBytes   = 5 * 1024 * 1024 * 1024
	diskFloorShare      = 20 // one twentieth: 5% of the volume
	mediaFetchInterval  = time.Minute
	// A request is a few hundred bytes; anything far larger is not Olympus's.
	mediaRequestMaxBytes = 64 * 1024
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

// mediaFloor is the one floor the three media stores share, and the
// downloads Olympus asks for.
type mediaFloor struct {
	fetchDir   string
	fetchedDir string
	space      func(dir string) (free uint64, total uint64, err error)
	status     *captureStatus
	mu         sync.Mutex
	// A capture met the floor since the volume last had room.
	metFloor bool
}

func newMediaFloor(stateDir string) *mediaFloor {
	media := filepath.Join(stateDir, "media")
	return &mediaFloor{
		fetchDir:   filepath.Join(media, mediaFetchDirName),
		fetchedDir: filepath.Join(media, mediaFetchedDirName),
		space:      defaultVolumeSpace,
	}
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

// noteWaiting is told when a capture met the floor: the status says so.
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

// fetchRequest is Olympus's request for one message's waiting media.
type fetchRequest struct {
	ChatJID            string `json:"chat_jid"`
	ID                 string `json:"id"`
	MediaType          string `json:"media_type"`
	MediaMime          string `json:"media_mime,omitempty"`
	MediaKey           string `json:"media_key,omitempty"`
	MediaDirectPath    string `json:"media_direct_path"`
	MediaFileSHA256    string `json:"media_file_sha256,omitempty"`
	MediaFileEncSHA256 string `json:"media_file_enc_sha256,omitempty"`
}

// requests is the stems Olympus asks for, oldest first.
func (q *mediaFloor) requests() []string {
	entries, err := os.ReadDir(q.fetchDir)
	if err != nil {
		return nil
	}
	type named struct {
		stem string
		at   time.Time
	}
	var found []named
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		found = append(found, named{stem: strings.TrimSuffix(name, ".json"), at: info.ModTime()})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].at.Before(found[j].at) })
	stems := make([]string, 0, len(found))
	for _, each := range found {
		stems = append(stems, each.stem)
	}
	return stems
}

// readRequest reads a request; ok is false for one that is gone, cannot be
// read, or is not for the message its name says.
func (q *mediaFloor) readRequest(stem string) (fetchRequest, bool) {
	var request fetchRequest
	path := filepath.Join(q.fetchDir, stem+".json")
	info, err := os.Stat(path)
	if err != nil || info.Size() > mediaRequestMaxBytes {
		return request, false
	}
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &request) != nil {
		return request, false
	}
	if request.ID == "" || request.MediaDirectPath == "" || mediaFileStem(request.ChatJID, request.ID) != stem {
		return request, false
	}
	return request, true
}

// answered says whether a request has its answer already: the media, or why it can never be fetched.
func (q *mediaFloor) answered(stem string, ext string) bool {
	for _, name := range []string{stem + ext, stem + mediaFailedSuffix} {
		if _, err := os.Lstat(filepath.Join(q.fetchedDir, name)); err == nil {
			return true
		}
	}
	return false
}

// sweepParts removes the downloads a killed bridge left unfinished. Run at
// start, when none is being written.
func (q *mediaFloor) sweepParts() {
	if q == nil {
		return
	}
	entries, err := os.ReadDir(q.fetchedDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), mediaPartSuffix) {
			_ = os.Remove(filepath.Join(q.fetchedDir, entry.Name()))
		}
	}
}

// run downloads what Olympus asks for every interval until ctx ends.
func (q *mediaFloor) run(ctx context.Context, store *audioMediaStore) {
	if q == nil {
		return
	}
	q.fetch(ctx, store)
	ticker := time.NewTicker(mediaFetchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			q.fetch(ctx, store)
		}
	}
}

// fetch downloads every request without an answer, oldest first, while the
// volume is above the floor. One too large for the room there is now is
// skipped, so the smaller ones after it may still go.
func (q *mediaFloor) fetch(ctx context.Context, store *audioMediaStore) {
	q.mu.Lock()
	defer q.mu.Unlock()
	blocked := false
	for _, stem := range q.requests() {
		if ctx.Err() != nil {
			return
		}
		request, ok := q.readRequest(stem)
		if !ok {
			continue
		}
		ext := extensionFromMime(request.MediaMime)
		if q.answered(stem, ext) {
			continue
		}
		if !q.hasRoom(q.fetchedDir) {
			blocked = true
			break
		}
		err := q.download(ctx, store, stem, ext, request)
		switch {
		case err == nil:
		case errors.Is(err, errWaitingForDisk):
			blocked = true
		case permanentDownloadError(err):
			if err := writeAnswer(filepath.Join(q.fetchedDir, stem+mediaFailedSuffix), []byte(classifyDownloadError(err))); err != nil {
				log.Printf("olympus-whatsapp-bridge: could not record media that can never be fetched: %v", err)
			}
		default:
			// A passing failure (the network): the request stays for the next pass.
			log.Printf("olympus-whatsapp-bridge: a requested media download failed for now: %v", err)
		}
	}
	room := q.hasRoom(q.fetchedDir)
	if room {
		q.metFloor = false
	}
	if q.status != nil {
		q.status.setMediaWaiting(!room && (blocked || q.metFloor))
	}
}

// download streams one request's media into `<stem>.part`, then gives it its
// name and makes both durable. The part is gone whatever happened.
func (q *mediaFloor) download(ctx context.Context, store *audioMediaStore, stem string, ext string, request fetchRequest) error {
	if store == nil || store.downloader == nil {
		return errors.New("no downloader")
	}
	if err := os.MkdirAll(q.fetchedDir, 0o700); err != nil {
		return err
	}
	part := filepath.Join(q.fetchedDir, stem+mediaPartSuffix)
	file, err := os.OpenFile(part, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(part)
	writer := &floorFile{file: file, floor: q, dir: q.fetchedDir}
	media := fetchRequestOf(request)
	if err := store.downloader.DownloadMediaWithPathToFile(ctx, media.directPath, media.encSHA256, media.fileSHA256, media.mediaKey, media.mediaType, "", false, writer); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(part, filepath.Join(q.fetchedDir, stem+ext)); err != nil {
		return err
	}
	return syncDir(q.fetchedDir)
}

// writeAnswer writes a small answer whole and durably: its file fsynced, then its folder.
func writeAnswer(path string, payload []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
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

// fetchRequestOf is the download Olympus's request names, from the fields the spool line carried.
func fetchRequestOf(rec fetchRequest) mediaRequest {
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
