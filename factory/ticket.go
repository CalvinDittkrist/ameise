package main

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// A ticket run is a factory run of one ticket of a spec run, a first run as any other
// (docs/glossary.md). Its branch is cut from the spec branch and not from the base, its gate merges
// the spec branch, and its pull request targets it. On every poll the factory reads the sub-issues of the specs it holds, and the
// tickets a run may take come before the routed issues in the line, the lowest number first. The
// base is merged into the spec branch before a ticket is claimed, when that merge is clean.

// SpecTicket is one ticket of a spec run as its record lists it: the runs of the ticket, and when the
// merge stage or a person merged its pull request into the spec branch, and whether the factory closed
// the ticket after that.
type SpecTicket struct {
	Issue       int        `json:"issue"`
	Title       string     `json:"title"`
	Runs        []int      `json:"runs"`
	PullRequest string     `json:"pullRequest,omitempty"`
	MergedAt    *time.Time `json:"mergedAt,omitempty"`
	Closed      bool       `json:"closed,omitempty"`
}

// ticketReady is the rule a ticket of a held spec is taken by: open, no pull request, carrying the
// spec-run label and ready-for-agent, nobody assigned and no open blocker. It is the frontier rule with
// the spec-run label in place of the routing label.
func ticketReady(issue ghIssue, routingLabel string) bool {
	return issue.PullRequest == nil &&
		issue.State == "open" &&
		issue.hasLabel(readyLabel) &&
		issue.hasLabel(specRunLabel(routingLabel)) &&
		len(issue.Assignees) == 0 &&
		issue.Dependencies.BlockedBy == 0
}

// inRepository says whether the issue is in the repository. GitHub lets a sub-issue come from another
// repository, and a ticket is read by its number in the spec's own, so one from elsewhere is no ticket
// (https://docs.github.com/en/rest/issues/sub-issues, checked 2026-09-27).
func (issue ghIssue) inRepository(repository string) bool {
	return strings.HasSuffix(repositoryKey(issue.RepositoryURL), "/repos/"+repositoryKey(repository))
}

// subIssuesRequest is the list of the sub-issues of one issue, one page of it as the issue list is.
func subIssuesRequest(repository string, number int) string {
	return "repos/" + repository + "/issues/" + strconv.Itoa(number) + "/sub_issues?per_page=100"
}

// specTickets reads the sub-issues of a held spec and keeps the tickets a ticket run may take. When
// the spec-run label was last set on a ticket is read from its event list, as the routing of an issue
// is, together with its assignments, which carry the release of a ticket this factory holds.
func (g *gitHub) specTickets(ctx context.Context, held Held) ([]Issue, error) {
	raw, err := gh(ctx, "api", subIssuesRequest(held.Repository, held.Number))
	if err != nil {
		return nil, err
	}
	var issues []ghIssue
	if err := json.Unmarshal(raw, &issues); err != nil {
		return nil, fmt.Errorf("the sub-issue list is not a list of issues: %w", err)
	}
	out := []Issue{}
	for _, issue := range issues {
		if !issue.inRepository(held.Repository) || !ticketReady(issue, g.label) {
			continue
		}
		key := Issue{Repository: held.Repository, Number: issue.Number}.key()
		read := g.signalsOf(ctx, held.Repository, issue, key, specRunLabel(g.label))
		out = append(out, Issue{Repository: held.Repository, Number: issue.Number, Title: issue.Title,
			Labels: issue.labelNames(), RoutedAt: read.routedAt, assignedAt: read.assignedAt,
			unassignedAt: read.unassignedAt, spec: held.Number})
	}
	return out, nil
}

// specOf is the spec an entry's run is a ticket run of: the spec of the ticket the line carries, or
// the one the run it continues recorded, and zero for a routed issue.
func (e Entry) specOf() int {
	if e.spec != 0 {
		return e.spec
	}
	return e.resume.Spec
}

// sortTickets puts the tickets in the order they are taken: by repository and spec, and within a spec
// the lowest number first.
func sortTickets(tickets []Issue) {
	sort.SliceStable(tickets, func(a, b int) bool {
		x, y := tickets[a], tickets[b]
		if rx, ry := repositoryKey(x.Repository), repositoryKey(y.Repository); rx != ry {
			return rx < ry
		}
		if x.spec != y.spec {
			return x.spec < y.spec
		}
		return x.Number < y.Number
	})
}

// openTickets is the tickets whose spec run still holds its spec: a spec let go after the poll read
// its tickets has none left to work.
func (f *Factory) openTickets(tickets []Issue) []Issue {
	out := []Issue{}
	for _, ticket := range tickets {
		if s, ok := f.specRunOf(ticket.Repository, ticket.spec); ok && s.State == specHolding {
			out = append(out, ticket)
		}
	}
	return out
}

// specRunOf is the latest spec run of a spec, as the store holds it.
func (f *Factory) specRunOf(repository string, spec int) (*SpecRun, bool) {
	latest, ok := f.specs.latest()[Issue{Repository: repository, Number: spec}.key()]
	if !ok {
		return nil, false
	}
	return f.specs.find(latest.ID)
}

