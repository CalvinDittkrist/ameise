package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The validate stage: once the ci stage reads the pull request green, the validators the repository
// names read the branch's diff beside each other and read-only; a fix session answers their findings,
// and the run goes back through the ci stage until they pass or the fix rounds are spent.

// validateClaim is panelClaim without a canned reading of the pull request: the gh shim then reads it
// green at the commit the branch is at on the remote, so a fix the factory pushes is the next head.
func validateClaim(t *testing.T) (*ghShim, string) {
	t.Helper()
	gh := newGhShim(t)
	gh.routed(t, "acme/edge-sensors", claimedIssue, claimedTitle)
	gh.loggedInAs(t, "factory-bot")
	gh.assigns(t, "acme/edge-sensors", claimedIssue, "factory-bot")
	gh.workerCommits(t, "worked.md")
	gh.env = append(gh.env, "GIT_AUTHOR_NAME=factory", "GIT_AUTHOR_EMAIL=factory@example.com",
		"GIT_COMMITTER_NAME=factory", "GIT_COMMITTER_EMAIL=factory@example.com")
	gh.gateIs(t, "acme/edge-sensors", "@echo the gate of the validated branch passes")
	data := filepath.Join(t.TempDir(), "data")
	gh.cloneInto(t, data, "acme/edge-sensors")
	return gh, data
}

// validateConfig is a configuration whose panel is the code reviewer alone and whose validators are the
// ones given, with the validate knobs given beside them.
func validateConfig(data string, validators []string, knobs map[string]any) config {
	c := ciConfig(data, nil)
	c["review"] = map[string]any{"reviewers": []string{"code"}}
	validate := map[string]any{"validators": validators}
	for k, v := range knobs {
		validate[k] = v
	}
	c["validate"] = validate
	return c
}

// validatorSessionsOf is the sessions of the claude shim's reviewer log that ran as that reviewer.
func validatorSessionsOf(t *testing.T, gh *ghShim, name string) []workerStart {
	t.Helper()
	out := []workerStart{}
	for _, s := range gh.reviewerSessions(t) {
		if agent, _ := agentOf(t, s); agent == name+"-reviewer" {
			out = append(out, s)
		}
	}
	return out
}

// sessionsAt is the sessions a run recorded at one stage, by their label.
func sessionsAt(run apiRun, stage string) []string {
	out := []string{}
	for _, s := range run.Sessions {
		if s.Stage == stage {
			out = append(out, s.Label)
		}
	}
	return out
}

