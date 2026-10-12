// PROTOTYPE Go stand-in for the daemon: the real daemon is a Go program, so the
// confinement is also exercised by a Go net/http server and Go dialers.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

func dial(network, addr string) string {
	started := time.Now()
	c, err := net.DialTimeout(network, addr, 3*time.Second)
	if err != nil {
		if time.Since(started) < time.Second {
			return "failed_fast"
		}
		return "failed_slow"
	}
	c.Close()
	return "connected"
}

// dgramDecoy is a host-side Unix datagram socket the matrix owns: it appends
// every datagram it receives to <path>.log, so an attempt that got through is
// visible to the test. (Node has no Unix datagram sockets.)
func dgramDecoy(path string) {
	_ = os.Remove(path)
	pc, err := net.ListenPacket("unixgram", path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dgram-decoy:", err)
		os.Exit(1)
	}
	fmt.Println("ready")
	buf := make([]byte, 2048)
	for {
		n, _, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		f, _ := os.OpenFile(path+".log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		f.Write(append(buf[:n], '\n'))
		f.Close()
	}
}

func main() {
	if len(os.Args) > 2 && os.Args[1] == "dgram-decoy" {
		dgramDecoy(os.Args[2])
		return
	}
	api, _ := strconv.Atoi(os.Args[1])
	tor, _ := strconv.Atoi(os.Args[2])
	other, _ := strconv.Atoi(os.Args[3])
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"standin":"go"}`) })
	mux.HandleFunc("/go-probe", func(w http.ResponseWriter, r *http.Request) {
		res := map[string]string{}
		if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", tor), 3*time.Second); err == nil {
			c.Write([]byte("probe"))
			buf := make([]byte, 64)
			c.SetReadDeadline(time.Now().Add(3 * time.Second))
			n, _ := c.Read(buf)
			res["tor_bridge_echo"] = string(buf[:n])
			c.Close()
		} else {
			res["tor_bridge_echo"] = "dial_error"
		}
		res["connect_other_port"] = dial("tcp", fmt.Sprintf("127.0.0.1:%d", other))
		res["connect_remote_testnet"] = dial("tcp", "192.0.2.1:9")
		res["ipv6_loopback"] = dial("tcp", fmt.Sprintf("[::1]:%d", tor))
		res["udp_dial"] = dial("udp", "127.0.0.1:9")
		_, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(other))
		if err != nil {
			res["bind_other_port"] = "denied"
		} else {
			res["bind_other_port"] = "bound"
		}
		_, err = net.Listen("tcp", "[::1]:"+strconv.Itoa(api+1))
		if err != nil {
			res["bind_ipv6"] = "denied"
		} else {
			res["bind_ipv6"] = "bound"
		}
		_, err = net.LookupHost("example.com")
		if err != nil {
			res["dns_lookup"] = "failed"
		} else {
			res["dns_lookup"] = "resolved"
		}
		json.NewEncoder(w).Encode(res)
	})
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", api))
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	http.Serve(l, mux)
}
