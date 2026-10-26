package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// streamingDownloader writes `chunk` `times` times, then fails with `err` (when set): a large or broken download.
type streamingDownloader struct {
	chunk   []byte
	times   int
	err     error
	written int64
}

func (d *streamingDownloader) DownloadToFile(_ context.Context, _ whatsmeow.DownloadableMessage, file whatsmeow.File) error {
	for i := 0; i < d.times; i++ {
		n, err := file.Write(d.chunk)
		d.written += int64(n)
		if err != nil {
			return err
		}
	}
	return d.err
}

func mediaTemps(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var temps []string
	for _, entry := range entries {
		if isMediaTemp(entry.Name()) {
			temps = append(temps, entry.Name())
		}
	}
	return temps
}

func TestAPictureLargerThanItsBoundIsAbortedWhileStreaming(t *testing.T) {
	dir := t.TempDir()
	// The message says it is small; the bytes say otherwise.
	downloader := &streamingDownloader{chunk: make([]byte, 1024*1024), times: 64}
	store := newAudioMediaStore(dir, downloader)
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("liar-1", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype:   proto.String("image/jpeg"),
		FileLength: proto.Uint64(10),
	}}))
	if rec.DownloadStatus != "too_large" || rec.MediaPath != "" {
		t.Fatalf("record = %#v", rec)
	}
	// Stopped at the bound, never the whole 64 MiB.
	if downloader.written > imageMediaMaxFileBytes+mediaEncryptionOverhead {
		t.Fatalf("written = %d, past the bound %d", downloader.written, imageMediaMaxFileBytes)
	}
	images := filepath.Join(dir, "media", "images")
	if temps := mediaTemps(t, images); len(temps) != 0 {
		t.Fatalf("temps left: %v", temps)
	}
	if entries, _ := os.ReadDir(images); len(entries) != 0 {
		t.Fatalf("files left: %d", len(entries))
	}
}

func TestAFailedDownloadLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	downloader := &streamingDownloader{chunk: []byte("partial bytes"), times: 3, err: errors.New("network unavailable")}
	store := newAudioMediaStore(dir, downloader)
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("cut-1", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Mimetype: proto.String("video/mp4")}}))
	if !strings.HasPrefix(rec.DownloadStatus, "failed:") || rec.MediaPath != "" {
		t.Fatalf("record = %#v", rec)
	}
	if temps := mediaTemps(t, filepath.Join(dir, "media", "video")); len(temps) != 0 {
		t.Fatalf("temps left: %v", temps)
	}
}

func TestATempNamesItsWriterItsBootAndItsMessage(t *testing.T) {
	stem := mediaFileStem("15550001111@s.whatsapp.net", "ABC")
	name := strings.Replace(mediaTempPattern(stem), "*", "123456", 1)
	pid, boot, ok := mediaTempWriter(name)
	if !isMediaTemp(name) || !ok || pid != os.Getpid() || boot != bootNonce || !strings.Contains(name, "-"+stem+"-") {
		t.Fatalf("temp name %q", name)
	}
}

// io.Copy prefers the destination's ReadFrom; the capped file's own one keeps the cap.
func TestIoCopyIntoTheCappedFileStopsAtTheBound(t *testing.T) {
	tmp, err := os.CreateTemp(t.TempDir(), "capped-*")
	if err != nil {
		t.Fatal(err)
	}
	defer tmp.Close()
	capped := &cappedFile{file: tmp, limit: 1024}
	hasher := sha256.New()
	n, err := io.Copy(capped, io.TeeReader(bytes.NewReader(make([]byte, 1024*1024)), hasher))
	if !errors.Is(err, errMediaTooLarge) {
		t.Fatalf("copy err = %v", err)
	}
	info, _ := tmp.Stat()
	if n > 1024 || info.Size() > 1024 {
		t.Fatalf("copied %d, file %d: past the bound", n, info.Size())
	}
	var _ whatsmeow.File = capped
}

func TestStartSweepsTempsAKilledBridgeLeftBehind(t *testing.T) {
	dir := t.TempDir()
	store := newAudioMediaStore(dir, &fakeDownloader{})
	images := filepath.Join(dir, "media", "images")
	if err := os.MkdirAll(images, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name string, age time.Duration) string {
		path := filepath.Join(images, name)
		if err := os.WriteFile(path, []byte("left behind"), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().Add(-age)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// A writer that is gone (pid 2^22 + 1 is past Linux's pid limit), a live pid of another boot, an older
	// build's temp past the age, and one older build's still fresh.
	dead := write(mediaTempPrefix+"4194305-"+bootNonce+"-stem-1.tmp", time.Second)
	otherBoot := write(fmt.Sprintf("%s%d-ffffffff-stem-2.tmp", mediaTempPrefix, os.Getpid()), time.Second)
	older := write(".audio-1.tmp", 2*mediaTempMaxAge)
	olderFresh := write(".audio-2.tmp", time.Second)
	// A download of this bridge that stalled for hours is still running: it stays.
	stalled := write(strings.Replace(mediaTempPattern("stem"), "*", "3", 1), 10*mediaTempMaxAge)
	saved := write("saved-0123456789abcdef.jpg", 2*mediaTempMaxAge)
	if bootNonce == "ffffffff" {
		t.Skip("this boot's nonce is the fixture's other boot")
	}
	store.sweepTemps(time.Now())
	for _, gone := range []string{dead, otherBoot, older} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("%s survived the sweep", filepath.Base(gone))
		}
	}
	for _, kept := range []string{stalled, olderFresh, saved} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("%s was swept: %v", filepath.Base(kept), err)
		}
	}
}

// The same stem Olympus computes (live-connector.ts, whatsAppMediaFileStem), so it finds a message's temps.
func TestMediaFileStemMatchesOlympus(t *testing.T) {
	if got := mediaFileStem(" 15550001111:3@S.WhatsApp.net ", "3EB0/ä x"); got != "3EB0___x-ebc4198b0daec666" {
		t.Fatalf("stem = %q", got)
	}
}
