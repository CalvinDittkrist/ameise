package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Ticket runs, tested the way the rest of the factory is: the real binary against the gh and claude
// shims and a bare remote, with a spec held on its spec branch and its sub-issues answered by the test.

// The ticket every test of a ticket run works first, and its branch.
const (
	ticketIssue  = 231
	ticketTitle  = "Cut the ticket branch"
	ticketBranch = "feat/231-cut-the-ticket-branch"
)

// ticketOf is a ticket of the spec: a sub-issue carrying the spec-run label and ready-for-agent, whose
// label was set an hour ago, that a claim assigns to factory-bot and that reads as held afterwards.
func (g *ghShim) ticketOf(t *testing.T, number int, title string) issueJSON {
	t.Helper()
	now := time.Now().UTC()
	g.timeline(t, "acme/edge-sensors", number, labeled(specRunLabel("factory"), now.Add(-time.Hour)))
	g.assigns(t, "acme/edge-sensors", number, "factory-bot")
	g.comments(t, "acme/edge-sensors", number)
	g.issue(t, "acme/edge-sensors", assignedTo(openIssue(number, title, now.Add(-48*time.Hour), readyLabel, specRunLabel("factory")), "factory-bot"))
	ticket := openIssue(number, title, now.Add(-48*time.Hour), readyLabel, specRunLabel("factory"))
	ticket["repository_url"] = "https://api.github.com/repos/acme/edge-sensors"
	return ticket
}

// subIssues is the sub-issue list of the spec, as GitHub answers it.
func (g *ghShim) subIssues(t *testing.T, tickets ...issueJSON) {
	t.Helper()
	if tickets == nil {
		tickets = []issueJSON{}
	}
	g.answer(t, "api "+subIssuesRequest("acme/edge-sensors", specNumber), marshal(t, tickets))
}

// openTicketPull is the reading of a ticket's pull request the merge stage makes: open and unmerged,
// into the spec branch, under the title it is squash-merged with.
func (g *ghShim) openTicketPull(t *testing.T, number int, branch string, merged bool) {
	t.Helper()
	state := "open"
	if merged {
		state = "closed"
	}
	g.answer(t, fmt.Sprintf("api repos/acme/edge-sensors/pulls/%d", number), marshal(t, map[string]any{
		"number": number, "state": state, "merged": merged, "title": "feat: ticket " + fmt.Sprint(number),
		"head": map[string]any{"ref": branch, "repo": map[string]any{"full_name": "acme/edge-sensors"}},
		"base": map[string]any{"ref": specBranch, "repo": map[string]any{"full_name": "acme/edge-sensors"}}}))
}

// ticketClaim is a held spec with one ticket, #231, whose implement session commits worked.md. The
// clone is made before the factory starts, so the base can move on beneath it.
func ticketClaim(t *testing.T) (*ghShim, string) {
	t.Helper()
	gh := newGhShim(t)
	gh.routedSpecFixture(t, "acme/edge-sensors", "factory")
	gh.subIssues(t, gh.ticketOf(t, ticketIssue, ticketTitle))
	gh.openTicketPull(t, ticketIssue, ticketBranch, false)
	gh.workerCommits(t, "worked.md")
	gh.env = append(gh.env, "GIT_AUTHOR_NAME=factory", "GIT_AUTHOR_EMAIL=factory@example.com",
		"GIT_COMMITTER_NAME=factory", "GIT_COMMITTER_EMAIL=factory@example.com")
	data := filepath.Join(t.TempDir(), "data")
	gh.cloneInto(t, data, "acme/edge-sensors")
	return gh, data
}

// ticketConfig is a ticket test's configuration: a panel of the code reviewer alone and the validate
// knobs given, none of them naming a validator unless the test does.
func ticketConfig(data string, review, validate map[string]any) config {
	c := ciConfig(data, nil)
	if review == nil {
		review = map[string]any{}
	}
	review["reviewers"] = []string{"code"}
	c["review"] = review
	if validate != nil {
		c["validate"] = validate
	}
	return c
}

// specRunNow is the spec run as /api/specs/1 serves it now.
func (f *factory) specRunNow(t *testing.T) apiSpecRun {
	t.Helper()
	var spec apiSpecRun
	f.get(t, "/api/specs/1", &spec)
	return spec
}

