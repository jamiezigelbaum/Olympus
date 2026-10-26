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
// `during` runs once, before the first write.
type streamingDownloader struct {
	chunk   []byte
	times   int
	err     error
	written int64
	calls   int
	during  func()
}

func (d *streamingDownloader) DownloadMediaWithPathToFile(_ context.Context, _ string, _, _, _ []byte, _ whatsmeow.MediaType, _ string, _ bool, file whatsmeow.File) error {
	d.calls++
	if d.during != nil {
		d.during()
		d.during = nil
	}
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

// spaceOf is a volume with `free` of `total` bytes free, for a store's floor.
func spaceOf(free *uint64, total uint64) func(string) (uint64, uint64, error) {
	return func(string) (uint64, uint64, error) { return *free, total, nil }
}

const testVolume = 200 * 1024 * 1024 * 1024 // 200 GiB: a floor of 10 GiB

func TestTheFloorIsTheLargerOfFiveGigabytesAndFivePercent(t *testing.T) {
	if got := diskFloor(50 * 1024 * 1024 * 1024); got != diskFloorMinBytes {
		t.Fatalf("floor of 50 GiB = %d, want 5 GiB", got)
	}
	if got := diskFloor(testVolume); got != testVolume/20 {
		t.Fatalf("floor of 200 GiB = %d, want 10 GiB", got)
	}
}

// Every piece of media is kept (owner, 2026-10-26): one larger than any old bound is streamed whole, never held in memory.
func TestAPictureOfAnySizeIsSavedWhole(t *testing.T) {
	dir := t.TempDir()
	downloader := &streamingDownloader{chunk: make([]byte, 1024*1024), times: 40}
	store := newAudioMediaStore(dir, downloader)
	free := uint64(testVolume)
	store.queue.space = spaceOf(&free, testVolume)
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("big-1", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype:   proto.String("image/jpeg"),
		FileLength: proto.Uint64(10),
	}}))
	if rec.DownloadStatus != "ok" || rec.MediaSizeBytes != 40*1024*1024 {
		t.Fatalf("record = %#v", rec)
	}
	if info, err := os.Stat(rec.MediaPath); err != nil || info.Size() != 40*1024*1024 {
		t.Fatalf("saved file: %v", err)
	}
}

func TestBelowTheFloorTheMessageIsKeptAndItsMediaWaits(t *testing.T) {
	dir := t.TempDir()
	downloader := &streamingDownloader{chunk: []byte("picture"), times: 1}
	store := newAudioMediaStore(dir, downloader)
	free := uint64(4 * 1024 * 1024 * 1024) // under the 10 GiB floor
	store.queue.space = spaceOf(&free, testVolume)
	rec, ok := recordFromMessage(context.Background(), nil, store, captionEvent("wait-1", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype: proto.String("image/jpeg"),
		Caption:  proto.String("the harbour"),
	}}))
	if !ok || rec.DownloadStatus != mediaWaitingStatus || rec.MediaPath != "" || rec.Text != "the harbour" {
		t.Fatalf("record = %#v", rec)
	}
	if downloader.calls != 0 {
		t.Fatalf("a download was started below the floor")
	}
	if waiting := store.queue.waiting(); len(waiting) != 1 || filepath.Base(waiting[0]) != mediaFileStem(rec.ChatJID, "wait-1")+".json" {
		t.Fatalf("waiting = %v", waiting)
	}
	if temps := mediaTemps(t, filepath.Join(dir, "media", "images")); len(temps) != 0 {
		t.Fatalf("temps left: %v", temps)
	}
}

func TestADownloadThatTakesTheVolumeBelowTheFloorStopsAndWaits(t *testing.T) {
	saved := diskCheckEveryBytes
	diskCheckEveryBytes = 1024
	defer func() { diskCheckEveryBytes = saved }()
	dir := t.TempDir()
	free := uint64(testVolume)
	downloader := &streamingDownloader{chunk: make([]byte, 4096), times: 16}
	store := newAudioMediaStore(dir, downloader)
	store.queue.space = spaceOf(&free, testVolume)
	// The volume fills while the video downloads.
	downloader.during = func() { free = 1024 }
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("clip-9", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Mimetype: proto.String("video/mp4")}}))
	if rec.DownloadStatus != mediaWaitingStatus || rec.MediaPath != "" {
		t.Fatalf("record = %#v", rec)
	}
	if downloader.written > 4096 {
		t.Fatalf("written = %d after the floor was reached", downloader.written)
	}
	if temps := mediaTemps(t, filepath.Join(dir, "media", "video")); len(temps) != 0 {
		t.Fatalf("temps left: %v", temps)
	}
	if len(store.queue.waiting()) != 1 {
		t.Fatalf("the video does not wait")
	}
}

