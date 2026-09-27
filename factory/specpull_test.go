package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// The end of a spec run, tested the way the rest of the factory is: the real binary against the gh
// and claude shims and a bare remote, with a spec held on its spec branch whose sub-issues the test
// answers and closes.

// specPullURL is the spec pull request, which the shim numbers after the spec of its branch.
var specPullURL = fmt.Sprintf("https://github.com/acme/edge-sensors/pull/%d", specNumber)

// specPullIs is the reading of the spec pull request a held run makes: open, or merged, from the spec
// branch into main.
func (g *ghShim) specPullIs(t *testing.T, merged bool) {
	t.Helper()
	g.specPullInto(t, "main", merged)
}

// specPullInto is the reading of the spec pull request into a base, open or merged.
func (g *ghShim) specPullInto(t *testing.T, base string, merged bool) {
	t.Helper()
	state := "open"
	if merged {
		state = "closed"
	}
	g.answer(t, fmt.Sprintf("api repos/acme/edge-sensors/pulls/%d", specNumber), marshal(t, map[string]any{
		"number": specNumber, "state": state, "merged": merged, "title": specPullTitle(specTitle),
		"head": map[string]any{"ref": specBranch, "repo": map[string]any{"full_name": "acme/edge-sensors"}},
		"base": map[string]any{"ref": base, "repo": map[string]any{"full_name": "acme/edge-sensors"}}}))
}

// heldSpec is the reading of the held spec after a gesture of the maintainer changed it.
func (g *ghShim) heldSpec(t *testing.T, change func(issueJSON) issueJSON) {
	t.Helper()
	g.issue(t, "acme/edge-sensors", change(assignedTo(
		openIssue(specNumber, specTitle, time.Now().UTC().Add(-72*time.Hour), specLabel, specRunLabel("factory")), "factory-bot")))
}

// runNow is a run as /api/runs/{id} serves it now.
func (f *factory) runNow(t *testing.T, id int) apiRun {
	t.Helper()
	var run apiRun
	f.get(t, fmt.Sprintf("/api/runs/%d", id), &run)
	return run
}

