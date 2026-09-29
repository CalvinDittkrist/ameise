package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The end of a spec run. When a held spec has sub-issues and every one of them is closed, the line
// carries its spec pull request: a factory run on the spec itself, which merges the base into the
// spec branch once more when that merge is clean, opens the spec pull request from the spec branch to
// the base, and runs it through the ci stage only. Its body lists every ticket with its pull request
// and says "Part of #<spec>", never "Closes": the acceptance of the spec stays with the planner. Green
// ends the run ready with a review request, and the run is held as a ticket run is: a review queues a
// follow-up run, and the merge a person makes is read on a later poll. That merge ends the spec run
// done and takes this host off the spec; the records stay.
//
// A spec run whose open tickets are all a person's (ready-for-human) or blocked waits: it takes no
// ticket and opens no spec pull request. It says on the spec what it waits for, which stands at the end
// of the chain of blockers: a ticket of a person that has no open blocker, and every open issue outside
// the spec that blocks a ticket of it. A ticket blocked by a sibling alone is named by neither.

// humanLabel marks an issue a person implements. It is the workflow's label vocabulary restated in Go,
// as readyLabel is, and the contract fixture holds it to the planner's copy.
const humanLabel = "ready-for-human"

// signalSpecPull is what puts the spec pull request of a spec run in the line: every ticket of the
// spec is closed. Its run is a first run, on the spec branch the spec run holds.
const signalSpecPull = "spec-pull"

// subIssue is one sub-issue of a held spec, as a poll read it.
type subIssue struct {
	Number int
	Title  string
	// Elsewhere is the repository of a sub-issue from another repository, and empty for one of the
	// spec's own. Such a sub-issue is no ticket the factory takes, but the spec is not done while it is
	// open.
	Elsewhere string
	Open      bool
	Human     bool // it carries ready-for-human
	Blocked   bool // an open issue blocks it
	// Blockers is the open issues that block it, and BlockersRead whether they were read: they are read
	// for the blocked tickets of a spec whose spec run may take none of them (specTickets).
	Blockers     []blocker
	BlockersRead bool
}

// blocker is an open issue that blocks a sub-issue of a held spec, as a poll read it.
type blocker struct {
	Repository string `json:"repository"`
	Number     int    `json:"number"`
	Title      string `json:"title"`
}

func (b blocker) key() string { return Issue{Repository: b.Repository, Number: b.Number}.key() }

// outsideBlocker is an open issue that blocks tickets of a spec and is no sub-issue of it, with the
// tickets it holds.
type outsideBlocker struct {
	blocker
	Tickets []int `json:"tickets"`
}

// name is how a comment on the spec names the blocker: its number alone in the spec's repository, and
// with its repository in another.
func (b blocker) name(repository string) string {
	if repositoryKey(b.Repository) == repositoryKey(repository) {
		return "#" + strconv.Itoa(b.Number)
	}
	return b.Repository + "#" + strconv.Itoa(b.Number)
}

// specPull says the run is the run of a spec pull request: a run on the spec itself, of its spec run.
func (r Run) specPull() bool { return r.Spec != 0 && r.Issue == r.Spec }

// specPullsDue is the spec pull requests the line carries: one for every spec run that holds its spec,
// has no ticket run going, and whose spec has sub-issues that are all closed, as the last poll read
// them. A spec run whose spec already had a run of its own since the claim has its spec pull request,
// and what becomes of it is that run's to answer.
func (f *Factory) specPullsDue(records []Run) []Entry {
	f.mu.Lock()
	read := f.subIssues
	f.mu.Unlock()
	out := []Entry{}
	for _, s := range f.specs.list() {
		connected, ok := f.connected(s.Repository)
		current, known := read[s.key()]
		subs := withIntegrated(s, current)
		if !ok || !known || len(subs) == 0 || s.State != specHolding || !s.Idle || s.ClaimedAt == nil || s.Branch == "" {
			continue
		}
		if slices.ContainsFunc(subs, func(i subIssue) bool { return i.Open }) {
			continue
		}
		if slices.ContainsFunc(records, func(r Run) bool { return r.key() == s.key() && !r.StartedAt.Before(*s.ClaimedAt) }) {
			continue
		}
		clone := clonePath(f.settings.DataDir, connected.Name)
		out = append(out, Entry{Issue: Issue{Repository: connected.Name, Number: s.Spec, Title: s.Title, Labels: []string{}, spec: s.Spec},
			Signal: signalSpecPull, SignalAt: *s.ClaimedAt,
			resume: Run{Branch: s.Branch, Base: s.Base, Worktree: worktreePath(clone, s.Branch)}})
	}
	return out
}

