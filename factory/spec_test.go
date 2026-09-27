package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The spec and the spec branch every test of a spec run starts from.
const (
	specNumber = 230
	specTitle  = "Spec runs on the factory"
	specBranch = "spec/230-spec-runs-on-the-factory"
)

// apiSpecRun is a spec run as the interface serves it.
type apiSpecRun struct {
	ID         int        `json:"id"`
	Repository string     `json:"repository"`
	Spec       int        `json:"spec"`
	Branch     string     `json:"branch"`
	Base       string     `json:"base"`
	State      string     `json:"state"`
	Idle       bool       `json:"idle"`
	ClaimedAt  *time.Time `json:"claimedAt"`
	LetGoAt    *time.Time `json:"letGoAt"`
	Reason     string     `json:"reason"`
	Events     []Event    `json:"events"`
}

// routedSpecFixture is one repository with one spec routed to a spec run under the routing label, and
// nothing routed besides it. The reading of the held spec answers it assigned to the factory, with
// both of its labels.
func (g *ghShim) routedSpecFixture(t *testing.T, repository, label string) issueJSON {
	t.Helper()
	now := time.Now().UTC()
	g.remote(t, repository)
	g.answer(t, "api "+issuesRequest(repository, label), "[]")
	spec := openIssue(specNumber, specTitle, now.Add(-72*time.Hour), specLabel, specRunLabel(label))
	g.answer(t, "api "+specsRequest(repository, label), marshal(t, []issueJSON{spec}))
	g.timeline(t, repository, specNumber, labeled(specRunLabel(label), now.Add(-time.Hour)))
	g.loggedInAs(t, "factory-bot")
	g.assigns(t, repository, specNumber, "factory-bot")
	held := openIssue(specNumber, specTitle, now.Add(-72*time.Hour), specLabel, specRunLabel(label))
	g.issue(t, repository, assignedTo(held, "factory-bot"))
	return spec
}

// specRuns is what /api/specs serves.
func (f *factory) specRuns(t *testing.T) []apiSpecRun {
	t.Helper()
	var specs []apiSpecRun
	f.get(t, "/api/specs", &specs)
	return specs
}

// specRunIn waits until the first spec run is in the state, and answers with it and its events.
func (f *factory) specRunIn(t *testing.T, state string) apiSpecRun {
	t.Helper()
	f.eventually(t, 20*time.Second, "a spec run "+state, func() bool {
		specs := f.specRuns(t)
		return len(specs) > 0 && specs[0].State == state
	})
	var spec apiSpecRun
	f.get(t, "/api/specs/1", &spec)
	return spec
}

func titles(events []Event) []string {
	out := []string{}
	for _, e := range events {
		out = append(out, e.Title)
	}
	return out
}

func TestARoutedSpecIsClaimedOnItsSpecBranchAndHeldAcrossPollsAndARestart(t *testing.T) {
	t.Parallel()
	gh := newGhShim(t)
	gh.routedSpecFixture(t, "acme/edge-sensors", "factory")
	base := gh.head(t, "acme/edge-sensors", "main")
	data := filepath.Join(t.TempDir(), "data")
	c := config{"poll": "50ms", "data_dir": data, "repositories": []string{"acme/edge-sensors"}}

	f := gh.work(t, c)
	spec := f.specRunIn(t, "holding")
	if head := gh.head(t, "acme/edge-sensors", specBranch); head != base {
		t.Errorf("%s is at %q on the remote, want the head of the base main (%s)", specBranch, head, base)
	}
	if spec.Branch != specBranch || spec.Base != "main" || spec.Spec != specNumber || spec.Repository != "acme/edge-sensors" {
		t.Errorf("the spec run records spec #%d of %s on %s from %s, want #%d of acme/edge-sensors on %s from main",
			spec.Spec, spec.Repository, spec.Branch, spec.Base, specNumber, specBranch)
	}
	if !spec.Idle || spec.ClaimedAt == nil {
		t.Errorf("the spec run is idle=%v with the claim at %v, want an idle holding with the time of its claim", spec.Idle, spec.ClaimedAt)
	}
	if !strings.Contains(strings.Join(titles(spec.Events), "\n"), "claimed "+specBranch) {
		t.Errorf("the spec run's events are %q, want the claim of %s among them", titles(spec.Events), specBranch)
	}
	assign := "issue edit 230 --repo acme/edge-sensors --add-assignee factory-bot"
	if gh.made(t, assign) != 1 {
		t.Errorf("the factory assigned the spec %d times, want once", gh.made(t, assign))
	}
	if len(gh.workers(t)) != 0 {
		t.Errorf("the claim of a spec started a session: %v", gh.workers(t))
	}
	if records, _ := filepath.Glob(filepath.Join(data, "run-*.json")); len(records) != 0 {
		t.Errorf("the claim of a spec made %d factory runs, want none: a spec run is no factory run", len(records))
	}

	// The spec is assigned now, so the list of routed specs no longer carries it, and the factory reads
	// it as held on every poll.
	gh.answer(t, "api "+specsRequest("acme/edge-sensors", "factory"), "[]")
	reading := "api repos/acme/edge-sensors/issues/230"
	f.eventually(t, 20*time.Second, "several readings of the held spec", func() bool { return gh.made(t, reading) >= 3 })
	f.stop(t, syscall.SIGTERM)

	again := gh.work(t, c)
	before := gh.made(t, reading)
	again.eventually(t, 20*time.Second, "the restarted factory to read the held spec", func() bool { return gh.made(t, reading) >= before+3 })
	specs := again.specRuns(t)
	if len(specs) != 1 || specs[0].State != "holding" || specs[0].Branch != specBranch {
		t.Errorf("after a restart the factory has the spec runs %+v, want the one that holds %s", specs, specBranch)
	}
	for _, call := range gh.calls(t) {
		if strings.Contains(call, "--remove-assignee") {
			t.Errorf("the factory called `gh %s` on a spec it holds and nobody let go", call)
		}
	}
	if gh.made(t, assign) != 1 {
		t.Errorf("the factory assigned the spec %d times across a restart, want once", gh.made(t, assign))
	}
}

