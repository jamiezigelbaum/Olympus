package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
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
	for _, kept := range []string{"waiting", "fetch", "fetched"} {
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

// serving starts the download call on a fresh state folder; `ask` sends one request and reads its answer.
func serving(t *testing.T, stateDir string, downloader mediaDownloader) (*audioMediaStore, func(downloadRequest) (downloadAnswer, []byte)) {
	t.Helper()
	store := newAudioMediaStore(stateDir, downloader)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		store.serveDownloads(ctx, stateDir)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	pointer := filepath.Join(stateDir, mediaSocketPointer)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(pointer); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the download call never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	ask := func(request downloadRequest) (downloadAnswer, []byte) {
		t.Helper()
		raw, err := os.ReadFile(pointer)
		if err != nil {
			t.Fatal(err)
		}
		var named struct {
			Socket string `json:"socket"`
		}
		if err := json.Unmarshal(raw, &named); err != nil {
			t.Fatal(err)
		}
		conn, err := net.Dial("unix", named.Socket)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		line, _ := json.Marshal(request)
		if _, err := conn.Write(append(line, '\n')); err != nil {
			t.Fatal(err)
		}
		reader := bufio.NewReader(conn)
		head, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var answer downloadAnswer
		if err := json.Unmarshal(head, &answer); err != nil {
			t.Fatal(err)
		}
		if answer.Status != "ok" {
			return answer, nil
		}
		body := make([]byte, answer.Size)
		if _, err := io.ReadFull(reader, body); err != nil {
			t.Fatal(err)
		}
		return answer, body
	}
	return store, ask
}

func pictureRequest(id string) downloadRequest {
	return downloadRequest{
		ChatJID:            "15551234567@s.whatsapp.net",
		ID:                 id,
		Version:            "2026-10-25T09:00:00Z",
		MediaType:          "image",
		MediaMime:          "image/jpeg",
		MediaKey:           "AQID",
		MediaDirectPath:    "/mms/image/" + id,
		MediaFileSHA256:    "BwgJ",
		MediaFileEncSHA256: "BAUG",
	}
}

// everyFile lists every file under the state folder but the socket and its pointer.
func everyFile(t *testing.T, stateDir string) []string {
	t.Helper()
	var found []string
	_ = filepath.WalkDir(stateDir, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && entry.Name() != mediaSocketName && entry.Name() != mediaSocketPointer {
			found = append(found, path)
		}
		return nil
	})
	return found
}

func TestTheWaitingLineCarriesWhatALaterDownloadNeeds(t *testing.T) {
	free := uint64(1024)
	store := newAudioMediaStore(t.TempDir(), &streamingDownloader{})
	store.floor.space = spaceOf(&free, testVolume)
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("line-1", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype:      proto.String("image/jpeg"),
		MediaKey:      []byte{1, 2, 3},
		FileEncSHA256: []byte{4, 5, 6},
		FileSHA256:    []byte{7, 8, 9},
		DirectPath:    proto.String("/mms/image/line-1"),
	}}))
	if rec.DownloadStatus != mediaWaitingStatus || rec.MediaDirectPath != "/mms/image/line-1" || rec.MediaKey == "" || rec.MediaFileSHA256 == "" || rec.MediaFileEncSHA256 == "" || rec.MediaMime != "image/jpeg" {
		t.Fatalf("record = %#v", rec)
	}
}

func TestTheDownloadCallAnswersTheBytesAndKeepsNothing(t *testing.T) {
	stateDir := t.TempDir()
	downloader := &streamingDownloader{chunk: []byte("picture bytes"), times: 1}
	_, ask := serving(t, stateDir, downloader)
	answer, body := ask(pictureRequest("asked-1"))
	if answer.Status != "ok" || answer.Size != int64(len("picture bytes")) || string(body) != "picture bytes" {
		t.Fatalf("answer = %#v, body = %q", answer, body)
	}
	// The bridge wrote no file for it: the download was decrypted in a temp that never had a name to keep.
	if files := everyFile(t, stateDir); len(files) != 0 {
		t.Fatalf("files left: %v", files)
	}
	info, err := os.Stat(filepath.Join(stateDir, mediaSocketName))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket: %v %v", info, err)
	}
}

