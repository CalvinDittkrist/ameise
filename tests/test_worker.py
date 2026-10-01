import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

from helpers import WORKER, ShimTest


class HuntBranchBriefTests(ShimTest):
    """A test hunt's branch names no issue, so the facts say none, and the hunt skill's brief carries the hunt
    record in its place (ADR 0045)."""

    def setUp(self):
        super().setUp()
        self.git("checkout", "-qb", "hunt/tests-2026-09-24")
        (self.repo / "test_app.py").write_text("def test_app():\n    assert 1\n")
        self.git("add", "."); self.git("commit", "-qm", "test: app")

    def test_the_hunt_brief_says_none_for_the_issue_and_carries_the_hunt_record(self):
        self.run_script(WORKER / "hunt.sh", "round")
        self.run_script(WORKER / "hunt.sh", "triage", "1",
                        stdin="candidate: test_app.py | test_app | cannot-fail | asserts a constant | medium\n")
        brief = self.skill_brief("worker", "hunt-tests", WF_BASE_BRANCH="main")
        self.assertIn("\nissue: none", brief)
        self.assertNotIn("issue: #", brief)
        self.assertIn("hunt_kept: 1", brief)
        self.assertIn("\n  kept, round 1: test_app.py | test_app | cannot-fail | asserts a constant", brief)


class FactsTests(ShimTest):
    def test_reports_mode_issue_and_base_from_env_or_branch(self):
        self.git("checkout", "-qb", "fix/7-y")
        r = self.run_script(WORKER / "facts.sh", WF_BASE_BRANCH="main")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[:4], ["mode: manual", "issue: #7", "base: main", "subagents: background"])
        r = self.run_script(WORKER / "facts.sh", WF_BASE_BRANCH="main", WF_MODE="yolo", WF_ISSUE="12")
        self.assertIn("mode: yolo\nissue: #12\n", r.stdout)

    def test_a_session_without_the_controller_is_told_what_to_start(self):
        """A skill that needs the controller stops on this line in a plain session rather than failing later
        (ADR 0063); a session the controller started reads present."""
        r = self.run_script(WORKER / "facts.sh", WF_BASE_BRANCH="main")
        self.assertEqual(r.returncode, 0, r.stderr)
        line = r.stdout.splitlines()[-1]
        self.assertTrue(line.startswith("controller: absent; this skill needs the ameise controller"), line)
        self.assertIn("start it with 'ameise'", line)
        r = self.run_script(WORKER / "facts.sh", WF_BASE_BRANCH="main", WF_CONTROLLER="1")
        self.assertEqual(r.stdout.splitlines()[-1], "controller: present")

    def test_the_waiting_shape_of_the_session_is_a_fact_the_review_stage_can_read(self):
        """A claim disables background tasks, a hand-started session does not; the review stage waits by
        collecting the tool results in the first case and by ending the turn in the second (issue #34)."""
        self.git("checkout", "-qb", "fix/7-y")
        for value, shape in (("1", "foreground"), ("  True ", "foreground"), ("on", "foreground"),
                             ("0", "background"), ("", "background")):
            with self.subTest(value=value):
                r = self.run_script(WORKER / "facts.sh", WF_BASE_BRANCH="main",
                                    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=value)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn(f"subagents: {shape}", r.stdout)

