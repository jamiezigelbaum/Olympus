package main

// Saving one piece of media, without ever holding more than its bound and
// without leaving a copy behind.
//
//   - A download streams into a temp file in the media folder, through a
//     writer that refuses past the store's bound (plus the encryption
//     overhead), so a large attachment is never read into memory and never
//     written whole. The size WhatsApp states is not trusted.
//   - Every temp has one known name:
//     `.olympus-media-<pid>-<boot>-<stem>-<random>.tmp`, where boot is this
//     boot's nonce (a pid is unique only within a boot) and the stem is the
//     message's file stem (mediaFileStem). Every failure path removes it. A
//     temp whose writer is alive in this boot is never swept, however long
//     its download stalls; one whose writer is gone (its pid dead, or of
//     another boot) is swept at start, and Olympus sweeps the same before
//     Secrets clearing and removes a Secret message's temps by its stem. A
//     temp named another way (an older build's) is swept once it is older
//     than mediaTempMaxAge.
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
	// A temp of an older build (no writer named) older than this is a leftover.
	mediaTempMaxAge = 30 * time.Minute
	// What encryption adds to a file's bytes on the wire (padding and the MAC), allowed past the bound.
	mediaEncryptionOverhead = 64
)

var errMediaTooLarge = errors.New("media too large")

// mediaDownloader streams one attachment into a file (whatsmeow's DownloadToFile).
type mediaDownloader interface {
	DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error
}

// cappedFile is a temp file that refuses any write past its limit. It does
// not embed the file: an embedded *os.File would lend it ReadFrom, through
// which io.Copy writes without asking Write, so every method is its own.
type cappedFile struct {
	file  *os.File
	limit int64
}

func (f *cappedFile) Read(p []byte) (int, error)                   { return f.file.Read(p) }
func (f *cappedFile) ReadAt(p []byte, off int64) (int, error)      { return f.file.ReadAt(p, off) }
func (f *cappedFile) Seek(offset int64, whence int) (int64, error) { return f.file.Seek(offset, whence) }
func (f *cappedFile) Stat() (os.FileInfo, error)                   { return f.file.Stat() }

func (f *cappedFile) Write(p []byte) (int, error) {
	at, err := f.file.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	if at+int64(len(p)) > f.limit {
		return 0, errMediaTooLarge
	}
	return f.file.Write(p)
}

// ReadFrom copies within the limit, so io.Copy into this file is capped too.
func (f *cappedFile) ReadFrom(r io.Reader) (int64, error) {
	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, err := r.Read(buf)
		if n > 0 {
			written, werr := f.Write(buf[:n])
			total += int64(written)
			if werr != nil {
				return total, werr
			}
		}
		if errors.Is(err, io.EOF) {
			return total, nil
		}
		if err != nil {
			return total, err
		}
	}
}

func (f *cappedFile) WriteAt(p []byte, off int64) (int, error) {
	if off+int64(len(p)) > f.limit {
		return 0, errMediaTooLarge
	}
	return f.file.WriteAt(p, off)
}

func (f *cappedFile) Truncate(size int64) error {
	if size > f.limit {
		return errMediaTooLarge
	}
	return f.file.Truncate(size)
}

// bootNonce names this boot in a temp's name: a pid is unique only within a boot.
var bootNonce = func() string {
	id := bootID()
	if id == "" {
		return "00000000"
	}
	sum := sha256.Sum256([]byte(id))
	return fmt.Sprintf("%x", sum[:4])
}()

// mediaTempPattern is the CreateTemp pattern for one message's media.
func mediaTempPattern(stem string) string {
	return fmt.Sprintf("%s%d-%s-%s-*%s", mediaTempPrefix, os.Getpid(), bootNonce, stem, mediaTempSuffix)
}

// mediaTempWriter is the pid and boot nonce a temp's name carries; ok is false for a name that carries none.
func mediaTempWriter(name string) (pid int, boot string, ok bool) {
	if !strings.HasPrefix(name, mediaTempPrefix) || !strings.HasSuffix(name, mediaTempSuffix) {
		return 0, "", false
	}
	parts := strings.SplitN(strings.TrimPrefix(name, mediaTempPrefix), "-", 3)
	if len(parts) < 3 || len(parts[1]) != 8 {
		return 0, "", false
	}
	pid, err := strconv.Atoi(parts[0])
	if err != nil || pid <= 0 {
		return 0, "", false
	}
	return pid, parts[1], true
}

// mediaTempPID is the pid a temp's name carries, or 0 when it carries none.
func mediaTempPID(name string) int {
	pid, _, _ := mediaTempWriter(name)
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
// one whose writer is gone (its pid dead, or of another boot), or an older
// build's past mediaTempMaxAge. A temp whose writer is alive in this boot
// stays, however long its download stalls.
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
			if pid, boot, named := mediaTempWriter(name); named {
				if boot == bootNonce && (pid == os.Getpid() || processAlive(pid)) {
					continue
				}
			} else if now.Sub(info.ModTime()) < mediaTempMaxAge {
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
	capped := &cappedFile{file: tmp, limit: store.maxFileBytes + mediaEncryptionOverhead}
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