// takeSpecBranch prepares the run of a spec pull request. There is nothing to claim: the spec branch
// is on the remote and the spec is assigned to this host. The base is merged into the spec branch once
// more when that merge is clean, and the worktree is made from the spec branch.
func (f *Factory) takeSpecBranch(ctx context.Context, r *Run, entry Entry) (claimed, error) {
	held := claimed{branch: entry.resume.Branch, base: entry.resume.Base, worktree: entry.resume.Worktree,
		created: true, holding: true, resumed: true}
	if f.fake {
		return held, nil
	}
	s, ok := f.specRunOf(entry.Repository, entry.spec)
	if !ok || s.State != specHolding {
		return held, fmt.Errorf("spec #%d is held by no spec run of this factory any more", entry.spec)
	}
	connected, ok := f.connected(entry.Repository)
	if !ok {
		return held, fmt.Errorf("%s is not a connected repository", entry.Repository)
	}
	clone := clonePath(f.settings.DataDir, connected.Name)
	// The base is read again, as a ticket's claim reads it: a repository that changed its base while
	// the spec ran gets the spec pull request against the base it has now.
	base, err := fetchBase(ctx, connected, clone)
	if err != nil {
		return held, err
	}
	held.base = base
	// The run records it too: the merge of its pull request is read against the run's base, and a
	// restart or a follow-up run resumes from it.
	f.runs.update(r, func() { r.Base = base })
	if s.Base != base {
		f.specs.update(s, func() { s.Base = base })
	}
	f.mergeIntoSpec(ctx, clone, held.base, s)
	if _, err := os.Stat(held.worktree); err != nil {
		if err := makeWorktree(ctx, clone, held.branch, held.worktree); err != nil {
			return held, err
		}
	}
	f.runs.event(r, Event{Kind: "factory", Title: "the spec pull request of spec #" + strconv.Itoa(entry.spec),
		Body: fmt.Sprintf("every ticket of spec #%d is closed, so spec run %d opens its spec pull request from %s into %s; the worktree is %s",
			entry.spec, s.ID, held.branch, held.base, held.worktree)})
	return held, nil
}

// openSpecPull opens the spec pull request and hands the run to the ci stage.
func (f *Factory) openSpecPull(parent, ctx context.Context, r *Run, entry Entry, claim claimed) {
	f.runs.update(r, func() { r.stage(stagePR) })
	if _, ok := f.settlePull(parent, ctx, r, entry, claim); !ok {
		return
	}
	if pull := r.PullRequest; pull != "" {
		f.carryOn(r, entry, pull)
		f.ci(parent, ctx, r, entry, claim, pull, false)
		return
	}
	s, ok := f.specRunOf(entry.Repository, r.Spec)
	if !ok {
		f.finish(r, outcomeFailed, fmt.Sprintf("spec #%d has no spec run on this host", r.Spec)+leftBehind(claim), nil)
		return
	}
	held, _ := f.specs.get(s.ID)
	f.mu.Lock()
	subs := f.subIssues[held.key()]
	f.mu.Unlock()
	body := specPullBody(held, withIntegrated(held, subs))
	url, err := f.source.createPull(ctx, entry.Repository, newPull{Title: specPullTitle(held.Title), Head: claim.branch, Base: claim.base, Body: body, issue: r.Issue})
	if err != nil {
		if !f.halted(parent, ctx, r, "opened the spec pull request") {
			f.finish(r, outcomeFailed, "the spec pull request could not be opened: "+err.Error()+leftBehind(claim), nil)
		}
		return
	}
	f.runs.event(r, Event{Kind: "factory", Title: "opened " + url, Body: body})
	f.specs.update(s, func() { s.PullRequest = url })
	f.specs.event(s, Event{Kind: "factory", Title: "opened the spec pull request", Body: url + " goes from " + claim.branch + " into " + claim.base})
	f.ci(parent, ctx, r, entry, claim, url, false)
}

// specPullTitle is the title of a spec pull request, which the squash merge takes as its subject. It
// is cut to the longest title the factory takes, as the title of any pull request it opens.
func specPullTitle(title string) string { return cut("feat: "+title, maxTitle) }