// A held spec whose tickets are all closed gets its spec pull request: the base is merged into the
// spec branch once more, the pull request goes from the spec branch into main, lists the tickets with
// their pull requests and is part of the spec, and it goes through the ci stage alone and ends ready
// with a review request. The merge a person makes ends the spec run done and takes the assignee off.
func TestASpecWhoseTicketsAreClosedGetsASpecPullRequestAndEndsWhenItIsMerged(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.specPullIs(t, false)
	gh.reviewRequests(t, specPullURL, maintainers...)
	gh.unassigns(t, "acme/edge-sensors", specNumber, "factory-bot")
	c := ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}})
	c["notify"] = maintainers
	f := gh.work(t, c)
	if ticket := f.ended(t, 1); ticket.Issue != ticketIssue || ticket.Outcome != outcomeMerged {
		t.Fatalf("run 1 worked #%d and ended %q (%s), want ticket #%d merged; the factory's log:\n%s", ticket.Issue, ticket.Outcome, ticket.Reason, ticketIssue, f.output(t))
	}
	sessions := len(gh.workers(t)) + len(gh.reviewerSessions(t))
	moved := gh.commitOn(t, "acme/edge-sensors", "main")
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)))

	run := f.ended(t, 2)
	if run.Issue != specNumber || run.Signal != signalSpecPull || run.Outcome != outcomeReady || run.PullRequest != specPullURL {
		t.Fatalf("run 2 worked #%d on %q and ended %q with %q (%s), want the spec pull request of #%d ready; the factory's log:\n%s",
			run.Issue, run.Signal, run.Outcome, run.PullRequest, run.Reason, specNumber, f.output(t))
	}
	if run.Branch != specBranch || run.Base != "main" || !equal(run.Stages, []string{"pr", "ci"}) {
		t.Errorf("run 2 went from %s into %s through %v, want %s into main through pr and ci alone", run.Branch, run.Base, run.Stages, specBranch)
	}
	if now := len(gh.workers(t)) + len(gh.reviewerSessions(t)); now != sessions {
		t.Errorf("the spec pull request started %d sessions, want none on a green pull request", now-sessions)
	}
	opened := gh.opened(t, "acme/edge-sensors")
	pull := opened[len(opened)-1]
	if pull.Head != specBranch || pull.Base != "main" {
		t.Errorf("the spec pull request goes from %s into %s, want %s into main", pull.Head, pull.Base, specBranch)
	}
	for _, want := range []string{"Part of #230", "#231 " + ticketTitle, "https://github.com/acme/edge-sensors/pull/231"} {
		if !strings.Contains(pull.Body, want) {
			t.Errorf("the spec pull request's body does not say %q:\n%s", want, pull.Body)
		}
	}
	if strings.Contains(strings.ToLower(pull.Body), "closes") {
		t.Errorf("the spec pull request's body closes the spec:\n%s", pull.Body)
	}
	if !gh.cutFrom(t, "acme/edge-sensors", specBranch, moved) {
		t.Errorf("the spec branch does not carry %s of main: the base was not merged into it once more", short(moved))
	}
	f.notified(t, 2)
	for _, login := range maintainers {
		if asked := gh.made(t, reviewCall(specPullURL, login)); asked != 1 {
			t.Errorf("%s was asked for a review of the spec pull request %d times, want once", login, asked)
		}
	}
	if spec := f.specRunNow(t); spec.State != specHolding || spec.PullRequest != specPullURL {
		t.Errorf("the spec run is %s with the spec pull request %q, want it holding %s", spec.State, spec.PullRequest, specPullURL)
	}

	gh.specPullIs(t, true)
	done := f.specRunIn(t, specDone)
	if done.DoneAt == nil || !strings.Contains(done.Reason, specPullURL) {
		t.Errorf("the spec run is done at %v for %q, want the time and the merge of %s", done.DoneAt, done.Reason, specPullURL)
	}
	if removed := gh.made(t, "issue edit 230 --repo acme/edge-sensors --remove-assignee factory-bot"); removed != 1 {
		t.Errorf("the assignee was taken off the spec %d times, want once", removed)
	}
	if got := titles(done.Events); !slices.Contains(got, "claimed "+specBranch) || !slices.Contains(got, specDone) {
		t.Errorf("the spec run's events are %v, want its claim kept and its end", got)
	}
	f.eventually(t, 30*time.Second, "the spec pull request's run let go", func() bool { return f.runNow(t, 2).LetGoAt != nil })
}

// Failing checks on the spec pull request are a repair round, as on a ticket's: a fix session on the
// spec branch, and the run ends ready once the checks pass.
func TestFailingChecksOnTheSpecPullRequestStartAFixSessionOnTheSpecBranch(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)))
	gh.specPullIs(t, false)
	gh.ciReads(t, "acme/edge-sensors", specNumber, ciPull{branch: specBranch, checks: []map[string]any{failed("test", 4242)}})
	gh.answer(t, "run view 4242 --repo acme/edge-sensors --log-failed", "FAIL: TestCalibration\n")
	f := gh.work(t, ticketConfig(data, nil, nil))
	f.repairPushed(t, 1)
	gh.ciReads(t, "acme/edge-sensors", specNumber, ciPull{branch: specBranch, head: gh.head(t, "acme/edge-sensors", specBranch)})
	run := f.ended(t, 1)
	if run.Issue != specNumber || run.Outcome != outcomeReady || run.RepairRounds != 1 {
		t.Fatalf("run 1 worked #%d and ended %q after %d repair rounds (%s), want the spec pull request ready after one; the factory's log:\n%s",
			run.Issue, run.Outcome, run.RepairRounds, run.Reason, f.output(t))
	}
	workers := gh.workers(t)
	if len(workers) != 1 || workers[0].branch != specBranch {
		t.Errorf("the factory started the sessions %+v, want one fix session on %s", workers, specBranch)
	}
}

