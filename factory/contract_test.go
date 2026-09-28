package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---- the contract fixture: the rules the local workflow and the factory share ----

// contract is the contract fixture, ../contract/fixture.json: the rules the factory shares with the
// local workflow, as inputs with expected outputs. The Python suite holds the local workflow to the
// same file, so a rule changes in the fixture first and the side that disagrees fails on the case it
// names ([ADR 0062]). No test here runs the local workflow's shell.
//
// [ADR 0062]: ../docs/adr/0062-the-peers-share-a-contract-fixture-not-code.md
type contract struct {
	Branch struct {
		Cases []struct {
			Case   string   `json:"case"`
			Number int      `json:"number"`
			Title  string   `json:"title"`
			Labels []string `json:"labels"`
			Branch string   `json:"branch"`
		} `json:"cases"`
	} `json:"branch"`
	SpecBranch struct {
		Cases []struct {
			Case   string `json:"case"`
			Number int    `json:"number"`
			Title  string `json:"title"`
			Branch string `json:"branch"`
		} `json:"cases"`
	} `json:"spec_branch"`
	IssueFromBranch struct {
		Cases []struct {
			Branch string `json:"branch"`
			Issue  string `json:"issue"`
		} `json:"cases"`
	} `json:"issue_from_branch"`
	RemoteSpecBranch struct {
		Remote []string `json:"remote"`
		Cases  []struct {
			Spec   int    `json:"spec"`
			Branch string `json:"branch"`
		} `json:"cases"`
	} `json:"remote_spec_branch"`
	BaseBranch struct {
		Cases []struct {
			Case          string `json:"case"`
			Explicit      string `json:"explicit"`
			OriginHead    string `json:"origin_head"`
			GitHubDefault string `json:"github_default"`
			Base          string `json:"base"`
		} `json:"cases"`
	} `json:"base_branch"`
	Frontier struct {
		Query        string `json:"query"`
		RoutingLabel string `json:"routing_label"`
		Issues       []struct {
			Number      int      `json:"number"`
			Title       string   `json:"title"`
			BlockedBy   int      `json:"blocked_by"`
			Assignees   []string `json:"assignees"`
			PullRequest bool     `json:"pull_request"`
			Parent      int      `json:"parent"`
		} `json:"issues"`
		Parents []struct {
			Number int      `json:"number"`
			Title  string   `json:"title"`
			Labels []string `json:"labels"`
		} `json:"parents"`
		Free []int `json:"free"`
	} `json:"frontier"`
	Labels struct {
		Vocabulary []struct {
			Name        string `json:"name"`
			Color       string `json:"color"`
			Description string `json:"description"`
		} `json:"vocabulary"`
	} `json:"labels"`
}

func readContract(t *testing.T) contract {
	t.Helper()
	path := abs(t, filepath.Join("..", "contract", "fixture.json"))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the contract fixture cannot be read: %v", err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatalf("the contract fixture %s is no JSON this test reads: %v", path, err)
	}
	return c
}

// The branch a claim creates is the branch contract: <type>/<number>-<slug>.
func TestTheBranchNameFollowsTheContractFixture(t *testing.T) {
	t.Parallel()
	cases := readContract(t).Branch.Cases
	if len(cases) == 0 {
		t.Fatal("the contract fixture has no branch case")
	}
	for _, c := range cases {
		t.Run(c.Case, func(t *testing.T) {
			issue := Issue{Number: c.Number, Title: c.Title, Labels: c.Labels}
			if got := branchName(issue); got != c.Branch {
				t.Errorf("branch case %q: the factory names the branch of %q %q; the contract fixture says %q",
					c.Case, c.Title, got, c.Branch)
			}
		})
	}
}

// The spec branch is the branch contract with spec as its type, and it belongs to its spec.
func TestTheSpecBranchFollowsTheContractFixture(t *testing.T) {
	t.Parallel()
	fixture := readContract(t)
	for _, c := range fixture.SpecBranch.Cases {
		spec := Issue{Number: c.Number, Title: c.Title}
		if got := specBranchName(spec); got != c.Branch {
			t.Errorf("spec branch case %q: the factory names the spec branch of %q %q; the contract fixture says %q",
				c.Case, c.Title, got, c.Branch)
		}
		if got := issueFromBranch(specBranchName(spec)); got != strconv.Itoa(c.Number) {
			t.Errorf("spec branch case %q: the factory reads the spec branch %q as the branch of issue %q, want %d",
				c.Case, specBranchName(spec), got, c.Number)
		}
	}

	// A local claim of a ticket of a spec run finds the spec branch on the remote to take it as its
	// base, and the factory finds it there the same way.
	gh := newGhShim(t)
	gh.remote(t, "acme/edge-sensors")
	clone := gh.cloneInto(t, t.TempDir(), "acme/edge-sensors")
	for _, branch := range fixture.RemoteSpecBranch.Remote {
		gh.git(t, clone, "push", "-q", "origin", "HEAD:refs/heads/"+branch)
	}
	gh.git(t, clone, "fetch", "-q", "--prune", "origin")
	for _, c := range fixture.RemoteSpecBranch.Cases {
		t.Run(strconv.Itoa(c.Spec), func(t *testing.T) {
			if got := remoteSpecBranch(context.Background(), clone, c.Spec); got != c.Branch {
				t.Errorf("remote spec branch case %d: the factory finds %q as the spec branch of #%d; the contract fixture says %q",
					c.Spec, got, c.Spec, c.Branch)
			}
		})
	}
}

