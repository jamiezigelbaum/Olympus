package main

// The one local call the bridge answers: Olympus asks for the media of one
// message version that waited for disk space, and gets its bytes (owner,
// 2026-10-26: Olympus asks the bridge for the exact message version,
// receives the bytes into its own folder, re-checks the judgment before
// indexing, and keys everything by version).
//
//   - It is an owner-only Unix socket (0600, in the 0700 state folder, or in
//     a private 0700 temp folder when the state folder's path is too long for
//     a socket), named in `media-download.json` in the state folder. It
//     answers one request per connection, one connection at a time, and
//     does nothing but download: no send path, no other command.
//   - A request names the message and its version, and carries the fields
//     its spool line carried (where the media is, its keys and hashes, its
//     type). The answer is one JSON line, then, when it is "ok", exactly
//     `size` bytes of the media. While the download runs, a bare newline is
//     sent every mediaKeepaliveEvery, so the caller tells a long download
//     from a stalled one. There is no limit on how long a download takes;
//     only one that writes nothing for mediaDownloadStall is given up.
//   - The bridge keeps no state and writes no file for it: the download is
//     decrypted in an unnamed temp (created and unlinked at once, so a crash
//     leaves nothing), through the same floor-checking writer as a capture.
//     Below the floor it answers a passing failure. Media gone from
//     WhatsApp's servers, or not what its hashes say, is a permanent one.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

const (
	mediaSocketName    = "media.sock"
	mediaSocketPointer = "media-download.json"
	// A socket path longer than this does not fit sun_path on every platform (104 bytes on macOS).
	mediaSocketMaxPath = 100
	// A request is a few hundred bytes; anything far larger is not Olympus's.
	mediaRequestMaxBytes = 64 * 1024
	mediaRequestTimeout  = 30 * time.Second
	// How long one write of the answer may stall.
	mediaAnswerStall = 2 * time.Minute
)

var (
	// How often a running download says it is alive, and how long it may write nothing before it is given up.
	mediaKeepaliveEvery = 30 * time.Second
	mediaDownloadStall  = 5 * time.Minute
)

// downloadRequest is Olympus's request for one message version's media.
type downloadRequest struct {
	ChatJID            string `json:"chat_jid"`
	ID                 string `json:"id"`
	Version            string `json:"version"`
	MediaType          string `json:"media_type"`
	MediaMime          string `json:"media_mime,omitempty"`
	MediaKey           string `json:"media_key,omitempty"`
	MediaDirectPath    string `json:"media_direct_path"`
	MediaFileSHA256    string `json:"media_file_sha256,omitempty"`
	MediaFileEncSHA256 string `json:"media_file_enc_sha256,omitempty"`
}

