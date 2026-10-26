package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
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

// grant writes Olympus's grant for a waiting record: the line spooled for it, and that line's digest.
func grant(t *testing.T, store *audioMediaStore, rec spoolRecord) {
	t.Helper()
	line, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(mediaGrant{LineSHA256: lineDigest(line), Line: string(line)})
	if err := os.WriteFile(grantPathOf(store.queue.pathOf(rec)), payload, 0o600); err != nil {
		t.Fatal(err)
	}
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
	// Olympus judged the message not Secret.
	grant(t, store, rec)
	var spooled []spoolRecord
	spool := func(rec spoolRecord) error { spooled = append(spooled, rec); return nil }
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

// waitFor makes a store whose pictures `ids` wait for disk space, each granted by Olympus, the volume
// then having room again.
func waitFor(t *testing.T, downloader mediaDownloader, ids ...string) (*audioMediaStore, *uint64) {
	t.Helper()
	store, free, recs := waitUngranted(t, downloader, ids...)
	for _, rec := range recs {
		grant(t, store, rec)
	}
	return store, free
}

// waitUngranted is waitFor before Olympus has granted anything.
func waitUngranted(t *testing.T, downloader mediaDownloader, ids ...string) (*audioMediaStore, *uint64, []spoolRecord) {
	t.Helper()
	free := uint64(1024)
	store := newAudioMediaStore(t.TempDir(), downloader)
	store.queue.space = spaceOf(&free, testVolume)
	var recs []spoolRecord
	for _, id := range ids {
		rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent(id, &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Mimetype: proto.String("image/jpeg"),
			Caption:  proto.String("the harbour at dusk"),
		}}))
		if rec.DownloadStatus != mediaWaitingStatus {
			t.Fatalf("record = %#v", rec)
		}
		recs = append(recs, rec)
		// Each waits in turn, oldest first.
		time.Sleep(10 * time.Millisecond)
	}
	free = testVolume
	return store, &free, recs
}

func TestAWaitingEntryGoesOnlyOnceItsLineIsWritten(t *testing.T) {
	store, _ := waitFor(t, &streamingDownloader{chunk: []byte("picture"), times: 1}, "durable-1")
	failing := func(spoolRecord) error { return errors.New("spool queue closed") }
	store.queue.retry(context.Background(), store, failing)
	if len(store.queue.waiting()) != 1 {
		t.Fatalf("the entry went although its line was never written")
	}
	var spooled []spoolRecord
	store.queue.retry(context.Background(), store, func(rec spoolRecord) error { spooled = append(spooled, rec); return nil })
	if len(spooled) != 1 || len(store.queue.waiting()) != 0 {
		t.Fatalf("spooled %d, waiting %d", len(spooled), len(store.queue.waiting()))
	}
}

func TestWriteDurablyReturnsOnceTheLineIsOnDisk(t *testing.T) {
	spoolDir := t.TempDir()
	writer := newSpoolWriter(spoolDir)
	go writer.run()
	defer writer.close()
	if err := writer.writeDurably(context.Background(), spoolRecord{ID: "durable-2", ChatJID: "15550001111@s.whatsapp.net"}); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(spoolDir, "*.jsonl"))
	if len(files) != 1 {
		t.Fatalf("spool files = %v", files)
	}
	raw, _ := os.ReadFile(files[0])
	if !strings.Contains(string(raw), `"durable-2"`) {
		t.Fatalf("the line is not on disk when writeDurably returned")
	}
}

func TestAPassingFailureKeepsTheMediaWaitingAndAPermanentOneEndsIt(t *testing.T) {
	store, _ := waitFor(t, &streamingDownloader{err: errors.New("connection reset by peer")}, "blip-1")
	status := newCaptureStatus(t.TempDir())
	store.queue.status = status
	var spooled []spoolRecord
	spool := func(rec spoolRecord) error { spooled = append(spooled, rec); return nil }
	store.queue.retry(context.Background(), store, spool)
	if len(spooled) != 0 || len(store.queue.waiting()) != 1 || !status.receipt().MediaWaitingForDisk {
		t.Fatalf("a network blip ended the wait: spooled %d, waiting %d", len(spooled), len(store.queue.waiting()))
	}
	// Gone from WhatsApp's servers: it can never be fetched, so it is spooled as failed and stops waiting.
	store.downloader = &streamingDownloader{err: whatsmeow.ErrMediaDownloadFailedWith404}
	store.images.downloader = store.downloader
	store.queue.retry(context.Background(), store, spool)
	if len(spooled) != 1 || !strings.HasPrefix(spooled[0].DownloadStatus, "failed:") || len(store.queue.waiting()) != 0 || status.receipt().MediaWaitingForDisk {
		t.Fatalf("spooled = %#v, waiting %d", spooled, len(store.queue.waiting()))
	}
}

