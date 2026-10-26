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
	store.floor.space = spaceOf(&free, testVolume)
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
	store.floor.space = spaceOf(&free, testVolume)
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
	// The line is the only record: nothing is kept beside it, and nothing is asked for yet.
	for _, kept := range []string{"waiting", mediaFetchDirName, mediaFetchedDirName} {
		if _, err := os.Stat(filepath.Join(dir, "media", kept)); !os.IsNotExist(err) {
			t.Fatalf("media/%s was made: %v", kept, err)
		}
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
	store.floor.space = spaceOf(&free, testVolume)
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
}

func TestAFailedDownloadLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	downloader := &streamingDownloader{chunk: []byte("partial bytes"), times: 3, err: errors.New("network unavailable")}
	store := newAudioMediaStore(dir, downloader)
	free := uint64(testVolume)
	store.floor.space = spaceOf(&free, testVolume)
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
	floor := &mediaFloor{space: spaceOf(&free, testVolume)}
	file := &floorFile{file: tmp, floor: floor, dir: filepath.Dir(tmp.Name())}
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

// waitFor makes a store whose pictures `ids` wait for disk space, the volume then having room again.
func waitFor(t *testing.T, downloader mediaDownloader, ids ...string) (*audioMediaStore, *uint64, []spoolRecord) {
	t.Helper()
	free := uint64(1024)
	store := newAudioMediaStore(t.TempDir(), downloader)
	store.floor.space = spaceOf(&free, testVolume)
	var recs []spoolRecord
	for _, id := range ids {
		rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent(id, &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Mimetype:      proto.String("image/jpeg"),
			Caption:       proto.String("the harbour at dusk"),
			MediaKey:      []byte{1, 2, 3},
			FileEncSHA256: []byte{4, 5, 6},
			FileSHA256:    []byte{7, 8, 9},
			DirectPath:    proto.String("/mms/image/" + id),
		}}))
		if rec.DownloadStatus != mediaWaitingStatus {
			t.Fatalf("record = %#v", rec)
		}
		recs = append(recs, rec)
		// Each is asked for in turn, oldest first.
		time.Sleep(10 * time.Millisecond)
	}
	free = testVolume
	return store, &free, recs
}

// ask writes Olympus's request for a waiting record, from the fields its spool line carries.
func ask(t *testing.T, store *audioMediaStore, rec spoolRecord) string {
	t.Helper()
	stem := mediaFileStem(rec.ChatJID, rec.ID)
	payload, _ := json.Marshal(fetchRequest{
		ChatJID:            rec.ChatJID,
		ID:                 rec.ID,
		MediaType:          rec.MediaType,
		MediaMime:          rec.MediaMime,
		MediaKey:           rec.MediaKey,
		MediaDirectPath:    rec.MediaDirectPath,
		MediaFileSHA256:    rec.MediaFileSHA256,
		MediaFileEncSHA256: rec.MediaFileEncSHA256,
	})
	if err := os.MkdirAll(store.floor.fetchDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.floor.fetchDir, stem+".json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	return stem
}

func fetchedNames(t *testing.T, store *audioMediaStore) []string {
	t.Helper()
	entries, err := os.ReadDir(store.floor.fetchedDir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func TestTheWaitingLineCarriesWhatALaterDownloadNeeds(t *testing.T) {
	_, _, recs := waitFor(t, &streamingDownloader{}, "line-1")
	rec := recs[0]
	if rec.MediaDirectPath != "/mms/image/line-1" || rec.MediaKey == "" || rec.MediaFileSHA256 == "" || rec.MediaFileEncSHA256 == "" || rec.MediaMime != "image/jpeg" {
		t.Fatalf("record = %#v", rec)
	}
}

func TestWaitingMediaIsNeverDownloadedUnlessOlympusAsks(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("picture"), times: 1}
	store, _, _ := waitFor(t, downloader, "unasked-1")
	store.floor.fetch(context.Background(), store)
	if downloader.calls != 0 || len(fetchedNames(t, store)) != 0 {
		t.Fatalf("downloaded %d times without a request: %v", downloader.calls, fetchedNames(t, store))
	}
}

func TestRequestedMediaIsDownloadedOnceThereIsRoomAndNothingIsSpooled(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("picture bytes"), times: 1}
	store, free, recs := waitFor(t, downloader, "asked-1")
	status := newCaptureStatus(t.TempDir())
	store.floor.status = status
	stem := ask(t, store, recs[0])
	// Still no room: nothing happens, and the status says media waits.
	*free = 1024
	store.floor.noteWaiting()
	store.floor.fetch(context.Background(), store)
	if downloader.calls != 0 || !status.receipt().MediaWaitingForDisk {
		t.Fatalf("fetched below the floor (%d), waiting said %v", downloader.calls, status.receipt().MediaWaitingForDisk)
	}
	*free = testVolume
	store.floor.fetch(context.Background(), store)
	if names := fetchedNames(t, store); len(names) != 1 || names[0] != stem+extensionFromMime("image/jpeg") {
		t.Fatalf("fetched = %v", names)
	}
	if raw, _ := os.ReadFile(filepath.Join(store.floor.fetchedDir, stem+extensionFromMime("image/jpeg"))); string(raw) != "picture bytes" {
		t.Fatalf("fetched bytes = %q", raw)
	}
	if status.receipt().MediaWaitingForDisk {
		t.Fatalf("still waiting once there was room")
	}
	// The request is Olympus's to remove; the answer is not downloaded again.
	if _, err := os.Stat(filepath.Join(store.floor.fetchDir, stem+".json")); err != nil {
		t.Fatalf("the bridge removed the request: %v", err)
	}
	store.floor.fetch(context.Background(), store)
	if downloader.calls != 1 {
		t.Fatalf("downloaded %d times", downloader.calls)
	}
	// The bridge spools nothing for it: the media went only to media/fetched.
	if entries, _ := os.ReadDir(store.images.dir); len(entries) != 0 {
		t.Fatalf("saved beside the live pictures: %v", entries)
	}
}

func TestAPassingFailureLeavesTheRequestAndAPermanentOneAnswersFailed(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("partial"), times: 1, err: errors.New("connection reset by peer")}
	store, _, recs := waitFor(t, downloader, "blip-1")
	stem := ask(t, store, recs[0])
	store.floor.fetch(context.Background(), store)
	if names := fetchedNames(t, store); len(names) != 0 {
		t.Fatalf("a network blip left %v", names)
	}
	downloader.err = fmt.Errorf("download: %w", whatsmeow.ErrInvalidMediaSHA256)
	store.floor.fetch(context.Background(), store)
	if names := fetchedNames(t, store); len(names) != 1 || names[0] != stem+mediaFailedSuffix {
		t.Fatalf("fetched = %v", names)
	}
	store.floor.fetch(context.Background(), store)
	if downloader.calls != 2 {
		t.Fatalf("an answered request was downloaded again: %d", downloader.calls)
	}
}

