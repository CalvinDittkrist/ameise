package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"time"
)

// The merge stage ends a ticket run of a spec run. It runs when the ci stage is green, the panel
// summary is ready and the validation passed. The factory squash-merges the ticket's pull request into
// the spec branch under the pull request's title and records the ticket as merged on the spec run.
// GitHub closes no issue on a merge into a branch other than the default one
// (https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue,
// checked 2026-09-27), so the factory closes the ticket with a comment that names the pull request. A
// ticket whose panel did not pass is not merged. Its run ends ready with a review request, and a person
// merges the pull request into the spec branch or changes it.

// stageMerge is the stage a ticket run is in while the factory merges its pull request.
const stageMerge = "merge"

// mergedDecision is the decision a poll reads when the pull request of a held issue was merged.
func mergedDecision(pull string) string { return "the pull request " + pull + " was merged" }

// passed ends a run whose validation passed at the commit head. A run of a routed issue ends ready; a
// ticket run whose panel summary is ready goes on to the merge stage.
func (f *Factory) passed(parent, ctx context.Context, r *Run, entry Entry, pull, head string) {
	if r.Spec == 0 {
		f.finish(r, outcomeReady, "", nil)
		return
	}
	if why := notPassed(f.panelOf(*r, pull)); why != "" {
		f.runs.event(r, Event{Kind: "factory", Title: "not merged into " + r.Base,
			Body: "the reviewer panel did not pass: " + why + " The pull request waits for a person, who merges it into the spec branch or changes it."})
		f.finish(r, outcomeReady, "", nil)
		return
	}
	f.merge(parent, ctx, r, entry, pull, head)
}

// panelOf is the panel summary the review stage recorded for the pull request: this run's, or that of
// the latest run of the issue on it, which a resumed or a follow-up run goes on from.
func (f *Factory) panelOf(r Run, pull string) string {
	summary, last := "", 0
	for _, run := range f.runs.list() {
		if run.key() == r.key() && run.Review != nil && run.ID >= last && (run.ID == r.ID || pullOf(run.PullRequest) == pullOf(pull)) {
			summary, last = run.Review.PanelSummary, run.ID
		}
	}
	return summary
}

// merge is the merge stage of a ticket run. A pull request that is merged already, which a run the
// factory stopped in after the merge leaves, is not merged again.
func (f *Factory) merge(parent, ctx context.Context, r *Run, entry Entry, pull, head string) {
	f.runs.update(r, func() { r.stage(stageMerge) })
	number, _ := pullNumber(pull)
	if err := f.source.mergePull(ctx, entry.Repository, number, head); err != nil {
		if !f.halted(parent, ctx, r, "merged the pull request") {
			f.runs.update(r, func() {
				r.Reason = fmt.Sprintf("the pull request %s passed and could not be merged into the spec branch %s: %v; merge it by hand, or take the assignee off the ticket to have the factory try again", pull, r.Base, err)
			})
			f.finish(r, outcomeBlocked, "", nil)
		}
		return
	}
	f.runs.event(r, Event{Kind: "factory", Title: "merged " + pull + " into " + r.Base,
		Body: "ci is green, the panel summary is ready and the validation passed, so the pull request is squash-merged under its title"})
	f.ticketMerged(ctx, r.Repository, r.Spec, entry.Number, pull, true)
	f.finish(r, outcomeMerged, "the pull request "+pull+" is squash-merged into the spec branch "+r.Base+" and the ticket is closed", nil)
}

// ticketMerged records a ticket whose pull request is merged into the spec branch on its spec run, and
// closes the ticket with a comment that names the pull request when close says it is open. It is made
// by the merge stage, and by the poll that reads a ticket's pull request merged: a person merged it,
// or the factory stopped between its merge and this.
func (f *Factory) ticketMerged(ctx context.Context, repository string, spec, ticket int, pull string, close bool) {
	s, ok := f.specRunOf(repository, spec)
	if !ok {
		return
	}
	marked, closed := false, false
	f.specs.update(s, func() {
		i := s.ticket(ticket, "")
		if s.Tickets[i].MergedAt == nil {
			now := time.Now()
			s.Tickets[i].MergedAt, s.Tickets[i].PullRequest, marked = &now, pull, true
		}
		closed = s.Tickets[i].Closed
	})
	if marked {
		f.specs.event(s, Event{Kind: "factory", Title: fmt.Sprintf("ticket #%d merged", ticket),
			Body: "its pull request " + pull + " is merged into the spec branch " + s.Branch})
	}
	if !close || closed {
		return // closed once already, by the merge stage or by the poll that read the merge
	}
	comment := "The pull request " + pull + " is merged into the spec branch " + s.Branch + " of the spec run of #" + strconv.Itoa(spec) +
		". GitHub closes no issue on a merge into a branch other than the default one, so the factory closes this ticket.\n"
	err := f.source.commentOnIssue(ctx, repository, ticket, comment)
	if err == nil {
		err = f.source.closeIssue(ctx, repository, ticket)
	}
	if err != nil {
		if ctx.Err() == nil {
			f.specs.warn(s, "ticket not closed", fmt.Sprintf("ticket #%d of %s is merged by %s and could not be closed: %v; close it by hand", ticket, repository, pull, err))
		}
		return // the record says open, as the ticket is
	}
	f.specs.update(s, func() { s.Tickets[s.ticket(ticket, "")].Closed = true })
	log.Printf("spec run %d (%s#%d): ticket #%d is merged by %s and closed", s.ID, repository, spec, ticket, pull)
}

// mergeRequest is the body of the call that squash-merges a pull request.
type mergeRequest struct {
	Method string `json:"merge_method"`
	Title  string `json:"commit_title"`
	SHA    string `json:"sha,omitempty"`
}

// mergePull reads the pull request and squash-merges it under its title, at the commit given when
// there is one, so a push after the validation is not merged unread. One that is merged already is
// left as it is.
func (g *gitHub) mergePull(ctx context.Context, repository string, pull int, head string) error {
	raw, err := gh(ctx, "api", pullRequestRequest(repository, pull))
	if err != nil {
		return fmt.Errorf("the pull request could not be read: %w", err)
	}
	var read ghPull
	if err := json.Unmarshal(raw, &read); err != nil {
		return fmt.Errorf("the answer is no pull request: %w", err)
	}
	switch {
	case read.Merged:
		return nil
	case read.State == "closed":
		return fmt.Errorf("the pull request is closed")
	}
	body, err := json.Marshal(mergeRequest{Method: "squash", Title: read.Title, SHA: head})
	if err != nil {
		return err
	}
	_, err = ghInput(ctx, ghTimeout, string(body)+"\n", "api", "--method", "PUT", pullRequestRequest(repository, pull)+"/merge", "--input", "-")
	return err
}

// closeIssue closes an issue as completed.
func (g *gitHub) closeIssue(ctx context.Context, repository string, issue int) error {
	_, err := gh(ctx, "issue", "close", strconv.Itoa(issue), "--repo", repository)
	return err
}
