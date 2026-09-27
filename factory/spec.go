package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A spec run is the factory's work on one spec as a whole: its tickets integrated on a spec branch
// (docs/glossary.md). This file is its claim and its holding: the factory takes a routed spec from
// the line by creating the spec branch through the API, which exactly one claimer wins ([ADR 0024]),
// assigns itself, and then holds the spec until the maintainer takes the spec-run label off or closes
// it. A spec run starts no session here and has no deadline: the runs of its tickets are factory runs
// of their own.
//
// [ADR 0024]: ../docs/adr/0024-a-claim-is-the-creation-of-the-branch-through-the-api.md

// specLabel marks a spec, the issue a planner cut into tickets. It is the workflow's label vocabulary
// restated in Go, as readyLabel is, and a drift test holds it to the planner's copy.
const specLabel = "spec"

// specRunLabel is the spec-run label, derived from the routing label: factory:spec-run for the default
// one, and <label>:spec-run for a host that routes by another name.
func specRunLabel(routingLabel string) string { return routingLabel + ":spec-run" }

// specBranchName is the spec branch of a spec: spec/<number>-<slug>, the branch contract with spec as
// its type.
func specBranchName(spec Issue) string {
	return "spec/" + strconv.Itoa(spec.Number) + "-" + slug(spec.Title)
}

// The states of a spec run. claiming is the moment between the start of the claim and its end;
// holding is a claim that stands (the spec branch on the remote, the spec assigned to this host); lost
// is a claim that met a spec branch on the remote and touched nothing; failed is a claim that could
// not be made; let-go is a holding the maintainer ended on GitHub.
const (
	specClaiming = "claiming"
	specHolding  = "holding"
	specLost     = "lost"
	specFailed   = "failed"
	specLetGo    = "let-go"
)

// SpecRun is the record of one spec run: the file in the data directory and the body the HTTP
// interface serves.
type SpecRun struct {
	ID         int    `json:"id"`
	Repository string `json:"repository"`
	Spec       int    `json:"spec"`
	Title      string `json:"title"`
	// Branch is the spec branch the claim created, or for a lost one the spec branch that stood on the
	// remote already, and Base the branch it was cut from.
	Branch string `json:"branch"`
	Base   string `json:"base"`
	State  string `json:"state"`
	// Idle says no ticket run of the spec run is working. A spec run holds its spec between tickets.
	Idle bool `json:"idle"`
	// SignalAt is when the spec-run label was last set on the spec, the routing this spec run answers.
	// A spec whose latest spec run did not hold it is claimed again only on a routing newer than that.
	SignalAt  time.Time  `json:"signalAt"`
	StartedAt time.Time  `json:"startedAt"`
	ClaimedAt *time.Time `json:"claimedAt"`
	LetGoAt   *time.Time `json:"letGoAt"`
	// Reason is why a spec run is lost, failed or let go.
	Reason   string   `json:"reason"`
	Warnings []string `json:"warnings"`
	// Tickets is the tickets whose runs this spec run took, in the order it took them, each with its
	// runs and whether its pull request is merged into the spec branch (ticket.go).
	Tickets    []SpecTicket `json:"tickets"`
	EventCount int          `json:"eventCount"`
}

func (s SpecRun) key() string { return Issue{Repository: s.Repository, Number: s.Spec}.key() }

// SpecStore holds the spec runs: one JSON record and one append-only JSONL event log per spec run in
// the data directory, beside the runs and written the same way.
type SpecStore struct {
	dir   string
	mu    sync.Mutex
	specs []*SpecRun
}

func (s *SpecStore) recordName(id int) string { return fmt.Sprintf("spec-%d.json", id) }

func (s *SpecStore) eventsPath(id int) string {
	return filepath.Join(s.dir, fmt.Sprintf("spec-%d.events.jsonl", id))
}