// The lowest-numbered ticket that may be taken comes before a routed issue: the base is merged into
// the spec branch, the ticket's branch is cut from it, its pull request goes against it, Codex and the
// Claude reviewer on Fable validate it, and it is squash-merged into the spec branch under its title.
// The ticket is closed with a comment, the spec run lists the run and the merge, and a ticket added
// to the spec afterwards is taken next, before the routed issue still.
func TestTheTicketsOfAHeldSpecAreWorkedOnTheSpecBranchAndMergedIntoIt(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	codex := gh.hasCodex(t)
	now := time.Now().UTC()
	// A routed issue waits beside the spec, a ticket with a higher number comes first in the list, and
	// a blocked one is lower still: neither of those is taken before #231.
	gh.timeline(t, "acme/edge-sensors", claimedIssue, labeled("factory", now.Add(-6*time.Hour)))
	gh.assigns(t, "acme/edge-sensors", claimedIssue, "factory-bot")
	blocked := gh.ticketOf(t, 229, "A blocked ticket")
	blocked["issue_dependencies_summary"] = map[string]any{"blocked_by": 1, "blocking": 0}
	gh.openTicketPull(t, 233, "feat/233-close-the-ticket-after", false)
	// The spec branch is claimed from main before main moves on and the tickets are listed, so the
	// claim of the first ticket merges the base in first.
	gh.subIssues(t)
	f := gh.work(t, ticketConfig(data, nil, nil))
	f.specRunIn(t, "holding")
	moved := gh.commitOn(t, "acme/edge-sensors", "main")
	gh.subIssues(t, gh.ticketOf(t, 233, "Close the ticket after"), blocked, gh.ticketOf(t, ticketIssue, ticketTitle))
	// The routed issue is listed once the tickets are: before, the factory would take it in the moment
	// the spec is held and its sub-issues are still none.
	gh.issues(t, "acme/edge-sensors", openIssue(claimedIssue, claimedTitle, now.Add(-96*time.Hour)))

	run := f.ended(t, 1)
	if run.Issue != ticketIssue || run.Outcome != outcomeMerged {
		t.Fatalf("run 1 worked #%d and ended %q (%s), want ticket #%d merged; the factory's log:\n%s", run.Issue, run.Outcome, run.Reason, ticketIssue, f.output(t))
	}
	if run.Spec != specNumber || run.Base != specBranch || run.Branch != ticketBranch {
		t.Errorf("run 1 records spec #%d, base %q and branch %q, want #%d, %s and %s", run.Spec, run.Base, run.Branch, specNumber, specBranch, ticketBranch)
	}
	if !equal(run.Stages, []string{"implement", "gate", "review", "pr", "ci", "validate", "merge"}) {
		t.Errorf("run 1 went through the stages %v, want validate and merge after ci", run.Stages)
	}
	if !gh.cutFrom(t, "acme/edge-sensors", specBranch, moved) {
		t.Errorf("the spec branch does not carry %s of main: the base was not merged into it", short(moved))
	}
	if !gh.cutFrom(t, "acme/edge-sensors", ticketBranch, moved) {
		t.Errorf("the ticket's branch does not carry the base merged into the spec branch")
	}
	opened := gh.opened(t, "acme/edge-sensors")
	if len(opened) == 0 || opened[0].Head != ticketBranch || opened[0].Base != specBranch {
		t.Fatalf("the factory opened the pull requests %+v, want one from %s against %s", opened, ticketBranch, specBranch)
	}
	v := run.Validation
	if v == nil || !v.Passed || len(v.Rounds) != 1 || len(v.Rounds[0].Verdicts) != 2 ||
		v.Rounds[0].Verdicts[0].Reviewer != "codex" || v.Rounds[0].Verdicts[1].Reviewer != "fable" {
		t.Errorf("run 1 recorded the validation %+v, want one round codex and fable passed", v)
	}
	if len(codex.calls(t)) == 0 {
		t.Errorf("the Codex validator was never called")
	}
	merge := "api --method PUT repos/acme/edge-sensors/pulls/231/merge --input -"
	if gh.made(t, merge) != 1 {
		t.Errorf("the factory merged the pull request %d times, want once", gh.made(t, merge))
	}
	var body mergeRequest
	raw, _ := os.ReadFile(filepath.Join(gh.bodies, requestName(merge)))
	if err := json.Unmarshal(raw, &body); err != nil || body.Method != "squash" || body.Title != "feat: ticket 231" {
		t.Errorf("the merge was asked as %s, want a squash under the pull request's title", raw)
	}
	subject := gh.git(t, gh.remotePath("acme/edge-sensors"), "log", "-1", "--format=%s", "refs/heads/"+specBranch)
	if subject != "feat: ticket 231" {
		t.Errorf("the spec branch's last commit is %q, want the squash of the ticket under its title", subject)
	}
	if gh.made(t, "issue close 231 --repo acme/edge-sensors") != 1 || !strings.Contains(gh.commented(t, "acme/edge-sensors", ticketIssue), "https://github.com/acme/edge-sensors/pull/231") {
		t.Errorf("ticket #231 was not closed with a comment that names its pull request: %q", gh.commented(t, "acme/edge-sensors", ticketIssue))
	}

	// #233 is taken next, and a ticket added to the spec while it runs is taken after it, before the
	// routed issue. The squash of #231 stands on the spec branch #233 is cut from.
	squashed := gh.head(t, "acme/edge-sensors", specBranch)
	f.sawIn(t, 2, "a ticket of spec")
	gh.subIssues(t, gh.ticketOf(t, 233, "Close the ticket after"), blocked, gh.ticketOf(t, 234, "A late ticket"))
	gh.openTicketPull(t, 234, "feat/234-a-late-ticket", false)
	second := f.ended(t, 2)
	if second.Issue != 233 || second.Outcome != outcomeMerged || !gh.cutFrom(t, "acme/edge-sensors", second.Branch, squashed) {
		t.Errorf("run 2 worked #%d on %s and ended %q (%s), want #233 cut from the squash of #231 and merged", second.Issue, second.Branch, second.Outcome, second.Reason)
	}
	third := f.ended(t, 3)
	if third.Issue != 234 || third.Spec != specNumber {
		t.Errorf("run 3 worked #%d of spec #%d, want the late ticket #234 before the routed issue", third.Issue, third.Spec)
	}
	spec := f.specRunNow(t)
	if len(spec.Tickets) < 2 || spec.Tickets[0].Issue != ticketIssue || spec.Tickets[0].MergedAt == nil ||
		spec.Tickets[0].PullRequest != "https://github.com/acme/edge-sensors/pull/231" || !equal(spec.Tickets[0].Runs, []int{1}) {
		t.Errorf("the spec run lists the tickets %+v, want #231 merged by run 1 first", spec.Tickets)
	}
	for _, run := range []apiRun{run, second, third} {
		if run.Issue == 229 {
			t.Errorf("the blocked ticket #229 was worked by run %d", run.ID)
		}
	}
}