// withIntegrated is the sub-issues of a spec with the tickets its spec run merged into the spec branch
// that are no longer on the list: a maintainer may take a ticket off the spec once its work is
// integrated, and that work is still part of the spec pull request. Such a ticket counts as closed.
func withIntegrated(s SpecRun, subs []subIssue) []subIssue {
	out := slices.Clone(subs)
	for _, t := range s.Tickets {
		if t.MergedAt == nil || slices.ContainsFunc(subs, func(i subIssue) bool { return i.Elsewhere == "" && i.Number == t.Issue }) {
			continue
		}
		out = append(out, subIssue{Number: t.Issue, Title: t.Title})
	}
	return out
}

// specPullBody is the body of a spec pull request: the spec it is part of, and every ticket with the
// pull request that merged it into the spec branch, or a note that none of the factory's did.
func specPullBody(s SpecRun, subs []subIssue) string {
	pulls := map[int]string{}
	for _, t := range s.Tickets {
		if t.MergedAt != nil {
			pulls[t.Issue] = t.PullRequest
		}
	}
	lines := []string{}
	for _, t := range subs {
		if t.Elsewhere != "" {
			lines = append(lines, fmt.Sprintf("- %s#%d %s: in another repository", t.Elsewhere, t.Number, t.Title))
			continue
		}
		pull := pulls[t.Number]
		if pull == "" {
			pull = "closed without a pull request the factory merged"
		}
		lines = append(lines, fmt.Sprintf("- #%d %s: %s", t.Number, t.Title, pull))
	}
	return fmt.Sprintf("Part of #%d.\n\nThe spec run of #%d integrated its tickets on the spec branch `%s`:\n\n%s\n",
		s.Spec, s.Spec, s.Branch, strings.Join(lines, "\n"))
}

// specPullMerged ends the spec run of a spec pull request a person merged: this host is taken off the
// spec and the spec run is done, its records and events kept. It answers false when the assignee could
// not be taken off, and the run stays held until a later poll manages it.
func (f *Factory) specPullMerged(ctx context.Context, h holding) bool {
	s, ok := f.specRunOf(h.run.Repository, h.run.Spec)
	connected, connectedOK := f.connected(h.run.Repository)
	if !ok || !connectedOK {
		return true
	}
	held, _ := f.specs.get(s.ID)
	if held.State != specHolding {
		return true
	}
	if err := f.unassignSpec(ctx, connected, s); err != nil {
		if ctx.Err() == nil {
			f.specs.warn(s, "the spec could not be let go",
				fmt.Sprintf("the spec pull request %s was merged, and the assignee of spec #%d of %s could not be taken off: %v; a later poll tries again", h.pullRequest, s.Spec, connected.Name, err))
		}
		return false
	}
	now := time.Now()
	reason := "the spec pull request " + h.pullRequest + " was merged into " + held.Base + "; the assignee was taken off the spec, and the records of the spec run stay"
	f.specs.event(s, Event{Kind: "factory", Title: specDone, Body: reason})
	f.specs.update(s, func() {
		s.State, s.Idle, s.DoneAt, s.Reason = specDone, true, &now, reason
		s.PullRequest = h.pullRequest
	})
	log.Printf("spec run %d (%s#%d) done: %s is merged", s.ID, s.Repository, s.Spec, h.pullRequest)
	return true
}

// ticketsOfSpecsLetGo adds to what a poll decided the tickets of spec runs that were let go: a ticket
// run the letting-go cancelled (letSpecGo) holds its ticket still, and its own reading carries no
// decision, so the letting-go of its spec run is what gives it back.
func (f *Factory) ticketsOfSpecsLetGo(held map[string]holding, letGo map[string]string) map[string]string {
	for key, h := range held {
		if !h.holds || !h.idle || h.run.Spec == 0 || h.last.Outcome != outcomeCancelled {
			continue
		}
		if _, decided := letGo[key]; decided {
			continue
		}
		s, ok := f.specRunOf(h.run.Repository, h.run.Spec)
		if !ok {
			continue
		}
		if spec, _ := f.specs.get(s.ID); spec.State != specLetGo {
			continue
		}
		if letGo == nil {
			letGo = map[string]string{}
		}
		letGo[key] = "the spec run of #" + strconv.Itoa(h.run.Spec) + " was let go"
	}
	return letGo
}