class ClaudeDocsTests(ShimTest):
    """The one network call a worker has is pinned to the documentation origin: nothing an argument carries
    may leave that path, and nothing from another host is printed (issue #44, ADR 0030)."""

    ORIGIN = "https://code.claude.com/docs/"

    def docs(self, *args, **env):
        return self.run_script(WORKER / "claude-docs.sh", *args, **env)

    def curl_calls(self):
        """The argv of every curl invocation, in order."""
        return [call for call in self.argv_calls() if call[0] == "curl"]

    def requested(self):
        """The URLs curl was asked for, in order."""
        return [call[-1] for call in self.curl_calls()]

    def timeout_of(self, result):
        """The seconds the one curl call of `result` was bounded by."""
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.curl_calls()[-1]
        return call[call.index("--max-time") + 1]

    def test_without_an_argument_it_prints_the_index(self):
        r = self.docs()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("# Claude Code Docs", r.stdout)
        self.assertIn(f"url: {self.ORIGIN}llms.txt", r.stdout)
        self.assertEqual(self.requested(), [f"{self.ORIGIN}llms.txt"])

    def test_a_slug_prints_that_page_as_markdown(self):
        r = self.docs("sub-agents")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("# Page sub-agents.md", r.stdout)
        # The url: line is what the lookup agent cites, so it names the page that actually answered.
        self.assertIn(f"url: {self.ORIGIN}en/sub-agents.md", r.stdout)
        self.assertEqual(self.requested(), [f"{self.ORIGIN}en/sub-agents.md"])

    def test_a_nested_slug_reaches_the_nested_page(self):
        """A quarter of the index is nested (agent-sdk/..., whats-new/...); those pages are reachable."""
        r = self.docs("agent-sdk/hooks")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"url: {self.ORIGIN}en/agent-sdk/hooks.md", r.stdout)
        self.assertEqual(self.requested(), [f"{self.ORIGIN}en/agent-sdk/hooks.md"])

    def test_the_request_carries_the_timeout_and_a_size_bound(self):
        self.assertEqual(self.timeout_of(self.docs("sub-agents")), "30")
        self.reset_calls()
        # An operator may raise or lower it; whatever they set is what curl is given.
        self.assertEqual(self.timeout_of(self.docs("sub-agents", WF_DOCS_TIMEOUT="7")), "7")
        self.assertIn("--max-filesize", self.curl_calls()[0], "a page of any size would land in a context")

    def test_a_timeout_that_is_not_a_number_of_seconds_above_zero_is_refused_with_the_fix(self):
        # "0" is a number, and `curl --max-time 0` means no timeout at all, so it is refused with the rest.
        for value in ("soon", "0", "00", "-1", "1.5", " 5"):
            with self.subTest(timeout=value):
                self.reset_calls()
                r = self.docs("sub-agents", WF_DOCS_TIMEOUT=value)
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertIn(f"error: WF_DOCS_TIMEOUT is '{value}'", r.stderr)
                self.assertEqual(self.requested(), [])

    def test_an_argument_that_is_not_a_slug_is_refused_before_any_request(self):
        # Each of these would leave the pinned path, or is not a page at all. The message names the fix.
        for argument in ("../x", "../../etc/passwd", "https://evil.example/x", "//evil.example/x", "/a",
                         "a/", "a//b", "a.b", "a b", "A", "a?b", "a#b", "a%2fb", "a\nb", ""):
            with self.subTest(argument=argument):
                self.reset_calls()
                r = self.docs(argument)
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertIn("error: not a documentation page", r.stderr)
                self.assertIn("slug of lowercase letters, digits and hyphens", r.stderr)
                self.assertEqual(self.requested(), [], "a refused argument still reached the network")
                self.assertEqual(r.stdout, "")

    def test_a_second_argument_is_refused_with_the_usage(self):
        r = self.docs("sub-agents", "hooks")
        self.assertEqual(r.returncode, 1)
        self.assertIn("error: usage: claude-docs.sh", r.stderr)
        self.assertEqual(self.requested(), [])

    def test_a_failed_request_is_an_error_naming_the_fix_not_an_empty_page(self):
        r = self.docs("no-such-page", SHIM_CURL_FAIL="1")
        self.assertEqual(r.returncode, 1)
        self.assertIn("error: could not read https://code.claude.com/docs/en/no-such-page.md", r.stderr)
        self.assertIn("claude-docs.sh with no argument", r.stderr)
        self.assertEqual(r.stdout, "")

    def test_an_answer_from_another_host_prints_nothing(self):
        """The URL is built here, so a redirect is the only way out of the origin; the body is discarded."""
        r = self.docs("sub-agents", SHIM_CURL_REDIRECT="https://evil.example/collect")
        self.assertEqual(r.returncode, 1)
        self.assertIn("outside https://code.claude.com/docs/", r.stderr)
        self.assertEqual(r.stdout, "")

    def test_a_redirect_inside_the_origin_is_followed_and_the_page_that_answered_is_named(self):
        """The documentation renames pages; the answer is printed and cited under the URL it came from."""
        r = self.docs("sub-agents", SHIM_CURL_REDIRECT=f"{self.ORIGIN}en/subagents.md")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"url: {self.ORIGIN}en/subagents.md", r.stdout)
        self.assertIn("# Page subagents.md", r.stdout, "the body of the page that answered is printed")

    def test_only_https_to_the_pinned_origin_is_ever_requested(self):
        for args in ((), ("sub-agents",), ("hooks",), ("cli-reference",)):
            self.docs(*args)
        self.assertTrue(self.requested())
        for url in self.requested():
            self.assertTrue(url.startswith(self.ORIGIN), url)
        for call in self.argv_calls():
            if call[0] != "curl":
                continue
            self.assertIn("--proto", call)
            self.assertEqual(call[call.index("--proto") + 1], "=https")
            self.assertEqual(call[call.index("--proto-redir") + 1], "=https")
            self.assertIn("--fail", call)
            self.assertIn("--max-time", call, "a documentation call without a timeout can hang a session")


