package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The update tick's decisions, tested against a releases API and a line endpoint served here and
// commands answered here: no network, no gh and no systemd.

func TestAVersionIsMajorMinorPatchAndComparesByNumber(t *testing.T) {
	t.Parallel()
	for _, bad := range []string{"", "1.2", "1.2.3.4", "v1.2.3", "1.02.3", "1.-2.3", "1.2.x", " 1.2.3"} {
		if _, ok := parseSemver(bad); ok {
			t.Errorf("parseSemver(%q) reads a version, want none", bad)
		}
	}
	for _, c := range []struct {
		v, w string
		less bool
	}{
		{"0.2.3", "0.2.4", true},
		{"0.2.9", "0.2.10", true},
		{"0.9.0", "0.10.0", true},
		{"1.0.0", "0.99.99", false},
		{"0.3.0", "0.3.0", false},
		{"0.3.1", "0.3.0", false},
	} {
		v, okV := parseSemver(c.v)
		w, okW := parseSemver(c.w)
		if !okV || !okW {
			t.Fatalf("parseSemver refuses %q or %q", c.v, c.w)
		}
		if got := v.less(w); got != c.less {
			t.Errorf("%s less %s is %v, want %v", c.v, c.w, got, c.less)
		}
		if v.String() != c.v {
			t.Errorf("%q reads back as %q", c.v, v)
		}
	}
}

func TestOnceSaysAStateChangeOncePerKey(t *testing.T) {
	t.Parallel()
	u := &updater{said: map[string]string{}}
	u.once("current", "0.3.0", "up to date")
	u.once("older", "0.2.0", "older")
	if u.said["current"] != "0.3.0" || u.said["older"] != "0.2.0" {
		t.Fatalf("once keeps %v, want each key with its own value", u.said)
	}
	u.once("current", "0.3.1", "up to date")
	if u.said["current"] != "0.3.1" || u.said["older"] != "0.2.0" {
		t.Errorf("once keeps %v after a change of one key, want the other untouched", u.said)
	}
}

func TestWaitsForNamesEveryRunOfTheDrain(t *testing.T) {
	t.Parallel()
	if got := waitsFor(nil); !strings.Contains(got, "no run") {
		t.Errorf("waitsFor(nil) = %q, want no run", got)
	}
	got := waitsFor([]Run{{ID: 4, Repository: "acme/a", Issue: 7}, {ID: 5, Repository: "acme/b", Issue: 9}})
	if !strings.Contains(got, "run 4 (acme/a#7)") || !strings.Contains(got, "run 5 (acme/b#9)") {
		t.Errorf("waitsFor = %q, want both runs", got)
	}
}

// tickCase is one tick: the newest release, the binary on disk, the running factory or none, and
// systemd's state of the service.
type tickCase struct {
	name      string
	newest    string
	onDisk    string
	running   *runningFactory
	active    string
	result    string
	wantErr   string // a part of the error, or empty for none
	install   bool   // the tick tries to install the newest release
	hangup    bool   // the tick sends SIGHUP
	wantOlder bool   // the tick says the newest release is older than the file
}

func TestATickDoesTheOneThingItsFactsCallFor(t *testing.T) {
	t.Parallel()
	draining := func(v string, now ...Run) *runningFactory {
		return &runningFactory{Version: v, Draining: true, Now: now}
	}
	running := func(v string, now ...Run) *runningFactory { return &runningFactory{Version: v, Now: now} }
	for _, c := range []tickCase{
		{name: "up to date", newest: "0.3.0", onDisk: "0.3.0", running: running("0.3.0")},
		{name: "the process runs a newer one", newest: "0.3.0", onDisk: "0.3.0", running: running("0.4.0")},
		{name: "installed and draining", newest: "0.3.0", onDisk: "0.3.0", running: draining("0.2.3", Run{ID: 1})},
		{name: "installed and not draining", newest: "0.3.0", onDisk: "0.3.0", running: running("0.2.3"), hangup: true},
		{name: "newer release, not draining", newest: "0.3.0", onDisk: "0.2.3", running: running("0.2.3", Run{ID: 1}),
			install: true, wantErr: "cannot be downloaded"},
		{name: "newer release, draining", newest: "0.3.0", onDisk: "0.2.3", running: draining("0.2.3"),
			install: true, wantErr: "cannot be downloaded"},
		{name: "never downgrades", newest: "0.2.0", onDisk: "0.3.0", running: running("0.3.0"), wantOlder: true},
		{name: "never downgrades a stale process", newest: "0.2.0", onDisk: "0.3.0", running: running("0.2.5"),
			wantOlder: true, hangup: true},
		{name: "a version that does not read", newest: "0.3.0", onDisk: "0.3.0", running: running("dev"),
			wantErr: "not major.minor.patch"},
		{name: "stopped and current", newest: "0.3.0", onDisk: "0.3.0", active: "inactive", result: "success"},
		{name: "stopped and older", newest: "0.3.0", onDisk: "0.2.3", active: "inactive", result: "success",
			install: true, wantErr: "cannot be downloaded"},
		{name: "not answering and failed", newest: "0.3.0", onDisk: "0.2.3", active: "failed", result: "exit-code",
			wantErr: "the tick does nothing"},
		{name: "not answering and starting", newest: "0.3.0", onDisk: "0.2.3", active: "activating", result: "success",
			wantErr: "the tick does nothing"},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			runTick(t, c)
		})
	}
}