// A ticket whose panel did not pass ends ready with its pull request against the spec branch, and
// nothing is merged.
func TestATicketWhosePanelDidNotPassIsNotMerged(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	fix := findings(t, Finding{Severity: "S2", Path: "worked.md", Line: 1, Claim: "It is wrong.", Why: "It is.", Fix: "Right it."})
	gh.verdict(t, "code", 1, fix)
	gh.verdict(t, "code", 2, fix)
	gh.repairs(t, map[string]any{"outcome": "complete", "fixed": []string{"F1"}, "disputed": []any{}, "skipped": []any{}, "summary": "righted"})
	f := gh.work(t, ticketConfig(data, map[string]any{"rounds": 1}, map[string]any{"validators": []string{"senior"}}))
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady || run.Spec != specNumber {
		t.Fatalf("run 1 ended %q (%s) for spec #%d, want ready; the factory's log:\n%s", run.Outcome, run.Reason, run.Spec, f.output(t))
	}
	if gh.asked(t, "api --method PUT") != 0 || gh.asked(t, "issue close") != 0 {
		t.Errorf("the factory merged or closed a ticket whose panel did not pass")
	}
	if len(factoryTitles(run, "not merged into "+specBranch)) != 1 {
		t.Errorf("run 1 does not say it was not merged; its events: %v", factoryTitles(run, ""))
	}
}

