package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const maxBridgeConns = 64

// ---------------------------------------------------------------------------
// Two bridges, neither of which resolves a path after the daemon starts.
//
// expose (host -> namespace, the daemon API). Stage0 binds <dir>/<name>.sock
// before the daemon exists and authenticates every connection with a mutual
// handshake keyed by a token that only travels on the private status
// descriptor. An authenticated connection is passed to stage1 as a descriptor;
// stage1 dials the fixed in-namespace port and pumps. A replaced or redirected
// socket path therefore fails the supervisor's handshake instead of carrying
// its request anywhere, and a stranger who reaches the socket is closed.
//
// reach (namespace -> host, Tor). Stage1 listens on the fixed namespace port.
// Each accepted connection is passed to stage0 as a descriptor and stage0
// dials the fixed host port. There is no socket path at all.

type exposeBridge struct {
	name string
	port int
	path string
	ln   net.Listener
}

func openExpose(cfg *config) ([]*exposeBridge, error) {
	var out []*exposeBridge
	for _, e := range cfg.expose {
		path := filepath.Join(cfg.dir, e.name+".sock")
		if len(path) > 100 {
			closeExpose(out)
			return nil, fmt.Errorf("socket path too long")
		}
		_ = os.Remove(path)
		l, err := net.Listen("unix", path)
		if err != nil {
			closeExpose(out)
			return nil, err
		}
		if err := os.Chmod(path, 0o600); err != nil {
			_ = l.Close()
			closeExpose(out)
			return nil, err
		}
		out = append(out, &exposeBridge{name: e.name, port: e.port, path: path, ln: l})
	}
	return out, nil
}

func closeExpose(bs []*exposeBridge) {
	for _, b := range bs {
		_ = b.ln.Close()
		_ = os.Remove(b.path)
	}
}

func mac(token []byte, role, name string, parts ...[]byte) []byte {
	m := hmac.New(sha256.New, token)
	m.Write([]byte("zkapi-confine/" + role + "/" + name + "\x00"))
	for _, p := range parts {
		m.Write(p)
	}
	return m.Sum(nil)
}

// serverHandshake authenticates the peer and proves this end holds the token.
func serverHandshake(c net.Conn, token []byte, name string) bool {
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	defer c.SetDeadline(time.Time{})
	var cn, sn [16]byte
	if _, err := io.ReadFull(c, cn[:]); err != nil {
		return false
	}
	if _, err := rand.Read(sn[:]); err != nil {
		return false
	}
	reply := append(append([]byte{}, sn[:]...), mac(token, "srv", name, cn[:], sn[:])...)
	if _, err := c.Write(reply); err != nil {
		return false
	}
	var proof [32]byte
	if _, err := io.ReadFull(c, proof[:]); err != nil {
		return false
	}
	return hmac.Equal(proof[:], mac(token, "cli", name, cn[:], sn[:]))
}

// exposeLoop accepts, authenticates and hands each connection to stage1.
func exposeLoop(b *exposeBridge, token []byte, ctl *ctlConn) {
	slots := make(chan struct{}, maxBridgeConns)
	for {
		c, err := b.ln.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
		default:
			c.Close()
			continue
		}
		go func() {
			defer func() { <-slots }()
			if !serverHandshake(c, token, b.name) {
				c.Close()
				return
			}
			f, err := c.(*net.UnixConn).File()
			c.Close()
			if err != nil {
				return
			}
			defer f.Close()
			_ = ctl.send(map[string]any{"t": "api", "bridge": b.name}, f)
		}()
	}
}

// dialAndPump runs in whichever stage received the descriptor.
func dialAndPump(f *os.File, address string) {
	c, err := net.FileConn(f)
	f.Close()
	if err != nil {
		return
	}
	d, err := net.DialTimeout("tcp4", address, 2*time.Second)
	if err != nil {
		c.Close() // a dead destination is a fast failure, never a hang
		return
	}
	pump(c, d)
}

// reachLoop accepts inside the namespace and passes each connection to stage0.
func reachLoop(l net.Listener, nsPort int, ctl *ctlConn) {
	slots := make(chan struct{}, maxBridgeConns)
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
		default:
			c.Close()
			continue
		}
		go func() {
			defer func() { <-slots }()
			f, err := c.(*net.TCPConn).File()
			c.Close()
			if err != nil {
				return
			}
			defer f.Close()
			_ = ctl.send(map[string]any{"t": "reach", "nsPort": nsPort}, f)
		}()
	}
}

func pump(a, b net.Conn) {
	var once sync.Once
	closeBoth := func() { a.Close(); b.Close() }
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	// One side finished: give the other a bounded time, then close both.
	t := time.AfterFunc(30*time.Second, func() { once.Do(closeBoth) })
	<-done
	t.Stop()
	once.Do(closeBoth)
}