// A spec whose open tickets are a person's or blocked waits: no spec pull request and no ticket, and one
// comment on the spec that names the person's ticket. Closing that ticket by hand lets the spec run
// take the ticket behind it.
func TestASpecRunWaitsForAPersonsTicketAndGoesOnOnceItIsClosed(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	human := openIssue(232, "Calibrate by hand", time.Now().UTC().Add(-48*time.Hour), humanLabel, specRunLabel("factory"))
	human["repository_url"] = "https://api.github.com/repos/acme/edge-sensors"
	blocked := gh.ticketOf(t, 233, "After the calibration")
	blocked["issue_dependencies_summary"] = map[string]any{"blocked_by": 1, "blocking": 0}
	gh.subIssues(t, human, blocked)
	gh.comments(t, "acme/edge-sensors", specNumber)
	c := ticketConfig(data, nil, nil)
	c["notify"] = maintainers
	f := gh.work(t, c)

	f.eventually(t, 30*time.Second, "the comment on the spec", func() bool { return gh.made(t, commentCall("acme/edge-sensors", specNumber)) == 1 })
	reading := "api " + subIssuesRequest("acme/edge-sensors", specNumber)
	before := gh.made(t, reading)
	f.eventually(t, 20*time.Second, "several more polls", func() bool { return gh.made(t, reading) >= before+5 })
	if made := gh.made(t, commentCall("acme/edge-sensors", specNumber)); made != 1 {
		t.Errorf("the factory commented %d times on the spec, want once", made)
	}
	said := gh.commented(t, "acme/edge-sensors", specNumber)
	for _, want := range []string{"@ada", "@linus", "#232"} {
		if !strings.Contains(said, want) {
			t.Errorf("the comment on the spec does not say %q:\n%s", want, said)
		}
	}
	if records, _ := filepath.Glob(filepath.Join(data, "run-*.json")); len(records) != 0 {
		t.Errorf("the waiting spec run started %d runs, want none", len(records))
	}
	if spec := f.specRunNow(t); !equal(spec.WaitingOn, []int{232}) || !equal(spec.Waiting, []int{232}) {
		t.Errorf("the spec run named %v and waits on %v, want #232 for both", spec.WaitingOn, spec.Waiting)
	}

	gh.openTicketPull(t, 233, "feat/233-after-the-calibration", false)
	gh.subIssues(t, closedIssue(human), gh.ticketOf(t, 233, "After the calibration"))
	run := f.ended(t, 1)
	if run.Issue != 233 || run.Spec != specNumber {
		t.Errorf("run 1 worked #%d of spec #%d, want the ticket #233 behind the person's", run.Issue, run.Spec)
	}
	if made := gh.made(t, commentCall("acme/edge-sensors", specNumber)); made != 1 {
		t.Errorf("the factory commented %d times on the spec, want once", made)
	}
	// The record keeps the ticket it named; what the spec run waits on now is nobody.
	if spec := f.specRunNow(t); !equal(spec.WaitingOn, []int{232}) || len(spec.Waiting) != 0 {
		t.Errorf("the spec run named %v and waits on %v, want #232 named and nobody waited on", spec.WaitingOn, spec.Waiting)
	}
}

// Taking the spec-run label off the spec, or closing it, during a ticket run ends that run cancelled,
// pushes and removes its worktree, takes the assignees off the ticket and the spec, and leaves the spec
// branch where it is.
func TestLettingASpecGoDuringATicketRunCancelsItAndLetsTheTicketGo(t *testing.T) {
	t.Parallel()
	for _, gesture := range []struct {
		name   string
		change func(issueJSON) issueJSON
	}{
		{"the label taken off", func(i issueJSON) issueJSON {
			i["labels"] = []any{map[string]any{"name": specLabel}}
			return i
		}},
		{"the spec closed", closedIssue},
	} {
		t.Run(gesture.name, func(t *testing.T) {
			t.Parallel()
			gh, data := ticketClaim(t)
			gh.workerWaits(t, 60*time.Second)
			gh.unassigns(t, "acme/edge-sensors", ticketIssue, "factory-bot")
			gh.unassigns(t, "acme/edge-sensors", specNumber, "factory-bot")
			f := gh.work(t, ticketConfig(data, nil, nil))
			f.sawIn(t, 1, "worker started")
			onSpec := gh.head(t, "acme/edge-sensors", specBranch)

			gh.heldSpec(t, gesture.change)
			run := f.ended(t, 1)
			if run.Issue != ticketIssue || run.Outcome != outcomeCancelled {
				t.Fatalf("run 1 worked #%d and ended %q (%s), want ticket #%d cancelled; the factory's log:\n%s", run.Issue, run.Outcome, run.Reason, ticketIssue, f.output(t))
			}
			f.eventually(t, 30*time.Second, "the ticket let go", func() bool { return f.runNow(t, 1).LetGoAt != nil })
			if _, err := os.Stat(run.Worktree); !os.IsNotExist(err) {
				t.Errorf("the worktree %s of the cancelled ticket run is still there (%v)", run.Worktree, err)
			}
			for _, issue := range []int{ticketIssue, specNumber} {
				if gh.made(t, fmt.Sprintf("issue edit %d --repo acme/edge-sensors --remove-assignee factory-bot", issue)) == 0 {
					t.Errorf("the assignee was not taken off #%d", issue)
				}
			}
			if spec := f.specRunNow(t); spec.State != specLetGo {
				t.Errorf("the spec run is %s, want let-go", spec.State)
			}
			if head := gh.head(t, "acme/edge-sensors", specBranch); head != onSpec {
				t.Errorf("%s is at %q after the letting-go, want it kept at %s", specBranch, head, onSpec)
			}
		})
	}
}