// A base that conflicts with the spec branch is left unmerged and noted on the spec run; the ticket
// is cut from the spec branch as it is.
func TestABaseThatConflictsWithTheSpecBranchIsNotMerged(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.subIssues(t)
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	f.specRunIn(t, "holding")
	// The spec branch and main each change the README another way.
	remote := gh.remotePath("acme/edge-sensors")
	for _, branch := range []string{specBranch, "main"} {
		work := filepath.Join(t.TempDir(), "w")
		gh.git(t, t.TempDir(), "clone", "-q", "-b", branch, remote, work)
		writeFile(t, filepath.Join(work, "README.md"), "# "+branch+"\n")
		gh.git(t, work, "commit", "-q", "-am", "readme on "+branch)
		gh.git(t, work, "push", "-q", "origin", branch)
	}
	onSpec := gh.head(t, "acme/edge-sensors", specBranch)
	gh.subIssues(t, gh.ticketOf(t, ticketIssue, ticketTitle))
	run := f.ended(t, 1)
	if run.Outcome != outcomeMerged {
		t.Fatalf("run 1 ended %q (%s), want merged; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	if !gh.cutFrom(t, "acme/edge-sensors", ticketBranch, onSpec) || gh.cutFrom(t, "acme/edge-sensors", specBranch, gh.head(t, "acme/edge-sensors", "main")) {
		t.Errorf("the conflicting base was merged into the spec branch, or the ticket was not cut from the spec branch; the spec run's events: %v", titles(f.specRunNow(t).Events))
	}
	var warned bool
	for _, e := range f.specRunNow(t).Events {
		warned = warned || e.Title == "base not merged"
	}
	if !warned {
		t.Errorf("the spec run does not note the base it left unmerged: %v", titles(f.specRunNow(t).Events))
	}
}

// A ticket's pull request a person merges while its run goes on ends the run, is not merged again,
// and is recorded on the spec run as merged, the ticket closed with a comment as the merge stage does.
func TestATicketMergedByAPersonIsRecordedAndNotMergedAgain(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.openTicketPull(t, ticketIssue, ticketBranch, true)
	gh.unassigns(t, "acme/edge-sensors", ticketIssue, "factory-bot")
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	run := f.ended(t, 1)
	// The poll that reads the merge cancels the run, or the merge stage finds it merged, whichever
	// comes first.
	if run.Outcome != outcomeCancelled && run.Outcome != outcomeMerged {
		t.Fatalf("run 1 ended %q (%s), want cancelled by the merge or merged; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	closing := "issue close 231 --repo acme/edge-sensors"
	f.eventually(t, 20*time.Second, "the merged ticket closed", func() bool { return gh.made(t, closing) == 1 })
	// Several more polls pass, the one that lets the ticket go among them.
	reading := "api " + subIssuesRequest("acme/edge-sensors", specNumber)
	before := gh.made(t, reading)
	f.eventually(t, 20*time.Second, "several more polls", func() bool { return gh.made(t, reading) >= before+5 })
	if gh.made(t, closing) != 1 {
		t.Errorf("the ticket was closed %d times, want once", gh.made(t, closing))
	}
	if gh.asked(t, "api --method PUT") != 0 {
		t.Errorf("the factory merged a pull request that was merged already")
	}
	spec := f.specRunNow(t)
	if len(spec.Tickets) != 1 || spec.Tickets[0].MergedAt == nil {
		t.Errorf("the spec run lists the tickets %+v, want #231 merged", spec.Tickets)
	}
	if !strings.Contains(gh.commented(t, "acme/edge-sensors", ticketIssue), "pull/231") {
		t.Errorf("ticket #231 was closed without a comment that names its pull request")
	}
}

// A sub-issue of the spec from another repository is no ticket, although it carries the labels and a
// lower number: it is read by its number in the spec's repository, which would work another issue.
func TestASubIssueFromAnotherRepositoryIsNotWorked(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	foreign := gh.ticketOf(t, 228, "A ticket of another repository")
	foreign["repository_url"] = "https://api.github.com/repos/acme/other-repo"
	gh.subIssues(t, foreign, gh.ticketOf(t, ticketIssue, ticketTitle))
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	run := f.ended(t, 1)
	if run.Issue != ticketIssue || run.Outcome != outcomeMerged {
		t.Fatalf("run 1 worked #%d and ended %q (%s), want ticket #%d merged and #228 of the other repository left alone; the factory's log:\n%s",
			run.Issue, run.Outcome, run.Reason, ticketIssue, f.output(t))
	}
	if read := gh.made(t, "api --paginate "+eventsRequest("acme/edge-sensors", 228)); read != 0 {
		t.Errorf("the factory read the events of #228 %d times, want never: it is no ticket of the spec", read)
	}
}

// A merge GitHub refuses ends the ticket run blocked, with a reason that names the pull request and
// the spec branch, and the ticket stays open.
func TestATicketWhoseMergeIsRefusedEndsBlocked(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.fail(t, "api --method PUT repos/acme/edge-sensors/pulls/231/merge*")
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	run := f.ended(t, 1)
	if run.Outcome != outcomeBlocked || run.Stage != stageMerge ||
		!strings.Contains(run.Reason, "pull/231") || !strings.Contains(run.Reason, specBranch) {
		t.Fatalf("run 1 ended %q in %q (%s), want blocked at merge naming the pull request and %s; the factory's log:\n%s",
			run.Outcome, run.Stage, run.Reason, specBranch, f.output(t))
	}
	if gh.made(t, "issue close 231 --repo acme/edge-sensors") != 0 {
		t.Errorf("the factory closed the ticket whose pull request it could not merge")
	}
	if spec := f.specRunNow(t); len(spec.Tickets) != 1 || spec.Tickets[0].MergedAt != nil {
		t.Errorf("the spec run lists the tickets %+v, want #231 not merged", spec.Tickets)
	}
}

// A held ticket is let go on the spec-run label taken off it or on the ticket closed, and not on the
// routing label, which a ticket never carries.
func TestTakingTheSpecRunLabelOffOrClosingATicketLetsItGo(t *testing.T) {
	t.Parallel()
	for _, gesture := range []struct {
		name     string
		decision string
		change   func(issueJSON) issueJSON
	}{
		{"the label taken off", "the spec-run label factory:spec-run was taken off the issue", func(i issueJSON) issueJSON {
			i["labels"] = []any{map[string]any{"name": readyLabel}}
			return i
		}},
		{"the ticket closed", "the issue was closed", closedIssue},
	} {
		t.Run(gesture.name, func(t *testing.T) {
			t.Parallel()
			gh, data := ticketClaim(t)
			gh.unassigns(t, "acme/edge-sensors", ticketIssue, "factory-bot")
			gh.workerReportsBlocked(t, "the spec leaves the retry count open")
			f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
			run := f.ended(t, 1)
			if run.Issue != ticketIssue || run.Outcome != outcomeBlocked || !run.Holding {
				t.Fatalf("run 1 worked #%d and ended %q holding=%v, want ticket #%d blocked and held; the factory's log:\n%s",
					run.Issue, run.Outcome, run.Holding, ticketIssue, f.output(t))
			}
			gh.issue(t, "acme/edge-sensors", gesture.change(assignedTo(
				openIssue(ticketIssue, ticketTitle, time.Now().UTC().Add(-48*time.Hour), readyLabel, specRunLabel("factory")), "factory-bot")))
			var let apiRun
			f.eventually(t, 30*time.Second, "the ticket to be let go", func() bool {
				let = apiRun{}
				f.get(t, "/api/runs/1", &let)
				return let.LetGoAt != nil
			})
			said := ""
			for _, e := range let.Events {
				if e.Title == "letting "+ticketBranch+" go" {
					said = e.Body
				}
			}
			if said != gesture.decision {
				t.Errorf("the ticket was let go on %q, want the decision %q", said, gesture.decision)
			}
		})
	}
}

// A ticket's pull request whose base was changed away from the spec branch after it was opened is not
// merged: the run ends blocked at the merge, naming the base it found, and the ticket stays open.
func TestATicketWhosePullRequestNoLongerGoesIntoTheSpecBranchIsNotMerged(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.answer(t, fmt.Sprintf("api repos/acme/edge-sensors/pulls/%d", ticketIssue), marshal(t, map[string]any{
		"number": ticketIssue, "state": "open", "merged": false, "title": "feat: ticket 231",
		"head": map[string]any{"ref": ticketBranch, "repo": map[string]any{"full_name": "acme/edge-sensors"}},
		"base": map[string]any{"ref": "main", "repo": map[string]any{"full_name": "acme/edge-sensors"}}}))
	main := gh.head(t, "acme/edge-sensors", "main")
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	run := f.ended(t, 1)
	if run.Outcome != outcomeBlocked || run.Stage != stageMerge || !strings.Contains(run.Reason, `"main"`) {
		t.Fatalf("run 1 ended %q in %q (%s), want blocked at merge naming the base main; the factory's log:\n%s",
			run.Outcome, run.Stage, run.Reason, f.output(t))
	}
	if gh.asked(t, "api --method PUT") != 0 || gh.made(t, "issue close 231 --repo acme/edge-sensors") != 0 {
		t.Errorf("the factory merged a pull request that goes into main, or closed its ticket")
	}
	if head := gh.head(t, "acme/edge-sensors", "main"); head != main {
		t.Errorf("main moved from %s to %s", short(main), short(head))
	}
}

// A factory stopped in the merge stage before GitHub took the merge merges on its restart, once. One
// stopped after the merge and before the ticket was closed merges nothing again and closes the ticket
// once, as the poll that reads the merge does.
func TestARestartedFactoryGoesOnAtTheMergeOnce(t *testing.T) {
	t.Parallel()
	for _, at := range []string{"before the merge", "after the merge"} {
		t.Run(at, func(t *testing.T) {
			t.Parallel()
			gh, data := ticketClaim(t)
			merge := "api --method PUT repos/acme/edge-sensors/pulls/231/merge --input -"
			closing := "issue close 231 --repo acme/edge-sensors"
			if at == "before the merge" {
				gh.stall(t, "api --method PUT *")
			} else {
				gh.stall(t, "issue comment 231 *")
			}
			first := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
			first.eventually(t, 90*time.Second, "the call "+at+" to be reached", func() bool {
				if at == "before the merge" {
					return gh.made(t, merge) == 1
				}
				return gh.asked(t, "issue comment 231 ") == 1
			})
			first.stop(t, syscall.SIGTERM)
			gh.stall(t, "")
			squashes := func() int {
				return len(strings.Fields(gh.git(t, gh.remotePath("acme/edge-sensors"), "log", "--format=%h", "--grep=feat: ticket 231", "refs/heads/"+specBranch)))
			}
			if at == "after the merge" {
				gh.openTicketPull(t, ticketIssue, ticketBranch, true) // GitHub answers it merged now
			}

			again := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
			again.eventually(t, 60*time.Second, "the merged ticket closed", func() bool { return gh.made(t, closing) >= 1 })
			reading := "api " + subIssuesRequest("acme/edge-sensors", specNumber)
			before := gh.made(t, reading)
			again.eventually(t, 20*time.Second, "several more polls", func() bool { return gh.made(t, reading) >= before+5 })
			want := 1
			if at == "before the merge" {
				want = 2 // the stalled call is counted, and GitHub never took it
			}
			if gh.made(t, merge) != want || squashes() != 1 {
				t.Errorf("the factory asked for the merge %d times and the spec branch holds %d squashes, want %d asks and one squash; the factory's log:\n%s",
					gh.made(t, merge), squashes(), want, again.output(t))
			}
			if gh.made(t, closing) != 1 {
				t.Errorf("the ticket was closed %d times, want once", gh.made(t, closing))
			}
			if spec := again.specRunNow(t); len(spec.Tickets) != 1 || spec.Tickets[0].MergedAt == nil || !spec.Tickets[0].Closed {
				t.Errorf("the spec run lists the tickets %+v, want #231 merged and closed", spec.Tickets)
			}
		})
	}
}

// A ticket run that ends blocked holds its ticket until it is released, and a sibling ticket is worked
// meanwhile.
func TestABlockedTicketWaitsWhileASiblingIsWorked(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.subIssues(t, gh.ticketOf(t, ticketIssue, ticketTitle), gh.ticketOf(t, 233, "Close the ticket after"))
	gh.workerReportsBlocked(t, "the spec leaves the retry count open")
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	first := f.ended(t, 1)
	if first.Issue != ticketIssue || first.Outcome != outcomeBlocked || first.Spec != specNumber {
		t.Fatalf("run 1 worked #%d and ended %q, want ticket #%d blocked; the factory's log:\n%s", first.Issue, first.Outcome, ticketIssue, f.output(t))
	}
	second := f.ended(t, 2)
	if second.Issue != 233 || second.Spec != specNumber || second.Base != specBranch {
		t.Errorf("run 2 worked #%d of spec #%d from %q, want the sibling #233 from %s", second.Issue, second.Spec, second.Base, specBranch)
	}
	var line apiLine
	f.get(t, "/api/line", &line)
	for _, entry := range line.Queue {
		if entry.Number == ticketIssue {
			t.Errorf("the blocked ticket #%d stands in the line before anybody released it", ticketIssue)
		}
	}
}

// A ticket's pull request a person turned to main and merged there never reached the spec branch: the
// ticket is not recorded merged on the spec run and the factory does not close it.
func TestATicketMergedIntoAnotherBranchIsNotRecordedMerged(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.answer(t, fmt.Sprintf("api repos/acme/edge-sensors/pulls/%d", ticketIssue), marshal(t, map[string]any{
		"number": ticketIssue, "state": "closed", "merged": true, "title": "feat: ticket 231",
		"head": map[string]any{"ref": ticketBranch, "repo": map[string]any{"full_name": "acme/edge-sensors"}},
		"base": map[string]any{"ref": "main", "repo": map[string]any{"full_name": "acme/edge-sensors"}}}))
	gh.unassigns(t, "acme/edge-sensors", ticketIssue, "factory-bot")
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	f.ended(t, 1)
	reading := "api " + subIssuesRequest("acme/edge-sensors", specNumber)
	before := gh.made(t, reading)
	f.eventually(t, 20*time.Second, "several more polls", func() bool { return gh.made(t, reading) >= before+5 })
	if gh.made(t, "issue close 231 --repo acme/edge-sensors") != 0 {
		t.Errorf("the factory closed a ticket whose pull request was merged into main")
	}
	if spec := f.specRunNow(t); len(spec.Tickets) != 1 || spec.Tickets[0].MergedAt != nil {
		t.Errorf("the spec run lists the tickets %+v, want #231 not merged", spec.Tickets)
	}
}

// A ticket whose pull request a person merged and which they closed before the next poll is recorded
// merged and closed on the spec run, and the factory neither comments on it nor closes it again.
func TestATicketMergedAndClosedByAPersonIsRecorded(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.unassigns(t, "acme/edge-sensors", ticketIssue, "factory-bot")
	gh.stall(t, "api --method PUT *") // the merge stage waits, so the poll is what reads the merge
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	f.eventually(t, 90*time.Second, "the merge asked for", func() bool { return gh.asked(t, "api --method PUT") == 1 })
	gh.openTicketPull(t, ticketIssue, ticketBranch, true)
	gh.issue(t, "acme/edge-sensors", closedIssue(assignedTo(
		openIssue(ticketIssue, ticketTitle, time.Now().UTC().Add(-48*time.Hour), readyLabel, specRunLabel("factory")), "factory-bot")))
	f.eventually(t, 90*time.Second, "the ticket recorded merged and closed", func() bool {
		spec := f.specRunNow(t)
		return len(spec.Tickets) == 1 && spec.Tickets[0].MergedAt != nil && spec.Tickets[0].Closed
	})
	if gh.made(t, "issue close 231 --repo acme/edge-sensors") != 0 || gh.asked(t, "issue comment 231 ") != 0 {
		t.Errorf("the factory commented on or closed a ticket a person had closed")
	}
}

// A merged ticket whose close fails stays held, and a later poll closes it once GitHub answers.
func TestAMergedTicketIsHeldUntilItIsClosed(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	gh.openTicketPull(t, ticketIssue, ticketBranch, true)
	gh.unassigns(t, "acme/edge-sensors", ticketIssue, "factory-bot")
	gh.fail(t, "issue close 231 *")
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	f.ended(t, 1)
	closing := "issue close 231 --repo acme/edge-sensors"
	f.eventually(t, 30*time.Second, "a failed close", func() bool { return gh.asked(t, closing) >= 1 })
	reading := "api " + subIssuesRequest("acme/edge-sensors", specNumber)
	before := gh.made(t, reading)
	f.eventually(t, 20*time.Second, "several more polls", func() bool { return gh.made(t, reading) >= before+3 })
	var run apiRun
	f.get(t, "/api/runs/1", &run)
	if run.LetGoAt != nil {
		t.Fatalf("the ticket was let go while it is still open; the factory's log:\n%s", f.output(t))
	}
	gh.fail(t, "")
	f.eventually(t, 30*time.Second, "the ticket closed and let go", func() bool {
		run = apiRun{}
		f.get(t, "/api/runs/1", &run)
		return run.LetGoAt != nil
	})
	if spec := f.specRunNow(t); len(spec.Tickets) != 1 || !spec.Tickets[0].Closed {
		t.Errorf("the spec run lists the tickets %+v, want #231 closed", spec.Tickets)
	}
}

// A spec run whose ticket run the factory was killed in is idle after the restart, paused as it is:
// the run is recorded interrupted, and nothing works on the spec.
func TestASpecRunIsIdleAfterARestartThatEndedItsTicketRun(t *testing.T) {
	t.Parallel()
	data := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(SpecRun{ID: 1, Repository: "acme/edge-sensors", Spec: specNumber, Title: "A spec", Branch: specBranch,
		Base: "main", State: specHolding, Idle: false, Warnings: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "spec-1.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	f := start(t, config{"paused": true, "data_dir": data})
	if spec := f.specRunNow(t); spec.State != specHolding || !spec.Idle {
		t.Errorf("spec run 1 is %s with idle=%v after a restart, want holding and idle", spec.State, spec.Idle)
	}
}

// A ticket run that ends while a poll reads the line may have unblocked the next ticket of its spec.
// The line that poll read is stale, and the head of it is not started: the next poll reads the ticket
// unblocked and takes it before the routed issue beside the spec.
func TestARunThatEndsWhileAPollReadsTheLineStartsNothingFromIt(t *testing.T) {
	t.Parallel()
	gh, data := ticketClaim(t)
	now := time.Now().UTC()
	gh.timeline(t, "acme/edge-sensors", claimedIssue, labeled("factory", now.Add(-6*time.Hour)))
	gh.assigns(t, "acme/edge-sensors", claimedIssue, "factory-bot")
	gh.issues(t, "acme/edge-sensors", openIssue(claimedIssue, claimedTitle, now.Add(-96*time.Hour)))
	next := gh.ticketOf(t, 233, "Close the ticket after")
	blocked := gh.ticketOf(t, 233, "Close the ticket after")
	blocked["issue_dependencies_summary"] = map[string]any{"blocked_by": 1, "blocking": 0}
	gh.openTicketPull(t, 233, "feat/233-close-the-ticket-after", false)
	gh.subIssues(t, gh.ticketOf(t, ticketIssue, ticketTitle), blocked)
	gh.workerWaits(t, 3*time.Second)
	f := gh.work(t, ticketConfig(data, nil, map[string]any{"validators": []string{"senior"}}))
	f.eventually(t, 60*time.Second, "run 1 to start", func() bool { return len(gh.workers(t)) > 0 })

	// A poll reads #233 still blocked, then waits in its read of #231's events while run 1 merges
	// #231 and ends. #231 was touched since the last poll, so that poll reads its events again.
	gh.hold(t, "api --paginate "+eventsRequest("acme/edge-sensors", ticketIssue))
	touched := gh.ticketOf(t, ticketIssue, ticketTitle)
	touched["updated_at"] = time.Now().UTC().Format(time.RFC3339)
	gh.subIssues(t, touched, blocked)
	f.eventually(t, 30*time.Second, "a poll inside the read of the ticket", func() bool { return gh.holdingAny(t) })
	first := f.ended(t, 1)
	if first.Issue != ticketIssue || first.Outcome != outcomeMerged {
		t.Fatalf("run 1 worked #%d and ended %q (%s), want ticket #%d merged; the factory's log:\n%s", first.Issue, first.Outcome, first.Reason, ticketIssue, f.output(t))
	}
	gh.subIssues(t, closedIssue(gh.ticketOf(t, ticketIssue, ticketTitle)), next)
	gh.release(t)

	second := f.ended(t, 2)
	if second.Issue != 233 || second.Spec != specNumber {
		t.Errorf("run 2 worked #%d of spec #%d, want the ticket #233 the end of run 1 unblocked", second.Issue, second.Spec)
	}
}