func TestTakingTheSpecRunLabelOffOrClosingTheSpecLetsItGoAndKeepsTheSpecBranch(t *testing.T) {
	t.Parallel()
	for _, gesture := range []struct {
		name     string
		decision string
		change   func(issueJSON) issueJSON
	}{
		{"the label taken off", "the spec-run label factory:spec-run was taken off the spec", func(i issueJSON) issueJSON {
			i["labels"] = []any{map[string]any{"name": specLabel}}
			return i
		}},
		{"the spec closed", "the spec was closed", closedIssue},
	} {
		t.Run(gesture.name, func(t *testing.T) {
			t.Parallel()
			gh := newGhShim(t)
			spec := gh.routedSpecFixture(t, "acme/edge-sensors", "factory")
			gh.unassigns(t, "acme/edge-sensors", specNumber, "factory-bot")
			f := gh.work(t, config{"poll": "50ms", "repositories": []string{"acme/edge-sensors"}})
			f.specRunIn(t, "holding")
			claimed := gh.head(t, "acme/edge-sensors", specBranch)

			gh.answer(t, "api "+specsRequest("acme/edge-sensors", "factory"), "[]")
			gh.issue(t, "acme/edge-sensors", gesture.change(assignedTo(spec, "factory-bot")))
			let := f.specRunIn(t, "let-go")

			if !strings.Contains(let.Reason, gesture.decision) || let.LetGoAt == nil {
				t.Errorf("the spec run was let go at %v for %q, want the decision %q", let.LetGoAt, let.Reason, gesture.decision)
			}
			if !strings.Contains(strings.Join(titles(let.Events), "\n"), "let go") {
				t.Errorf("the spec run's events are %q, want the letting-go among them", titles(let.Events))
			}
			if head := gh.head(t, "acme/edge-sensors", specBranch); head == "" || head != claimed {
				t.Errorf("%s is at %q after the letting-go, want it kept at %s", specBranch, head, claimed)
			}
			if gh.made(t, "issue edit 230 --repo acme/edge-sensors --remove-assignee factory-bot") != 1 {
				t.Errorf("the factory took its assignee off the spec %d times, want once; its calls: %v",
					gh.made(t, "issue edit 230 --repo acme/edge-sensors --remove-assignee factory-bot"), gh.calls(t))
			}
			for _, call := range gh.calls(t) {
				if strings.Contains(call, "--method DELETE") {
					t.Errorf("letting a spec go called `gh %s`; the spec branch stays", call)
				}
			}
		})
	}
}