// Which issue a branch belongs to decides whether somebody else already holds the issue.
func TestTheIssueABranchBelongsToFollowsTheContractFixture(t *testing.T) {
	t.Parallel()
	for _, c := range readContract(t).IssueFromBranch.Cases {
		t.Run(c.Branch, func(t *testing.T) {
			if got := issueFromBranch(c.Branch); got != c.Issue {
				t.Errorf("issue-from-branch case %q: the factory reads it as the branch of issue %q; the contract fixture says %q",
					c.Branch, got, c.Issue)
			}
		})
	}
}

// The base branch rule: the explicit setting, then the head of the remote, then the default branch
// on GitHub, then main. The factory is given the explicit setting either by its host's configuration
// or by the settings file of the repository, so each case with one runs both ways.
func TestTheBaseBranchRuleFollowsTheContractFixture(t *testing.T) {
	// Serial: inProcess sets this process's PATH, GH_SHIM_* and GIT_CONFIG_* to reach the shim.
	for _, c := range readContract(t).BaseBranch.Cases {
		ways := []bool{false}
		if c.Explicit != "" {
			ways = append(ways, true)
		}
		for _, declared := range ways {
			name := c.Case
			if declared {
				name += " declared by the repository"
			}
			t.Run(name, func(t *testing.T) {
				gh := newGhShim(t)
				gh.remote(t, "acme/edge-sensors")
				clone := gh.cloneInto(t, t.TempDir(), "acme/edge-sensors")
				configured := c.Explicit
				if declared {
					configured = ""
					branch := c.OriginHead
					if branch == "" {
						branch = "main"
					}
					declaresBase(t, gh, clone, "acme/edge-sensors", branch, c.Explicit)
				}
				if c.OriginHead != "" {
					gh.git(t, clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/"+c.OriginHead)
				} else {
					gh.git(t, clone, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
				}
				if c.GitHubDefault != "" { // without an answer gh fails, which is the rule's last step
					gh.answer(t, "repo view acme/edge-sensors --json defaultBranchRef --jq .defaultBranchRef.name", c.GitHubDefault+"\n")
				}
				inProcess(t, gh)
				if got := baseBranch(context.Background(), Connected{Name: "acme/edge-sensors", Base: configured}, clone); got != c.Base {
					t.Errorf("base branch case %q: the factory branches off %q; the contract fixture says %q", name, got, c.Base)
				}
			})
		}
	}
}

// The frontier rule, split by the routing label: what the local board leaves out is what the factory
// takes. Both read GitHub through a query that already says state=open and labels=ready-for-agent, so
// the fixture varies what the rule decides for itself: assignees, open blockers, pull requests, and
// parents, of which one carries the spec-run label and one cannot be read.
func TestTheFrontierRuleFollowsTheContractFixture(t *testing.T) {
	t.Parallel()
	frontier := readContract(t).Frontier
	if frontier.RoutingLabel != defaultLabel {
		t.Fatalf("the contract fixture routes by %q, the factory by default by %q", frontier.RoutingLabel, defaultLabel)
	}
	now := time.Now().UTC()
	issues := func(routed bool) []issueJSON {
		labels := []string{readyLabel}
		if routed {
			labels = append(labels, frontier.RoutingLabel)
		}
		out := []issueJSON{}
		for _, i := range frontier.Issues {
			issue := openIssue(i.Number, i.Title, now, labels...)
			if i.BlockedBy > 0 {
				issue["issue_dependencies_summary"] = map[string]any{"blocked_by": i.BlockedBy}
			}
			if len(i.Assignees) > 0 {
				assignees := []any{}
				for _, login := range i.Assignees {
					assignees = append(assignees, map[string]any{"login": login})
				}
				issue["assignees"] = assignees
			}
			if i.PullRequest {
				issue["pull_request"] = map[string]any{"url": "https://api.github.com/repos/o/r/pulls/" + strconv.Itoa(i.Number)}
			}
			if i.Parent > 0 {
				issue["parent_issue_url"] = "https://api.github.com/repos/o/r/issues/" + strconv.Itoa(i.Parent)
			}
			out = append(out, issue)
		}
		return out
	}
	parents := map[int]issueJSON{} // by the number of the child; a parent the fixture names nowhere cannot be read
	for _, i := range frontier.Issues {
		for _, p := range frontier.Parents {
			if p.Number == i.Parent {
				parents[i.Number] = openIssue(p.Number, p.Title, now, p.Labels...)
			}
		}
	}

	routed, request := factoryQueueOf(t, issues(true), parents, len(frontier.Free))
	if !equal(routed, frontier.Free) {
		t.Errorf("frontier: the factory takes %v of the routed issues; the contract fixture says the free ones are %v", routed, frontier.Free)
	}
	if unrouted, _ := factoryQueueOf(t, issues(false), parents, 0); len(unrouted) != 0 {
		t.Errorf("frontier: the factory takes %v without the routing label, want nothing: an unrouted issue is the maintainer's", unrouted)
	}
	want := "api repos/o/r/" + strings.Replace(frontier.Query, "labels="+readyLabel, "labels="+readyLabel+","+frontier.RoutingLabel, 1)
	if request != want {
		t.Errorf("frontier: the factory asks GitHub for %q; the contract fixture's query with the routing label is %q", request, want)
	}
}

// The factory's copy of the label vocabulary is the labels it reads by name. Each is a label of the
// contract fixture's vocabulary, which the local workflow creates in a repository.
func TestTheFactorysLabelsAreInTheContractFixture(t *testing.T) {
	t.Parallel()
	vocabulary := map[string]bool{}
	for _, label := range readContract(t).Labels.Vocabulary {
		vocabulary[label.Name] = true
	}
	for _, label := range []string{readyLabel, humanLabel, defaultLabel, specLabel, specRunLabel(defaultLabel)} {
		if !vocabulary[label] {
			t.Errorf("labels: the factory reads the label %q, which the contract fixture's vocabulary does not name", label)
		}
	}
}