// A repository that names two validators has both read the green pull request, the Claude one and the
// one on Codex beside each other, read-only, in the run's worktree, briefed with the base and the head;
// both pass and the run ends ready, its record and events carrying the round.
func TestTwoValidatorsReadTheGreenPullRequestBesideEachOther(t *testing.T) {
	t.Parallel()
	gh, data := validateClaim(t)
	codex := gh.hasCodex(t)
	// The senior validator reports only once the Codex validator has been started, which a stage that
	// ran them one after the other never does.
	gh.verdict(t, "senior", 1, "AWAIT "+codex.log+"\n"+findings(t))
	f := gh.work(t, validateConfig(data, []string{"senior", "codex"}, nil))
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady {
		t.Fatalf("the run ended as %q (%s), want ready; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	if !equal(run.Stages, []string{"implement", "gate", "review", "pr", "ci", "validate"}) || run.Stage != stageValidate {
		t.Errorf("the run went through the stages %v and ended in %q, want the validate stage after ci", run.Stages, run.Stage)
	}
	head := gh.head(t, "acme/edge-sensors", claimedBranch)
	v := run.Validation
	if v == nil || !v.Passed || len(v.Rounds) != 1 || v.Rounds[0].Head != head || len(v.Rounds[0].Verdicts) != 2 ||
		v.Rounds[0].Verdicts[0].Reviewer != "senior" || v.Rounds[0].Verdicts[1].Reviewer != "codex" {
		t.Fatalf("the run recorded the validation %+v, want one round at %s that senior and codex passed", v, short(head))
	}
	if labels := sessionsAt(run, stageValidate); !equal(labels, []string{"senior", "codex"}) {
		t.Errorf("the run recorded the validate sessions %v, want senior and codex", labels)
	}
	workers := gh.workers(t)
	senior := validatorSessionsOf(t, gh, "senior")
	if len(senior) != 1 || !senior[0].started("--tools", "Read,Grep,Glob") || senior[0].cwd != workers[0].cwd {
		t.Fatalf("the senior validator was started as %+v, want once, read-only, in the run's worktree %s", senior, workers[0].cwd)
	}
	calls := codex.calls(t)
	if len(calls) != 1 || calls[0].arg("--sandbox") != "read-only" || calls[0].cwd != senior[0].cwd {
		t.Fatalf("the factory made the Codex calls %+v, want one in the read-only sandbox of the worktree", calls)
	}
	brief := strings.Join(factoryBodies(run, "briefed the validators"), "\n")
	for _, want := range []string{"its base is main", "at " + short(head), "worked.md", "Issue #104"} {
		if !strings.Contains(brief, want) {
			t.Errorf("the validators' brief does not carry %q:\n%s", want, brief)
		}
	}
	if said := calls[0].args[len(calls[0].args)-1]; !strings.Contains(said, "read-only sandbox") || !strings.Contains(said, "Validate the branch") || !strings.Contains(said, "at "+short(head)) {
		t.Errorf("the Codex validator was briefed with %q, want the reviewer's prompt and the validation's brief at %s", said, short(head))
	}
	if titles := factoryTitles(run, "senior: pass", "codex: pass", "validation round 1 passed"); len(titles) != 3 {
		t.Errorf("the run's events carry %v, want each validator's verdict and the pass", titles)
	}
	if len(workers) != 1 || gh.made(t, pullPatched) != 0 {
		t.Errorf("the factory started %d worker sessions and wrote the pull request %d times, want the implement session alone and no write", len(workers), gh.made(t, pullPatched))
	}
}

// A branch that moves on the remote while the run waits on CI is validated at the commit CI passed: the
// worktree follows the pull request to it before the validators read it.
func TestTheValidatorsReadTheCommitCIPassed(t *testing.T) {
	t.Parallel()
	gh, data := validateClaim(t)
	gh.checksAre(t, claimedIssue, "", pending("gate"))
	f := gh.work(t, validateConfig(data, []string{"senior"}, nil))
	f.saw(t, "ci: "+ciWaiting)
	moved := gh.commitOn(t, "acme/edge-sensors", claimedBranch)
	gh.checksAre(t, claimedIssue, moved, passed("gate"))
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady {
		t.Fatalf("the run ended as %q (%s), want ready; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	if v := run.Validation; v == nil || !v.Passed || len(v.Rounds) != 1 || v.Rounds[0].Head != moved {
		t.Fatalf("the run recorded the validation %+v, want one round that passed at %s", v, short(moved))
	}
	if len(factoryTitles(run, "followed the branch to "+short(moved))) != 1 {
		t.Errorf("the run did not follow the branch to %s; the run's events: %v", short(moved), factoryTitles(run, ""))
	}
	if brief := strings.Join(factoryBodies(run, "briefed the validators"), "\n"); !strings.Contains(brief, "at "+short(moved)) {
		t.Errorf("the validators' brief does not name the commit CI passed, %s:\n%s", short(moved), brief)
	}
}

// pullPatched is the call that writes the body of the claim's pull request.
var pullPatched = fmt.Sprintf("api --method PATCH repos/acme/edge-sensors/pulls/%d --input -", claimedIssue)

// A validator that asks for fixes has one fix session given the findings of both validators, which
// commits; the factory pushes, reads the pull request again through the ci stage and validates again.
func TestAFixVerdictTakesOneFixSessionAndTheRunValidatesAgainAfterCI(t *testing.T) {
	t.Parallel()
	gh, data := validateClaim(t)
	codex := gh.hasCodex(t)
	gh.verdict(t, "senior", 1, findings(t, Finding{Severity: "S2", Path: "worked.md", Line: 1, Claim: "The retry is unbounded.", Why: "It never gives up.", Fix: "Bound it."}))
	codex.answers(t, 1, findings(t, Finding{Severity: "S1", Path: "worked.md", Line: 2, Claim: "The token is logged.", Why: "It leaks.", Fix: "Drop the log."}))
	gh.env = append(gh.env, "CLAUDE_SHIM_THEN_COMMIT=validated.md")
	gh.repairs(t, map[string]any{"outcome": "complete", "fixed": []string{"F1", "F2"}, "disputed": []any{}, "skipped": []any{}, "summary": "bounded and dropped"})
	f := gh.work(t, validateConfig(data, []string{"senior", "codex"}, nil))
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady {
		t.Fatalf("the run ended as %q (%s), want ready; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	if !equal(run.Stages, []string{"implement", "gate", "review", "pr", "ci", "validate", "ci", "validate"}) {
		t.Errorf("the run went through the stages %v, want ci and validate twice", run.Stages)
	}
	head := gh.head(t, "acme/edge-sensors", claimedBranch)
	v := run.Validation
	if v == nil || !v.Passed || len(v.Rounds) != 2 {
		t.Fatalf("the run recorded the validation %+v, want two rounds, the second passed", v)
	}
	first := v.Rounds[0]
	if len(fixing(first)) != 2 || first.Repair == nil || !equal(first.Repair.Fixed, []string{"F1", "F2"}) || first.Pushed != head || v.Rounds[1].Head != head {
		t.Errorf("the first round is %+v and the second at %s, want both validators asking, the fix of both findings pushed at %s and read again there", first, v.Rounds[1].Head, short(head))
	}
	workers := gh.workers(t)
	if len(workers) != 2 || workers[1].cwd != workers[0].cwd {
		t.Fatalf("the factory started %d worker sessions, want the implement session and one fix session in its worktree", len(workers))
	}
	fix := strings.Join(factoryBodies(run, "briefed the fix session of validation round 1, 1 of 2"), "\n")
	for _, want := range []string{"senior: F1 [S2] worked.md:1: The retry is unbounded.", "codex: F2 [S1] worked.md:2: The token is logged."} {
		if !strings.Contains(fix, want) {
			t.Errorf("the fix session's brief does not carry %q:\n%s", want, fix)
		}
	}
	if labels := sessionsAt(run, stageValidate); !equal(labels, []string{"senior", "codex", "", "senior", "codex"}) {
		t.Errorf("the run recorded the validate sessions %v, want both validators, the fix session, and both again", labels)
	}
	if len(factoryTitles(run, "pushed "+short(head))) != 1 {
		t.Errorf("the fix was not pushed to %s; the run's events: %v", claimedBranch, factoryTitles(run, ""))
	}
}

// With validate.rounds at two, the third validation that fails ends the run ready with a review request
// and a pull request body that names the failed validation in place of the one an earlier run wrote; no
// fourth validation and no third fix start.
func TestAValidationThatFailsPastItsRoundsEndsReadyNamingIt(t *testing.T) {
	t.Parallel()
	gh, data := validateClaim(t)
	gh.verdict(t, "senior", 0, findings(t, Finding{Severity: "S2", Path: "worked.md", Line: 1, Claim: "The retry is unbounded.", Why: "It never gives up.", Fix: "Bound it."}))
	gh.env = append(gh.env, "CLAUDE_SHIM_THEN_COMMIT=validated.md")
	gh.repairs(t, map[string]any{"outcome": "complete", "fixed": []string{"F1"}, "disputed": []any{}, "skipped": []any{}, "summary": "bounded"})
	gh.answer(t, fmt.Sprintf("api repos/acme/edge-sensors/pulls/%d --jq .body", claimedIssue),
		"Closes #104\n\nThe body the author wrote.\n\n"+validationStart+"\n## Validation\n\nThe failure of an earlier run.\n"+validationEnd+"\n")
	gh.reviewRequests(t, pullOfTheClaim, maintainers...)
	gh.comments(t, "acme/edge-sensors", claimedIssue)
	c := validateConfig(data, []string{"senior"}, map[string]any{"rounds": 2})
	c["notify"] = maintainers
	f := gh.work(t, c)
	run := f.ended(t, 1)
	if run.Outcome != outcomeReady || !strings.Contains(run.Reason, "after 2 of 2 fix rounds (validate.rounds)") || !strings.Contains(run.Reason, "senior") {
		t.Fatalf("the run ended as %q (%s), want ready naming the spent fix rounds and the validator; the factory's log:\n%s", run.Outcome, run.Reason, f.output(t))
	}
	if v := run.Validation; v == nil || v.Passed || len(v.Rounds) != 3 || v.fixes() != 2 {
		t.Fatalf("the run recorded the validation %+v, want three failing rounds and two fixes", v)
	}
	if senior, workers := validatorSessionsOf(t, gh, "senior"), gh.workers(t); len(senior) != 3 || len(workers) != 3 {
		t.Errorf("the factory started the senior validator %d times and %d worker sessions, want three validations and the implement session with two fixes", len(senior), len(workers))
	}
	var edit struct {
		Body string `json:"body"`
	}
	if err := json.Unmarshal([]byte(gh.wrote(t, pullPatched)), &edit); err != nil {
		t.Fatalf("the factory wrote %q to the pull request, want its body: %v", gh.wrote(t, pullPatched), err)
	}
	if !strings.HasPrefix(edit.Body, "Closes #104\n\nThe body the author wrote.") || !strings.Contains(edit.Body, "**The validation did not pass:**") ||
		!strings.Contains(edit.Body, "The retry is unbounded.") || strings.Count(edit.Body, "## Validation") != 1 || strings.Contains(edit.Body, "an earlier run") {
		t.Errorf("the pull request's body became %q, want the author's body with the failed validation and its findings after it, in place of the earlier one", edit.Body)
	}
	f.notified(t, 1)
	for _, who := range maintainers {
		if gh.made(t, reviewCall(pullOfTheClaim, who)) != 1 {
			t.Errorf("the factory did not ask %s for a review of %s", who, pullOfTheClaim)
		}
	}
}

// A validate object that names a validator the panel does not have, or no positive number of rounds,
// is refused at start with the fix.
func TestAnInvalidValidateObjectIsRefusedWithTheFix(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct{ config, want string }{
		"unknown validator":              {`{"data_dir":"data","repositories":["a/b"],"validate":{"validators":["codex","style"]}}`, `validate: validators carries "style", which is no reviewer; the validators are any of code, security, docs, tests, senior, codex`},
		"unknown validator of a repo":    {`{"data_dir":"data","repositories":[{"name":"a/b","validate":{"validators":["lint"]}}]}`, `the validate of a/b: validators carries "lint"`},
		"no fix round":                   {`{"data_dir":"data","repositories":["a/b"],"validate":{"validators":["codex"],"rounds":0}}`, `validate: rounds 0 is not a positive number of fix rounds; write it as 2`},
		"negative rounds of a repo":      {`{"data_dir":"data","repositories":[{"name":"a/b","validate":{"rounds":-1}}]}`, `the validate of a/b: rounds -1 is not a positive number`},
		"a validator named twice":        {`{"data_dir":"data","repositories":["a/b"],"validate":{"validators":["codex","codex"]}}`, `validators names "codex" twice`},
		"a knob the stage does not have": {`{"data_dir":"data","repositories":["a/b"],"validate":{"round":2}}`, `the validate knobs are validators, rounds`},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "factory.json")
			if err := os.WriteFile(path, []byte(c.config), 0o600); err != nil {
				t.Fatal(err)
			}
			output, err := factoryCommand(binary, "-config", path, "-fake").CombinedOutput()
			if err == nil {
				t.Fatalf("the factory started on %s, want a refusal", c.config)
			}
			if !strings.HasPrefix(string(output), "error: ") || !strings.Contains(string(output), c.want) {
				t.Errorf("the factory said %q, want an error line with %q", strings.TrimSpace(string(output)), c.want)
			}
		})
	}
}