func TestWaitingMediaIsDownloadedWhenSpaceReturnsAndTheMessageSpooledAgain(t *testing.T) {
	dir := t.TempDir()
	free := uint64(1024)
	downloader := &streamingDownloader{chunk: []byte("picture bytes"), times: 1}
	store := newAudioMediaStore(dir, downloader)
	store.queue.space = spaceOf(&free, testVolume)
	status := newCaptureStatus(t.TempDir())
	store.queue.status = status
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("later-1", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype:      proto.String("image/jpeg"),
		MediaKey:      []byte{1, 2, 3},
		FileEncSHA256: []byte{4, 5, 6},
		DirectPath:    proto.String("/mms/image"),
	}}))
	if rec.DownloadStatus != mediaWaitingStatus || !status.receipt().MediaWaitingForDisk {
		t.Fatalf("record = %#v, waiting said = %v", rec, status.receipt().MediaWaitingForDisk)
	}
	var spooled []spoolRecord
	spool := func(rec spoolRecord) { spooled = append(spooled, rec) }
	// Still no room: nothing happens.
	store.queue.retry(context.Background(), store, spool)
	if len(spooled) != 0 || downloader.calls != 0 {
		t.Fatalf("retried below the floor")
	}
	free = testVolume
	store.queue.retry(context.Background(), store, spool)
	if len(spooled) != 1 || spooled[0].DownloadStatus != "ok" || spooled[0].MediaPath == "" || spooled[0].ID != "later-1" || spooled[0].MediaDirectPath != "/mms/image" {
		t.Fatalf("spooled = %#v", spooled)
	}
	if len(store.queue.waiting()) != 0 || status.receipt().MediaWaitingForDisk {
		t.Fatalf("still waiting after it was filled")
	}
}

func TestWaitingMediaClearedMeanwhileIsNeverKept(t *testing.T) {
	dir := t.TempDir()
	free := uint64(1024)
	downloader := &streamingDownloader{chunk: []byte("secret picture"), times: 1}
	store := newAudioMediaStore(dir, downloader)
	store.queue.space = spaceOf(&free, testVolume)
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("secret-1", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg")}}))
	waiting := store.queue.pathOf(rec)
	free = testVolume
	// Olympus judges the picture Secret while it downloads, and removes its waiting line.
	downloader.during = func() { _ = os.Remove(waiting) }
	var spooled []spoolRecord
	store.queue.retry(context.Background(), store, func(rec spoolRecord) { spooled = append(spooled, rec) })
	if len(spooled) != 0 {
		t.Fatalf("spooled a cleared message: %#v", spooled)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "media", "images"))
	for _, entry := range entries {
		t.Fatalf("kept %s for a cleared message", entry.Name())
	}
}

func TestAFailedDownloadLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	downloader := &streamingDownloader{chunk: []byte("partial bytes"), times: 3, err: errors.New("network unavailable")}
	store := newAudioMediaStore(dir, downloader)
	free := uint64(testVolume)
	store.queue.space = spaceOf(&free, testVolume)
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

// io.Copy prefers the destination's ReadFrom; the floor file's own one goes through Write, so the floor still holds.
func TestIoCopyIntoTheFloorFileStopsAtTheFloor(t *testing.T) {
	saved := diskCheckEveryBytes
	diskCheckEveryBytes = 1
	defer func() { diskCheckEveryBytes = saved }()
	tmp, err := os.CreateTemp(t.TempDir(), "floor-*")
	if err != nil {
		t.Fatal(err)
	}
	defer tmp.Close()
	free := uint64(1024)
	queue := &mediaWaitQueue{space: spaceOf(&free, testVolume)}
	file := &floorFile{file: tmp, queue: queue, dir: filepath.Dir(tmp.Name())}
	hasher := sha256.New()
	n, err := io.Copy(file, io.TeeReader(bytes.NewReader(make([]byte, 1024*1024)), hasher))
	if !errors.Is(err, errWaitingForDisk) {
		t.Fatalf("copy err = %v", err)
	}
	info, _ := tmp.Stat()
	if n != 0 || info.Size() != 0 {
		t.Fatalf("copied %d, file %d below the floor", n, info.Size())
	}
	var _ whatsmeow.File = file
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
