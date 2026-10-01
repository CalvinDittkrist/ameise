import json
import unittest

from helpers import STANDARDS, ShimTest

WORKSPACE = STANDARDS / "workspace.sh"
AUTOADD = "turn on Workflows > Auto-add to project with the filter is:issue,pr is:open for o/r (the API cannot create or turn on project workflows)"


def milestone(number, title, open_issues, closed_issues, state="open"):
    return {"number": number, "title": title, "state": state, "open_issues": open_issues, "closed_issues": closed_issues}


STATUS = ["Triage", "Ready", "In progress", "In review", "Done"]
PRIORITY = ["P0", "P1", "P2", "P3"]


def select(name, options):
    return {"name": name, "dataType": "SINGLE_SELECT", "options": [{"name": o} for o in options]}


def project(number, fields=None, autoadd=False, closed=False):
    """One projectsV2 node as the GraphQL query returns it; by default its fields match the standard."""
    if fields is None:
        fields = [select("Status", STATUS), select("Priority", PRIORITY)]
    return {"id": f"PVT_{number}", "number": number, "title": "r",
            "url": f"https://github.com/users/o/projects/{number}", "closed": closed,
            "workflows": {"nodes": [{"name": "Auto-add to project", "enabled": autoadd}]},
            "fields": {"nodes": [{"name": "Title", "dataType": "TITLE"}, *fields]}}