// A validator on Codex on a host without it ends the run blocked, saying so, and starts no validator.
func TestAValidatorOnCodexOnAHostWithoutItBlocksTheRun(t *testing.T) {
	t.Parallel()
	gh, data := validateClaim(t)
	f := gh.work(t, validateConfig(data, []string{"senior", "codex"}, nil))
	run := f.ended(t, 1)
	if run.Outcome != outcomeBlocked || run.Stage != stageValidate || !strings.Contains(run.Reason, "the validator codex runs on Codex") ||
		!strings.Contains(run.Reason, "no codex command on the PATH") {
		t.Fatalf("the run ended as %q in %q (%s), want blocked in the validate stage naming the missing Codex; the factory's log:\n%s", run.Outcome, run.Stage, run.Reason, f.output(t))
	}
	if senior := validatorSessionsOf(t, gh, "senior"); len(senior) != 0 {
		t.Errorf("the factory started the senior validator %d times, want none: the validators the repository names cannot all run", len(senior))
	}
}

// A factory restarted while a run validated resumes it at the validate stage; one restarted after the
// run recorded a pass on the commit the branch is at does not validate it again; one restarted after a
// round that did not pass on that commit, and before its fix reported, runs the fix before validating.
// One that resumes after a run wrote a failed validation into the pull request takes it out on a pass.
func TestAResumedRunValidatesUnlessItsRecordCarriesAPass(t *testing.T) {
	t.Parallel()
	for _, at := range []string{"during the validation", "after a pass", "at the fix", "after a failure was written"} {
		t.Run(at, func(t *testing.T) {
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
			interrupted.PullRequest = pullOfTheClaim
			interrupted.Stages = []string{"implement", "gate", "review", "pr", "ci", "validate"}
			switch at {
			case "after a pass":
				interrupted.Validation = &Validation{Passed: true, Rounds: []Round{{Number: 1, Head: head, Verdicts: []Verdict{{Reviewer: "senior", Verdict: verdictPass, Findings: []Finding{}}}}}}
			case "at the fix":
				interrupted.Validation = &Validation{Rounds: []Round{{Number: 1, Head: head, Verdicts: []Verdict{{Reviewer: "senior", Verdict: verdictFix,
					Findings: []Finding{{ID: "F1", Severity: "S2", Path: "worked.md", Line: 1, Claim: "The retry is unbounded.", Why: "It never gives up.", Fix: "Bound it."}}}}}}}
				gh.env = append(gh.env, "GIT_AUTHOR_NAME=factory", "GIT_AUTHOR_EMAIL=factory@example.com",
					"GIT_COMMITTER_NAME=factory", "GIT_COMMITTER_EMAIL=factory@example.com", "CLAUDE_SHIM_THEN_COMMIT=validated.md")
				gh.repairs(t, map[string]any{"outcome": "complete", "fixed": []string{"F1"}, "disputed": []any{}, "skipped": []any{}, "summary": "bounded"})
			case "after a failure was written":
				interrupted.Validation = &Validation{Marked: true, Rounds: []Round{{Number: 1, Head: "0ld", Verdicts: []Verdict{{Reviewer: "senior", Verdict: verdictFix,
					Findings: []Finding{{ID: "F1", Severity: "S2", Path: "worked.md", Line: 1, Claim: "The retry is unbounded.", Why: "It never gives up.", Fix: "Bound it."}}}}}}}
				gh.answer(t, fmt.Sprintf("api repos/acme/edge-sensors/pulls/%d --jq .body", claimedIssue),
					"Closes #104\n\n"+validationStart+"\n## Validation\n\n**The validation did not pass:** it failed.\n"+validationEnd+"\n")
			}
			records(t, data, interrupted)
			gh.issues(t, "acme/edge-sensors")
			gh.issue(t, "acme/edge-sensors", assignedTo(openIssue(claimedIssue, claimedTitle, began.Add(-72*time.Hour)), "factory-bot"))
			gh.openPullsListed(t, "acme/edge-sensors", claimedBranch, claimedIssue)

			f := gh.work(t, validateConfig(data, []string{"senior"}, nil))
			resumed := f.ended(t, 2)
			if resumed.Signal != signalInterruption || resumed.Outcome != outcomeReady || resumed.Stage != stageValidate {
				t.Fatalf("run 2 is the %q run and ended as %q in %q (%s), want the resume ready in the validate stage; the factory's log:\n%s",
					resumed.Signal, resumed.Outcome, resumed.Stage, resumed.Reason, f.output(t))
			}
			senior := validatorSessionsOf(t, gh, "senior")
			workers := gh.workers(t)
			switch at {
			case "after a pass":
				if len(senior) != 0 || len(factoryTitles(resumed, "validated already at "+short(head))) != 1 {
					t.Errorf("the resume started the senior validator %d times, want none and an event that the pass stands", len(senior))
				}
			case "after a failure was written":
				v := resumed.Validation
				if len(senior) != 1 || v == nil || !v.Passed || v.Marked || len(v.Rounds) != 2 {
					t.Errorf("the resume started the senior validator %d times and recorded %+v, want a second round that passed and no mark", len(senior), v)
				}
				if body := gh.wrote(t, pullPatched); body != marshal(t, map[string]string{"body": "Closes #104"})+"\n" {
					t.Errorf("the factory wrote %q to the pull request, want the body without the failed validation", body)
				}
			case "during the validation":
				if len(senior) != 1 || resumed.Validation == nil || !resumed.Validation.Passed || resumed.Validation.Rounds[0].Head != head {
					t.Errorf("the resume started the senior validator %d times and recorded %+v, want one round that passed at %s", len(senior), resumed.Validation, short(head))
				}
			case "at the fix":
				if len(factoryTitles(resumed, "resuming at the fix of validation round 1")) != 1 {
					t.Errorf("the resume did not say it resumes at the fix; the run's events: %v", factoryTitles(resumed, ""))
				}
				if len(workers) != 1 {
					t.Errorf("the resume started %d worker sessions, want the one fix session", len(workers))
				}
				v := resumed.Validation
				if v == nil || len(v.Rounds) != 2 || v.Rounds[0].Repair == nil || !v.Passed || len(senior) != 1 {
					t.Errorf("the resume started the senior validator %d times and recorded %+v, want the fix of round 1 and one new round that passed", len(senior), v)
				}
				if labels := sessionsAt(resumed, stageValidate); len(labels) < 2 || labels[0] != "" {
					t.Errorf("the resume ran the validate sessions %v, want the fix session before any validator", labels)
				}
				return
			}
			if len(workers) != 0 {
				t.Errorf("the resume started %d worker sessions, want none: the work is done", len(workers))
			}
		})
	}
}
