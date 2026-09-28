"""The local workflow's side of the contract fixture: the orchestrator's shell over every case of
contract/fixture.json, the file the factory's Go tests read as well (ADR 0062). A failure names the case."""
import json
import subprocess

from helpers import ORCH, ROOT, ShimTest

FIXTURE = ROOT / "contract" / "fixture.json"


def contract():
    return json.loads(FIXTURE.read_text())


class ContractFixtureTests(ShimTest):
    maxDiff = None

    def lib(self, script, *args, cwd=None, **env):
        """One function of the orchestrator's lib.sh, run with the shims on the PATH."""
        r = subprocess.run(["bash", "-c", '. "$1"; shift; ' + script, "_", str(ORCH / "lib.sh"), *args],
                           cwd=cwd or self.repo, env=self.env(**env), text=True, capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_the_branch_a_claim_names_follows_the_fixture(self):
        cases = contract()["branch"]["cases"]
        self.assertTrue(cases, "the contract fixture has no branch case")
        for c in cases:
            got = self.lib('printf "%s/%s-%s\\n" "$(wf_branch_type "$2")" "$1" "$(wf_slug "$3")"',
                           str(c["number"]), ",".join(c["labels"]), c["title"])
            self.assertEqual(got, c["branch"], f"branch case {c['case']!r}: the orchestrator's shell names the branch "
                             f"of {c['title']!r} {got!r}; the contract fixture says {c['branch']!r}")

    def test_the_spec_branch_follows_the_fixture(self):
        for c in contract()["spec_branch"]["cases"]:
            got = self.lib('printf "spec/%s-%s\\n" "$1" "$(wf_slug "$2")"', str(c["number"]), c["title"])
            self.assertEqual(got, c["branch"], f"spec branch case {c['case']!r}: the orchestrator's shell spells it "
                             f"{got!r}; the contract fixture says {c['branch']!r}")

    def test_the_issue_a_branch_belongs_to_follows_the_fixture(self):
        for c in contract()["issue_from_branch"]["cases"]:
            got = self.lib('wf_issue_from_branch "$1"', c["branch"])
            self.assertEqual(got, c["issue"], f"issue-from-branch case {c['branch']!r}: the orchestrator's shell reads "
                             f"issue {got!r}; the contract fixture says {c['issue']!r}")

    def test_the_spec_branch_on_the_remote_follows_the_fixture(self):
        fixture = contract()["remote_spec_branch"]
        remote = self.base / "remote.git"
        self.git("init", "-q", "--bare", str(remote))
        self.git("remote", "add", "origin", str(remote))
        for branch in fixture["remote"]:
            self.git("push", "-q", "origin", f"HEAD:refs/heads/{branch}")
        self.git("fetch", "-q", "--prune", "origin")
        for c in fixture["cases"]:
            got = self.lib('wf_remote_spec_branch "$1"', str(c["spec"]))
            self.assertEqual(got, c["branch"], f"remote spec branch case {c['spec']}: the orchestrator's shell finds "
                             f"{got!r}; the contract fixture says {c['branch']!r}")

    def test_the_base_branch_rule_follows_the_fixture(self):
        for c in contract()["base_branch"]["cases"]:
            if c["origin_head"]:
                self.git("update-ref", f"refs/remotes/origin/{c['origin_head']}", "HEAD")
                self.git("symbolic-ref", "refs/remotes/origin/HEAD", f"refs/remotes/origin/{c['origin_head']}")
            else:
                subprocess.run(["git", "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], cwd=self.repo,
                               env=self.env(), capture_output=True)
            env = {"WF_BASE_BRANCH": c["explicit"]}
            env.update({"SHIM_DEFAULT_BRANCH": c["github_default"]} if c["github_default"] else {"SHIM_DEFAULT_ERROR": "1"})
            got = self.lib("wf_base_branch", **env)
            self.assertEqual(got, c["base"], f"base branch case {c['case']!r}: the orchestrator's shell branches off "
                             f"{got!r}; the contract fixture says {c['base']!r}")

    def board_frontier(self, routed):
        """The issues board.sh offers of the fixture's issues, and the issue list it asked GitHub for."""
        fixture = contract()["frontier"]
        labels = ["ready-for-agent"] + ([fixture["routing_label"]] if routed else [])
        stamp = "2026-09-20T10:00:00Z"

        def issue(number, title, names):
            return {"number": number, "title": title, "state": "open", "created_at": stamp, "updated_at": stamp,
                    "assignees": [], "labels": [{"name": n} for n in names],
                    "issue_dependencies_summary": {"blocked_by": 0, "blocking": 0}}
        issues, parents = [], {p["number"]: p for p in fixture["parents"]}
        by_child = {}
        for i in fixture["issues"]:
            one = issue(i["number"], i["title"], labels)
            if i.get("blocked_by"):
                one["issue_dependencies_summary"] = {"blocked_by": i["blocked_by"]}
            if i.get("assignees"):
                one["assignees"] = [{"login": login} for login in i["assignees"]]
            if i.get("pull_request"):
                one["pull_request"] = {"url": f"https://api.github.com/repos/o/r/pulls/{i['number']}"}
            if i.get("parent"):
                one["parent_issue_url"] = f"https://api.github.com/repos/o/r/issues/{i['parent']}"
                if i["parent"] in parents:  # a parent the fixture names nowhere cannot be read
                    p = parents[i["parent"]]
                    by_child[str(i["number"])] = issue(p["number"], p["title"], p["labels"])
            issues.append(one)
        ready, parent_file = self.base / "ready.json", self.base / "parents.json"
        ready.write_text(json.dumps(issues))
        parent_file.write_text(json.dumps(by_child))
        self.reset_calls()
        r = self.run_script(ORCH / "board.sh", SHIM_FRONTIER_FIXTURE=str(ready), SHIM_PARENTS_FIXTURE=str(parent_file))
        self.assertEqual(r.returncode, 0, r.stderr)
        numbers, inside = [], False
        for line in r.stdout.splitlines():
            if line.startswith("frontier["):
                inside = True
                continue
            if inside:
                if not line.startswith("  "):
                    break
                numbers.append(int(line.strip().split(",", 1)[0]))
        requests = [c[3:] for c in self.calls() if c.startswith("gh api repos/o/r/issues?labels=")]
        return numbers, requests

    def test_the_board_offers_the_fixtures_frontier_and_leaves_the_routed_issues_alone(self):
        fixture = contract()["frontier"]
        offered, requests = self.board_frontier(routed=False)
        self.assertEqual(offered, fixture["free"], f"frontier: the board offers {offered}; the contract fixture says "
                         f"the free ones are {fixture['free']}")
        self.assertEqual(requests, [f"api repos/o/r/{fixture['query']}"],
                         "frontier: the board asks GitHub for another issue list than the contract fixture's query")
        offered, _ = self.board_frontier(routed=True)
        self.assertEqual(offered, [], f"frontier: the board offers {offered} of the routed issues; they are the factory's")

    def test_the_claim_compacts_at_the_fixtures_pin(self):
        pin = contract()["compact_pin"]
        settings = json.loads(self.lib('wf_worker_settings manual 7'))
        self.assertEqual(settings["autoCompactWindow"], pin["window"],
                         "compact pin: the claim sets another window than the contract fixture pins")
        self.assertEqual(settings["env"]["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"], str(pin["percentage"]),
                         "compact pin: the claim sets another percentage than the contract fixture pins")