class WorkspaceTests(ShimTest):
    """The plugin's workspace.sh against a stateful gh shim: $SHIM_WS holds the GitHub state. Its dry run is what
    check.sh reads; applying is controller code, tested in controller/test/standard-workspace.test.ts."""

    def setUp(self):
        super().setUp()
        self.ws = self.base / "github"
        self.ws.mkdir()

    def put(self, name, data):
        (self.ws / name).write_text(json.dumps(data))

    def public_main(self):
        """A public repository on main alone, clicked together by hand."""
        self.put("repo.json", {
            "visibility": "public", "default_branch": "main", "permissions": {"admin": True},
            "allow_squash_merge": True, "allow_merge_commit": True, "allow_rebase_merge": True,
            "delete_branch_on_merge": False, "squash_merge_commit_title": "COMMIT_OR_PR_TITLE",
            "squash_merge_commit_message": "COMMIT_MESSAGES", "has_wiki": True, "has_discussions": False,
            "security_and_analysis": {"secret_scanning": {"status": "disabled"},
                                      "secret_scanning_push_protection": {"status": "disabled"}}})
        # GitHub matches label names ignoring case, so Wontfix counts as wontfix.
        self.put("labels.json", [{"name": n} for n in ("bug", "enhancement", "ready-for-agent", "question", "Wontfix")])
        # automated-security-fixes.json is absent: GitHub may answer 404 while Dependabot alerts are off.
        self.put("actions-workflow.json", {"default_workflow_permissions": "write", "can_approve_pull_request_reviews": True})
        self.put("private-vulnerability-reporting.json", {"enabled": False})
        self.put("protection-main.json", {"required_pull_request_reviews": {"required_approving_review_count": 1}})
        self.put("milestones.json", [
            milestone(1, "v0.1.0", 0, 3), milestone(2, "Backlog", 0, 2), milestone(3, "v0.2.0", 0, 0),
            milestone(4, "v0.3.0", 2, 0), milestone(5, "Someday", 1, 0), milestone(6, "old", 0, 0, state="closed")])
        self.put("projects.json", [])

    def private_dev_main(self):
        """A private repository on dev plus main that is close to the standard: dev conforms, main has a bypass."""
        self.public_main()
        repo = json.loads((self.ws / "repo.json").read_text())
        repo.update({"visibility": "private", "default_branch": "dev", "allow_merge_commit": False, "allow_rebase_merge": False,
                     "delete_branch_on_merge": True, "squash_merge_commit_title": "PR_TITLE", "has_wiki": False,
                     "security_and_analysis": None})
        self.put("repo.json", repo)
        self.put("labels.json", [{"name": n} for n in ("ready-for-agent", "needs-triage", "needs-info", "ready-for-human",
                                                        "wontfix", "spec", "factory", "factory:spec-run", "bug", "enhancement", "skill-candidate")])
        (self.ws / "vulnerability-alerts").touch()
        self.put("automated-security-fixes.json", {"enabled": True, "paused": False})
        self.put("actions-workflow.json", {"default_workflow_permissions": "read"})
        (self.ws / "private-vulnerability-reporting.json").unlink()
        (self.ws / "protection-main.json").unlink()
        self.put("milestones.json", [milestone(1, "v1.0.0", 1, 4)])
        self.put("projects.json", [project(3)])
        # As GitHub returns them: ids, defaults the standard leaves open, rules in another order.
        dev = {"id": 7, "name": "standard: dev", "target": "branch", "enforcement": "active", "source_type": "Repository",
               "bypass_actors": [], "current_user_can_bypass": "never",
               "conditions": {"ref_name": {"exclude": [], "include": ["refs/heads/dev"]}},
               "rules": [{"type": "required_linear_history"}, {"type": "deletion"}, {"type": "non_fast_forward"},
                         {"type": "required_status_checks", "parameters": {
                             "strict_required_status_checks_policy": False, "do_not_enforce_on_create": False,
                             "required_status_checks": [{"context": "check", "integration_id": 15368}]}},
                         {"type": "pull_request", "parameters": {
                             "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": False,
                             "require_code_owner_review": False, "require_last_push_approval": False,
                             "required_review_thread_resolution": True, "allowed_merge_methods": ["squash"],
                             "automatic_copilot_code_review_enabled": False}}]}
        main = json.loads(json.dumps(dev))
        main.update({"id": 8, "name": "standard: main", "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole",
                                                                           "bypass_mode": "always"}],
                     "conditions": {"ref_name": {"exclude": [], "include": ["refs/heads/main"]}}})
        main["rules"] = [r for r in main["rules"] if r["type"] != "required_linear_history"]
        main["rules"][-1]["parameters"]["allowed_merge_methods"] = ["squash", "merge"]
        copilot = {"id": 9, "name": "Copilot review for default branch", "target": "branch", "enforcement": "active",
                   "bypass_actors": [], "conditions": {"ref_name": {"exclude": [], "include": ["~DEFAULT_BRANCH"]}},
                   "rules": [{"type": "copilot_code_review", "parameters": {"review_on_push": False}}]}
        for r in (dev, main, copilot):
            self.put(f"ruleset-{r['id']}.json", r)

    def ws_run(self, *args, **env):
        return self.run_script(WORKSPACE, *args, SHIM_WS=str(self.ws), TMPDIR=str(self.base), **env)

    def test_the_dry_run_prints_every_difference_and_never_applies(self):
        self.public_main()
        r = self.ws_run(WF_PROJECT_TEMPLATE="tpl-owner/1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "\n".join([
            "repository: o/r",
            "profile: public, main",
            "diff: repo allow_merge_commit: true -> false",
            "diff: repo allow_rebase_merge: true -> false",
            "diff: repo delete_branch_on_merge: false -> true",
            "diff: repo squash_merge_commit_title: COMMIT_OR_PR_TITLE -> PR_TITLE",
            "diff: repo has_wiki: true -> false",
            "diff: branch-protection main: classic -> removed (the ruleset replaces it)",
            "diff: ruleset standard: main: missing -> create",
            "diff: ruleset standard: pre-standard: missing -> create",
            "diff: label needs-triage: missing -> create",
            "diff: label needs-info: missing -> create",
            "diff: label ready-for-human: missing -> create",
            "diff: label spec: missing -> create",
            "diff: label factory: missing -> create",
            "diff: label factory:spec-run: missing -> create",
            "diff: label skill-candidate: missing -> create",
            "diff: dependabot alerts: off -> on",
            "diff: dependabot security-updates: off -> on",
            "diff: actions default-token: write -> read",
            "diff: actions token-approves-pull-requests: true -> false",
            "diff: secret-scanning: disabled -> enabled",
            "diff: secret-scanning-push-protection: disabled -> enabled",
            "diff: private-vulnerability-reporting: off -> on",
            "diff: milestone Backlog: open, orphaned -> closed",
            "diff: milestone v0.2.0: open, empty -> closed",
            "diff: project: none linked -> copy of tpl-owner/1",
            f"manual: project (the copy): {AUTOADD}",
            "differences: 25",
            "next: the standardize process of the controller makes these changes",
            ""]))
        r = self.ws_run("--apply")
        self.assertEqual(r.returncode, 1)
        self.assertIn("error: unknown argument --apply", r.stderr)
        self.assertEqual([c for c in self.calls() if " --method " in c or c.startswith("gh project")], [])

    def test_check_reports_workspace_drift_and_skips_it_when_github_is_unreachable(self):
        self.assertEqual(self.run_script(STANDARDS / "scaffold.sh").returncode, 0)
        r = self.run_script(STANDARDS / "check.sh")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("skip: GitHub workspace not checked (cannot read repos/o/r:", r.stdout)
        self.private_dev_main()
        r = self.run_script(STANDARDS / "check.sh", SHIM_WS=str(self.ws))
        self.assertEqual(r.returncode, 0, r.stdout)
        drift = [line for line in r.stdout.splitlines() if "GitHub workspace" in line]
        self.assertEqual(drift, [
            "warn: GitHub workspace: repo allow_merge_commit: false -> true",
            "warn: GitHub workspace: ruleset standard: main: differs -> replace",
            "warn: GitHub workspace: ruleset standard: pre-standard: missing -> create",
            "warn: GitHub workspace differs from the standard; plugins/repo-standards/scripts/workspace.sh shows why, "
            "the standardize process of the controller fixes it"])
        # That the check passes once the controller applied the workspace is tested beside the apply, in
        # controller/test/standard-workspace.test.ts.


if __name__ == "__main__":
    unittest.main()
