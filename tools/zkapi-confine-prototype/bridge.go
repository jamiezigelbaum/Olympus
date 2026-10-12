package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const maxBridgeConns = 64

type bridgeSet struct {
	listeners []net.Listener
	paths     []string
	expose    []string
	reach     []string
}

func (b *bridgeSet) exposed() []string { return b.expose }
func (b *bridgeSet) reached() []string { return b.reach }

func (b *bridgeSet) close() {
	for _, l := range b.listeners {
		_ = l.Close()
	}
	for _, p := range b.paths {
		_ = os.Remove(p)
	}
}

// openBridges binds every listener before anything untrusted runs, so a
// listener that cannot be bound refuses the session and nothing races it.
func openBridges(cfg *config) (*bridgeSet, error) {
	b := &bridgeSet{}
	for _, e := range cfg.expose {
		path := filepath.Join(cfg.dir, e.name+".sock")
		if len(path) > 100 {
			return nil, fmt.Errorf("socket path too long")
		}
		_ = os.Remove(path)
		l, err := net.Listen("unix", path)
		if err != nil {
			b.close()
			return nil, err
		}
		b.listeners = append(b.listeners, l)
		b.paths = append(b.paths, path)
		b.expose = append(b.expose, e.name)
		go acceptLoop(l, "tcp4", fmt.Sprintf("127.0.0.1:%d", e.port))
	}
	for _, r := range cfg.reach {
		l, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", r.port))
		if err != nil {
			b.close()
			return nil, err
		}
		b.listeners = append(b.listeners, l)
		b.reach = append(b.reach, fmt.Sprintf("%d", r.port))
		go acceptLoop(l, "unix", filepath.Join(cfg.dir, r.name+".sock"))
	}
	return b, nil
}

// acceptLoop forwards each accepted connection to one fixed destination. A
// destination that does not answer closes the accepted connection at once, so
// a dead bridge is a fast failure and never a hang.
func acceptLoop(l net.Listener, network, address string) {
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
			d, err := net.DialTimeout(network, address, 2*time.Second)
			if err != nil {
				c.Close()
				return
			}
			pump(c, d)
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