// sizedDownloader writes `sizes[n]` bytes on its n-th call.
type sizedDownloader struct {
	sizes []int
	calls int
}

func (d *sizedDownloader) DownloadMediaWithPathToFile(_ context.Context, _ string, _, _, _ []byte, _ whatsmeow.MediaType, _ string, _ bool, file whatsmeow.File) error {
	size := d.sizes[d.calls%len(d.sizes)]
	d.calls++
	for written := 0; written < size; written += 1024 {
		if _, err := file.Write(make([]byte, 1024)); err != nil {
			return err
		}
	}
	return nil
}

func TestAMediaTooLargeForTheRoomIsSkippedAndSmallerOnesAfterItStillGo(t *testing.T) {
	saved := diskCheckEveryBytes
	diskCheckEveryBytes = 1024
	defer func() { diskCheckEveryBytes = saved }()
	// The first waiting picture is 64 KiB, the second 2 KiB; the volume has 32 KiB above its floor.
	downloader := &sizedDownloader{sizes: []int{64 * 1024, 2 * 1024}}
	store, _ := waitFor(t, downloader, "big-2", "small-2")
	images := store.images.dir
	floor := diskFloor(testVolume)
	store.queue.space = func(string) (uint64, uint64, error) {
		var temps uint64
		entries, _ := os.ReadDir(images)
		for _, entry := range entries {
			if info, err := entry.Info(); err == nil && isMediaTemp(entry.Name()) {
				temps += uint64(info.Size())
			}
		}
		return floor + 32*1024 - temps, testVolume, nil
	}
	var spooled []spoolRecord
	store.queue.retry(context.Background(), store, func(rec spoolRecord) error { spooled = append(spooled, rec); return nil })
	if len(spooled) != 1 || spooled[0].ID != "small-2" || spooled[0].DownloadStatus != "ok" {
		t.Fatalf("spooled = %#v", spooled)
	}
	if waiting := store.queue.waiting(); len(waiting) != 1 || filepath.Base(waiting[0]) != mediaFileStem(spooled[0].ChatJID, "big-2")+".json" {
		t.Fatalf("waiting = %v", waiting)
	}
}

