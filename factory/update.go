package main

// The update tick: the factory binary run with -update by a systemd timer, as root, once an hour.
// One tick is short. It reads the configuration, the newest release, the running factory and the
// binary on disk, does one thing and exits. It never waits for a drain: the drain is the running
// factory's, and the next tick reads where it stands.
//
// The tick installs only what the release workflow of this repository built at the tag of the
// version it installs, as gh's attestation check says without a login. It never downgrades, it
// writes nothing into the factory's data directory, and it keeps its own state (what it said once)
// in a root-owned directory of its own.
//
// A release that does not come up is undone. After an install the tick judges the new binary: at
// once when the factory had no run to drain for, at the next tick when a run was going. Healthy is
// the line endpoint answering with the new version; a factory that drains answers, so it is never
// judged unhealthy. Until a release is judged, no tick installs another. A new binary that does not
// answer is unhealthy, and so is a unit that failed or restarts again and again. An unhealthy
// release goes on the block list, which no tick installs again. The previous binary is put back
// and the unit restarted. When the previous binary does not answer either, the tick says so and
// touches nothing more until the factory answers again.
//
// It talks to gh and systemd through their commands, run as child processes by absolute path and
// never through a shell.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	// releaseRepository is the repository whose factory releases a host installs.
	releaseRepository = "CalvinDittkrist/workflows"
	// releaseTagPrefix opens every factory version tag; a plugin or milestone tag never carries it.
	releaseTagPrefix = "factory/v"
	// updateStateDir is the updater's own directory, root's and not the factory's.
	updateStateDir = "/var/lib/factory-update"
	// factoryUnit is the service the tick signals and asks about.
	factoryUnit = "factory.service"
	// The commands the tick runs, by absolute path: root's PATH is not what decides which binary
	// verifies a release or signals the service.
	ghCommand        = "/usr/bin/gh"
	systemctlCommand = "/usr/bin/systemctl"
	// The five-part policy of the attestation check, whose identity is releaseIdentity.
	actionsIssuer  = "https://token.actions.githubusercontent.com"
	slsaProvenance = "https://slsa.dev/provenance/v1"
	// updateTimeout bounds a whole tick, downloads, the attestation check and the judgement
	// included, so a hung network never keeps the next tick from starting.
	updateTimeout = 20 * time.Minute
	// settleMargin is how long past the unit's restart delay a started factory has to answer.
	settleMargin = time.Minute
	// restartLimit is how many restarts since the install make a unit that restarts again and
	// again: the restart after the drain is one.
	restartLimit = 3
	// commandTimeout bounds a -version or systemctl call, verifyTimeout the attestation check.
	commandTimeout = 30 * time.Second
	verifyTimeout  = 5 * time.Minute
)

// releaseIdentity is the certificate identity of the attestation check: the release workflow of
// releaseRepository at a factory version tag. It is built from the constant so the two never drift.
var releaseIdentity = `^https://github\.com/` + regexp.QuoteMeta(releaseRepository) +
	`/\.github/workflows/factory-release\.yml@refs/tags/factory/v[0-9]+\.[0-9]+\.[0-9]+$`

// semver is a factory version, major.minor.patch.
type semver [3]int

func parseSemver(s string) (semver, bool) {
	var v semver
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return v, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || part != strconv.Itoa(n) {
			return v, false
		}
		v[i] = n
	}
	return v, true
}

func (v semver) less(w semver) bool {
	for i := range v {
		if v[i] != w[i] {
			return v[i] < w[i]
		}
	}
	return false
}

func (v semver) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }

// release is a published factory release: its version and the URLs of the two files a tick needs.
type release struct {
	version semver
	tag     string
	binary  string // the download URL of factory-linux-<arch>
	bundle  string // the download URL of factory-v<version>.sigstore.json
}

// runningFactory is what the line endpoint says of the process that runs.
type runningFactory struct {
	Version  string `json:"version"`
	Draining bool   `json:"draining"`
	Now      []Run  `json:"now"`
}