// Letting a spec go while its spec pull request is open and ready leaves that pull request open for a
// person: the spec run ends let-go with the pull request still on it and says so, and the factory
// closes nothing and cancels no run.
func TestLettingASpecGoLeavesItsOpenSpecPullRequestOpen(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)))
	gh.specPullIs(t, false)
	gh.unassigns(t, "acme/edge-sensors", specNumber, "factory-bot")
	f := gh.work(t, ticketConfig(data, nil, nil))
	run := f.ended(t, 1)
	if run.Issue != specNumber || run.Signal != signalSpecPull || run.Outcome != outcomeReady || run.PullRequest != specPullURL {
		t.Fatalf("run 1 worked #%d on %q and ended %q with %q (%s), want the spec pull request of #%d ready; the factory's log:\n%s",
			run.Issue, run.Signal, run.Outcome, run.PullRequest, run.Reason, specNumber, f.output(t))
	}

	gh.heldSpec(t, func(i issueJSON) issueJSON {
		i["labels"] = []any{map[string]any{"name": specLabel}}
		return i
	})
	spec := f.specRunIn(t, specLetGo)
	if spec.PullRequest != specPullURL || !strings.Contains(spec.Reason, specPullURL+" stays open") {
		t.Errorf("the spec run was let go with the spec pull request %q for %q, want %s kept and said to stay open", spec.PullRequest, spec.Reason, specPullURL)
	}
	if now := f.runNow(t, 1); now.Outcome != outcomeReady || now.PullRequest != specPullURL {
		t.Errorf("the run of the spec pull request is %q with %q after the letting-go, want it ready with %s", now.Outcome, now.PullRequest, specPullURL)
	}
	f.eventually(t, 30*time.Second, "the spec pull request's run let go", func() bool { return f.runNow(t, 1).LetGoAt != nil })
	if _, err := os.Stat(run.Worktree); err == nil {
		t.Errorf("the worktree %s of the spec pull request's run stays after the letting-go", run.Worktree)
	}
	if gh.head(t, "acme/edge-sensors", specBranch) == "" {
		t.Errorf("the spec branch %s is gone from the remote, want it kept under the open spec pull request", specBranch)
	}
	for _, call := range gh.calls(t) {
		if strings.HasPrefix(call, "pr close") || strings.Contains(call, "state=closed") {
			t.Errorf("the factory closed the spec pull request: %s", call)
		}
	}
}

// A spec pull request GitHub refuses to open ends its run failed, and the spec branch and its worktree
// stay as they are: the run resumed them, so it is not the run's to take back.
func TestASpecPullRequestThatCannotBeOpenedFailsAndLeavesTheSpecBranch(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)))
	gh.fail(t, createPullCall("acme/edge-sensors")+"*")
	f := gh.work(t, ticketConfig(data, nil, nil))
	run := f.ended(t, 1)
	if run.Issue != specNumber || run.Signal != signalSpecPull || run.Outcome != outcomeFailed || run.PullRequest != "" {
		t.Fatalf("run 1 worked #%d on %q and ended %q with %q (%s), want the spec pull request of #%d failed and unopened; the factory's log:\n%s",
			run.Issue, run.Signal, run.Outcome, run.PullRequest, run.Reason, specNumber, f.output(t))
	}
	for _, want := range []string{"the spec pull request could not be opened", specBranch + " and its worktree stay as they are"} {
		if !strings.Contains(run.Reason, want) {
			t.Errorf("run 1 failed for %q, want it to say %q", run.Reason, want)
		}
	}
	if _, err := os.Stat(run.Worktree); err != nil {
		t.Errorf("the worktree %s of the spec branch is gone after the failure: %v", run.Worktree, err)
	}
	if spec := f.specRunNow(t); spec.State != specHolding || spec.PullRequest != "" {
		t.Errorf("the spec run is %s with the spec pull request %q, want it holding with none", spec.State, spec.PullRequest)
	}
}