func TestStartSweepsAWaitingEntryAKilledBridgeNeverRenamed(t *testing.T) {
	dir := t.TempDir()
	store := newAudioMediaStore(dir, &fakeDownloader{})
	waitingDir := filepath.Join(dir, "media", "waiting")
	if err := os.MkdirAll(waitingDir, 0o700); err != nil {
		t.Fatal(err)
	}
	stem := mediaFileStem("15550001111@s.whatsapp.net", "orphan-1")
	orphan := filepath.Join(waitingDir, "."+stem+".json.tmp123456")
	kept := filepath.Join(waitingDir, stem+".json")
	for _, path := range []string{orphan, kept} {
		if err := os.WriteFile(path, []byte(`{"text":"the door code"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	store.sweepTemps(time.Now())
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("the orphaned temp survived the start")
	}
	if _, err := os.Stat(kept); err != nil {
		t.Fatalf("a waiting entry was swept: %v", err)
	}
}

func TestAWaitingEntryHoldsNothingTheMessageSaid(t *testing.T) {
	store, _, recs := waitUngranted(t, &streamingDownloader{}, "words-1")
	raw, err := os.ReadFile(store.queue.pathOf(recs[0]))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "harbour") || strings.Contains(string(raw), recs[0].SenderName) && recs[0].SenderName != "" {
		t.Fatalf("the entry holds the message's words: %s", raw)
	}
}

func TestWaitingMediaWithoutAGrantIsNeverDownloaded(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("picture"), times: 1}
	store, _, _ := waitUngranted(t, downloader, "ungranted-1")
	// Room again, but Olympus has not judged the message not Secret: nothing is fetched.
	store.queue.retry(context.Background(), store, func(spoolRecord) error { t.Fatal("spooled without a grant"); return nil })
	if downloader.calls != 0 || len(store.queue.waiting()) != 1 {
		t.Fatalf("downloaded %d times, waiting %d", downloader.calls, len(store.queue.waiting()))
	}
}

func TestAGrantThatDoesNotMatchItsEntryIsNotUsed(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("picture"), times: 1}
	store, _, recs := waitUngranted(t, downloader, "mismatch-1", "mismatch-2")
	write := func(rec spoolRecord, g mediaGrant) {
		payload, _ := json.Marshal(g)
		if err := os.WriteFile(grantPathOf(store.queue.pathOf(rec)), payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A grant for another version of the message (its line changed since).
	edited := recs[0]
	edited.Text = "an edited caption"
	line, _ := json.Marshal(edited)
	write(recs[0], mediaGrant{LineSHA256: lineDigest(line), Line: string(line)})
	// A grant whose digest is the entry's, over another message's line.
	other, _ := json.Marshal(recs[0])
	entry, _ := readEntry(store.queue.pathOf(recs[1]))
	write(recs[1], mediaGrant{LineSHA256: entry.LineSHA256, Line: string(other)})
	store.queue.retry(context.Background(), store, func(spoolRecord) error { t.Fatal("spooled on a grant that does not match"); return nil })
	if downloader.calls != 0 || len(store.queue.waiting()) != 2 {
		t.Fatalf("downloaded %d times, waiting %d", downloader.calls, len(store.queue.waiting()))
	}
}

func TestTheGrantedLineIsWhatIsSpooledWithItsMedia(t *testing.T) {
	store, _, recs := waitUngranted(t, &streamingDownloader{chunk: []byte("picture"), times: 1}, "granted-1")
	grant(t, store, recs[0])
	var spooled []spoolRecord
	store.queue.retry(context.Background(), store, func(rec spoolRecord) error { spooled = append(spooled, rec); return nil })
	if len(spooled) != 1 || spooled[0].Text != "the harbour at dusk" || spooled[0].DownloadStatus != "ok" || spooled[0].MediaPath == "" {
		t.Fatalf("spooled = %#v", spooled)
	}
	if len(store.queue.waiting()) != 0 {
		t.Fatalf("the entry stayed")
	}
	if _, err := os.Stat(grantPathOf(store.queue.pathOf(recs[0]))); !os.IsNotExist(err) {
		t.Fatalf("the grant stayed")
	}
}

func TestACrashBetweenDownloadAndSpoolMakesTheGrantedDownloadAgain(t *testing.T) {
	store, _ := waitFor(t, &streamingDownloader{chunk: []byte("picture"), times: 1}, "crash-1")
	// The bridge stops after the download is saved and before its line is written.
	store.queue.retry(context.Background(), store, func(spoolRecord) error { return errors.New("killed") })
	if len(store.queue.waiting()) != 1 {
		t.Fatalf("the entry went although its line was never written")
	}
	var spooled []spoolRecord
	store.queue.retry(context.Background(), store, func(rec spoolRecord) error { spooled = append(spooled, rec); return nil })
	if len(spooled) != 1 || spooled[0].DownloadStatus != "ok" {
		t.Fatalf("spooled = %#v", spooled)
	}
	// The same bytes reused the file the first download saved: one file, named by the line.
	entries, _ := os.ReadDir(store.images.dir)
	if len(entries) != 1 || filepath.Join(store.images.dir, entries[0].Name()) != spooled[0].MediaPath {
		t.Fatalf("media files = %v", entries)
	}
}

func TestAnEntryNeverGrantedIsDroppedInTime(t *testing.T) {
	store, _, recs := waitUngranted(t, &streamingDownloader{}, "old-1")
	path := store.queue.pathOf(recs[0])
	old := time.Now().Add(-2 * waitingEntryKeep)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	store.queue.retry(context.Background(), store, func(spoolRecord) error { return nil })
	if len(store.queue.waiting()) != 0 {
		t.Fatalf("an entry never granted stayed past its time")
	}
}