func TestBelowTheFloorTheCallAnswersAPassingFailureAndTheStatusSaysMediaWaits(t *testing.T) {
	stateDir := t.TempDir()
	downloader := &streamingDownloader{chunk: []byte("picture"), times: 1}
	store, ask := serving(t, stateDir, downloader)
	free := uint64(1024)
	store.floor.space = spaceOf(&free, testVolume)
	status := newCaptureStatus(t.TempDir())
	store.floor.status = status
	answer, _ := ask(pictureRequest("low-1"))
	if answer.Status != "failed" || answer.Permanent || answer.Reason != "waiting_for_disk" || downloader.calls != 0 {
		t.Fatalf("answer = %#v, calls %d", answer, downloader.calls)
	}
	if !status.receipt().MediaWaitingForDisk {
		t.Fatalf("the status does not say media waits")
	}
	free = testVolume
	store.floor.look()
	if status.receipt().MediaWaitingForDisk {
		t.Fatalf("still waiting once there was room")
	}
}

func TestAPassingFailureAndAPermanentOneAreToldApart(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("partial"), times: 1, err: errors.New("connection reset by peer")}
	stateDir := t.TempDir()
	_, ask := serving(t, stateDir, downloader)
	if answer, _ := ask(pictureRequest("blip-1")); answer.Status != "failed" || answer.Permanent {
		t.Fatalf("a network blip: %#v", answer)
	}
	downloader.err = fmt.Errorf("download: %w", whatsmeow.ErrInvalidMediaSHA256)
	if answer, _ := ask(pictureRequest("blip-1")); answer.Status != "failed" || !answer.Permanent {
		t.Fatalf("a bad hash: %#v", answer)
	}
	// A failed download leaves nothing behind either.
	if files := everyFile(t, stateDir); len(files) != 0 {
		t.Fatalf("files left: %v", files)
	}
}

func TestARequestWithoutWhereTheMediaIsIsRefused(t *testing.T) {
	downloader := &streamingDownloader{chunk: []byte("picture"), times: 1}
	_, ask := serving(t, t.TempDir(), downloader)
	request := pictureRequest("bad-1")
	request.MediaDirectPath = ""
	if answer, _ := ask(request); answer.Status != "failed" || !answer.Permanent || answer.Reason != "bad_request" || downloader.calls != 0 {
		t.Fatalf("answer = %#v, calls %d", answer, downloader.calls)
	}
	request = pictureRequest("bad-2")
	request.MediaType = "sticker"
	if answer, _ := ask(request); answer.Status != "failed" || !answer.Permanent || downloader.calls != 0 {
		t.Fatalf("answer = %#v, calls %d", answer, downloader.calls)
	}
}

func TestALongStateFolderPutsTheSocketInAPrivateTempFolder(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), strings.Repeat("a-long-account-folder-name/", 4))
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	_, ask := serving(t, stateDir, &streamingDownloader{chunk: []byte("picture"), times: 1})
	raw, _ := os.ReadFile(filepath.Join(stateDir, mediaSocketPointer))
	var named struct {
		Socket string `json:"socket"`
	}
	_ = json.Unmarshal(raw, &named)
	if strings.HasPrefix(named.Socket, stateDir) || len(named.Socket) > mediaSocketMaxPath {
		t.Fatalf("socket = %q", named.Socket)
	}
	if info, err := os.Stat(filepath.Dir(named.Socket)); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("socket folder: %v %v", info, err)
	}
	if answer, body := ask(pictureRequest("long-1")); answer.Status != "ok" || string(body) != "picture" {
		t.Fatalf("answer = %#v", answer)
	}
}
