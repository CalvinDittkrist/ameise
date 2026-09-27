package main

import (
	"fmt"
	"slices"
	"testing"
	"time"
)

// A factory in fake mode that connects a third repository works the canned spec there before the
// canned queue: the spec is claimed on its spec branch, its three tickets run one after the other in
// the order their chain allows, the validation of the second fails once and passes after its fix,
// every ticket is merged into the spec branch and closed, and the spec pull request ends its run
// ready. All of it is read from the HTTP interface.
func TestFakeModeWorksTheCannedSpecRunFromItsClaimToItsSpecPullRequest(t *testing.T) {
	t.Parallel()
	f := start(t, config{"poll": "100ms", "repositories": []string{"acme/edge-sensors", "acme/backtest", "acme/firmware"}})
	branch := "spec/130-remote-firmware-updates"
	tickets := []int{131, 132, 133}

	// While the first ticket runs, the two behind it are blocked by it, so the line carries neither.
	f.eventually(t, 60*time.Second, "the first ticket run to be going", func() bool {
		var line apiLine
		f.get(t, "/api/line", &line)
		if len(line.Now) == 0 || line.Now[0].Issue != tickets[0] {
			return false
		}
		for _, entry := range line.Queue {
			if slices.Contains(tickets[1:], entry.Number) {
				t.Errorf("the line carries ticket #%d while #%d, which blocks it, is being worked", entry.Number, tickets[0])
			}
		}
		return true
	})

	for i, ticket := range tickets {
		run := f.ended(t, i+1)
		if run.Issue != ticket || run.Spec != cannedSpec.number || run.Repository != "acme/firmware" || run.Base != branch {
			t.Fatalf("run %d worked #%d of spec #%d in %s against %q, want ticket #%d of spec #%d in acme/firmware against %s; the factory's log:\n%s",
				run.ID, run.Issue, run.Spec, run.Repository, run.Base, ticket, cannedSpec.number, branch, f.output(t))
		}
		if run.Outcome != outcomeMerged {
			t.Errorf("run %d of #%d ended %q (%s), want merged", run.ID, ticket, run.Outcome, run.Reason)
		}
		// A merged ticket ended well, and its log says so as the factory's word, never as an error.
		for _, e := range run.Events {
			if e.Title == outcomeMerged && e.Kind != "factory" {
				t.Errorf("run %d logs its merge as a %q event, want a factory event", run.ID, e.Kind)
			}
		}
		stages := []string{"implement", "gate", "review", "pr", "ci", "validate", "merge"}
		rounds := 1
		if ticket == 132 {
			stages = []string{"implement", "gate", "review", "pr", "ci", "validate", "ci", "validate", "merge"}
			rounds = 2
		}
		if !equal(run.Stages, stages) {
			t.Errorf("run %d of #%d went through the stages %v, want %v", run.ID, ticket, run.Stages, stages)
		}
		v := run.Validation
		if v == nil || !v.Passed || len(v.Rounds) != rounds {
			t.Fatalf("run %d of #%d recorded the validation %+v, want %d rounds that end passed", run.ID, ticket, v, rounds)
		}
		if first := v.Rounds[0]; ticket == 132 && (first.Verdicts[0].Reviewer != "codex" || first.Verdicts[0].Verdict != verdictFix || first.Repair == nil) {
			t.Errorf("the first validation round of #132 is %+v, want codex asking for a fix and a fix session answering it", first)
		}
	}

	pull := f.ended(t, len(tickets)+1)
	specPull := fmt.Sprintf("https://github.com/acme/firmware/pull/%d", cannedPull(cannedSpec.number))
	if pull.Issue != cannedSpec.number || pull.Spec != cannedSpec.number || pull.Outcome != outcomeReady || pull.PullRequest != specPull {
		t.Errorf("run %d worked #%d of spec #%d, ended %q with %q, want the spec pull request %s of #%d ready",
			pull.ID, pull.Issue, pull.Spec, pull.Outcome, pull.PullRequest, specPull, cannedSpec.number)
	}

	specs := f.specRuns(t)
	if len(specs) != 1 {
		t.Fatalf("the factory has the spec runs %+v, want the one of the canned spec", specs)
	}
	spec := f.specRunNow(t)
	if spec.Spec != cannedSpec.number || spec.Repository != "acme/firmware" || spec.State != specHolding || spec.Branch != branch || spec.PullRequest != specPull {
		t.Errorf("the spec run is #%d of %s, %s on %q with %q, want #%d of acme/firmware holding %s with %s",
			spec.Spec, spec.Repository, spec.State, spec.Branch, spec.PullRequest, cannedSpec.number, branch, specPull)
	}
	if len(spec.Tickets) != len(tickets) {
		t.Fatalf("the spec run lists the tickets %+v, want %v", spec.Tickets, tickets)
	}
	for i, ticket := range spec.Tickets {
		if ticket.Issue != tickets[i] || !equal(ticket.Runs, []int{i + 1}) || ticket.MergedAt == nil || !ticket.Closed {
			t.Errorf("the spec run lists %+v in place %d, want #%d merged and closed by run %d", ticket, i+1, tickets[i], i+1)
		}
	}
	if said := titles(spec.Events); !slices.Contains(said, "claimed "+branch) || !slices.Contains(said, "opened the spec pull request") {
		t.Errorf("the spec run's events are %v, want its claim and its spec pull request", said)
	}
}
