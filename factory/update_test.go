package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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
	refuse    bool   // gh refuses the attestation
	reports   string // what the downloaded binary says on -version, when not the newest release
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
			install: true, hangup: true},
		{name: "newer release, draining", newest: "0.3.0", onDisk: "0.2.3", running: draining("0.2.3"), install: true},
		{name: "a refused attestation installs nothing", newest: "0.3.0", onDisk: "0.2.3", running: running("0.2.3"),
			refuse: true, install: true, wantErr: "was refused"},
		{name: "a binary that reports another version installs nothing", newest: "0.3.0", onDisk: "0.2.3",
			running: running("0.2.3"), reports: "0.2.9", install: true, wantErr: "does not report that version"},
		{name: "never downgrades", newest: "0.2.0", onDisk: "0.3.0", running: running("0.3.0"), wantOlder: true},
		{name: "never downgrades a stale process", newest: "0.2.0", onDisk: "0.3.0", running: running("0.2.5"),
			wantOlder: true, hangup: true},
		{name: "a version that does not read", newest: "0.3.0", onDisk: "0.3.0", running: running("dev"),
			wantErr: "not major.minor.patch"},
		{name: "stopped and current", newest: "0.3.0", onDisk: "0.3.0", active: "inactive", result: "success"},
		{name: "stopped and older", newest: "0.3.0", onDisk: "0.2.3", active: "inactive", result: "success", install: true},
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

const (
	oldBinary = "the installed binary"
	newBinary = "the released binary"
)