class HuntPathsTests(ShimTest):
    """The shares a test hunt sends its hunters to: the directories that carry test files by the fixed
    conventions, packed into shares of at most 1500 lines and a longer file split into parts by line."""

    def commit(self, files):
        for name, text in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.git("add", "."); self.git("commit", "-qm", "files")

    def shares(self):
        r = self.run_script(WORKER / "hunt.sh", "paths")
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_every_convention_is_found_and_other_files_are_not(self):
        self.commit({
            "tests/test_login.py": "", "tests/helpers.py": "", "tests/run.sh": "",
            "spec/models/user_spec.rb": "", "app/views_test.py": "", "pkg/server_test.go": "",
            "ui/src/app.test.tsx": "", "ui/src/api.spec.js": "",
            # Not tests: code, data beside the tests, fixtures and vendored packages.
            "pkg/server.go": "", "app/views.py": "", "ui/src/app.tsx": "", "tests/data.json": "",
            "tests/fixtures/test_sample.py": "", "vendor/lib/lib_test.go": "",
        })
        out = self.shares()
        files = sorted(line.split("file: ", 1)[1] for line in out.splitlines() if line.startswith("  file: "))
        self.assertEqual(files, sorted([
            "tests/test_login.py", "tests/helpers.py", "tests/run.sh", "spec/models/user_spec.rb",
            "app/views_test.py", "pkg/server_test.go", "ui/src/app.test.tsx", "ui/src/api.spec.js",
        ]))
        self.assertIn("hunt_shares: 5,", out)
        self.assertIn(": ui/src, files: 2, lines: 0\n", out)

    def test_a_large_directory_is_packed_by_lines_and_a_long_file_is_split_into_parts(self):
        # Five files of 600 lines pack two to a share, and a file of 3200 lines is read in three parts, so no
        # hunter gets more than it can read to the end.
        files = {f"tests/test_{i}.py": "x = 1\n" * 600 for i in range(5)}
        files["tests/test_long.py"] = "x = 1\n" * 3200
        self.commit(files)
        out = self.shares()
        self.assertIn("hunt_shares: 6, at most 1500 lines each;", out)
        self.assertIn("share 1: tests, files: 2, lines: 1200\n  file: tests/test_0.py\n  file: tests/test_1.py\n", out)
        self.assertIn("share 3: tests, files: 1, lines: 600\n  file: tests/test_4.py\n", out)
        self.assertIn("share 4: tests, part 1 of 3 of tests/test_long.py, lines 1-1500 of 3200\n  file: tests/test_long.py\n", out)
        self.assertIn("share 6: tests, part 3 of 3 of tests/test_long.py, lines 3001-3200 of 3200\n", out)

    def test_a_repository_without_test_files_is_refused_with_the_patterns(self):
        self.commit({"app.py": "", "tests/fixtures/test_x.py": ""})
        r = self.run_script(WORKER / "hunt.sh", "paths")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("error: no test file", r.stderr)
        self.assertIn("test_*.py", r.stderr); self.assertIn("*_test.go", r.stderr)