// waiting is what a spec run waits for: the tickets of a person that can be worked, and the open
// issues outside the spec that block its tickets.
type waiting struct {
	people  []int
	outside []outsideBlocker
}

// waitsOn is what a spec run waits for when every open sub-issue of its spec is a person's or blocked.
// Otherwise there is a ticket the factory may still take, or one it works, and the spec run waits for
// nothing. A person's ticket is waited for while it has no open blocker; one blocked by a sibling is
// behind that sibling, and what holds the sibling is named instead. A sub-issue from another repository
// is no ticket of the spec's repository and is left out.
func waitsOn(repository string, subs []subIssue) waiting {
	people := []int{}
	for _, t := range subs {
		switch {
		case !t.Open || t.Elsewhere != "":
		case t.Human && !t.Blocked:
			people = append(people, t.Number)
		case !t.Human && !t.Blocked:
			return waiting{}
		}
	}
	outside, _ := outsideBlockers(repository, subs)
	return waiting{people: people, outside: outside}
}

// outsideBlockers is the open issues that block an open ticket of the spec and are no sub-issue of it,
// by repository and number, each with the tickets it holds. It answers too whether the blockers of
// every blocked ticket were read, so the list is all there is.
func outsideBlockers(repository string, subs []subIssue) ([]outsideBlocker, bool) {
	sibling := map[string]bool{}
	for _, t := range subs {
		in := t.Elsewhere
		if in == "" {
			in = repository
		}
		sibling[Issue{Repository: in, Number: t.Number}.key()] = true
	}
	complete := true
	out := []outsideBlocker{}
	for _, t := range subs {
		if !t.Open || t.Elsewhere != "" || !t.Blocked {
			continue
		}
		complete = complete && t.BlockersRead
		for _, b := range t.Blockers {
			if sibling[b.key()] {
				continue
			}
			i := slices.IndexFunc(out, func(o outsideBlocker) bool { return o.key() == b.key() })
			if i < 0 {
				out = append(out, outsideBlocker{blocker: b})
				i = len(out) - 1
			}
			if !slices.Contains(out[i].Tickets, t.Number) {
				out[i].Tickets = append(out[i].Tickets, t.Number)
			}
		}
	}
	slices.SortFunc(out, func(a, b outsideBlocker) int {
		if x, y := repositoryKey(a.Repository), repositoryKey(b.Repository); x != y {
			return strings.Compare(x, y)
		}
		return a.Number - b.Number
	})
	for _, o := range out {
		slices.Sort(o.Tickets)
	}
	return out, complete
}

// waitForPeople says on each held spec what its spec run waits for, once per time it waits for it: a
// comment on the spec that mentions the configured logins, for each ticket of a person that can be
// worked and for each open issue outside the spec that blocks its tickets. A ticket of a person that
// has an open blocker again is no longer recorded as named, and neither is a blocker outside the spec
// that a complete reading no longer finds, so each is named again once it is waited for again. A
// comment GitHub refused is a warning, and a later poll makes it again. A paused factory says nothing.
func (f *Factory) waitForPeople(ctx context.Context) {
	if f.Paused() || ctx.Err() != nil {
		return
	}
	f.mu.Lock()
	read := f.subIssues
	f.mu.Unlock()
	for _, held := range f.specs.list() {
		connected, ok := f.connected(held.Repository)
		subs, known := read[held.key()]
		if !ok || !known || held.State != specHolding {
			continue
		}
		s, ok := f.specs.find(held.ID)
		if !ok {
			continue
		}
		f.forgetNamed(s, held, subs)
		held, _ = f.specs.get(held.ID)
		wait := waitsOn(held.Repository, subs)
		for _, ticket := range wait.people {
			if slices.Contains(held.WaitingOn, ticket) || ctx.Err() != nil {
				continue
			}
			if f.waitOn(ctx, connected, s, ticket) {
				f.specs.update(s, func() { s.WaitingOn = append(slices.Clone(s.WaitingOn), ticket) })
			}
		}
		for _, b := range wait.outside {
			if slices.Contains(held.WaitingOnBlockers, b.key()) || ctx.Err() != nil {
				continue
			}
			if f.waitOnBlocker(ctx, connected, s, b) {
				f.specs.update(s, func() { s.WaitingOnBlockers = append(slices.Clone(s.WaitingOnBlockers), b.key()) })
			}
		}
	}
}