func runTick(t *testing.T, c tickCase) {
	t.Helper()
	var mu sync.Mutex
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
		case r.URL.Path == "/download/binary":
			mu.Lock()
			downloads = append(downloads, r.URL.Path)
			mu.Unlock()
			io.WriteString(w, newBinary)
		case r.URL.Path == "/download/bundle":
			io.WriteString(w, "{}")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	listen := strings.TrimPrefix(server.URL, "http://")
	if c.running == nil {
		listen = closedAddress(t)
	}
	bin := t.TempDir()
	state := t.TempDir()
	exe := filepath.Join(bin, "factory")
	if err := os.WriteFile(exe, []byte(oldBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	reports := c.newest
	if c.reports != "" {
		reports = c.reports
	}
	var calls, verified []string
	var ghEnv []string
	u := &updater{
		ctx:    context.Background(),
		client: server.Client(),
		exe:    exe,
		state:  state,
		said:   map[string]string{},
		api:    server.URL,
		run: func(_ context.Context, _ time.Duration, name string, args ...string) ([]byte, string, error) {
			call := strings.Join(append([]string{name}, args...), " ")
			calls = append(calls, call)
			switch {
			case name == exe && len(args) == 1 && args[0] == "-version":
				return []byte("factory " + c.onDisk + "\n"), "", nil
			case strings.HasPrefix(name, filepath.Join(bin, ".factory-new-")) && len(args) == 1 && args[0] == "-version":
				return []byte("factory " + reports + "\n"), "", nil
			case name == systemctlCommand && args[0] == "show":
				return []byte(fmt.Sprintf("ActiveState=%s\nResult=%s\n", c.active, c.result)), "", nil
			case name == systemctlCommand && args[0] == "kill":
				return nil, "", nil
			}
			return nil, "unexpected", fmt.Errorf("unexpected command %s", call)
		},
		runIn: func(_ context.Context, _ time.Duration, env []string, _, name string, args ...string) ([]byte, string, error) {
			verified = append([]string{name}, args...)
			ghEnv = env
			if c.refuse {
				return nil, "verification failed", fmt.Errorf("exit status 1")
			}
			return nil, "", nil
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
	if c.install {
		checkVerified(t, c, verified, ghEnv, state)
	}
	checkInstalled(t, c.install && c.wantErr == "", exe)
}

// checkVerified asserts gh checked the release with the whole policy, in a home under the
// updater's own directory.
func checkVerified(t *testing.T, c tickCase, verified, env []string, state string) {
	t.Helper()
	if len(verified) == 0 {
		if c.wantErr == "" || c.refuse {
			t.Errorf("the tick installed without asking gh")
		}
		return
	}
	call := strings.Join(verified, " ")
	for _, part := range []string{
		ghCommand + " attestation verify ",
		"--repo " + releaseRepository,
		"--cert-identity-regex " + releaseIdentity,
		"--source-ref refs/tags/" + releaseTagPrefix + c.newest,
		"--cert-oidc-issuer " + actionsIssuer,
		"--deny-self-hosted-runners",
		"--predicate-type " + slsaProvenance,
	} {
		if !strings.Contains(call, part) {
			t.Errorf("gh ran as %q, want %q in it", call, part)
		}
	}
	for _, v := range env {
		if strings.HasPrefix(v, "HOME=") && !strings.HasPrefix(v, "HOME="+state+string(filepath.Separator)) {
			t.Errorf("gh ran with %s, want a home under %s", v, state)
		}
		if strings.HasPrefix(v, "GH_TOKEN=") || strings.HasPrefix(v, "GITHUB_TOKEN=") {
			t.Errorf("gh ran with a token: %s", v)
		}
	}
}

// checkInstalled asserts the binary on disk is the released one with the installed one kept
// beside it, or the installed one untouched, and that no new file is left behind either way.
func checkInstalled(t *testing.T, installed bool, exe string) {
	t.Helper()
	got, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	previous, previousErr := os.ReadFile(exe + ".previous")
	switch {
	case installed && string(got) != newBinary:
		t.Errorf("the binary on disk is %q after an install, want %q", got, newBinary)
	case installed && (previousErr != nil || string(previous) != oldBinary):
		t.Errorf("the previous binary is %q (%v), want %q", previous, previousErr, oldBinary)
	case !installed && string(got) != oldBinary:
		t.Errorf("the binary on disk is %q without an install, want %q", got, oldBinary)
	case !installed && previousErr == nil:
		t.Errorf("a tick without an install left %s.previous", exe)
	}
	if installed {
		if info, err := os.Stat(exe); err != nil || info.Mode().Perm() != 0o755 {
			t.Errorf("the installed binary has the mode %v (%v), want 0755", info.Mode().Perm(), err)
		}
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), ".factory-new-*"))
	if len(left) > 0 {
		t.Errorf("the tick left %q beside the binary", left)
	}
}

func TestTheSaidStateSurvivesATickOnDisk(t *testing.T) {
	t.Parallel()
	state := filepath.Join(t.TempDir(), "factory-update")
	u := &updater{state: state}
	if err := u.loadState(); err != nil {
		t.Fatalf("a missing state does not load: %v", err)
	}
	if len(u.said) != 0 {
		t.Fatalf("a missing state loads as %v, want nothing said", u.said)
	}
	if info, err := os.Stat(state); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the state directory is %v (%v), want 0700", info, err)
	}
	u.once("current", "0.3.0", "up to date")
	u.once("auto_update", "on", "auto-update on")
	if err := u.saveState(); err != nil {
		t.Fatalf("the state does not save: %v", err)
	}
	again := &updater{state: state}
	if err := again.loadState(); err != nil {
		t.Fatalf("the saved state does not load: %v", err)
	}
	if len(again.said) != 2 || again.said["current"] != "0.3.0" || again.said["auto_update"] != "on" {
		t.Errorf("the state reads back as %v, want current 0.3.0 and auto_update on", again.said)
	}
	if err := os.WriteFile(filepath.Join(state, "said.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	broken := &updater{state: state}
	if err := broken.loadState(); err != nil || len(broken.said) != 0 {
		t.Errorf("a state that does not read loads as %v (%v), want nothing said and no error", broken.said, err)
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

// The tick treats a state file that reads as JSON null like one that does not read: as empty.
func TestAStateOfNullReadsAsEmpty(t *testing.T) {
	t.Parallel()
	u := &updater{state: t.TempDir()}
	if err := os.WriteFile(u.statePath(), []byte("null"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := u.loadState(); err != nil {
		t.Fatalf("loadState: %v", err)
	}
	u.once("current", "0.3.0", "up to date")
	if u.said["current"] != "0.3.0" {
		t.Errorf("once keeps %v after a null state, want the key it said", u.said)
	}
}

// factory -update is one tick through the real binary: it reads the configuration first, and it
// exits with an error line and serves nothing. Run as a user other than root, the tick cannot open
// its own root-owned directory, and says so.
func TestTheUpdateFlagRunsOneTickAndExits(t *testing.T) {
	t.Parallel()
	missing := filepath.Join(t.TempDir(), "absent.json")
	out, err := factoryCommand(binary, "-update", "-config", missing).CombinedOutput()
	if err == nil || !strings.HasPrefix(string(out), "error: ") || !strings.Contains(string(out), missing) {
		t.Errorf("-update with a missing configuration exits with %v and says %q, want an error that names the file", err, out)
	}
	if strings.Contains(string(out), updateStateDir) {
		t.Errorf("-update with a missing configuration says %q, want the configuration read before the updater's directory", out)
	}

	if os.Geteuid() == 0 {
		t.Skip("as root the tick would make the host's updater directory")
	}
	listen := freeAddress(t)
	path := writeConfig(t, config{"listen": listen, "data_dir": t.TempDir(), "auto_update": false,
		"repositories": []string{"acme/app"}})
	out, err = factoryCommand(binary, "-update", "-config", path).CombinedOutput()
	if err == nil || !strings.HasPrefix(string(out), "error: ") || !strings.Contains(string(out), updateStateDir) {
		t.Errorf("-update as a user other than root exits with %v and says %q, want an error that names %s", err, out, updateStateDir)
	}
	if conn, dialErr := net.DialTimeout("tcp", listen, time.Second); dialErr == nil {
		_ = conn.Close()
		t.Errorf("-update left something listening on %s, want one tick and no factory", listen)
	}
}