func TestARoutedSpecWhoseBranchStandsIsLostAndTouchesNothing(t *testing.T) {
	t.Parallel()
	gh := newGhShim(t)
	gh.routedSpecFixture(t, "acme/edge-sensors", "factory")
	// A spec branch of an earlier spec run, under a title the spec no longer has.
	earlier := gh.commitOn(t, "acme/edge-sensors", "main")
	gh.branchAt(t, "acme/edge-sensors", "spec/230-an-older-title", earlier)

	f := gh.work(t, config{"poll": "50ms", "repositories": []string{"acme/edge-sensors"}})
	spec := f.specRunIn(t, "lost")
	if spec.Branch != "spec/230-an-older-title" {
		t.Errorf("the lost spec run names %q, want the spec branch that stands on the remote", spec.Branch)
	}
	if head := gh.head(t, "acme/edge-sensors", "spec/230-an-older-title"); head != earlier {
		t.Errorf("the spec branch that stood is at %q, want it untouched at %s", head, earlier)
	}
	if head := gh.head(t, "acme/edge-sensors", specBranch); head != "" {
		t.Errorf("a lost claim created %s at %s", specBranch, head)
	}
	// The spec stays routed, and the lost spec run is the answer to that routing: several more polls
	// claim nothing.
	asked := "api " + specsRequest("acme/edge-sensors", "factory")
	before := gh.made(t, asked)
	f.eventually(t, 20*time.Second, "several more polls", func() bool { return gh.made(t, asked) >= before+5 })
	if specs := f.specRuns(t); len(specs) != 1 {
		t.Errorf("the factory made %d spec runs of one routing, want the one lost", len(specs))
	}
	for _, call := range gh.calls(t) {
		if strings.HasPrefix(call, "issue edit ") || strings.Contains(call, "git/refs") {
			t.Errorf("a lost spec claim called `gh %s`; it touches nothing", call)
		}
	}
}

func TestATicketWhoseParentCarriesTheSpecRunLabelNeverEntersTheQueue(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	withParent := func(i issueJSON) issueJSON {
		i["parent_issue_url"] = "https://api.github.com/repos/acme/edge-sensors/issues/" + strconv.Itoa(i["number"].(int)+100)
		return i
	}
	gh := newGhShim(t)
	gh.remote(t, "acme/edge-sensors")
	gh.issues(t, "acme/edge-sensors",
		withParent(openIssue(40, "A ticket of a spec run", now.Add(-4*time.Hour))),
		withParent(openIssue(41, "A ticket of a normal run", now.Add(-3*time.Hour))),
		withParent(openIssue(42, "A ticket whose parent cannot be read", now.Add(-2*time.Hour))),
		openIssue(43, "An issue without a parent", now.Add(-time.Hour)))
	for _, n := range []int{40, 41, 42, 43} {
		gh.timeline(t, "acme/edge-sensors", n)
	}
	gh.answer(t, "api "+parentRequest("acme/edge-sensors", 40), marshal(t, openIssue(140, "A spec run", now, specLabel, "factory:spec-run")))
	gh.answer(t, "api "+parentRequest("acme/edge-sensors", 41), marshal(t, openIssue(141, "A spec", now, specLabel)))
	// Nothing answers the parent of 42, which is how the shim fails a call.

	f := gh.start(t, config{"poll": "50ms", "repositories": []string{"acme/edge-sensors"}})
	f.queue(t, 2)
	asked := "api " + issuesRequest("acme/edge-sensors", "factory")
	f.eventually(t, 20*time.Second, "several polls", func() bool { return gh.made(t, asked) >= 5 })
	if got := keys(f.queue(t, 2)); !equal(got, []string{"acme/edge-sensors#41", "acme/edge-sensors#43"}) {
		t.Errorf("the line holds %v, want the ticket of a normal run and the issue without a parent", got)
	}
	warned := strings.Count(f.output(t), "the parent of acme/edge-sensors#42 could not be read")
	if warned != 1 {
		t.Errorf("the unreadable parent of #42 was warned about %d times over several polls, want once; the log:\n%s", warned, f.output(t))
	}
	if gh.made(t, "api "+parentRequest("acme/edge-sensors", 43)) != 0 {
		t.Errorf("the factory read the parent of an issue that has none")
	}
}

