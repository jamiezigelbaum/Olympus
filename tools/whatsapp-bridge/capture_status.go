package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The capture status receipt tells Olympus two things the spool cannot: that
// capture is running while the account is simply quiet, and how many messages
// were lost before they reached the spool. It lives in the spool directory
// beside the YYYY-MM-DD.jsonl files (the connector lists only *.jsonl) and
// carries counts and times only: no JID, no name, no text.
const (
	captureStatusName     = "capture-status.json"
	captureStatusKind     = "whatsapp_capture_status"
	captureStatusInterval = time.Minute
)

type captureStatusReceipt struct {
	Kind      string `json:"kind"`
	UpdatedAt string `json:"updated_at"`
	Connected bool   `json:"connected"`
	// The last time this process knew it was connected and authenticated.
	// Kept across a disconnect and a restart, so a reader can tell "capture
	// stopped at T" from "capture never ran".
	ConnectedThrough string `json:"connected_through,omitempty"`
	// Messages dropped because the spool queue was full, over the life of
	// this state directory (carried across restarts).
	DroppedMessages int64  `json:"dropped_messages"`
	LastDroppedAt   string `json:"last_dropped_at,omitempty"`
	// Media is waiting for disk space (media_waiting.go): said, never counted.
	MediaWaitingForDisk bool `json:"media_waiting_for_disk,omitempty"`
}

type captureStatus struct {
	path string
	now  func() time.Time
	wake chan struct{}

	mu               sync.Mutex
	connected        bool
	connectedThrough time.Time
	dropped          int64
	lastDropped      time.Time
	mediaWaiting     bool
	writeFailed      bool
}

func newCaptureStatus(spoolDir string) *captureStatus {
	status := &captureStatus{
		path: filepath.Join(spoolDir, captureStatusName),
		now:  time.Now,
		wake: make(chan struct{}, 1),
	}
	// Carry the earlier process's totals so a restart never resets the drop
	// count or forgets when capture last ran.
	if raw, err := os.ReadFile(status.path); err == nil {
		var previous captureStatusReceipt
		if json.Unmarshal(raw, &previous) == nil && previous.Kind == captureStatusKind {
			if previous.DroppedMessages > 0 {
				status.dropped = previous.DroppedMessages
			}
			status.lastDropped = parseStatusTime(previous.LastDroppedAt)
			status.connectedThrough = parseStatusTime(previous.ConnectedThrough)
		}
	}
	return status
}

func parseStatusTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func (s *captureStatus) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *captureStatus) setConnected(connected bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	if connected || s.connected {
		s.connectedThrough = s.now()
	}
	s.connected = connected
	s.mu.Unlock()
	s.poke()
}

// setMediaWaiting says whether any media is waiting for disk space.
func (s *captureStatus) setMediaWaiting(waiting bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	changed := s.mediaWaiting != waiting
	s.mediaWaiting = waiting
	s.mu.Unlock()
	if changed {
		s.poke()
	}
}

// recordDrop never blocks: it runs on the provider's event loop.
func (s *captureStatus) recordDrop() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.dropped++
	s.lastDropped = s.now()
	s.mu.Unlock()
	s.poke()
}

func (s *captureStatus) receipt() captureStatusReceipt {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC()
	if s.connected {
		s.connectedThrough = now
	}
	receipt := captureStatusReceipt{
		Kind:                captureStatusKind,
		UpdatedAt:           now.Format(time.RFC3339),
		Connected:           s.connected,
		DroppedMessages:     s.dropped,
		MediaWaitingForDisk: s.mediaWaiting,
	}
	if !s.connectedThrough.IsZero() {
		receipt.ConnectedThrough = s.connectedThrough.UTC().Format(time.RFC3339)
	}
	if !s.lastDropped.IsZero() {
		receipt.LastDroppedAt = s.lastDropped.UTC().Format(time.RFC3339)
	}
	return receipt
}

func (s *captureStatus) write() {
	payload, err := json.Marshal(s.receipt())
	if err == nil {
		err = writeFileAtomicPrivate(s.path, append(payload, '\n'))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil && !s.writeFailed {
		// Logged once per failure run: a disk that refuses this file is
		// refusing the spool too, and the spool writer reports that loudly.
		log.Print("olympus-whatsapp-bridge: could not write the capture status receipt")
	}
	s.writeFailed = err != nil
}

// run writes the receipt every interval and whenever something changes, until
// stop closes; the last write says capture is no longer connected.
func (s *captureStatus) run(stop <-chan struct{}) {
	ticker := time.NewTicker(captureStatusInterval)
	defer ticker.Stop()
	s.write()
	for {
		select {
		case <-ticker.C:
			s.write()
		case <-s.wake:
			s.write()
		case <-stop:
			s.setConnected(false)
			s.write()
			return
		}
	}
}