HUNT_SOURCE = """def test_constant():
    assert 1


def test_login():
    assert login("a") == "ok"
"""


class HuntRecordTests(ShimTest):
    """The hunt record: rounds, removals recorded at their commits and kept candidates, and the block the
    briefs print, derived by the script and never restated by the worker."""

    def setUp(self):
        super().setUp()
        self.git("checkout", "-qb", "hunt/tests-2026-09-24")
        (self.repo / "tests").mkdir()
        (self.repo / "tests/test_login.py").write_text(HUNT_SOURCE)
        (self.repo / "tests/test_logout.py").write_text("def test_logout():\n    assert logout()\n")
        (self.repo / "app.py").write_text("def login(u):\n    return 'ok'\n")
        self.git("add", "."); self.git("commit", "-qm", "tests")

    def hunt(self, *args, stdin="", ok=True):
        r = self.run_script(WORKER / "hunt.sh", *args, stdin=stdin)
        if ok:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def remove_constant_test(self):
        (self.repo / "tests/test_login.py").write_text(HUNT_SOURCE.split("\n\n\n", 1)[1])
        self.git("commit", "-qam", "test: remove test_constant, which asserts a constant")

    REMOVED = """remove: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1
why: it checks that the number 1 is true, which no change to the code can break
still_proven: no, it touched no behaviour
"""

    def test_a_triaged_reply_names_the_removals_and_the_checks_and_refuses_what_does_not_fit(self):
        self.hunt("round")
        reply = "\n".join([
            "candidate: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1 | high",
            "candidate: tests/test_logout.py | test_logout | mocks-subject | logout may be stubbed | medium",
            "candidate: app.py | login | duplicate | the code itself | high",
            "Here are my findings:",
        ])
        out = self.hunt("triage", "1", stdin=reply).stdout
        self.assertIn("remove: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1\n", out)
        self.assertIn("check: tests/test_logout.py | test_logout | mocks-subject | logout may be stubbed\n", out)
        self.assertIn("refused: 'candidate: app.py | login | duplicate | the code itself | high': app.py is no test file", out)
        self.assertIn("refused: 'Here are my findings:': not a candidate line", out)
        self.assertIn("hunt_triage: 1 to remove, 1 to check, 0 kept, 0 dropped, 2 refused", out)

    def test_malformed_candidates_are_refused_with_their_reason(self):
        cases = {
            "candidate: tests/test_login.py | test_constant | cannot-fail | a | b | high": "it has 6 fields separated by |, not 5",
            "candidate: tests/test_login.py | test_constant | flaky | it sleeps | high": "'flaky' is none of the categories",
            "candidate: tests/test_login.py | test_constant | cannot-fail | a constant | sure": "'sure' is no confidence",
            "candidate: tests/test_login.py |  | cannot-fail | a constant | high": "a field is empty",
            "candidate: tests/../app.py | login | cannot-fail | a constant | high": "tests/../app.py is no test file this repository tracks",
            "candidate: /etc/tests/x.sh | x | cannot-fail | a constant | high": "/etc/tests/x.sh is no test file this repository tracks",
            "candidate: tests/test_gone.py | test_x | cannot-fail | a constant | high": "tests/test_gone.py is no test file this repository tracks",
            "candidate: tests/test_login.py | test_constant | cannot-fail | " + "x" * 301 + " | high": "the reason is longer than 300 characters",
        }
        # One share for each case, since a share's reply is triaged once: a directory each, sorted before tests.
        for i in range(len(cases)):
            (self.repo / f"a{i}/tests").mkdir(parents=True)
            (self.repo / f"a{i}/tests/test_x.py").write_text("def test_x():\n    pass\n")
        self.git("add", "."); self.git("commit", "-qm", "shares")
        self.hunt("round")
        for share, (line, reason) in enumerate(cases.items(), start=1):
            with self.subTest(line=line):
                out = self.hunt("triage", str(share), stdin=line + "\n").stdout
                self.assertIn(f"refused: '{line}': {reason}", out)
                self.assertIn("1 refused", out)

    def test_a_hunter_names_at_most_three_candidates(self):
        self.hunt("round")
        lines = [f"candidate: tests/test_login.py | t{i} | incidental | log lines | low" for i in range(4)]
        out = self.hunt("triage", "1", stdin="\n".join(lines)).stdout
        self.assertIn("hunt_triage: 0 to remove, 0 to check, 0 kept, 3 dropped, 1 refused", out)
        self.assertIn("at most 3 candidates", out)

    def test_a_candidate_proposed_twice_is_recorded_once(self):
        self.hunt("round")
        line = "candidate: tests/test_logout.py | test_logout | mocks-subject | logout may be stubbed | medium\n"
        self.hunt("triage", "1", stdin=line)
        # One reply per share and round: the same share is not triaged twice.
        again = self.hunt("triage", "1", stdin=line, ok=False)
        self.assertNotEqual(again.returncode, 0)
        self.assertIn("triaged already", again.stderr)
        self.remove_constant_test()
        self.hunt("removed", stdin=self.REMOVED)
        self.hunt("round")
        out = self.hunt("triage", "1", stdin=line).stdout
        self.assertIn("(checked already)", out)
        self.assertNotIn("check:", out)
        self.assertIn("hunt_kept: 1\n", self.hunt("print").stdout)

    def test_a_high_candidate_the_worker_leaves_is_kept_and_not_named_for_removal_again(self):
        self.hunt("round")
        line = "candidate: tests/test_login.py | test_login | cannot-fail | looks constant | high\n"
        self.assertIn("remove: tests/test_login.py | test_login", self.hunt("triage", "1", stdin=line).stdout)
        # The worker read it and found that it proves the login: nothing is removed, and the test stays kept.
        printed = self.hunt("print").stdout
        self.assertIn("hunt_kept: 1\n", printed)
        self.assertIn("\n  kept, round 1: tests/test_login.py | test_login | cannot-fail | looks constant\n", printed)
        second = self.hunt("round").stdout
        self.assertIn("  kept: tests/test_login.py | test_login | cannot-fail | looks constant\n", second)
        out = self.hunt("triage", "1", stdin=line).stdout
        self.assertNotIn("remove:", out)
        self.assertIn("hunt_triage: 0 to remove, 0 to check, 1 kept, 0 dropped, 0 refused", out)

    def test_a_removal_is_recorded_at_its_commit_and_printed_with_its_reason(self):
        self.hunt("round")
        self.remove_constant_test()
        out = self.hunt("removed", stdin=self.REMOVED).stdout
        head = self.git("rev-parse", "--short", "HEAD").strip()
        self.assertIn(f"hunt_removed: test_constant in tests/test_login.py at {head}, round 1", out)
        printed = self.hunt("print").stdout
        self.assertIn("hunt_removed: 1\n", printed)
        self.assertIn(f"\n  removed 1 at {head}, round 1: tests/test_login.py | test_constant | cannot-fail\n", printed)
        self.assertIn("\n    why: it checks that the number 1 is true, which no change to the code can break\n", printed)
        self.assertIn("\n    still proven: no, it touched no behaviour\n", printed)
        # One commit removes one test: the same commit cannot be recorded for a second removal.
        again = self.hunt("removed", stdin=self.REMOVED.replace("test_constant", "test_login"), ok=False)
        self.assertNotEqual(again.returncode, 0)
        self.assertIn("recorded already", again.stderr)

    def test_a_removal_is_refused_until_it_is_committed_on_its_own(self):
        self.hunt("round")
        r = self.hunt("removed", stdin=self.REMOVED, ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("removes nothing", r.stderr)
        (self.repo / "tests/test_login.py").write_text("")
        r = self.hunt("removed", stdin=self.REMOVED, ok=False)
        self.assertIn("uncommitted changes", r.stderr)
        self.git("checkout", "--", "tests/test_login.py")
        (self.repo / "app.py").write_text("")
        self.git("commit", "-qam", "unrelated")
        r = self.hunt("removed", stdin=self.REMOVED, ok=False)
        self.assertIn("does not touch tests/test_login.py", r.stderr)
        r = self.hunt("removed", stdin=self.REMOVED.replace("still_proven: no", "still_proven: perhaps"), ok=False)
        self.assertIn("starts with yes or no", r.stderr)
        self.assertIn("hunt_removed: 0\n", self.hunt("print").stdout)

    def test_rounds_run_until_one_finds_no_new_candidate(self):
        self.assertIn("hunt_round: 1 of at most 3\n", self.hunt("round").stdout)
        self.hunt("triage", "1", stdin="candidate: tests/test_logout.py | test_logout | mocks-subject | stubbed | medium\n")
        self.remove_constant_test()
        self.hunt("removed", stdin=self.REMOVED)
        second = self.hunt("round").stdout
        self.assertIn("hunt_round: 2 of at most 3\n", second)
        # The next round's hunter is told what was checked and kept in its share.
        self.assertIn("  kept: tests/test_logout.py | test_logout | mocks-subject | stubbed\n", second)
        self.hunt("triage", "1", stdin="no candidates\n")
        ended = self.hunt("round").stdout
        self.assertIn("hunt_round: none; the hunt has ended: round 2 found no new candidate", ended)
        self.assertIn("next: 1 test(s) removed in 2 round(s): report 'hunt: 1 removed'", ended)
        self.assertIn("hunt_rounds: 2 of at most 3; the hunt has ended: round 2 found no new candidate", self.hunt("print").stdout)
        r = self.hunt("triage", "1", stdin="no candidates\n", ok=False)
        self.assertIn("the hunt has ended", r.stderr)

    def test_the_record_as_json_holds_the_rounds_the_removals_and_the_kept_candidates(self):
        empty = json.loads(self.hunt("json").stdout)
        self.assertEqual(empty, {"branch": "hunt/tests-2026-09-24", "rounds": 0, "max_rounds": 3, "ended": None,
                                 "removed": [], "kept": [], "stale": 0})
        self.hunt("round")
        self.hunt("triage", "1", stdin='candidate: tests/test_logout.py | test_logout | mocks-subject | a "stub"\\ only | medium\n')
        self.remove_constant_test()
        self.hunt("removed", stdin=self.REMOVED)
        head = self.git("rev-parse", "--short", "HEAD").strip()
        record = json.loads(self.hunt("json").stdout)
        self.assertEqual(record["rounds"], 1)
        self.assertIsNone(record["ended"])
        self.assertEqual(record["removed"], [{
            "round": 1, "commit": head, "path": "tests/test_login.py", "test": "test_constant", "category": "cannot-fail",
            "reason": "asserts the constant 1", "why": "it checks that the number 1 is true, which no change to the code can break",
            "still_proven": "no, it touched no behaviour"}])
        # A hunter's text reaches the controller as it stands, quotes and backslashes included.
        self.assertEqual(record["kept"], [{"round": 1, "path": "tests/test_logout.py", "test": "test_logout",
                                           "category": "mocks-subject", "reason": 'a "stub"\\ only', "confidence": "medium"}])
        self.hunt("round")
        self.hunt("triage", "1", stdin="no candidates\n")
        self.hunt("round")
        self.assertEqual(json.loads(self.hunt("json").stdout)["ended"], "round 2 found no new candidate")

    def test_a_hunt_that_finds_nothing_ends_after_its_first_round_without_a_pull_request(self):
        self.hunt("round")
        self.hunt("triage", "1", stdin="no candidates\n")
        ended = self.hunt("round").stdout
        self.assertIn("round 1 found no new candidate", ended)
        self.assertIn("report 'hunt: nothing removed'", ended)
        self.assertIn("opens no pull request", ended)

    def test_a_round_left_before_every_reply_was_triaged_resumes_with_the_shares_still_out(self):
        (self.repo / "spec").mkdir()
        (self.repo / "spec/test_api.py").write_text("def test_api():\n    assert api()\n")
        self.git("add", "."); self.git("commit", "-qm", "spec")
        first = self.hunt("round").stdout
        self.assertIn("share 1: spec, files: 1, lines: 2\n", first)
        self.assertIn("share 2: tests, files: 2, lines: 8\n", first)
        self.hunt("triage", "1", stdin="no candidates\n")
        # A fresh context calls round again: the round is not closed, and only share 2 is handed out.
        resumed = self.hunt("round").stdout
        self.assertIn("hunt_round: 1 of at most 3, resumed: 1 of 2 share(s) not triaged yet", resumed)
        self.assertIn("share 2: tests, files: 2, lines: 8\n  file: tests/test_login.py\n", resumed)
        self.assertNotIn("share 1:", resumed)
        self.hunt("triage", "2", stdin="no candidates\n")
        self.assertIn("round 1 found no new candidate", self.hunt("round").stdout)

    def test_a_triage_names_a_share_of_the_running_round(self):
        self.hunt("round")
        for args, message in ((["triage"], "name the share"), (["triage", "x"], "name the share"),
                              (["triage", "2"], "round 1 has no share 2")):
            with self.subTest(args=args):
                r = self.hunt(*args, stdin="no candidates\n", ok=False)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(message, r.stderr)

    def test_a_removal_a_later_commit_restores_is_no_longer_listed(self):
        self.hunt("round")
        self.remove_constant_test()
        self.hunt("removed", stdin=self.REMOVED)
        self.git("revert", "--no-edit", "HEAD")
        printed = self.hunt("print").stdout
        self.assertIn("hunt_removed: 0\n", printed)
        self.assertIn("hunt_note: 1 recorded removal(s) no longer stand", printed)

    def test_a_removal_whose_test_is_still_in_its_file_is_refused(self):
        self.hunt("round")
        (self.repo / "app.py").write_text("")
        (self.repo / "tests/test_login.py").write_text(HUNT_SOURCE + "\n# touched\n")
        self.git("commit", "-qam", "test: touch the file, remove nothing")
        r = self.hunt("removed", stdin=self.REMOVED, ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("still names test_constant", r.stderr)

    def test_a_later_round_hunts_only_the_files_the_round_before_found_something_in(self):
        first = self.hunt("round").stdout
        self.assertIn("share 1: tests, files: 2, lines: 8\n  file: tests/test_login.py\n  file: tests/test_logout.py\n", first)
        self.hunt("triage", "1", stdin="candidate: tests/test_logout.py | test_logout | mocks-subject | stubbed | medium\n")
        second = self.hunt("round").stdout
        self.assertIn("hunt_shares: 1,", second)
        self.assertIn("share 1: tests, files: 1, lines: 2\n  file: tests/test_logout.py\n", second)
        self.assertNotIn("test_login.py", second)

    def test_a_hunt_ends_when_the_files_it_found_something_in_are_gone(self):
        self.hunt("round")
        self.hunt("triage", "1", stdin="candidate: tests/test_logout.py | test_logout | cannot-fail | asserts a stub | high\n")
        self.git("rm", "-q", "tests/test_logout.py"); self.git("commit", "-qm", "test: remove test_logout")
        self.hunt("removed", stdin="remove: tests/test_logout.py | test_logout | cannot-fail | asserts a stub\n"
                                   "why: it asserts what a stub returns\nstill_proven: no, it proved nothing\n")
        ended = self.hunt("round").stdout
        self.assertIn("the hunt has ended: no file round 1 found a candidate in is a test file any more", ended)
        self.assertIn("next: 1 test(s) removed in 1 round(s)", ended)

    def test_the_hunt_runs_three_rounds_at_most(self):
        for n in range(3):
            self.assertIn(f"hunt_round: {n + 1} of at most 3", self.hunt("round").stdout)
            self.hunt("triage", "1", stdin=f"candidate: tests/test_logout.py | t{n} | incidental | log lines | medium\n")
        self.assertIn("the hunt has ended: 3 rounds ran", self.hunt("round").stdout)


if __name__ == "__main__":
    unittest.main()