// updater is one tick.
type updater struct {
	ctx    context.Context
	client *http.Client
	exe    string // the installed binary, the file this tick runs as
	state  string // updateStateDir
	said   map[string]string
	// api is the REST API the releases are read from, run runs the -version and systemctl
	// commands, and runIn runs gh in an environment of its own. A tick uses api.github.com, command
	// and commandIn; a test puts its own in their place.
	api   string
	run   func(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, string, error)
	runIn func(ctx context.Context, timeout time.Duration, env []string, input, name string, args ...string) ([]byte, string, error)
	// after is the clock settle waits on: time.After when nil, a test's own in its place.
	after func(time.Duration) <-chan time.Time
}

// update is the tick, from the configuration to its one action. An error is the tick's alone: it
// blocks nothing, and the next tick starts over.
func update(config string) error {
	settings, err := Load(config)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("the path of this binary cannot be read: %w", err)
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return fmt.Errorf("the path of this binary cannot be resolved: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), updateTimeout)
	defer cancel()
	u := &updater{ctx: ctx, client: &http.Client{Timeout: 5 * time.Minute}, exe: exe, state: updateStateDir,
		api: "https://api.github.com", run: command, runIn: commandIn}
	if err := u.loadState(); err != nil {
		return err
	}
	if !settings.AutoUpdate {
		u.once("auto_update", "off", "auto-update off: the configuration says auto_update false, and the tick touches nothing")
		return u.saveState()
	}
	u.once("auto_update", "on", "auto-update on")
	err = u.tick(settings.Listen)
	if saved := u.saveState(); err == nil {
		err = saved
	}
	return err
}

// tick reads the three facts and does exactly one thing.
func (u *updater) tick(listen string) error {
	pending, err := u.loadJudgement()
	if err != nil {
		return err
	}
	if pending != nil {
		if done, err := u.judge(listen, *pending, false); done || err != nil {
			return err
		}
		// A judgement the tick made is cleared; one it could not make yet stays pending.
		if pending, err = u.loadJudgement(); err != nil {
			return err
		}
	}
	newest, err := u.newestRelease()
	if err != nil {
		return err
	}
	fileVersion, err := u.fileVersion(u.exe)
	if err != nil {
		return err
	}
	// The updater never downgrades: a release older than the binary on disk is ignored.
	target := newest.version
	if newest.version.less(fileVersion) {
		u.once("older", newest.version.String(), fmt.Sprintf("the newest release %s is older than the binary on disk, %s; the updater never downgrades and ignores it",
			newest.version, fileVersion))
		target = fileVersion
	}

	process, reachable, err := u.running(listen)
	if err != nil {
		return err
	}
	if !reachable {
		return u.unreachable(listen, newest, fileVersion)
	}
	processVersion, ok := parseSemver(process.Version)
	if !ok {
		return fmt.Errorf("the running factory reports the version %q, which is not major.minor.patch; the tick does nothing", process.Version)
	}
	if processVersion != fileVersion {
		log.Printf("the running factory is %s, the binary on disk %s", processVersion, fileVersion)
	}

	switch {
	case !processVersion.less(target):
		u.once("current", target.String(), fmt.Sprintf("up to date: the running factory is %s, the newest release %s", processVersion, newest.version))
		return nil
	case !fileVersion.less(target) && process.Draining:
		log.Printf("the binary on disk is %s and the factory %s drains; %s", fileVersion, processVersion, waitsFor(process.Now))
		return nil
	case !fileVersion.less(target):
		log.Printf("the binary on disk is %s and the factory runs %s without draining; sending SIGHUP again", fileVersion, processVersion)
		return u.hangup()
	}
	// At most one release waits for its judgement: another installed now would keep the unjudged
	// one as the previous binary, which a rollback would then put back.
	if pending != nil {
		u.once("unjudged", pending.Version+" "+newest.version.String(), fmt.Sprintf("%s waits for its judgement; the tick installs %s once it is judged",
			pending.Version, newest.version))
		return nil
	}
	// The restarts are counted from here, so the restart after the drain and those of earlier
	// releases never count as a unit that restarts again and again.
	before, err := u.serviceState()
	if err != nil {
		return err
	}
	if err := u.install(newest); err != nil {
		return err
	}
	pending = &judgement{Version: newest.version.String(), Previous: fileVersion.String(), Restarts: before.restarts}
	if err := u.saveJudgement(pending); err != nil {
		return err
	}
	if process.Draining {
		log.Printf("installed %s; the factory drains already and systemd starts it when the drain ends: %s; the next tick judges it",
			newest.version, waitsFor(process.Now))
		return nil
	}
	log.Printf("installed %s", newest.version)
	if err := u.hangup(); err != nil {
		return err
	}
	if len(process.Now) > 0 {
		log.Printf("a run in .now stops no install: %s; the next tick judges %s", waitsFor(process.Now), newest.version)
		return nil
	}
	_, err = u.judge(listen, *pending, true)
	return err
}

// judgement is an installed release the tick has not judged yet, kept in the updater's directory
// from the install to the judgement.
type judgement struct {
	Version  string `json:"version"`  // the release installed
	Previous string `json:"previous"` // the version of the binary kept as the previous one
	Restarts int    `json:"restarts"` // the unit's NRestarts before the install
	// Stuck says the rollback's binary did not answer either: the tick touches nothing more until
	// the factory answers again.
	Stuck bool `json:"stuck,omitempty"`
}

// judge reads whether the installed release came up. It says done when the tick does nothing
// more: after a rollback, while the factory is stuck, or when the operator stopped it. settled says
// the factory has had its time to start already.
func (u *updater) judge(listen string, p judgement, settled bool) (bool, error) {
	if p.Stuck {
		return u.stuck(listen, p)
	}
	if settled {
		if err := u.settle(); err != nil {
			return true, err
		}
	}
	for {
		process, reachable, err := u.running(listen)
		if err != nil {
			log.Printf("%v; the tick reads that as a factory that does not answer", err)
		}
		if reachable {
			switch {
			case process.Version == p.Version:
				log.Printf("healthy: the factory answers with %s", p.Version)
				return false, u.clearJudgement()
			case newerThan(process.Version, p.Version):
				log.Printf("%s is not judged: the factory answers with the newer %s", p.Version, process.Version)
				return false, u.clearJudgement()
			case process.Version == p.Previous && u.rolledBack(p):
				log.Printf("rolled back: the factory answers with %s, and %s stays blocked", process.Version, p.Version)
				return false, u.clearJudgement()
			case process.Draining:
				log.Printf("%s is not judged yet: the factory %s drains, however long that takes; %s", p.Version, process.Version, waitsFor(process.Now))
			default:
				log.Printf("%s is not judged yet: the factory answers with %s", p.Version, process.Version)
			}
			return false, nil
		}
		s, err := u.serviceState()
		if err != nil {
			return true, err
		}
		if s.active == "inactive" && s.result == "success" {
			u.once("stopped", p.Version, fmt.Sprintf("%s is not judged: %s was stopped by the operator (inactive, success); the tick judges it once the factory runs", p.Version, factoryUnit))
			return true, nil
		}
		again := s.restarts-p.Restarts >= restartLimit
		if s.active == "failed" || again || settled {
			log.Printf("unhealthy: %s does not answer on http://%s/api/line, and %s is %s", p.Version, listen, factoryUnit, s)
			return true, u.rollback(listen, p)
		}
		if err := u.settle(); err != nil {
			return true, err
		}
		settled = true
	}
}

// newerThan says version a is a later release than version b.
func newerThan(a, b string) bool {
	va, okA := parseSemver(a)
	vb, okB := parseSemver(b)
	return okA && okB && vb.less(va)
}

// rolledBack says a rollback of the release ran to its end already: the release is blocked and the
// binary on disk is the previous one again. A tick that ran out of time after the restart leaves
// its judgement behind, and this is how the next tick recognises it.
func (u *updater) rolledBack(p judgement) bool {
	blocked, err := u.blocked()
	if err != nil {
		return false
	}
	version, ok := parseSemver(p.Version)
	if !ok || !blocked[version] {
		return false
	}
	onDisk, err := u.fileVersion(u.exe)
	return err == nil && onDisk.String() == p.Previous
}

// rollback blocks the release, puts the previous binary back and restarts the unit. The block
// comes first, so a release judged unhealthy is never installed again, even when the previous
// binary cannot be put back.
func (u *updater) rollback(listen string, p judgement) error {
	if err := u.block(p.Version); err != nil {
		return err
	}
	log.Printf("put %s on the block list %s", p.Version, u.blockPath())
	previous := u.exe + ".previous"
	if _, err := u.fileVersion(previous); err != nil {
		p.Stuck = true
		if saved := u.saveJudgement(&p); saved != nil {
			return saved
		}
		u.said["stuck"] = p.Version
		return fmt.Errorf("%s cannot be rolled back: the previous binary does not run (%v); the tick touches nothing more until the factory answers again", p.Version, err)
	}
	if err := os.Rename(previous, u.exe); err != nil {
		return fmt.Errorf("the previous binary %s cannot be put back over %s: %w", previous, u.exe, err)
	}
	log.Printf("put the previous binary %s back as %s", p.Previous, u.exe)
	if _, reason, err := u.run(u.ctx, commandTimeout, systemctlCommand, "restart", factoryUnit); err != nil {
		return fmt.Errorf("%s restart %s failed: %s", systemctlCommand, factoryUnit, reason)
	}
	log.Printf("restarted %s", factoryUnit)
	if err := u.settle(); err != nil {
		return err
	}
	if process, reachable, _ := u.running(listen); reachable {
		log.Printf("rolled back: the factory answers with %s, and %s stays blocked", process.Version, p.Version)
		return u.clearJudgement()
	}
	p.Stuck = true
	if err := u.saveJudgement(&p); err != nil {
		return err
	}
	u.said["stuck"] = p.Version
	return fmt.Errorf("the previous binary %s does not answer on http://%s/api/line after the rollback either; the tick touches nothing more until the factory answers again", p.Previous, listen)
}

// stuck is a tick after a rollback that did not come up: it touches nothing until the factory
// answers again.
func (u *updater) stuck(listen string, p judgement) (bool, error) {
	if process, reachable, _ := u.running(listen); reachable {
		log.Printf("the factory answers again with %s; the tick goes on, and %s stays blocked", process.Version, p.Version)
		delete(u.said, "stuck")
		return false, u.clearJudgement()
	}
	u.once("stuck", p.Version, fmt.Sprintf("error: the factory does not answer since %s was rolled back to %s; the tick touches nothing until it answers again", p.Version, p.Previous))
	return true, nil
}

func (u *updater) judgementPath() string { return filepath.Join(u.state, "judgement.json") }

func (u *updater) loadJudgement() (*judgement, error) {
	raw, err := os.ReadFile(u.judgementPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", u.judgementPath(), err)
	}
	var p judgement
	if err := json.Unmarshal(raw, &p); err != nil || p.Version == "" {
		return nil, fmt.Errorf("%s does not read (%v); remove it and the tick judges nothing", u.judgementPath(), err)
	}
	return &p, nil
}

func (u *updater) saveJudgement(p *judgement) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return writeAtomic(u.judgementPath(), raw)
}