// OpenSpecStore reads the spec runs already in the data directory. A spec run that has not ended wrote
// its record after an event it may not have counted, so its log is the truth about how much of it was
// logged, as for a run. One that was claiming when the factory stopped before it named its spec branch
// touched nothing on the remote and says so as a failure; one that had named it may have created it
// and assigned the spec, and stays claiming for the working loop to finish (resumeSpec).
func OpenSpecStore(dir string) (*SpecStore, error) {
	s := &SpecStore{dir: dir}
	records, err := filepath.Glob(filepath.Join(dir, "spec-[0-9]*.json"))
	if err != nil {
		return nil, err
	}
	for _, file := range records {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("the spec run record %s cannot be read: %w; move it aside to start without it", file, err)
		}
		r := &SpecRun{}
		if err := json.Unmarshal(raw, r); err != nil {
			return nil, fmt.Errorf("the spec run record %s is not a spec run: %v; move it aside to start without it", file, err)
		}
		if r.ID <= 0 {
			return nil, fmt.Errorf("the spec run record %s has no id; move it aside to start without it", file)
		}
		if r.State == specClaiming || r.State == specHolding {
			events, err := s.events(r.ID, 0)
			if err != nil {
				return nil, fmt.Errorf("the event log %s cannot be read: %w; move it aside to start without it", s.eventsPath(r.ID), err)
			}
			r.EventCount = len(events)
		}
		s.specs = append(s.specs, r)
	}
	sort.Slice(s.specs, func(a, b int) bool { return s.specs[a].ID < s.specs[b].ID })
	for _, r := range s.specs {
		if r.State == specClaiming && r.Branch == "" {
			reason := "the factory stopped while this spec was being claimed" + specLeftBehind("")
			s.event(r, Event{Kind: "error", Title: specFailed, Body: reason})
			s.update(r, func() { r.State, r.Reason = specFailed, reason })
		}
	}
	return s, nil
}

// add starts a spec run's record under the next id.
func (s *SpecStore) add(r *SpecRun) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r.ID = 1
	for _, other := range s.specs {
		if other.ID >= r.ID {
			r.ID = other.ID + 1
		}
	}
	s.specs = append(s.specs, r)
	s.write(r)
}

// update changes a spec run and writes its record.
func (s *SpecStore) update(r *SpecRun, change func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	change()
	s.write(r)
}

func (s *SpecStore) write(r *SpecRun) {
	raw, err := json.MarshalIndent(r, "", "  ")
	if err == nil {
		err = persist(s.dir, s.recordName(r.ID), raw)
	}
	if err != nil {
		log.Printf("error: the record of spec run %d could not be written: %v; is %s writable and has it space left?", r.ID, err, s.dir)
	}
}

// event appends to a spec run's log.
func (s *SpecStore) event(r *SpecRun, e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r.EventCount++
	if err := appendEvent(s.eventsPath(r.ID), r.EventCount, e); err != nil {
		log.Printf("error: event %d of spec run %d could not be logged: %v; is %s writable and has it space left?", r.EventCount, r.ID, err, s.dir)
	}
	s.write(r)
}

// warn puts a warning on a spec run once, in its record, its log and the journal.
func (s *SpecStore) warn(r *SpecRun, title, warning string) {
	s.mu.Lock()
	said := false
	for _, already := range r.Warnings {
		said = said || already == warning
	}
	if !said {
		r.Warnings = append(r.Warnings, warning)
	}
	s.mu.Unlock()
	if said {
		return
	}
	log.Printf("error: %s", warning)
	s.event(r, Event{Kind: "error", Title: title, Body: warning})
}

// list is a copy of every spec run's record, oldest first.
func (s *SpecStore) list() []SpecRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SpecRun, 0, len(s.specs))
	for _, r := range s.specs {
		copied := *r
		copied.Warnings = append([]string{}, r.Warnings...)
		out = append(out, copied)
	}
	return out
}

// find is the spec run of that id as the store holds it.
func (s *SpecStore) find(id int) (*SpecRun, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.specs {
		if r.ID == id {
			return r, true
		}
	}
	return nil, false
}

