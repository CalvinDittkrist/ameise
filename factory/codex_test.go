package main

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A reviewer runs on a runtime, and the reviewer codex runs on Codex ([ADR 0052]): `codex exec` in the
// run's worktree, read-only, held to the reviewer's schema, its last message read as its result with
// the checks a Claude reviewer's gets.
//
// [ADR 0052]: ../docs/adr/0052-sessions-run-on-a-runtime-and-codex-is-one-of-them.md

// codexShim is the codex of testdata/runtimes as a test sees it: the log of its exec calls and the
// directory of the last messages it writes by call.
type codexShim struct {
	log, results string
}

// hasCodex puts the codex shim on the PATH of this host, logged in, and answers with what it records.
func (g *ghShim) hasCodex(t *testing.T) *codexShim {
	t.Helper()
	dir := t.TempDir()
	c := &codexShim{log: filepath.Join(dir, "codex.log"), results: filepath.Join(dir, "results")}
	if err := os.MkdirAll(c.results, 0o700); err != nil {
		t.Fatal(err)
	}
	for i, entry := range g.env {
		if path, ok := strings.CutPrefix(entry, "PATH="); ok {
			g.env[i] = "PATH=" + abs(t, filepath.Join("testdata", "runtimes")) + string(os.PathListSeparator) + path
		}
	}
	g.env = append(g.env, "CODEX_SHIM_LOG="+c.log, "CODEX_SHIM_RESULTS="+c.results)
	return c
}