func (u *updater) clearJudgement() error {
	if err := os.Remove(u.judgementPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s cannot be removed: %w", u.judgementPath(), err)
	}
	return nil
}

// blockPath is the block list: one version a line, root's own. Deleting a line lifts its block.
func (u *updater) blockPath() string { return filepath.Join(u.state, "blocked") }

func (u *updater) blocked() (map[semver]bool, error) {
	blocked := map[semver]bool{}
	raw, err := os.ReadFile(u.blockPath())
	if errors.Is(err, os.ErrNotExist) {
		return blocked, nil
	}
	if err != nil {
		return nil, fmt.Errorf("the block list %s cannot be read: %w", u.blockPath(), err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		v, ok := parseSemver(line)
		if !ok {
			return nil, fmt.Errorf("the block list %s carries %q, which is not major.minor.patch; the tick does nothing until it is fixed", u.blockPath(), line)
		}
		blocked[v] = true
	}
	return blocked, nil
}

func (u *updater) block(version string) error {
	raw, err := os.ReadFile(u.blockPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("the block list %s cannot be read: %w", u.blockPath(), err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == version {
			return nil
		}
	}
	if len(raw) > 0 && raw[len(raw)-1] != '\n' {
		raw = append(raw, '\n')
	}
	if err := writeAtomic(u.blockPath(), append(raw, version+"\n"...)); err != nil {
		return fmt.Errorf("%s cannot be put on the block list: %w", version, err)
	}
	return nil
}

// writeAtomic writes a file of the updater's directory, root's alone, in one rename.
func writeAtomic(path string, raw []byte) error {
	temp := path + ".new"
	if err := os.WriteFile(temp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

// waitsFor names the run the drain waits for.
func waitsFor(now []Run) string {
	if len(now) == 0 {
		return "the drain waits for no run and ends in a moment"
	}
	names := make([]string, 0, len(now))
	for _, r := range now {
		names = append(names, fmt.Sprintf("run %d (%s#%d)", r.ID, r.Repository, r.Issue))
	}
	return "the drain waits for " + strings.Join(names, ", ")
}

// unreachable is a tick whose factory does not answer. A service the operator stopped gets the
// newer file and is not started; any other state is one the tick does not act on.
func (u *updater) unreachable(listen string, newest release, fileVersion semver) error {
	s, err := u.serviceState()
	if err != nil {
		return err
	}
	if s.active != "inactive" || s.result != "success" {
		return fmt.Errorf("the factory does not answer on http://%s/api/line and %s is %s with the result %s; the tick does nothing and tries again at the next one",
			listen, factoryUnit, s.active, s.result)
	}
	if !fileVersion.less(newest.version) {
		u.once("current", "stopped "+fileVersion.String(), fmt.Sprintf("%s is stopped and the binary on disk is %s, the newest release %s; nothing to install", factoryUnit, fileVersion, newest.version))
		return nil
	}
	if err := u.install(newest); err != nil {
		return err
	}
	log.Printf("installed %s; %s was stopped by the operator (inactive, success), so nothing is started", newest.version, factoryUnit)
	return nil
}

// newestRelease is the highest version off the block list among the repository's published
// factory releases, read through the REST API without a login. The latest-release endpoint is not
// used: factory releases are published with latest set to false.
func (u *updater) newestRelease() (release, error) {
	type asset struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	}
	type listed struct {
		Tag        string  `json:"tag_name"`
		Draft      bool    `json:"draft"`
		Prerelease bool    `json:"prerelease"`
		Assets     []asset `json:"assets"`
	}
	blocked, err := u.blocked()
	if err != nil {
		return release{}, err
	}
	var best *listed
	var bestVersion semver
	skipped := 0
	for page := 1; ; page++ {
		url := fmt.Sprintf("%s/repos/%s/releases?per_page=100&page=%d", u.api, releaseRepository, page)
		var releases []listed
		if err := u.getJSON(url, &releases); err != nil {
			return release{}, fmt.Errorf("the releases of %s cannot be read: %w", releaseRepository, err)
		}
		for i := range releases {
			r := &releases[i]
			if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, releaseTagPrefix) {
				continue
			}
			v, ok := parseSemver(strings.TrimPrefix(r.Tag, releaseTagPrefix))
			if ok && blocked[v] {
				u.once("blocked "+v.String(), "yes", fmt.Sprintf("the release %s is on the block list %s; the tick never installs it", v, u.blockPath()))
				skipped++
				continue
			}
			if ok && (best == nil || bestVersion.less(v)) {
				best, bestVersion = r, v
			}
		}
		if len(releases) < 100 {
			break
		}
	}
	if best == nil && skipped > 0 {
		return release{}, fmt.Errorf("every published factory release of %s is on the block list %s; the tick installs nothing until a new release or a lifted block", releaseRepository, u.blockPath())
	}
	if best == nil {
		return release{}, fmt.Errorf("%s has no published factory release", releaseRepository)
	}
	found := release{version: bestVersion, tag: best.Tag}
	binary, bundle := "factory-linux-"+runtime.GOARCH, "factory-v"+bestVersion.String()+".sigstore.json"
	for _, a := range best.Assets {
		switch a.Name {
		case binary:
			found.binary = a.URL
		case bundle:
			found.bundle = a.URL
		}
	}
	return found, nil
}

func (u *updater) getJSON(url string, into any) error {
	request, err := http.NewRequestWithContext(u.ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := u.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, response.Status)
	}
	return json.NewDecoder(response.Body).Decode(into)
}

// running reads the line endpoint. A factory that does not answer is not an error here: whether
// that is a stop the operator made is systemd's to say.
func (u *updater) running(listen string) (runningFactory, bool, error) {
	var process runningFactory
	request, err := http.NewRequestWithContext(u.ctx, http.MethodGet, "http://"+listen+"/api/line", nil)
	if err != nil {
		return process, false, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return process, false, nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return process, false, fmt.Errorf("the factory's http://%s/api/line answered %s; the tick does nothing", listen, response.Status)
	}
	if err := json.NewDecoder(response.Body).Decode(&process); err != nil {
		return process, false, fmt.Errorf("the factory's http://%s/api/line cannot be read: %w", listen, err)
	}
	return process, true, nil
}

// fileVersion is what a binary reports on -version: the version of the file, never of the process.
func (u *updater) fileVersion(path string) (semver, error) {
	out, reason, err := u.run(u.ctx, commandTimeout, path, "-version")
	if err != nil {
		return semver{}, fmt.Errorf("%s -version failed: %s", path, reason)
	}
	said := strings.TrimSpace(string(out))
	v, ok := parseSemver(strings.TrimPrefix(said, "factory "))
	if !ok || !strings.HasPrefix(said, "factory ") {
		return semver{}, fmt.Errorf("%s -version printed %q, not factory major.minor.patch", path, said)
	}
	return v, nil
}

// unitState is what systemd reports of the service.
type unitState struct {
	active   string // ActiveState
	sub      string // SubState
	result   string // Result
	restarts int    // NRestarts, the restarts systemd made since the unit was last started by hand
	delay    string // RestartUSec, the unit's restart delay as systemd prints it
}

func (s unitState) String() string {
	return fmt.Sprintf("%s (%s) with the result %s after %d restarts", s.active, s.sub, s.result, s.restarts)
}

// serviceState is the service's state as systemd reports it.
func (u *updater) serviceState() (unitState, error) {
	var s unitState
	out, reason, err := u.run(u.ctx, commandTimeout, systemctlCommand, "show", factoryUnit,
		"--property=ActiveState,SubState,Result,NRestarts,RestartUSec")
	if err != nil {
		return s, fmt.Errorf("%s show %s failed: %s", systemctlCommand, factoryUnit, reason)
	}
	for _, line := range strings.Split(string(out), "\n") {
		key, value, _ := strings.Cut(line, "=")
		switch key {
		case "ActiveState":
			s.active = value
		case "SubState":
			s.sub = value
		case "Result":
			s.result = value
		case "NRestarts":
			s.restarts, _ = strconv.Atoi(value)
		case "RestartUSec":
			s.delay = value
		}
	}
	return s, nil
}

// restartDelay reads a systemd time span such as 0, 30s, 100ms or 1min 30s. infinity, a unit that
// is never restarted, reads as no delay: the factory has the margin alone to answer.
func restartDelay(span string) (time.Duration, error) {
	span = strings.TrimSpace(span)
	if span == "infinity" {
		return 0, nil
	}
	d, err := time.ParseDuration(strings.ReplaceAll(strings.ReplaceAll(span, "min", "m"), " ", ""))
	if err != nil || d < 0 {
		return 0, fmt.Errorf("the restart delay %q of %s does not read as a time span", span, factoryUnit)
	}
	return d, nil
}

// settle waits the unit's restart delay and a minute more, the time a started factory has to answer.
func (u *updater) settle() error {
	s, err := u.serviceState()
	if err != nil {
		return err
	}
	delay, err := restartDelay(s.delay)
	if err != nil {
		return err
	}
	wait := delay + settleMargin
	log.Printf("waiting %s, the restart delay of %s and a minute, before the line endpoint is read", wait, factoryUnit)
	after := u.after
	if after == nil {
		after = time.After
	}
	select {
	case <-after(wait):
		return nil
	case <-u.ctx.Done():
		return fmt.Errorf("the tick ran out of time while it waited for %s: %w", factoryUnit, u.ctx.Err())
	}
}

// hangup has the running factory drain, to the factory's main process alone so the worker of the
// run that is going does not die of the signal.
func (u *updater) hangup() error {
	if _, reason, err := u.run(u.ctx, commandTimeout, systemctlCommand, "kill", "--kill-whom=main", "-s", "HUP", factoryUnit); err != nil {
		return fmt.Errorf("%s kill -s HUP %s failed: %s", systemctlCommand, factoryUnit, reason)
	}
	log.Printf("sent SIGHUP to %s: it drains and systemd starts the binary on disk", factoryUnit)
	return nil
}

// install downloads the release's binary and bundle, verifies the attestation and renames the
// binary over the installed one, keeping that one beside it as the previous binary. A refused or
// broken file installs nothing.
func (u *updater) install(r release) error {
	if r.binary == "" || r.bundle == "" {
		return fmt.Errorf("the release %s lacks factory-linux-%s or its attestation bundle; nothing is installed", r.tag, runtime.GOARCH)
	}
	work, err := os.MkdirTemp(u.state, "tick-")
	if err != nil {
		return fmt.Errorf("the updater's work directory cannot be made in %s: %w", u.state, err)
	}
	defer os.RemoveAll(work)
	// The new binary is written beside the installed one, so the rename that installs it stays on
	// one file system and is atomic.
	fresh, err := os.CreateTemp(filepath.Dir(u.exe), ".factory-new-")
	if err != nil {
		return fmt.Errorf("the new binary cannot be written beside %s: %w", u.exe, err)
	}
	freshPath := fresh.Name()
	installed := false
	defer func() {
		if !installed {
			os.Remove(freshPath)
		}
	}()
	err = u.download(r.binary, fresh)
	if closed := fresh.Close(); err == nil {
		err = closed
	}
	if err != nil {
		return fmt.Errorf("factory-linux-%s of %s cannot be downloaded: %w; nothing is installed", runtime.GOARCH, r.tag, err)
	}
	bundle := filepath.Join(work, "bundle.sigstore.json")
	if err := u.downloadTo(r.bundle, bundle); err != nil {
		return fmt.Errorf("the attestation bundle of %s cannot be downloaded: %w; nothing is installed", r.tag, err)
	}
	if err := u.verify(freshPath, bundle, r, work); err != nil {
		return err
	}
	if err := os.Chmod(freshPath, 0o755); err != nil {
		return fmt.Errorf("the new binary cannot be made executable: %w; nothing is installed", err)
	}
	if got, err := u.fileVersion(freshPath); err != nil || got != r.version {
		return fmt.Errorf("the verified binary of %s does not report that version (%v, %v); nothing is installed", r.tag, got, err)
	}
	previous := u.exe + ".previous"
	if err := os.Remove(previous); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("the previous binary %s cannot be replaced: %w; nothing is installed", previous, err)
	}
	if err := os.Link(u.exe, previous); err != nil {
		return fmt.Errorf("the installed binary cannot be kept as %s: %w; nothing is installed", previous, err)
	}
	if err := os.Rename(freshPath, u.exe); err != nil {
		return fmt.Errorf("the new binary cannot be renamed over %s: %w; nothing is installed", u.exe, err)
	}
	installed = true
	log.Printf("verified the attestation of %s and installed it as %s, keeping the one before as %s", r.tag, u.exe, previous)
	return nil
}