func TestAHostWithAnotherRoutingLabelDerivesTheSpecRunLabelFromIt(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	gh := newGhShim(t)
	gh.routedSpecFixture(t, "acme/edge-sensors", "robot")
	ticket := func(n int) issueJSON {
		i := openIssue(n, "Ticket "+strconv.Itoa(n), now.Add(-time.Hour), readyLabel, "robot")
		i["parent_issue_url"] = "https://api.github.com/repos/acme/edge-sensors/issues/" + strconv.Itoa(n+100)
		return i
	}
	gh.answer(t, "api "+issuesRequest("acme/edge-sensors", "robot"), marshal(t, []issueJSON{ticket(40), ticket(41)}))
	gh.timeline(t, "acme/edge-sensors", 40)
	gh.timeline(t, "acme/edge-sensors", 41)
	gh.answer(t, "api "+parentRequest("acme/edge-sensors", 40), marshal(t, openIssue(140, "Robot's spec", now, specLabel, "robot:spec-run")))
	gh.answer(t, "api "+parentRequest("acme/edge-sensors", 41), marshal(t, openIssue(141, "Another host's spec", now, specLabel, "factory:spec-run")))

	f := gh.start(t, config{"poll": "50ms", "label": "robot", "repositories": []string{"acme/edge-sensors"}})
	if got := keys(f.queue(t, 1)); !equal(got, []string{"acme/edge-sensors#41"}) {
		t.Errorf("the line of a host routed by robot holds %v, want the ticket whose parent carries factory:spec-run and not robot:spec-run", got)
	}
	if gh.made(t, "api repos/acme/edge-sensors/issues?labels=spec,robot%3Aspec-run&state=open&per_page=100") == 0 {
		t.Errorf("the factory never asked for the specs labelled robot:spec-run; its calls: %v", gh.calls(t))
	}

	// And unpaused it claims the spec that carries robot:spec-run.
	f.stop(t, syscall.SIGTERM)
	worked := gh.work(t, config{"poll": "50ms", "label": "robot", "repositories": []string{"acme/edge-sensors"},
		"data_dir": filepath.Join(t.TempDir(), "data")})
	gh.answer(t, "api "+issuesRequest("acme/edge-sensors", "robot"), "[]")
	if spec := worked.specRunIn(t, "holding"); spec.Branch != specBranch {
		t.Errorf("the spec run of a host routed by robot holds %q, want %s", spec.Branch, specBranch)
	}
}