// lacksCodex takes every codex of this host off the PATH the shim gives the factory, so a test of a
// host without Codex holds on a host that has it installed. A directory on the PATH that holds a codex
// is stood in for by a directory of links to everything else in it.
func (g *ghShim) lacksCodex(t *testing.T) {
	t.Helper()
	for i, entry := range g.env {
		path, ok := strings.CutPrefix(entry, "PATH=")
		if !ok {
			continue
		}
		dirs := filepath.SplitList(path)
		for j, dir := range dirs {
			if _, err := os.Stat(filepath.Join(dir, "codex")); err != nil {
				continue
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			mirror := t.TempDir()
			for _, e := range entries {
				if e.Name() == "codex" {
					continue
				}
				if err := os.Symlink(filepath.Join(dir, e.Name()), filepath.Join(mirror, e.Name())); err != nil {
					t.Fatal(err)
				}
			}
			dirs[j] = mirror
		}
		g.env[i] = "PATH=" + strings.Join(dirs, string(os.PathListSeparator))
	}
}

// answers has the n-th Codex session end on this last message.
func (c *codexShim) answers(t *testing.T, n int, message string) {
	t.Helper()
	writeFile(t, filepath.Join(c.results, strconv.Itoa(n)), message)
}

// codexCall is one exec call of the codex shim.
type codexCall struct {
	cwd, stdin, schema string
	args               []string
}

// arg is the value that follows a flag of the call, and empty when the call has no such flag.
func (c codexCall) arg(flag string) string {
	if i := slices.Index(c.args, flag); i >= 0 && i+1 < len(c.args) {
		return c.args[i+1]
	}
	return ""
}

// calls is every exec call of the codex shim, in order.
func (c *codexShim) calls(t *testing.T) []codexCall {
	t.Helper()
	raw, err := os.ReadFile(c.log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	out := []codexCall{}
	last := ""
	for _, line := range strings.Split(string(raw), "\n") {
		field, value, _ := strings.Cut(line, " ")
		if field == "call" {
			out = append(out, codexCall{})
			last = field
			continue
		}
		if len(out) == 0 {
			continue
		}
		call := &out[len(out)-1]
		switch field {
		case "cwd":
			call.cwd = value
		case "stdin":
			call.stdin = value
		case "schema":
			call.schema = value
		case "arg":
			call.args = append(call.args, value)
		default:
			// A line of no field is the next line of an argument or of standard input that has more
			// than one, a brief's.
			switch last {
			case "arg":
				call.args[len(call.args)-1] += "\n" + line
			case "stdin":
				call.stdin += "\n" + line
			}
			continue
		}
		last = field
	}
	return out
}

// codexPanel is the configuration of a run whose panel is the code reviewer and the reviewer on Codex.
func codexPanel(data string) config {
	c := ciConfig(data, nil)
	c["review"] = map[string]any{"reviewers": []string{"code", "codex"}}
	return c
}

// A repository whose panel names codex runs a Codex reviewer beside the Claude one in every round: in
// the run's worktree, in the read-only sandbox, with the reviewer's schema as the output schema file,
// its last message to a file, its model named and its standard input closed. Its findings go to the
// round and to the fix session like any reviewer's, and the record names the runtime and the model of
// every session.
func TestACodexReviewerRunsInThePanelBesideTheClaudeReviewers(t *testing.T) {
	t.Parallel()
	gh, data := panelClaim(t, "@echo the gate of the panel passes")
	codex := gh.hasCodex(t)
	codex.answers(t, 1, findings(t, Finding{Severity: "S2", Path: "worked.md", Line: 1, Claim: "The sum overflows.", Why: "An int of 32 bits.", Fix: "Use int64."}))
	gh.repairs(t, map[string]any{"outcome": "complete", "fixed": []string{}, "skipped": []map[string]any{},
		"disputed": []map[string]any{{"finding": "F1", "reason": "The values are bounded by 100."}}, "summary": "disputed the overflow"})
	f := gh.work(t, codexPanel(data))
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady {
		t.Fatalf("the run ended as %q (%s), want ready; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	calls := codex.calls(t)
	if len(calls) != 2 {
		t.Fatalf("the factory started %d Codex sessions, want one in each of the two rounds", len(calls))
	}
	worktree := resolved(t, run.Worktree)
	for i, call := range calls {
		if call.args[0] != "exec" || call.arg("--sandbox") != "read-only" || call.arg("--cd") != run.Worktree || call.cwd != worktree ||
			!slices.Contains(call.args, "--json") || !slices.Contains(call.args, "--ephemeral") ||
			!slices.Contains(call.args, "--ignore-user-config") || !slices.Contains(call.args, "--ignore-rules") {
			t.Errorf("Codex session %d ran in %s with %v, want codex exec --json in the read-only sandbox of the worktree %s, without the user's configuration and rules", i+1, call.cwd, call.args, worktree)
		}
		if call.arg("--output-schema") == "" || call.schema != reviewSchema {
			t.Errorf("Codex session %d was held to the schema file %q holding %q, want the reviewer's schema", i+1, call.arg("--output-schema"), call.schema)
		}
		if call.arg("-o") == "" || call.arg("-m") != codexModel || call.arg("-c") != `model_reasoning_effort="`+codexReasoning+`"` {
			t.Errorf("Codex session %d wrote its last message to %q on the model %q with the override %q, want a file, %s and the reasoning effort %s",
				i+1, call.arg("-o"), call.arg("-m"), call.arg("-c"), codexModel, codexReasoning)
		}
		if last := call.args[len(call.args)-1]; last != "-" {
			t.Errorf("Codex session %d took the prompt argument %q, want - for its prompt on standard input", i+1, last)
		}
		if !strings.Contains(call.stdin, "read-only sandbox") || !strings.Contains(call.stdin, "Review round") {
			t.Errorf("Codex session %d read %q on its standard input, want the reviewer's prompt and the round's brief, closed after it", i+1, call.stdin)
		}
	}
	if len(run.Panel.Rounds) != 2 {
		t.Fatalf("the panel recorded %d rounds, want 2", len(run.Panel.Rounds))
	}
	first := run.Panel.Rounds[0]
	var verdicts []string
	for _, v := range first.Verdicts {
		verdicts = append(verdicts, v.Reviewer+"="+v.Verdict)
	}
	if !equal(verdicts, []string{"code=pass", "codex=fix"}) || len(first.Verdicts[1].Findings) != 1 || first.Verdicts[1].Findings[0].Claim != "The sum overflows." {
		t.Errorf("round 1 recorded %v with %+v, want the code reviewer's pass and codex's finding", verdicts, first.Verdicts)
	}
	if first.Repair == nil || len(first.Repair.Disputed) != 1 || first.Repair.Disputed[0].Finding != "F1" {
		t.Errorf("the fix session of round 1 reported %+v, want codex's finding F1 disputed", first.Repair)
	}
	if second := run.Panel.Rounds[1]; len(second.Verdicts) != 1 || second.Verdicts[0].Reviewer != "codex" || second.Verdicts[0].Verdict != verdictPass {
		t.Errorf("round 2 recorded %+v, want codex alone, passing", second.Verdicts)
	}
	var codexSessions, claudeSessions int
	for _, s := range run.Sessions {
		switch {
		case s.Label == "codex" && s.Runtime == runtimeCodex && s.Model == codexModel && s.Stage == stageReview:
			codexSessions++
		case s.Runtime == runtimeClaude && s.Model != "":
			claudeSessions++
		default:
			t.Errorf("the run records the session %+v, want each on its runtime with its model", s)
		}
	}
	if codexSessions != 2 || claudeSessions < 4 {
		t.Errorf("the run records %d Codex and %d Claude sessions (%+v), want 2 Codex reviewers beside the implement, code reviewer, fix and author sessions", codexSessions, claudeSessions, run.Sessions)
	}
	// Every Claude Code session of the shim writes to the cache in hundreds, and each Codex session
	// writes 1001 tokens, so the two Codex sessions leave 2 in the last two digits.
	if run.Tokens.CacheCreation%100 != 2 {
		t.Errorf("the run counts %d tokens written to the cache, want the 1001 of each of the 2 Codex sessions among them", run.Tokens.CacheCreation)
	}
	started := false
	for _, e := range run.Events {
		if e.Title == "codex: worker started" && strings.HasPrefix(e.Body, "runtime codex, model "+codexModel) {
			started = true
		}
	}
	if !started {
		t.Errorf("the run's log names no Codex session with its runtime and model")
	}
	for _, e := range run.Events {
		if e.Kind == "error" && strings.HasPrefix(e.Title, "codex: ") {
			t.Errorf("the run records the error %q of a Codex session that succeeded, want none", e.Title)
		}
	}
}

// A last message that is not an object of the reviewer's schema fails the run and names the reviewer,
// as a Claude reviewer's result that does not fit does.
func TestACodexReviewerWhoseLastMessageDoesNotFitFailsTheRun(t *testing.T) {
	t.Parallel()
	for name, message := range map[string]string{
		"no findings": `{"verdict":"fix"}`,
		"not JSON":    `The change looks fine to me.`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			gh, data := panelClaim(t, "@true")
			codex := gh.hasCodex(t)
			codex.answers(t, 1, message)
			f := gh.work(t, codexPanel(data))
			run := f.ended(t, 1)
			if run.Outcome != outcomeFailed || !strings.HasPrefix(run.Reason, "the codex reviewer: ") || !strings.Contains(run.Reason, "does not fit the schema") {
				t.Fatalf("the run ended as %q (%s), want failed naming the codex reviewer and the misfit; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
			}
		})
	}
}

// A host without codex, or with codex and no login, cannot run the panel the repository names: the run
// ends blocked with that reason before a reviewer starts, and the comment mentions the logins in notify.
func TestARunThatNeedsCodexOnAHostWithoutItIsBlocked(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct {
		codex    bool
		loggedIn bool
		said     string
	}{
		"codex is missing":       {false, false, "no codex command on the PATH"},
		"codex is not logged in": {true, false, "Codex is not logged in on this host"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			gh, data := panelClaim(t, "@true")
			var codex *codexShim
			if c.codex {
				codex = gh.hasCodex(t)
				gh.env = append(gh.env, "CODEX_SHIM_LOGGED_OUT=1")
			} else {
				gh.lacksCodex(t)
			}
			gh.comments(t, "acme/edge-sensors", claimedIssue)
			cfg := codexPanel(data)
			cfg["notify"] = maintainers
			f := gh.work(t, cfg)
			run := f.ended(t, 1)
			if run.Outcome != outcomeBlocked || run.Stage != stageReview || !strings.Contains(run.Reason, c.said) || !strings.Contains(run.Reason, "codex login") {
				t.Fatalf("the run ended as %q in %q (%s), want blocked in the review saying %q and how to log in; the factory's log:\n%s",
					run.Outcome, run.Stage, run.Reason, c.said, f.output(t))
			}
			if reviewers := gh.reviewerSessions(t); len(reviewers) != 0 {
				t.Errorf("the factory started %d reviewers, want none: the panel the repository names cannot run", len(reviewers))
			}
			if codex != nil && len(codex.calls(t)) != 0 {
				t.Errorf("the factory started a Codex session on a host where it is not logged in")
			}
			f.notified(t, 1)
			said := gh.commented(t, "acme/edge-sensors", claimedIssue)
			if !strings.Contains(said, c.said) || !strings.Contains(said, "@ada") || !strings.Contains(said, "@linus") {
				t.Errorf("the comment on the issue is %q, want the reason and the logins of notify", said)
			}
		})
	}
}

// claimsWithCodexQuota is claimsWithQuota on a host with codex, whose repository's panel names it, and
// whose quota-axi answers for Codex from its own plan.
func claimsWithCodexQuota(t *testing.T, q *quotaShim, codexPlan []string, env ...string) (*factory, *codexShim) {
	t.Helper()
	dir := t.TempDir()
	codex := &codexShim{log: filepath.Join(dir, "codex.log")}
	writeFile(t, filepath.Join(dir, "codex-plan"), strings.Join(codexPlan, "\n")+"\n")
	path := "PATH=" + abs(t, filepath.Join("testdata", "runtimes")) + string(os.PathListSeparator) + abs(t, "testdata") + string(os.PathListSeparator) + os.Getenv("PATH")
	env = append(env, path, "CODEX_SHIM_LOG="+codex.log, "QUOTA_SHIM_CODEX_PLAN="+filepath.Join(dir, "codex-plan"))
	f, _ := claimsWithQuota(t, q, config{"review": map[string]any{"reviewers": []string{"code", "codex"}}}, env...)
	return f, codex
}

// codexChecks is the calls of quota-axi for the Codex provider.
func codexChecks(t *testing.T, q *quotaShim) []quotaCall {
	t.Helper()
	out := []quotaCall{}
	for _, call := range q.calls(t) {
		if call.args == "--provider codex --json" {
			out = append(out, call)
		}
	}
	return out
}

// Before a run whose panel names codex the check reads the Codex provider of the same quota-axi beside
// Claude's, and a Codex scope below the minimum holds the run back until its reset.
func TestTheCodexQuotaHoldsARunWhosePanelNamesCodexBack(t *testing.T) {
	t.Parallel()
	q := newQuotaShim(t, "all=80 opus=80 sonnet=80 reset=+3600")
	f, codex := claimsWithCodexQuota(t, q, []string{"all=80 gpt-6-sol=5 reset=+3", "all=80 gpt-6-sol=60 reset=+3600"})
	until := f.waitsForQuota(t)
	if !f.missing(t, 1) {
		t.Fatalf("a run started while the factory waits for the Codex quota; the factory's log:\n%s", f.output(t))
	}
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady || run.StartedAt.Before(until) || len(run.Warnings) != 0 {
		t.Fatalf("the run ended as %q (%s) with the warnings %q, started at %s, want ready after the reset at %s; the factory's log:\n%s",
			run.Outcome, run.Reason, run.Warnings, run.StartedAt, until, f.output(t))
	}
	if checks := codexChecks(t, q); len(checks) != 2 {
		t.Errorf("the factory asked quota-axi for Codex %d times, want twice: before the reset and after it", len(checks))
	}
	if !strings.Contains(f.output(t), "5 % of codex model:gpt-6-sol is left") {
		t.Errorf("the factory's log does not say it waited for the Codex scope model:gpt-6-sol of %s:\n%s", codexModel, f.output(t))
	}
	if len(codex.calls(t)) != 1 {
		t.Errorf("the run started %d Codex sessions, want its one reviewer", len(codex.calls(t)))
	}
}

// A Codex reading that fails lets the run start, with a warning that says the Codex quota was not read.
func TestARunStartsWithAWarningWhenTheCodexQuotaCheckFails(t *testing.T) {
	t.Parallel()
	q := newQuotaShim(t, "all=80 opus=80 sonnet=80 reset=+3600")
	f, _ := claimsWithCodexQuota(t, q, []string{"fail"})
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady {
		t.Fatalf("the run ended as %q (%s), want ready: a failed check starts the run; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	if len(run.Warnings) != 1 || !strings.Contains(run.Warnings[0], "quota check failed") || !strings.Contains(run.Warnings[0], "Codex quota") {
		t.Errorf("the run carries the warnings %q, want one that says the check of the Codex quota failed", run.Warnings)
	}
}

// A Codex session whose turn fails on the usage limit ends the run quota when quota-axi reads the Codex
// quota used up, and the factory resumes the issue after the reset, as it does a Claude quota run.
func TestACodexSessionOnItsUsageLimitEndsTheRunQuotaAndIsResumed(t *testing.T) {
	t.Parallel()
	q := newQuotaShim(t, "all=80 opus=80 sonnet=80 reset=+3600")
	f, codex := claimsWithCodexQuota(t, q, []string{"all=80 reset=+3600", "all=0 reset=+3", "all=100 reset=+3600"}, "CODEX_SHIM_USAGE_LIMIT=1")
	first := f.ended(t, 1)
	if first.Outcome != outcomeQuota || !strings.Contains(first.Reason, "usage limit") || !strings.Contains(first.Reason, "Codex quota") {
		t.Fatalf("the run ended as %q (%s), want quota on the Codex usage limit; the factory's log:\n%s", first.Outcome, first.Reason, f.output(t))
	}
	until := f.waitsForQuota(t)
	second := f.ended(t, 2)
	if second.Signal != signalQuota || second.StartedAt.Before(until) || second.Worktree != first.Worktree {
		t.Fatalf("run 2 ran on the signal %q from %s in %s, want the resume after the reset at %s in %s; the factory's log:\n%s",
			second.Signal, second.StartedAt, second.Worktree, until, first.Worktree, f.output(t))
	}
	if len(codex.calls(t)) < 2 {
		t.Errorf("the factory started %d Codex sessions, want the one that ran out and the one of the resumed run", len(codex.calls(t)))
	}
}

// The class full asks all five reviewers because no class vouches for the change, and the reviewer on
// Codex the repository's panel adds as well: naming codex is never lost to a change outside every class.
func TestTheClassFullAsksTheCodexReviewerThePanelNames(t *testing.T) {
	t.Parallel()
	gh, data := panelClaim(t, "@true")
	codex := gh.hasCodex(t)
	c := ciConfig(data, nil)
	c["repositories"] = []map[string]any{{"name": "acme/edge-sensors", "review": map[string]any{
		"reviewers": []string{"code", "codex"},
		"classes":   []map[string]any{{"name": "src", "paths": []string{"src/**"}, "gate": []string{}, "reviewers": []string{"code"}}},
	}}}
	f := gh.work(t, c)
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady {
		t.Fatalf("the run ended as %q (%s), want ready; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	got := agents(t, gh)
	slices.Sort(got)
	if !equal(got, []string{"code", "docs", "security", "senior", "tests"}) {
		t.Errorf("the class full ran the Claude reviewers %v, want all five", got)
	}
	if len(codex.calls(t)) != 1 {
		t.Errorf("the class full started %d Codex reviewers, want the one the panel names", len(codex.calls(t)))
	}
}

// A review the factory resumes goes on with the reviewers its panel recorded, so a Codex reviewer it
// recorded is read in the quota check before the resume even when the configuration no longer names
// codex, and its Codex scope below the minimum holds the resume back.
func TestTheCodexQuotaHoldsBackAResumedReviewWhosePanelRecordedCodex(t *testing.T) {
	t.Parallel()
	gh := newGhShim(t)
	gh.remote(t, "acme/edge-sensors")
	gh.loggedInAs(t, "factory-bot")
	data := filepath.Join(t.TempDir(), "data")
	clone := gh.cloneInto(t, data, "acme/edge-sensors")
	gh.branchAt(t, "acme/edge-sensors", claimedBranch, gh.head(t, "acme/edge-sensors", "main"))
	head := gh.commitOn(t, "acme/edge-sensors", claimedBranch)
	began := time.Now().UTC().Add(-2 * time.Hour)
	interrupted := record(1, claimedIssue, claimedTitle, signalRouted, outcomeInterrupted, true, began, began.Add(30*time.Minute))
	interrupted.Worktree = filepath.Join(clone, ".claude", "worktrees", claimedWorktree)
	interrupted.Stages = []string{"implement", "review"}
	interrupted.Panel = &Panel{Gate: "gate_result: pass (exit 0) at " + head[:7], GatedAt: head, Head: head,
		Classes: []Classed{{Class: "full", For: classForReview, Head: head, Reviewers: []string{"code", "codex"}}}}
	records(t, data, interrupted)
	gh.issues(t, "acme/edge-sensors")
	gh.issue(t, "acme/edge-sensors", assignedTo(openIssue(claimedIssue, claimedTitle, began.Add(-72*time.Hour)), "factory-bot"))

	q := newQuotaShim(t, "all=80 opus=80 sonnet=80 reset=+3600")
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "codex-plan"), "all=80 gpt-6-sol=5 reset=+3600\n")
	c := ciConfig(data, nil)
	c["quota_axi"] = q.path
	f := launch(t, c, append(append(gh.env, q.env...), "QUOTA_SHIM_CODEX_PLAN="+filepath.Join(dir, "codex-plan")))
	f.waitsForQuota(t)
	if !f.missing(t, 2) {
		t.Fatalf("the resume started while the Codex scope its recorded panel spends is below the minimum; the factory's log:\n%s", f.output(t))
	}
	if len(codexChecks(t, q)) == 0 {
		t.Errorf("the factory did not ask quota-axi for Codex before resuming a review whose panel recorded codex")
	}
}