// downloadAnswer heads the answer: "ok" and the size of the bytes that follow, or why not.
type downloadAnswer struct {
	Status    string `json:"status"`
	Size      int64  `json:"size,omitempty"`
	Permanent bool   `json:"permanent,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// mediaSocketPath is where the socket goes: in the state folder when its path fits, else in a private temp folder.
func mediaSocketPath(stateDir string) (string, func(), error) {
	path := filepath.Join(stateDir, mediaSocketName)
	if len(path) <= mediaSocketMaxPath {
		return path, func() { _ = os.Remove(path) }, nil
	}
	dir, err := os.MkdirTemp("", "olympus-wa-")
	if err != nil {
		return "", nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	return filepath.Join(dir, "m.sock"), func() { _ = os.RemoveAll(dir) }, nil
}

// serveDownloads answers Olympus's download calls until ctx ends.
func (store *audioMediaStore) serveDownloads(ctx context.Context, stateDir string) {
	if err := store.listenForDownloads(ctx, stateDir); err != nil {
		log.Printf("olympus-whatsapp-bridge: the media download call is not available: %v", err)
	}
}

func (store *audioMediaStore) listenForDownloads(ctx context.Context, stateDir string) error {
	path, cleanup, err := mediaSocketPath(stateDir)
	if err != nil {
		return err
	}
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		cleanup()
		return err
	}
	defer cleanup()
	defer listener.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	pointer, _ := json.Marshal(map[string]string{"socket": path})
	pointerPath := filepath.Join(stateDir, mediaSocketPointer)
	if err := writeFileAtomicPrivate(pointerPath, pointer); err != nil {
		return err
	}
	defer os.Remove(pointerPath)
	go func() {
		<-ctx.Done()
		listener.Close()
	}()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			continue
		}
		// One at a time: a second download waits, so two never share the room above the floor.
		store.answerDownload(ctx, conn)
	}
}

// answerDownload reads one request and answers it.
func (store *audioMediaStore) answerDownload(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	reply := func(answer downloadAnswer) bool {
		line, _ := json.Marshal(answer)
		_ = conn.SetWriteDeadline(time.Now().Add(mediaAnswerStall))
		_, err := conn.Write(append(line, '\n'))
		return err == nil
	}
	_ = conn.SetReadDeadline(time.Now().Add(mediaRequestTimeout))
	line, err := bufio.NewReader(io.LimitReader(conn, mediaRequestMaxBytes)).ReadBytes('\n')
	var request downloadRequest
	if err != nil || json.Unmarshal(line, &request) != nil || request.ID == "" || request.ChatJID == "" || request.MediaDirectPath == "" {
		reply(downloadAnswer{Status: "failed", Permanent: true, Reason: "bad_request"})
		return
	}
	kind := store.forMediaType(request.MediaType)
	if kind == nil {
		reply(downloadAnswer{Status: "failed", Permanent: true, Reason: "unknown_media_type"})
		return
	}
	downloadCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Alive while it runs: a newline now and then, which also finds a caller that went away.
	var writing sync.Mutex
	stopKeepalive := make(chan struct{})
	keepaliveDone := make(chan struct{})
	go func() {
		defer close(keepaliveDone)
		ticker := time.NewTicker(mediaKeepaliveEvery)
		defer ticker.Stop()
		for {
			select {
			case <-stopKeepalive:
				return
			case <-ticker.C:
				writing.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(mediaAnswerStall))
				_, err := conn.Write([]byte{'\n'})
				writing.Unlock()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	file, size, err := kind.downloadUnnamed(downloadCtx, request)
	close(stopKeepalive)
	<-keepaliveDone
	switch {
	case errors.Is(err, errWaitingForDisk):
		store.floor.noteWaiting()
		reply(downloadAnswer{Status: "failed", Reason: "waiting_for_disk"})
		return
	case err != nil:
		reply(downloadAnswer{Status: "failed", Permanent: permanentDownloadError(err), Reason: classifyDownloadError(err)})
		return
	}
	defer file.Close()
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		reply(downloadAnswer{Status: "failed", Reason: "read_back"})
		return
	}
	if !reply(downloadAnswer{Status: "ok", Size: size}) {
		return
	}
	_, _ = io.Copy(&stallWriter{conn: conn}, io.LimitReader(file, size))
}

// stallWriter writes to a connection, giving up when one write stalls past mediaAnswerStall.
type stallWriter struct{ conn net.Conn }

func (w *stallWriter) Write(p []byte) (int, error) {
	_ = w.conn.SetWriteDeadline(time.Now().Add(mediaAnswerStall))
	return w.conn.Write(p)
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

// downloadUnnamed downloads one request's media into a temp that has no name
// (created and unlinked at once) in the media's own folder, through the
// floor-checking writer, and returns it with its size.
func (store *audioMediaStore) downloadUnnamed(ctx context.Context, request downloadRequest) (*os.File, int64, error) {
	if store.downloader == nil {
		return nil, 0, errors.New("no downloader")
	}
	if err := os.MkdirAll(store.dir, 0o700); err != nil {
		return nil, 0, err
	}
	if !store.floor.hasRoom(store.dir) {
		return nil, 0, errWaitingForDisk
	}
	tmp, err := os.CreateTemp(store.dir, mediaTempPattern(mediaFileStem(request.ChatJID, request.ID)))
	if err != nil {
		return nil, 0, err
	}
	if err := os.Remove(tmp.Name()); err != nil {
		tmp.Close()
		return nil, 0, err
	}
	media := downloadRequestOf(request)
	// A download that writes nothing for mediaDownloadStall is given up; one that keeps writing runs as long as it takes.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var progress atomic.Int64
	progress.Store(time.Now().UnixNano())
	stopWatch := make(chan struct{})
	defer close(stopWatch)
	go func() {
		ticker := time.NewTicker(mediaDownloadStall / 10)
		defer ticker.Stop()
		for {
			select {
			case <-stopWatch:
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, progress.Load())) >= mediaDownloadStall {
					cancel()
					return
				}
			}
		}
	}()
	file := &floorFile{file: tmp, floor: store.floor, dir: store.dir, progress: &progress}
	if err := store.downloader.DownloadMediaWithPathToFile(ctx, media.directPath, media.encSHA256, media.fileSHA256, media.mediaKey, media.mediaType, "", false, file); err != nil {
		tmp.Close()
		return nil, 0, err
	}
	info, err := tmp.Stat()
	if err != nil {
		tmp.Close()
		return nil, 0, err
	}
	return tmp, info.Size(), nil
}