func TestADownloadAKilledBridgeLeftIsDoneAgainFromTheStart(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("whole picture"), times: 1}
	store, _, recs := waitFor(t, downloader, "crash-1")
	stem := ask(t, store, recs[0])
	if err := os.MkdirAll(store.floor.fetchedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	part := filepath.Join(store.floor.fetchedDir, stem+mediaPartSuffix)
	if err := os.WriteFile(part, []byte("half of another try, longer than the picture"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The bridge starts again: the unfinished part goes, the request stays and is downloaded whole.
	store.sweepTemps(time.Now())
	if _, err := os.Stat(part); !os.IsNotExist(err) {
		t.Fatalf("the unfinished part survived the start")
	}
	store.floor.fetch(context.Background(), store)
	if raw, _ := os.ReadFile(filepath.Join(store.floor.fetchedDir, stem+extensionFromMime("image/jpeg"))); string(raw) != "whole picture" {
		t.Fatalf("fetched bytes = %q", raw)
	}
	if names := fetchedNames(t, store); len(names) != 1 {
		t.Fatalf("fetched = %v", names)
	}
}

func TestARequestNamedForOneMessageButAskingForAnotherIsNotDownloaded(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("picture"), times: 1}
	store, _, recs := waitFor(t, downloader, "named-1", "named-2")
	stem := ask(t, store, recs[1])
	// The file named for named-1 asks for named-2's media.
	if err := os.Rename(filepath.Join(store.floor.fetchDir, stem+".json"), filepath.Join(store.floor.fetchDir, mediaFileStem(recs[0].ChatJID, "named-1")+".json")); err != nil {
		t.Fatal(err)
	}
	store.floor.fetch(context.Background(), store)
	if downloader.calls != 0 {
		t.Fatalf("downloaded a request whose name is not its message")
	}
}

func TestAMediaTooLargeForTheRoomIsSkippedAndSmallerOnesAfterItStillGo(t *testing.T) {
	saved := diskCheckEveryBytes
	diskCheckEveryBytes = 1024
	defer func() { diskCheckEveryBytes = saved }()
	// The first requested picture is 64 KiB, the second 2 KiB; the volume has 32 KiB above its floor.
	downloader := &sizedDownloader{sizes: []int{64 * 1024, 2 * 1024}}
	store, _, recs := waitFor(t, downloader, "big-2", "small-2")
	big := ask(t, store, recs[0])
	time.Sleep(10 * time.Millisecond)
	small := ask(t, store, recs[1])
	floor := diskFloor(testVolume)
	store.floor.space = func(string) (uint64, uint64, error) {
		var parts uint64
		entries, _ := os.ReadDir(store.floor.fetchedDir)
		for _, entry := range entries {
			if info, err := entry.Info(); err == nil && strings.HasSuffix(entry.Name(), mediaPartSuffix) {
				parts += uint64(info.Size())
			}
		}
		return floor + 32*1024 - parts, testVolume, nil
	}
	store.floor.fetch(context.Background(), store)
	if names := fetchedNames(t, store); len(names) != 1 || names[0] != small+extensionFromMime("image/jpeg") {
		t.Fatalf("fetched = %v (big %s)", names, big)
	}
}