func (u *updater) download(url string, into io.Writer) error {
	request, err := http.NewRequestWithContext(u.ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := u.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, response.Status)
	}
	_, err = io.Copy(into, response.Body)
	return err
}

func (u *updater) downloadTo(url, path string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	err = u.download(url, file)
	if closed := file.Close(); err == nil {
		err = closed
	}
	return err
}

// verify runs gh's attestation check with the five-part policy and without a login. gh gets a home
// of its own in the tick's work directory, which the tick removes, so the trust roots are fetched
// through TUF on every verification and no token of anybody's is read.
func (u *updater) verify(binary, bundle string, r release, work string) error {
	env := []string{
		"PATH=/usr/bin:/bin",
		"HOME=" + work,
		"XDG_CONFIG_HOME=" + filepath.Join(work, "config"),
		"XDG_CACHE_HOME=" + filepath.Join(work, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(work, "data"),
		"XDG_STATE_HOME=" + filepath.Join(work, "state"),
		"GH_CONFIG_DIR=" + filepath.Join(work, "gh"),
		"GH_PROMPT_DISABLED=1",
		"GH_NO_UPDATE_NOTIFIER=1",
	}
	_, reason, err := u.runIn(u.ctx, verifyTimeout, env, "", ghCommand, "attestation", "verify", binary,
		"--repo", releaseRepository,
		"--bundle", bundle,
		"--cert-identity-regex", releaseIdentity,
		"--source-ref", "refs/tags/"+r.tag,
		"--cert-oidc-issuer", actionsIssuer,
		"--deny-self-hosted-runners",
		"--predicate-type", slsaProvenance)
	if err != nil {
		return fmt.Errorf("the attestation of %s was refused (%v): %s; nothing is installed, and the next tick tries again",
			r.tag, err, strings.Join(strings.Fields(reason), " "))
	}
	return nil
}

// once logs a message when what it says about key differs from what the last tick said, so the
// journal carries a state change once and not every hour.
func (u *updater) once(key, value, message string) {
	if u.said[key] == value {
		return
	}
	u.said[key] = value
	log.Print(message)
}

func (u *updater) statePath() string { return filepath.Join(u.state, "said.json") }

// loadState reads what earlier ticks said. The directory is made root's alone when it is missing.
func (u *updater) loadState() error {
	u.said = map[string]string{}
	if err := os.MkdirAll(u.state, 0o700); err != nil {
		return fmt.Errorf("the updater's directory %s cannot be made: %w; the tick runs as root", u.state, err)
	}
	raw, err := os.ReadFile(u.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%s cannot be read: %w", u.statePath(), err)
	}
	if err := json.Unmarshal(raw, &u.said); err != nil || u.said == nil {
		// A state that does not read, or reads as null, only costs a line said twice.
		u.said = map[string]string{}
	}
	return nil
}

func (u *updater) saveState() error {
	raw, err := json.Marshal(u.said)
	if err != nil {
		return err
	}
	if err := writeAtomic(u.statePath(), raw); err != nil {
		return fmt.Errorf("the updater's state cannot be written: %w", err)
	}
	return nil
}
