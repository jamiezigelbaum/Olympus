package main

import (
	"context"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func mediaStores(dir string, downloader *fakeDownloader) *audioMediaStore {
	store := newAudioMediaStore(dir, downloader)
	return store
}

func TestRecordFromMessageSavesPicturesAndVideosInTheirOwnFolders(t *testing.T) {
	dir := t.TempDir()
	downloader := &fakeDownloader{bytes: []byte("synthetic media bytes")}
	store := mediaStores(dir, downloader)

	photo, ok := recordFromMessage(context.Background(), nil, store, captionEvent("photo-1", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype:   proto.String("image/jpeg"),
		FileLength: proto.Uint64(21),
		Caption:    proto.String("the harbour"),
		MediaKey:   []byte{1, 2, 3},
		DirectPath: proto.String("/mms/image"),
	}}))
	if !ok || photo.DownloadStatus != "ok" || filepath.Dir(photo.MediaPath) != filepath.Join(dir, "media", "images") {
		t.Fatalf("photo record = %#v", photo)
	}
	if photo.Text != "the harbour" || photo.MediaMime != "image/jpeg" || photo.MediaDirectPath != "/mms/image" {
		t.Fatalf("photo fields = %#v", photo)
	}

	clip, ok := recordFromMessage(context.Background(), nil, store, captionEvent("clip-1", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
		Mimetype:   proto.String("video/mp4"),
		FileLength: proto.Uint64(21),
		Seconds:    proto.Uint32(12),
	}}))
	if !ok || clip.DownloadStatus != "ok" || filepath.Dir(clip.MediaPath) != filepath.Join(dir, "media", "video") || clip.MediaDurationSeconds != 12 {
		t.Fatalf("video record = %#v", clip)
	}
	if downloader.calls != 2 {
		t.Fatalf("downloads = %d, want 2", downloader.calls)
	}
}

func TestStoresWithoutPictureFoldersKeepMetadataOnly(t *testing.T) {
	downloader := &fakeDownloader{bytes: []byte("x")}
	store := &audioMediaStore{dir: t.TempDir(), downloader: downloader}
	rec, _ := recordFromMessage(context.Background(), nil, store, captionEvent("p-2", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg")}}))
	if rec.MediaPath != "" || rec.DownloadStatus != "" || downloader.calls != 0 {
		t.Fatalf("record = %#v", rec)
	}
}