// A merged spec pull request whose spec cannot be let go keeps the spec run holding, and a later poll
// that can take the assignee off ends it done.
func TestAMergedSpecPullRequestIsHeldUntilTheAssigneeComesOff(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)))
	gh.specPullIs(t, false)
	gh.unassigns(t, "acme/edge-sensors", specNumber, "factory-bot")
	f := gh.work(t, ticketConfig(data, nil, nil))
	if run := f.ended(t, 1); run.Outcome != outcomeReady || run.PullRequest != specPullURL {
		t.Fatalf("run 1 ended %q with %q (%s), want the spec pull request ready; the factory's log:\n%s", run.Outcome, run.PullRequest, run.Reason, f.output(t))
	}

	gh.fail(t, fmt.Sprintf("issue edit %d --repo acme/edge-sensors --remove-assignee *", specNumber))
	gh.specPullIs(t, true)
	f.eventually(t, 30*time.Second, "the spec run warns that the spec could not be let go", func() bool {
		return slices.Contains(titles(f.specRunNow(t).Events), "the spec could not be let go")
	})
	if spec := f.specRunNow(t); spec.State != specHolding || spec.DoneAt != nil {
		t.Errorf("the spec run is %s (done at %v) while the assignee is still on the spec, want it holding", spec.State, spec.DoneAt)
	}

	gh.fail(t, "")
	done := f.specRunIn(t, specDone)
	if done.DoneAt == nil || !strings.Contains(done.Reason, specPullURL) {
		t.Errorf("the spec run is done at %v for %q, want the time and the merge of %s", done.DoneAt, done.Reason, specPullURL)
	}
}

// A repository that moves its default branch while a spec runs gets the spec pull request against the
// base it has now, and the run records that base: the merge a person makes into it ends the spec run.
func TestASpecPullRequestFollowsTheBaseTheRepositoryMovedTo(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.specPullInto(t, "dev", false)
	gh.unassigns(t, "acme/edge-sensors", specNumber, "factory-bot")
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	if ticket := f.ended(t, 1); ticket.Issue != ticketIssue || ticket.Outcome != outcomeMerged {
		t.Fatalf("run 1 worked #%d and ended %q (%s), want ticket #%d merged; the factory's log:\n%s", ticket.Issue, ticket.Outcome, ticket.Reason, ticketIssue, f.output(t))
	}
	gh.branchAt(t, "acme/edge-sensors", "dev", gh.head(t, "acme/edge-sensors", "main"))
	gh.commitOn(t, "acme/edge-sensors", "dev")
	gh.defaultBranchIs(t, "acme/edge-sensors", "dev")
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)))

	run := f.ended(t, 2)
	if run.Signal != signalSpecPull || run.Outcome != outcomeReady || run.Base != "dev" {
		t.Fatalf("run 2 on %q ended %q into %q (%s), want the spec pull request ready into dev; the factory's log:\n%s",
			run.Signal, run.Outcome, run.Base, run.Reason, f.output(t))
	}
	if opened := gh.opened(t, "acme/edge-sensors"); opened[len(opened)-1].Base != "dev" {
		t.Errorf("the spec pull request goes into %s, want dev", opened[len(opened)-1].Base)
	}
	gh.specPullInto(t, "dev", true)
	if done := f.specRunIn(t, specDone); !strings.Contains(done.Reason, "into dev") {
		t.Errorf("the spec run is done for %q, want the merge into dev", done.Reason)
	}
}