// The factory's copy of the label vocabulary is the labels it reads by name. Each of them is a label
// of the workflow's vocabulary: one the planner's labels.sh creates in a repository that has none, and
// one the repository standard's label_json can create. The Python suite holds those two to each other.
func TestTheFactorysLabelsAreInTheWorkflowsVocabulary(t *testing.T) {
	t.Parallel()
	read := []string{readyLabel, defaultLabel, specLabel, specRunLabel(defaultLabel)}

	// labels.sh against a gh that has no label yet and creates every one it is asked for.
	bin := t.TempDir()
	stub := "#!/bin/sh\ncase \"$1 $2\" in\n\"label list\") echo '[]' ;;\n\"label create\") ;;\n*) exit 1 ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(stub), 0o700); err != nil {
		t.Fatal(err)
	}
	env := append(gitIsolation(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	planner := abs(t, filepath.Join("..", "plugins", "planner", "scripts", "labels.sh"))
	created := map[string]bool{}
	for _, line := range strings.Split(shell(t, t.TempDir(), `bash "$1"`, env, planner), "\n") {
		if names, ok := strings.CutPrefix(line, "created: "); ok {
			for _, name := range strings.Split(names, ",") {
				created[name] = true
			}
		}
	}
	for _, label := range read {
		if !created[label] {
			t.Errorf("the factory reads the label %q, which the planner's labels.sh does not create; it created %v", label, created)
		}
	}

	// label_json of the repository standard, asked for each label by name.
	standard := abs(t, filepath.Join("..", "plugins", "repo-standards", "scripts", "lib.sh"))
	for _, label := range read {
		body := strings.TrimSpace(shell(t, t.TempDir(), `. "$1"; label_json "$2" | jq -r .name`, nil, standard, label))
		if body != label {
			t.Errorf("the factory reads the label %q, which label_json of the repository standard answers as %q", label, body)
		}
	}
}

// interruptedSpecRuns writes the records of two spec runs a factory left claiming when it stopped:
// spec run 1 had named its spec branch and logged two events, but its record counts one, as a record
// written before its last event does; spec run 2 had named nothing.
func interruptedSpecRuns(t *testing.T) string {
	t.Helper()
	data := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, r := range []SpecRun{
		{ID: 1, Repository: "acme/edge-sensors", Spec: specNumber, Title: specTitle, Branch: specBranch, Base: "main",
			State: "claiming", Warnings: []string{}, EventCount: 1},
		{ID: 2, Repository: "acme/edge-sensors", Spec: specNumber + 1, Title: "Another spec", State: "claiming", Warnings: []string{}},
	} {
		raw, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(data, "spec-"+strconv.Itoa(r.ID)+".json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for seq, title := range []string{"opened", "claiming " + specBranch} {
		if err := appendEvent(filepath.Join(data, "spec-1.events.jsonl"), seq+1, Event{Kind: "factory", Title: title}); err != nil {
			t.Fatal(err)
		}
	}
	return data
}

func TestASpecRunTheFactoryStoppedInBeforeNamingItsBranchIsFailedOnRestartAndOneThatNamedItWaits(t *testing.T) {
	t.Parallel()
	f := start(t, config{"paused": true, "data_dir": interruptedSpecRuns(t)})

	var named, untouched apiSpecRun
	f.get(t, "/api/specs/1", &named)
	f.get(t, "/api/specs/2", &untouched)
	if untouched.State != "failed" || !strings.Contains(untouched.Reason, "the factory stopped while this spec was being claimed") ||
		!strings.Contains(untouched.Reason, "nothing was claimed on the remote") {
		t.Errorf("spec run 2 is %s for %q after a restart, want failed because the factory stopped before it claimed anything",
			untouched.State, untouched.Reason)
	}
	if want := []string{"failed"}; !equal(titles(untouched.Events), want) {
		t.Errorf("spec run 2 logged %q, want %q", titles(untouched.Events), want)
	}
	// A paused factory finishes no claim, so the spec run that named its branch waits as it was.
	if named.State != "claiming" || named.Branch != specBranch {
		t.Errorf("spec run 1 is %s on %q after a paused restart, want it still claiming %s", named.State, named.Branch, specBranch)
	}
	if want := []string{"opened", "claiming " + specBranch}; !equal(titles(named.Events), want) {
		t.Errorf("spec run 1 logged %q, want %q", titles(named.Events), want)
	}
}

func TestAClaimTheFactoryStoppedInIsFinishedOnRestartFromWhatStandsOnTheRemote(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name      string
		stands    bool   // the spec branch was created before the factory stopped
		createdBy string // who GitHub says created it
		want      string
	}{
		{"stopped before the branch was created", false, "", "holding"},
		{"stopped after the branch was created or the spec assigned", true, "factory-bot", "holding"},
		{"another claimer created the branch", true, "somebody-else", "lost"},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			gh := newGhShim(t)
			gh.routedSpecFixture(t, "acme/edge-sensors", "factory")
			base := gh.head(t, "acme/edge-sensors", "main")
			if c.stands {
				gh.branchAt(t, "acme/edge-sensors", specBranch, base)
				gh.pushedBy(t, "acme/edge-sensors", specBranch, c.createdBy)
			}

			f := gh.work(t, config{"poll": "50ms", "data_dir": interruptedSpecRuns(t), "repositories": []string{"acme/edge-sensors"}})
			spec := f.specRunIn(t, c.want)
			if head := gh.head(t, "acme/edge-sensors", specBranch); head != base {
				t.Errorf("%s is at %q on the remote, want it at the head of main (%s)", specBranch, head, base)
			}
			assigned := gh.made(t, "issue edit 230 --repo acme/edge-sensors --add-assignee factory-bot")
			if want := map[string]int{"holding": 1, "lost": 0}[c.want]; assigned != want {
				t.Errorf("the factory assigned the spec %d times, want %d", assigned, want)
			}
			if got := titles(spec.Events); len(got) < 3 || got[2] != "resuming the claim" {
				t.Errorf("spec run 1 logged %q, want the resumption right after the two events it had", got)
			}
			for i, e := range spec.Events {
				if e.Seq != i+1 {
					t.Errorf("event %d of spec run 1 has the sequence number %d, want %d: a restart reused a number", i+1, e.Seq, i+1)
				}
			}
			if specs := f.specRuns(t); len(specs) != 2 {
				t.Errorf("the factory has %d spec runs, want the 2 it had: a resumed claim is no new one", len(specs))
			}
		})
	}
}

func TestASpecRunIsServedWithTheEventsAfterTheOneAskedForAndAnUnknownOneIsNotFound(t *testing.T) {
	t.Parallel()
	f := start(t, config{"paused": true, "data_dir": interruptedSpecRuns(t)})

	var tail apiSpecRun
	f.get(t, "/api/specs/1?after=1", &tail)
	if len(tail.Events) != 1 || tail.Events[0].Seq != 2 || tail.Events[0].Title != "claiming "+specBranch {
		t.Errorf("after=1 served %+v, want only the second event, the claiming", tail.Events)
	}
	var all apiSpecRun
	f.get(t, "/api/specs/1?after=-5", &all)
	if len(all.Events) != 2 {
		t.Errorf("a negative after served %d events, want both", len(all.Events))
	}
	for _, path := range []string{"/api/specs/3", "/api/specs/one", "/api/specs/0"} {
		response := f.do(t, "GET", path)
		response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s answered %d, want 404", path, response.StatusCode)
		}
	}
}