// forgetNamed takes off the record of a spec run what it named and no longer waits for as it was: a
// ticket of a person that has an open blocker, and a blocker outside the spec that a reading of every
// blocker no longer finds. A ticket recorded while it was blocked, as a factory before this rule did,
// is named once it can be worked.
func (f *Factory) forgetNamed(s *SpecRun, held SpecRun, subs []subIssue) {
	tickets := slices.DeleteFunc(slices.Clone(held.WaitingOn), func(n int) bool {
		return slices.ContainsFunc(subs, func(t subIssue) bool { return t.Elsewhere == "" && t.Number == n && t.Open && t.Blocked })
	})
	blockers := slices.Clone(held.WaitingOnBlockers)
	if outside, complete := outsideBlockers(held.Repository, subs); complete {
		blockers = slices.DeleteFunc(blockers, func(key string) bool {
			return !slices.ContainsFunc(outside, func(o outsideBlocker) bool { return o.key() == key })
		})
	}
	if len(tickets) == len(held.WaitingOn) && len(blockers) == len(held.WaitingOnBlockers) {
		return
	}
	f.specs.update(s, func() {
		s.WaitingOn = slices.DeleteFunc(slices.Clone(s.WaitingOn), func(n int) bool { return !slices.Contains(tickets, n) })
		s.WaitingOnBlockers = slices.DeleteFunc(slices.Clone(s.WaitingOnBlockers), func(k string) bool { return !slices.Contains(blockers, k) })
	})
}

// waitOn says on the spec that its spec run waits for a ticket of a person, and records it on the spec
// run. A factory with no logins to notify records it and comments nothing.
func (f *Factory) waitOn(ctx context.Context, connected Connected, s *SpecRun, ticket int) bool {
	held, _ := f.specs.get(s.ID)
	body := fmt.Sprintf("The spec run of this spec waits for #%d, a ticket for a person (`%s`): the factory takes no ticket behind it and opens no spec pull request while it is open. "+
		"Merge its pull request into the spec branch `%s` and close it, and the spec run goes on at the next poll.\n", ticket, humanLabel, held.Branch)
	if !f.sayWait(ctx, connected, s, fmt.Sprintf("#%d", ticket), body) {
		return false
	}
	log.Printf("spec run %d (%s#%d) waits for #%d, a ticket for a person", s.ID, s.Repository, s.Spec, ticket)
	return true
}

// waitOnBlocker says on the spec that its spec run waits for an open issue outside the spec that
// blocks its tickets, and records it on the spec run. A factory with no logins to notify records it
// and comments nothing.
func (f *Factory) waitOnBlocker(ctx context.Context, connected Connected, s *SpecRun, b outsideBlocker) bool {
	name := b.name(s.Repository)
	tickets := []string{}
	for _, n := range b.Tickets {
		tickets = append(tickets, "#"+strconv.Itoa(n))
	}
	held := "ticket " + tickets[0]
	if len(tickets) > 1 {
		held = "tickets " + strings.Join(tickets[:len(tickets)-1], ", ") + " and " + tickets[len(tickets)-1]
	}
	body := fmt.Sprintf("The spec run of this spec waits for %s, an open issue outside the spec that blocks its %s: the factory takes no ticket it blocks while it is open. "+
		"Once %s is closed, the spec run goes on at the next poll.\n", name, held, name)
	if !f.sayWait(ctx, connected, s, name, body) {
		return false
	}
	log.Printf("spec run %d (%s#%d) waits for %s, an issue outside the spec", s.ID, s.Repository, s.Spec, name)
	return true
}

// sayWait comments a wait on the spec when the factory has logins to notify, and logs it on the spec
// run. A comment GitHub refused is a warning, and it answers false.
func (f *Factory) sayWait(ctx context.Context, connected Connected, s *SpecRun, name, body string) bool {
	if f.notifying() {
		if err := f.source.commentOnIssue(ctx, connected.Name, s.Spec, mentions(f.settings.Notify)+"\n\n"+body); err != nil {
			if ctx.Err() == nil {
				f.specs.warn(s, "the wait was not said", fmt.Sprintf("the comment on spec #%d that the spec run waits for %s could not be made: %v; a later poll tries again", s.Spec, name, err))
			}
			return false
		}
	}
	f.specs.event(s, Event{Kind: "factory", Title: "waiting for " + name, Body: body})
	return true
}