func runTick(t *testing.T, c tickCase) {
	t.Helper()
	var downloads []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/"+releaseRepository+"/releases":
			base := "http://" + r.Host + "/download/"
			json.NewEncoder(w).Encode([]map[string]any{
				{"tag_name": "factory/v9.9.9", "draft": true},
				{"tag_name": "factory/v8.8.8", "prerelease": true},
				{"tag_name": "planner/v7.7.7"},
				{"tag_name": releaseTagPrefix + c.newest, "assets": []map[string]string{
					{"name": "factory-linux-" + runtime.GOARCH, "browser_download_url": base + "binary"},
					{"name": "factory-v" + c.newest + ".sigstore.json", "browser_download_url": base + "bundle"},
				}},
			})
		case r.URL.Path == "/api/line" && c.running != nil:
			json.NewEncoder(w).Encode(c.running)
		case strings.HasPrefix(r.URL.Path, "/download/"):
			downloads = append(downloads, r.URL.Path)
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	listen := strings.TrimPrefix(server.URL, "http://")
	if c.running == nil {
		listen = closedAddress(t)
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "factory")
	var calls []string
	u := &updater{
		ctx:    context.Background(),
		client: server.Client(),
		exe:    exe,
		state:  dir,
		said:   map[string]string{},
		api:    server.URL,
		run: func(_ context.Context, _ time.Duration, name string, args ...string) ([]byte, string, error) {
			call := strings.Join(append([]string{name}, args...), " ")
			calls = append(calls, call)
			switch {
			case name == exe && len(args) == 1 && args[0] == "-version":
				return []byte("factory " + c.onDisk + "\n"), "", nil
			case name == systemctlCommand && args[0] == "show":
				return []byte(fmt.Sprintf("ActiveState=%s\nResult=%s\n", c.active, c.result)), "", nil
			case name == systemctlCommand && args[0] == "kill":
				return nil, "", nil
			}
			return nil, "unexpected", fmt.Errorf("unexpected command %s", call)
		},
	}

	err := u.tick(listen)
	switch {
	case c.wantErr == "" && err != nil:
		t.Fatalf("the tick failed: %v", err)
	case c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)):
		t.Fatalf("the tick answered %v, want an error with %q", err, c.wantErr)
	}
	hangup := false
	for _, call := range calls {
		if strings.HasPrefix(call, systemctlCommand+" kill") {
			hangup = true
			if call != systemctlCommand+" kill --kill-whom=main -s HUP "+factoryUnit {
				t.Errorf("the tick signals with %q, want SIGHUP to the main process", call)
			}
		}
	}
	if hangup != c.hangup {
		t.Errorf("the tick sent SIGHUP: %v, want %v; its commands: %q", hangup, c.hangup, calls)
	}
	if installed := len(downloads) > 0; installed != c.install {
		t.Errorf("the tick tried an install: %v, want %v; its downloads: %q", installed, c.install, downloads)
	}
	if older := u.said["older"] != ""; older != c.wantOlder {
		t.Errorf("the tick said the newest release is older: %v, want %v", older, c.wantOlder)
	}
}

// closedAddress is an address on this machine that nothing listens on.
func closedAddress(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := l.Addr().String()
	l.Close()
	return address
}

func TestACommandWithAnEnvironmentOfItsOwnSeesNoOtherVariable(t *testing.T) {
	t.Setenv("GH_TOKEN", "a-token-of-the-process")
	out, reason, err := commandIn(context.Background(), commandTimeout, []string{"ONLY=this"}, "", "/usr/bin/env")
	if err != nil {
		t.Fatalf("env failed: %s", reason)
	}
	if got := strings.TrimSpace(string(out)); got != "ONLY=this" {
		t.Errorf("the command saw the environment %q, want ONLY=this alone", got)
	}
}