// get is a copy of the spec run of that id.
func (s *SpecStore) get(id int) (SpecRun, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.specs {
		if r.ID == id {
			copied := *r
			copied.Warnings = append([]string{}, r.Warnings...)
			return copied, true
		}
	}
	return SpecRun{}, false
}

// latest is the newest spec run of every spec, by its key.
func (s *SpecStore) latest() map[string]SpecRun {
	out := map[string]SpecRun{}
	for _, r := range s.list() {
		out[r.key()] = r
	}
	return out
}

func (s *SpecStore) events(id, after int) ([]Event, error) {
	return readEvents(s.eventsPath(id), after)
}

// heldSpecs is the specs this factory holds in a connected repository, as a poll asks GitHub about
// them. Every one of them is asked on every poll: a spec run is one per spec, and a maintainer who
// ends one is heard within a poll.
func (f *Factory) heldSpecs() []Held {
	out := []Held{}
	for _, r := range f.specs.list() {
		connected, ok := f.connected(r.Repository)
		if r.State != specHolding || !ok {
			continue
		}
		out = append(out, Held{Repository: connected.Name, Number: r.Spec, Branch: r.Branch, Spec: true})
	}
	return out
}

// claimSpecs takes the routed specs from the line, in the order they were routed. A spec is claimed
// when no spec run of it holds it and the routing is newer than the one its latest spec run answered:
// the label that stood when a claim was lost or a spec was let go is the one that was acted on, and
// setting it again is the gesture that asks for another claim. The claim runs in the working loop
// while no run is going, so it is the only thing that writes to the clone.
//
// One pass claims one spec at most, and a claim the factory stopped in comes first. A claim fetches
// the clone, which may wait as long as a clone does, and the line of issues behind it waits for it
// too: one claim per dispatch keeps that wait to one, and the next spec is claimed a poll later. It
// answers whether it made a claim, after which the dispatch starts nothing: the next poll reads the
// tickets of the spec, which come before the routed issues.
func (f *Factory) claimSpecs(ctx context.Context) bool {
	if f.fake {
		return false // the canned line of fake mode holds no spec
	}
	for _, held := range f.specs.list() {
		if ctx.Err() != nil || f.Paused() || f.Draining() {
			return false
		}
		if _, ok := f.connected(held.Repository); held.State != specClaiming || !ok || !f.claimable(held.Repository) {
			continue
		}
		if r, ok := f.specs.find(held.ID); ok {
			f.resumeSpec(ctx, r)
			return true
		}
	}
	f.mu.Lock()
	routed := append([]Issue{}, f.specQueue...) // sorted by refreshQueue
	f.mu.Unlock()
	latest := f.specs.latest()
	for _, spec := range routed {
		if ctx.Err() != nil || f.Paused() || f.Draining() {
			return false
		}
		if _, ok := f.connected(spec.Repository); !ok {
			continue
		}
		if last, ok := latest[spec.key()]; ok {
			if last.State == specHolding || last.State == specClaiming || !spec.RoutedAt.After(last.SignalAt) {
				continue
			}
		}
		if !f.claimable(spec.Repository) {
			continue
		}
		f.claimSpec(ctx, spec)
		return true
	}
	return false
}

// claimSpec is the claim of one spec: the spec branch created through the API from the base the base
// branch rule names, and then the spec assigned to this host. A spec branch that stands on the remote
// already, whoever made it, ends the spec run lost and touches nothing, as an issue's leftover branch
// does: the spec is claimed again once that branch is gone and the spec is routed again.
func (f *Factory) claimSpec(ctx context.Context, spec Issue) {
	r := &SpecRun{Repository: spec.Repository, Spec: spec.Number, Title: spec.Title, State: specClaiming,
		SignalAt: spec.RoutedAt, StartedAt: time.Now(), Warnings: []string{}}
	f.specs.add(r)
	f.takeSpec(ctx, r, false)
}

