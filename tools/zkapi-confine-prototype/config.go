package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

type exposeSpec struct {
	name string
	port int
}

type reachSpec struct {
	nsPort   int // 127.0.0.1:nsPort inside the namespace
	hostPort int // 127.0.0.1:hostPort in the host network namespace
}

type config struct {
	dir     string
	expose  []exposeSpec // authenticated unix socket in dir -> 127.0.0.1:port inside the namespace
	reach   []reachSpec  // 127.0.0.1:nsPort inside the namespace -> 127.0.0.1:hostPort on the host
	connect []int        // Landlock: TCP connect allowed
	bind    []int        // Landlock: TCP bind allowed
	prog    []string
	status  bool // --status-fd 3: events go to fd 3, never to the daemon's stdout
}

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

func parsePort(s string) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > 65535 {
		return 0, fmt.Errorf("invalid port %q", s)
	}
	return n, nil
}

func parseConfig(args []string) (*config, error) {
	cfg := &config{}
	i := 0
	next := func(flag string) (string, error) {
		i++
		if i >= len(args) {
			return "", fmt.Errorf("%s needs a value", flag)
		}
		return args[i], nil
	}
	for ; i < len(args); i++ {
		switch a := args[i]; a {
		case "--":
			cfg.prog = args[i+1:]
			i = len(args)
		case "--dir":
			v, err := next(a)
			if err != nil {
				return nil, err
			}
			cfg.dir = v
		case "--expose", "--reach":
			v, err := next(a)
			if err != nil {
				return nil, err
			}
			left, right, ok := strings.Cut(v, "=")
			if !ok {
				return nil, fmt.Errorf("%s wants A=B", a)
			}
			if a == "--expose" {
				p, err := parsePort(right)
				if err != nil || !nameRE.MatchString(left) {
					return nil, fmt.Errorf("bad --expose %q", v)
				}
				cfg.expose = append(cfg.expose, exposeSpec{left, p})
			} else {
				p, err := parsePort(left)
				hp, err2 := parsePort(right)
				if err != nil || err2 != nil {
					return nil, fmt.Errorf("bad --reach %q", v)
				}
				cfg.reach = append(cfg.reach, reachSpec{p, hp})
			}
		case "--status-fd":
			v, err := next(a)
			if err != nil || v != "3" {
				return nil, fmt.Errorf("--status-fd must be 3")
			}
			cfg.status = true
		case "--connect-port", "--bind-port":
			v, err := next(a)
			if err != nil {
				return nil, err
			}
			p, err := parsePort(v)
			if err != nil {
				return nil, err
			}
			if a == "--connect-port" {
				cfg.connect = append(cfg.connect, p)
			} else {
				cfg.bind = append(cfg.bind, p)
			}
		default:
			return nil, fmt.Errorf("unknown argument %q", a)
		}
	}
	if len(cfg.prog) == 0 || !strings.HasPrefix(cfg.prog[0], "/") {
		return nil, fmt.Errorf("the program must be an absolute path after --")
	}
	if len(cfg.expose) > 0 && cfg.dir == "" {
		return nil, fmt.Errorf("--dir is required with --expose")
	}
	if !cfg.status {
		return nil, fmt.Errorf("the private status descriptor is required: pass --status-fd 3")
	}
	if cfg.dir != "" {
		st, err := os.Lstat(cfg.dir)
		if err != nil {
			return nil, err
		}
		sys, _ := st.Sys().(*syscall.Stat_t)
		if !st.IsDir() || st.Mode().Perm() != 0o700 || sys == nil || int(sys.Uid) != os.Getuid() {
			return nil, fmt.Errorf("--dir must be a real directory, mode 0700, owned by this user")
		}
	}
	return cfg, nil
}

// stageReport is stage2's account of what it applied, sent to stage1 on its report pipe.
type stageReport struct {
	OK     bool     `json:"ok"`
	Code   string   `json:"code,omitempty"`
	Detail string   `json:"detail,omitempty"`
	ABI    int      `json:"abi,omitempty"`
	Layers []string `json:"layers,omitempty"`
}

func writeReport(f *os.File, r stageReport) {
	b, _ := json.Marshal(r)
	_, _ = f.Write(append(b, '\n'))
}

func readReport(f *os.File) stageReport {
	defer f.Close()
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		n, err := f.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil || len(buf) > 1<<16 {
			break
		}
	}
	line := strings.SplitN(string(buf), "\n", 2)[0]
	var r stageReport
	if json.Unmarshal([]byte(line), &r) != nil {
		return stageReport{Code: "restriction_failed", Detail: "no report from the restriction stage"}
	}
	return r
}
