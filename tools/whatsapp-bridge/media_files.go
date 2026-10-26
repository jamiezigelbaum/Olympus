package main

// Saving one piece of media, without ever holding more than its bound and
// without leaving a copy behind.
//
//   - A download streams into a temp file in the media folder, through a
//     writer that refuses past the store's bound (plus the encryption
//     overhead), so a large attachment is never read into memory and never
//     written whole. The size WhatsApp states is not trusted.
//   - Every temp has one known name: `.olympus-media-<pid>-<stem>-<random>.tmp`,
//     where the stem is the message's file stem (mediaFileStem). Every failure
//     path removes it; a temp a killed bridge left behind is swept at start
//     (its pid is gone, or it is older than mediaTempMaxAge), and Olympus's
//     Secrets clearing removes a Secret message's temps by its stem.
//   - The final step links rather than renames, so an existing file is never
//     overwritten: identical bytes (a re-delivered message) reuse it,
//     different bytes take the next free "-N" name.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow"
)

const (
	mediaTempPrefix = ".olympus-media-"
	mediaTempSuffix = ".tmp"
	// A temp older than this is a leftover whoever wrote it: no single download takes so long.
	mediaTempMaxAge = 30 * time.Minute
	// What encryption adds to a file's bytes on the wire (padding and the MAC), allowed past the bound.
	mediaEncryptionOverhead = 64
)

var errMediaTooLarge = errors.New("media too large")

// mediaDownloader streams one attachment into a file (whatsmeow's DownloadToFile).
type mediaDownloader interface {
	DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error
}

// cappedFile is a temp file that refuses any write past its limit.
type cappedFile struct {
	*os.File
	limit int64
}

func (f *cappedFile) Write(p []byte) (int, error) {
	at, err := f.File.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	if at+int64(len(p)) > f.limit {
		return 0, errMediaTooLarge
	}
	return f.File.Write(p)
}

func (f *cappedFile) WriteAt(p []byte, off int64) (int, error) {
	if off+int64(len(p)) > f.limit {
		return 0, errMediaTooLarge
	}
	return f.File.WriteAt(p, off)
}

func (f *cappedFile) Truncate(size int64) error {
	if size > f.limit {
		return errMediaTooLarge
	}
	return f.File.Truncate(size)
}

// mediaTempPattern is the CreateTemp pattern for one message's media.
func mediaTempPattern(stem string) string {
	return fmt.Sprintf("%s%d-%s-*%s", mediaTempPrefix, os.Getpid(), stem, mediaTempSuffix)
}

// mediaTempPID is the pid a temp's name carries, or 0 when it carries none.
func mediaTempPID(name string) int {
	if !strings.HasPrefix(name, mediaTempPrefix) || !strings.HasSuffix(name, mediaTempSuffix) {
		return 0
	}
	rest := strings.TrimPrefix(name, mediaTempPrefix)
	dash := strings.IndexByte(rest, '-')
	if dash <= 0 {
		return 0
	}
	pid, err := strconv.Atoi(rest[:dash])
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// isMediaTemp says whether a name is a media temp, of this build or of the
// one before (`.audio-*.tmp`).
func isMediaTemp(name string) bool {
	return (strings.HasPrefix(name, mediaTempPrefix) || strings.HasPrefix(name, ".audio-")) && strings.HasSuffix(name, mediaTempSuffix)
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// sweepTemps removes the media temps a bridge that was killed left behind:
// one whose writer is gone, an older build's, or one older than
// mediaTempMaxAge. This bridge's own temps of a download still running stay.
func (store *audioMediaStore) sweepTemps(now time.Time) {
	if store == nil {
		return
	}
	for _, each := range []*audioMediaStore{store, store.images, store.video} {
		if each == nil {
			continue
		}
		entries, err := os.ReadDir(each.dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if !entry.Type().IsRegular() || !isMediaTemp(name) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			pid := mediaTempPID(name)
			ours := pid == os.Getpid()
			if (ours || processAlive(pid)) && now.Sub(info.ModTime()) < mediaTempMaxAge {
				continue
			}
			_ = os.Remove(filepath.Join(each.dir, name))
		}
	}
}

// download streams one attachment into a temp within the bound and saves it
// under the message's name. It returns the saved path and its size; the temp
// is gone whatever happened.
func (store *audioMediaStore) download(ctx context.Context, chatJID string, messageID string, mediaMime string, media whatsmeow.DownloadableMessage) (string, int64, error) {
	if err := os.MkdirAll(store.dir, 0o700); err != nil {
		return "", 0, err
	}
	stem := mediaFileStem(chatJID, messageID)
	tmp, err := os.CreateTemp(store.dir, mediaTempPattern(stem))
	if err != nil {
		return "", 0, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", 0, err
	}
	capped := &cappedFile{File: tmp, limit: store.maxFileBytes + mediaEncryptionOverhead}
	if err := store.downloader.DownloadToFile(ctx, media, capped); err != nil {
		tmp.Close()
		return "", 0, err
	}
	info, err := tmp.Stat()
	if err != nil {
		tmp.Close()
		return "", 0, err
	}
	if info.Size() > store.maxFileBytes {
		tmp.Close()
		return "", 0, errMediaTooLarge
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", 0, err
	}
	if err := tmp.Close(); err != nil {
		return "", 0, err
	}
	path, err := store.linkTemp(tmpPath, stem, extensionFromMime(mediaMime))
	if err != nil {
		return "", 0, err
	}
	return path, info.Size(), nil
}

// linkTemp gives a finished temp its final name (see the header).
func (store *audioMediaStore) linkTemp(tmpPath string, stem string, ext string) (string, error) {
	for attempt := 0; attempt < audioMediaNameAttempts; attempt++ {
		name := stem + ext
		if attempt > 0 {
			name = fmt.Sprintf("%s-%d%s", stem, attempt, ext)
		}
		path := filepath.Join(store.dir, name)
		err := os.Link(tmpPath, path)
		if err == nil {
			return path, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", err
		}
		if sameFileContent(path, tmpPath) {
			return path, nil
		}
	}
	return "", fmt.Errorf("no free media file name for %s", stem)
}

func sameFileContent(a string, b string) bool {
	left, err := fileDigest(a)
	if err != nil {
		return false
	}
	right, err := fileDigest(b)
	return err == nil && bytes.Equal(left, right)
}

func fileDigest(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return nil, err
	}
	return hash.Sum(nil), nil
}