// A spec whose title takes GitHub's whole allowance gets a spec pull request whose title is cut to the
// longest the factory opens.
func TestASpecPullRequestTitleIsCutToTheLongestTheFactoryOpens(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	long := strings.Repeat("a long spec title ", 15)[:256]
	now := time.Now().UTC()
	gh.answer(t, "api "+specsRequest("acme/edge-sensors", "factory"), marshal(t, []issueJSON{
		openIssue(specNumber, long, now.Add(-72*time.Hour), specLabel, specRunLabel("factory"))}))
	gh.issue(t, "acme/edge-sensors", assignedTo(openIssue(specNumber, long, now.Add(-72*time.Hour), specLabel, specRunLabel("factory")), "factory-bot"))
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)))
	f := gh.work(t, ticketConfig(data, nil, nil))
	f.ended(t, 1)
	opened := gh.opened(t, "acme/edge-sensors")
	if len(opened) == 0 {
		t.Fatalf("no spec pull request was opened; the factory's log:\n%s", f.output(t))
	}
	if title := opened[0].Title; len(title) != 100 || !strings.HasPrefix(title, "feat: a long spec title") {
		t.Errorf("the spec pull request's title is %d characters, %q, want the first 100 of the prefixed spec title", len(title), title)
	}
}

// An open sub-issue from another repository keeps the spec from its spec pull request, though it is no
// ticket the factory takes; once it is closed the spec pull request lists it.
func TestAnOpenSubIssueOfAnotherRepositoryHoldsTheSpecPullRequestBack(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	elsewhere := openIssue(7, "Flash the new firmware", time.Now().UTC().Add(-48*time.Hour), readyLabel, specRunLabel("factory"))
	elsewhere["repository_url"] = "https://api.github.com/repos/acme/firmware"
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)), elsewhere)
	gh.specPullIs(t, false)
	f := gh.work(t, ticketConfig(data, nil, nil))

	reading := "api " + subIssuesRequest("acme/edge-sensors", specNumber)
	f.eventually(t, 20*time.Second, "several polls", func() bool { return gh.made(t, reading) >= 5 })
	if records, _ := filepath.Glob(filepath.Join(data, "run-*.json")); len(records) != 0 {
		t.Fatalf("the spec with an open sub-issue elsewhere started %d runs, want none; the factory's log:\n%s", len(records), f.output(t))
	}

	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)), closedIssue(elsewhere))
	if run := f.ended(t, 1); run.Signal != signalSpecPull || run.Outcome != outcomeReady {
		t.Fatalf("run 1 on %q ended %q (%s), want the spec pull request ready; the factory's log:\n%s", run.Signal, run.Outcome, run.Reason, f.output(t))
	}
	if body := gh.opened(t, "acme/edge-sensors")[0].Body; !strings.Contains(body, "acme/firmware#7 Flash the new firmware") {
		t.Errorf("the spec pull request's body does not list the sub-issue of acme/firmware:\n%s", body)
	}
}

// A ticket merged into the spec branch and then taken off the spec's sub-issues still counts: the spec
// gets its spec pull request, and the body lists the ticket with its pull request.
func TestATicketTakenOffTheSpecAfterItsMergeStaysInTheSpecPullRequest(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.specPullIs(t, false)
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	if ticket := f.ended(t, 1); ticket.Issue != ticketIssue || ticket.Outcome != outcomeMerged {
		t.Fatalf("run 1 worked #%d and ended %q (%s), want ticket #%d merged; the factory's log:\n%s", ticket.Issue, ticket.Outcome, ticket.Reason, ticketIssue, f.output(t))
	}
	gh.subIssues(t)

	if run := f.ended(t, 2); run.Signal != signalSpecPull || run.Outcome != outcomeReady {
		t.Fatalf("run 2 on %q ended %q (%s), want the spec pull request ready; the factory's log:\n%s", run.Signal, run.Outcome, run.Reason, f.output(t))
	}
	opened := gh.opened(t, "acme/edge-sensors")
	body := opened[len(opened)-1].Body
	for _, want := range []string{"#231 " + ticketTitle, "https://github.com/acme/edge-sensors/pull/231"} {
		if !strings.Contains(body, want) {
			t.Errorf("the spec pull request's body does not say %q:\n%s", want, body)
		}
	}
}
