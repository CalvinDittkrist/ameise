package main

import (
	"fmt"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// A session whose Bash calls the auto mode classifier gives no verdict on cannot tell that outage from
// a reason to stop, and reports blocked. The factory can: the run saw the permission check fail, so it
// waits and resumes the issue once in its worktree by itself, on the budget an interruption spends,
// and nobody is told of the first ending. A second outage spends nothing more and waits for a person,
// as does a resumed run that ends blocked for a reason of its own.
func TestARunBlockedOnAnOutageOfThePermissionCheckIsResumedOnceByItself(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name    string
		outages int  // how many of the sessions meet the outage
		again   bool // the resumed run meets it too
	}{
		{"the resumed run blocks for a reason of its own", 1, false},
		{"the resumed run meets the outage again", 2, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			const wait = 3 * time.Second
			gh := newGhShim(t)
			gh.routed(t, "acme/edge-sensors", claimedIssue, claimedTitle)
			gh.loggedInAs(t, "factory-bot")
			gh.assigns(t, "acme/edge-sensors", claimedIssue, "factory-bot")
			gh.comments(t, "acme/edge-sensors", claimedIssue)
			gh.workerMeetsOutage(t, c.outages)
			gh.workerReportsBlocked(t, "Bash failed on every call: the auto-mode safety check returned no verdict")

			data := filepath.Join(t.TempDir(), "data")
			gh.cloneInto(t, data, "acme/edge-sensors")
			f := gh.work(t, config{"poll": "50ms", "deadline": "90s", "outage_wait": wait.String(), "data_dir": data,
				"repositories": []string{"acme/edge-sensors"}, "notify": maintainers})

			first := f.ended(t, 1)
			if first.Outcome != outcomeBlocked || !first.Outage || !first.Holding {
				t.Fatalf("run 1 ended as %q with outage=%v holding=%v, want blocked on an outage and holding the issue; the factory's log:\n%s",
					first.Outcome, first.Outage, first.Holding, f.output(t))
			}
			if first.Notified != "" {
				t.Errorf("run 1 owes the notification %q, want none: the factory resumes it by itself", first.Notified)
			}
			if !loggedEvent(first, "factory", "outage of the permission check") {
				t.Errorf("run 1 does not say the factory resumes it after the outage; its events: %+v", first.Events)
			}

			second := f.ended(t, 2)
			if second.Signal != signalOutage || second.Kind != kindResumed || second.Issue != claimedIssue {
				t.Fatalf("run 2 works #%d on the signal %q (%s), want #%d resumed after the outage; the factory's log:\n%s",
					second.Issue, second.Signal, second.Kind, claimedIssue, f.output(t))
			}
			if second.StartedAt.Before(first.EndedAt.Add(wait)) {
				t.Errorf("run 2 started at %s, before the wait of %s after run 1 ended at %s", second.StartedAt, wait, first.EndedAt)
			}
			if second.Worktree != first.Worktree || second.Branch != first.Branch || !second.Holding {
				t.Errorf("run 2 is %s in %s (holding=%v), want the claim's %s in %s", second.Branch, second.Worktree, second.Holding, first.Branch, first.Worktree)
			}
			if second.Outcome != outcomeBlocked || second.Outage != c.again {
				t.Errorf("run 2 ended as %q with outage=%v, want blocked with outage=%v", second.Outcome, second.Outage, c.again)
			}
			if c.again && !loggedEvent(second, "error", "outage of the permission check") {
				t.Errorf("run 2 does not say its outage waits for a person; its events: %+v", second.Events)
			}

			// That was the one resume: the second ending waits for a person, who hears of it.
			f.eventually(t, 10*time.Second, "the notification of run 2", func() bool {
				return gh.made(t, commentCall("acme/edge-sensors", claimedIssue)) == 1
			})
			f.never(t, wait+time.Second, fmt.Sprintf("the factory resumed #%d a second time by itself", claimedIssue),
				func() bool { return !f.missing(t, 3) })
		})
	}
}

// loggedEvent says that a run logged an event of that kind under that title.
func loggedEvent(run apiRun, kind, title string) bool {
	return slices.ContainsFunc(run.Events, func(e apiEvent) bool { return e.Kind == kind && e.Title == title })
}

// workerMeetsOutage makes the first sessions of the scripted worker meet an outage of the permission
// check before they report: a Bash call the auto mode classifier gives no verdict on.
func (g *ghShim) workerMeetsOutage(t *testing.T, sessions int) {
	t.Helper()
	g.env = append(g.env, fmt.Sprintf("CLAUDE_SHIM_OUTAGE=%d", sessions))
}