// resumeSpec finishes a claim the factory stopped in after the record named its spec branch. The
// branch may stand on the remote and the spec may be assigned already, so the claim goes on from the
// creation of the branch: a branch of that name that this host's login created is the one this spec
// run made, and assigning the spec again changes nothing when it is assigned. A branch somebody else
// created is a lost claim, as ever.
func (f *Factory) resumeSpec(ctx context.Context, r *SpecRun) {
	f.specs.event(r, Event{Kind: "factory", Title: "resuming the claim",
		Body: "the factory stopped while this spec was being claimed; the claim of " + r.Branch + " goes on where it stopped"})
	log.Printf("spec run %d (%s#%d) resumes the claim of %s", r.ID, r.Repository, r.Spec, r.Branch)
	f.takeSpec(ctx, r, true)
}

func (f *Factory) takeSpec(ctx context.Context, r *SpecRun, resumed bool) {
	end := func(state, reason string) {
		kind := "error"
		if state == specLost {
			kind = "factory"
		}
		f.specs.event(r, Event{Kind: kind, Title: state, Body: reason})
		f.specs.update(r, func() { r.State, r.Reason = state, reason })
		log.Printf("spec run %d (%s#%d) ended: %s", r.ID, r.Repository, r.Spec, state)
	}
	failed := func(err error, created bool) {
		if ctx.Err() == nil && !created {
			// Nothing of the spec was touched, so the reason lies with this host or with GitHub, and the
			// issues of the repository would meet it too.
			f.hold(r.Repository, "could not be claimed from: "+err.Error())
		}
		branch := ""
		if created {
			branch = r.Branch
		}
		end(specFailed, "the spec could not be claimed: "+err.Error()+specLeftBehind(branch))
	}

	connected, _ := f.connected(r.Repository)
	clone := clonePath(f.settings.DataDir, connected.Name)
	base, err := fetchBase(ctx, connected, clone)
	if err != nil {
		failed(err, false)
		return
	}
	branch := specBranchName(Issue{Number: r.Spec, Title: r.Title})
	if resumed {
		branch = r.Branch
	} else if held := remoteSpecBranch(ctx, clone, r.Spec); held != "" {
		f.specs.update(r, func() { r.Branch, r.Base = held, base })
		end(specLost, "the spec branch "+held+" stands on the remote already, so this spec run touched nothing; remove that branch and set the spec-run label again to claim the spec")
		return
	}
	head, login, err := f.branchPoint(ctx, connected, clone, base)
	if err != nil {
		failed(err, false)
		return
	}
	// The record names the spec branch before it is created: a host that loses power while the branch
	// is made, or before the spec is assigned, finds the claim to finish in this record alone.
	f.specs.update(r, func() { r.Branch, r.Base = branch, base })
	f.specs.event(r, Event{Kind: "factory", Title: "claiming " + branch, Body: fmt.Sprintf("creating refs/heads/%s of %s at %s (%s)", branch, connected.Name, head, base)})
	if err := createRef(ctx, connected.Name, branch, head); err != nil {
		switch {
		case errors.Is(err, errLost) && resumed && createdBy(ctx, connected.Name, branch, login):
			f.specs.event(r, Event{Kind: "factory", Title: branch + " is this spec run's",
				Body: fmt.Sprintf("%s stands on the remote and %s created it: it is the branch this spec run made before the factory stopped", branch, login)})
		case errors.Is(err, errLost):
			end(specLost, "another claimer holds "+branch+" on the remote; this spec run touched nothing else")
			return
		default:
			failed(err, false)
			return
		}
	}
	if err := assignSelf(ctx, connected.Name, r.Spec, login); err != nil {
		failed(fmt.Errorf("spec #%d of %s could not be assigned to %s: %w", r.Spec, connected.Name, login, err), true)
		return
	}
	now := time.Now()
	f.specs.update(r, func() { r.State, r.Idle, r.ClaimedAt = specHolding, true, &now })
	f.specs.event(r, Event{Kind: "factory", Title: "claimed " + branch,
		Body: fmt.Sprintf("the spec branch %s is on the remote at %s (%s) and the spec is assigned to %s; the spec run holds the spec, idle", branch, head, base, login)})
	log.Printf("spec run %d (%s#%d) holds %s", r.ID, r.Repository, r.Spec, branch)
}