// ticketBase is the base of a ticket's claim: the spec branch of the spec run that holds its spec,
// after the base the repository names is merged into it (mergeIntoSpec). base is that repository base,
// which the claim has just fetched.
func (f *Factory) ticketBase(ctx context.Context, r *Run, clone, base string, ticket Issue) (string, error) {
	s, ok := f.specRunOf(ticket.Repository, ticket.spec)
	if !ok || s.State != specHolding || s.Branch == "" {
		return "", fmt.Errorf("ticket #%d is a sub-issue of spec #%d, which no spec run of this factory holds any more", ticket.Number, ticket.spec)
	}
	f.mergeIntoSpec(ctx, clone, base, s)
	f.runs.event(r, Event{Kind: "factory", Title: "a ticket of spec #" + strconv.Itoa(ticket.spec),
		Body: fmt.Sprintf("spec run %d holds spec #%d, so the branch is cut from the spec branch %s and its pull request goes against it", s.ID, ticket.spec, s.Branch)})
	return s.Branch, nil
}

// mergeIntoSpec merges the base into the spec branch before a ticket is claimed, when the base has
// commits the spec branch lacks and the merge is clean, and pushes the merge. It is made in the clone
// without a worktree: git merge-tree writes the merged tree, and the merge commit is pushed as a fast
// forward of the spec branch. A merge that conflicts, or that cannot be made or pushed, leaves the spec
// branch as it was and is noted on the spec run; the ticket is claimed from the spec branch all the same.
func (f *Factory) mergeIntoSpec(ctx context.Context, clone, base string, s *SpecRun) {
	spec, from := "refs/remotes/origin/"+s.Branch, "refs/remotes/origin/"+base
	if _, err := git(ctx, clone, "merge-base", "--is-ancestor", from, spec); err == nil {
		return // the spec branch has everything of the base
	}
	leave := func(why string) {
		f.specs.warn(s, "base not merged", fmt.Sprintf("the base %s was not merged into the spec branch %s: %s; the spec branch is left as it was and its tickets are cut from it", base, s.Branch, why))
	}
	tree, err := git(ctx, clone, "merge-tree", "--write-tree", "--no-messages", spec, from)
	if err != nil {
		leave("the merge conflicts or could not be made (" + err.Error() + ")")
		return
	}
	tree, _, _ = strings.Cut(tree, "\n")
	commit, err := git(ctx, clone, "commit-tree", tree, "-p", spec, "-p", from, "-m", "Merge "+base+" into "+s.Branch)
	if err != nil {
		leave("the merge commit could not be made: " + err.Error())
		return
	}
	if _, err := gitWithin(ctx, clone, fetchTimeout, "push", "--quiet", "origin", commit+":refs/heads/"+s.Branch); err != nil {
		leave("the merge could not be pushed: " + err.Error())
		return
	}
	// The claim cuts the ticket's branch from what the clone knows of the spec branch.
	if _, err := git(ctx, clone, "update-ref", spec, commit); err != nil {
		leave("the clone could not be moved to the pushed merge: " + err.Error())
		return
	}
	f.specs.event(s, Event{Kind: "factory", Title: "merged " + base + " into " + s.Branch,
		Body: "the merge commit " + short(commit) + " is pushed, and the next ticket is cut from it"})
}

// ticketStarted lists a ticket run on the record of its spec run, which is working from then on.
func (f *Factory) ticketStarted(r Run) {
	s, ok := f.specRunOf(r.Repository, r.Spec)
	if r.Spec == 0 || !ok {
		return
	}
	f.specs.update(s, func() {
		s.Idle = false
		i := s.ticket(r.Issue, r.Title)
		s.Tickets[i].Runs = append(slices.Clone(s.Tickets[i].Runs), r.ID)
	})
	f.specs.event(s, Event{Kind: "factory", Title: fmt.Sprintf("ticket #%d: run %d", r.Issue, r.ID),
		Body: fmt.Sprintf("a %s run of ticket #%d started", r.Kind, r.Issue)})
}

// ticketEnded says on the spec run that its ticket run ended, and the spec run is idle again.
func (f *Factory) ticketEnded(r Run) {
	s, ok := f.specRunOf(r.Repository, r.Spec)
	if r.Spec == 0 || !ok {
		return
	}
	ended, _ := f.runs.get(r.ID)
	f.specs.update(s, func() { s.Idle = true })
	f.specs.event(s, Event{Kind: "factory", Title: fmt.Sprintf("ticket #%d: run %d %s", r.Issue, r.ID, ended.Outcome), Body: ended.Reason})
}

// ticket is the index of a ticket in the spec run's list, which it is added to when it is not in it
// yet. The list is a copy from here on, since the copies the store hands out share the one before.
// Callers hold the lock of the store.
func (s *SpecRun) ticket(issue int, title string) int {
	s.Tickets = slices.Clone(s.Tickets)
	for i, t := range s.Tickets {
		if t.Issue == issue {
			return i
		}
	}
	s.Tickets = append(s.Tickets, SpecTicket{Issue: issue, Title: title, Runs: []int{}})
	return len(s.Tickets) - 1
}