// createdBy says whether the latest activity GitHub records on a branch (its creation, a push) was
// made by that login. A reading that fails says no, so the claim ends lost and touches nothing.
func createdBy(ctx context.Context, repository, branch, login string) bool {
	raw, err := gh(ctx, "api", "repos/"+repository+"/activity?ref="+url.QueryEscape("refs/heads/"+branch)+"&per_page=1",
		"--jq", ".[0].actor.login // empty")
	return err == nil && strings.EqualFold(strings.TrimSpace(string(raw)), login)
}

// letSpecsGo answers the decisions a poll read about the specs this factory holds: the spec-run label
// taken off, or the spec closed. Letting a spec go takes this host off as its assignee, keeps the spec
// branch and everything on it ([ADR 0026]), and records the letting-go on the spec run. An assignee
// that cannot be taken off is a warning, and the spec stays held until a later poll manages it. A
// paused factory lets nothing go.
//
// [ADR 0026]: ../docs/adr/0026-the-factory-never-deletes-work-on-its-own.md
func (f *Factory) letSpecsGo(ctx context.Context, decisions map[string]string) {
	if len(decisions) == 0 || f.Paused() || ctx.Err() != nil {
		return
	}
	for _, held := range f.specs.list() {
		decision, ends := decisions[held.key()]
		if !ends || held.State != specHolding {
			continue
		}
		r, ok := f.specs.find(held.ID)
		if !ok {
			continue
		}
		f.letSpecGo(ctx, r, decision)
	}
}

func (f *Factory) letSpecGo(ctx context.Context, r *SpecRun, decision string) {
	connected, ok := f.connected(r.Repository)
	if !ok {
		return
	}
	login, err := f.login(ctx)
	if err == nil {
		_, err = gh(ctx, "issue", "edit", strconv.Itoa(r.Spec), "--repo", connected.Name, "--remove-assignee", login)
	}
	if err != nil {
		if ctx.Err() == nil {
			f.specs.warn(r, "the spec could not be let go",
				fmt.Sprintf("%s, and the assignee of spec #%d of %s could not be taken off: %v; the spec stays held and a later poll tries again", decision, r.Spec, connected.Name, err))
		}
		return
	}
	now := time.Now()
	reason := decision + "; the assignee was taken off and the spec branch " + r.Branch + " stays on the remote with everything on it"
	f.specs.event(r, Event{Kind: "factory", Title: "let go", Body: reason})
	f.specs.update(r, func() { r.State, r.Idle, r.LetGoAt, r.Reason = specLetGo, true, &now, reason })
	log.Printf("spec run %d (%s#%d) let go: %s", r.ID, r.Repository, r.Spec, decision)
}

// remoteSpecBranch is the spec branch of a spec on the remote, as the clone knows it after the fetch,
// or empty when there is none: any branch spec/<number>-, whatever slug its title spelled then.
func remoteSpecBranch(ctx context.Context, clone string, spec int) string {
	heads, err := git(ctx, clone, "for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin/spec/")
	if err != nil {
		return "" // the creation of the reference decides the claim either way
	}
	prefix := "spec/" + strconv.Itoa(spec) + "-"
	for _, head := range strings.Split(heads, "\n") {
		if strings.HasPrefix(head, prefix) {
			return head
		}
	}
	return ""
}

// specLeftBehind says what a spec claim that ended without holding the spec left on the remote.
func specLeftBehind(branch string) string {
	if branch == "" {
		return "; nothing was claimed on the remote"
	}
	return "; the spec branch " + branch + " was created on the remote and is left behind: remove it to claim the spec again"
}
