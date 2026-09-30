import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from helpers import ROOT, STANDARDS, WORKER, ShimTest

PLUGINS = sorted(p for p in (ROOT / "plugins").iterdir() if (p / ".claude-plugin/plugin.json").exists())


class ManifestTests(unittest.TestCase):
    def test_marketplace_lists_every_plugin_with_matching_names(self):
        market = json.loads((ROOT / ".claude-plugin/marketplace.json").read_text())
        listed = {p["name"]: p["source"] for p in market["plugins"]}
        for plugin in PLUGINS:
            manifest = json.loads((plugin / ".claude-plugin/plugin.json").read_text())
            self.assertEqual(manifest["name"], plugin.name)
            self.assertEqual(listed[plugin.name], f"./plugins/{plugin.name}")
            self.assertRegex(manifest["version"], r"^\d+\.\d+\.\d+$")

    def test_every_skill_and_agent_has_frontmatter_name_matching_its_file(self):
        for plugin in PLUGINS:
            for skill in plugin.glob("skills/*/SKILL.md"):
                fm = skill.read_text().split("---")[1]
                self.assertIn(f"name: {skill.parent.name}\n", fm, skill)
                self.assertIn("description:", fm, skill)
            for agent in plugin.glob("agents/*.md"):
                fm = agent.read_text().split("---")[1]
                self.assertIn(f"name: {agent.stem}\n", fm, agent)

    def test_agent_models_and_efforts_match_their_role(self):
        """The model and effort of an agent are a decision. A session agent names its own model; every subagent runs on sonnet at its effort and none inherits."""
        sessions = {
            "worker/agents/worker.md": ("opus", None),
            "planner/agents/planner.md": ("fable", None),
        }
        subagents = {
            "worker/agents/code-reviewer.md": "high",
            "worker/agents/security-reviewer.md": "high",
            "worker/agents/docs-reviewer.md": "high",
            "worker/agents/test-reviewer.md": "high",
            "worker/agents/senior-reviewer.md": "high",
            "worker/agents/test-hunter.md": "high",
            "worker/agents/docs-lookup.md": "high",
            "planner/agents/spec-checker.md": "high",
            "repo-standards/agents/agent-config-auditor.md": "high",
            "repo-standards/agents/docs-auditor.md": "high",
            "repo-standards/agents/files-auditor.md": "high",
            "repo-standards/agents/security-auditor.md": "high",
            "repo-standards/agents/tests-ci-auditor.md": "high",
            "repo-standards/agents/workspace-auditor.md": "high",
        }
        expected = dict(sessions, **{rel: ("sonnet", effort) for rel, effort in subagents.items()})
        agents = sorted(ROOT.glob("plugins/*/agents/*.md"))
        # Every agent file has a decided value, so a new agent cannot slip in on a default.
        self.assertEqual(set(expected), {a.relative_to(ROOT / "plugins").as_posix() for a in agents})
        for agent in agents:
            rel = agent.relative_to(ROOT / "plugins").as_posix()
            fm = agent.read_text().split("---")[1]
            model = re.search(r"^model: (.+)$", fm, re.M)
            effort = re.search(r"^effort: (.+)$", fm, re.M)
            self.assertIsNotNone(model, rel)
            # claude plugin validate accepts any string here, so a typo like "fabel" or "hgih" is only caught by this.
            self.assertIn(model.group(1), {"fable", "opus", "sonnet", "haiku"}, rel)
            if effort:
                self.assertIn(effort.group(1), {"low", "medium", "high", "xhigh", "max"}, rel)
            self.assertEqual((model.group(1), effort and effort.group(1)), expected[rel], rel)

    def assert_read_only(self, agent):
        """An agent that only judges: no edit tool and no agent tool, neither granted nor reachable."""
        fields = dict(line.split(": ", 1) for line in agent.read_text().split("---")[1].strip().splitlines())
        self.assertEqual(fields["tools"].split(", "), ["Read", "Grep", "Glob", "Bash"], agent)
        self.assertTrue({"Edit", "Write", "NotebookEdit", "Agent"} <= set(fields["disallowedTools"].split(", ")), agent)
        self.assertNotIn("mcpServers", fields, agent)

    def test_every_auditor_is_read_only_by_its_declared_tools(self):
        agents = ROOT / "plugins/repo-standards/agents"
        names = {"files", "agent-config", "docs", "tests-ci", "workspace", "security"}
        self.assertEqual({p.stem for p in agents.glob("*.md")}, {f"{n}-auditor" for n in names})
        for agent in agents.glob("*.md"):
            self.assert_read_only(agent)

    def test_the_spec_checker_is_read_only_by_its_declared_tools(self):
        self.assert_read_only(ROOT / "plugins/planner/agents/spec-checker.md")

    def test_the_documentation_lookup_is_read_only_by_its_declared_tools(self):
        self.assert_read_only(ROOT / "plugins/worker/agents/docs-lookup.md")

    def test_the_hunter_is_read_only_and_has_no_shell_by_its_declared_tools(self):
        """A hunter reads repository files and nothing else: without a shell it can neither run a test nor
        change a file, whatever the files it reads tell it to do."""
        agent = ROOT / "plugins/worker/agents/test-hunter.md"
        fields = dict(line.split(": ", 1) for line in agent.read_text().split("---")[1].strip().splitlines())
        self.assertEqual(fields["tools"].split(", "), ["Read", "Grep", "Glob"])
        self.assertTrue({"Bash", "Edit", "Write", "NotebookEdit", "Agent"} <= set(fields["disallowedTools"].split(", ")))
        self.assertNotIn("mcpServers", fields)

    def test_the_test_hunt_skill_is_user_invoked_only(self):
        fm = (ROOT / "plugins/worker/skills/hunt-tests/SKILL.md").read_text().split("---")[1]
        self.assertIn("disable-model-invocation: true\n", fm)

    def test_the_worker_plugin_carries_skills_and_agents_and_no_hook(self):
        """The controller drives the stages (ADR 0063): the worker plugin holds prompts, and a script only
        where a skill injects or runs it."""
        worker = ROOT / "plugins/worker"
        self.assertFalse((worker / "hooks").exists(), "the worker plugin carries a hooks directory")
        self.assertNotIn("hooks", json.loads((worker / ".claude-plugin/plugin.json").read_text()))
        used = set()
        for skill in worker.glob("skills/*/SKILL.md"):
            used |= set(re.findall(r"\$\{CLAUDE_PLUGIN_ROOT\}/scripts/([\w.-]+)", skill.read_text()))
        scripts = {p.name for p in (worker / "scripts").glob("*.sh")}
        self.assertEqual(scripts - {"lib.sh"}, used, "a worker script no skill runs is steering the controller owns")

    def test_the_worker_reaches_the_documentation_through_its_script_and_not_through_the_web_tools(self):
        """The worker's main context holds issue text written by someone else, so its own tool list carries
        no free web access; the documentation arrives through the pinned script and a lookup subagent
        (issue #44, ADR 0030). A subagent with its own tool list does get WebFetch, so this is surface
        reduction in the context that reads untrusted text, not a network boundary."""
        worker = ROOT / "plugins/worker/agents/worker.md"
        tools = self.declared_tools(worker)
        for tool in ("WebFetch", "WebSearch"):
            self.assertNotIn(tool, tools,
                             f"{worker.name} lists {tool}; the documentation is read with /worker:docs, which "
                             f"runs claude-docs.sh in a lookup subagent")

    def declared_tools(self, agent):
        """The tools of an agent file, each name mapped to its specifier list: `Agent(a, b)` is
        {"Agent": ["a", "b"]}, a bare `Bash` is {"Bash": None}."""
        declared = re.search(r"^tools: (.+)$", agent.read_text().split("---")[1], re.M)
        self.assertIsNotNone(declared, f"{agent.name} declares no tools")
        # Split on the comma alone, outside parentheses: a tool written without the space after it is
        # still a granted tool, and the commas of a specifier list belong to their tool.
        tools = {}
        for entry in re.split(r",(?![^(]*\))", declared.group(1)):
            name, _, inner = entry.strip().partition("(")
            tools[name] = [item.strip() for item in inner.rstrip(")").split(",")] if inner else None
        return tools

    def test_the_worker_spawns_its_own_subagents_and_no_other_type(self):
        """A subagent's declared tools are granted, not intersected with the worker's, so a bare `Agent`
        hands the worker every built-in type, the ones with `WebFetch` and `WebSearch` among them
        (`general-purpose`, `claude-code-guide`). The allowlist names the plugin's own subagents and
        nothing else (ADR 0030). A type missing from it fails at the Agent call, so a new agent file
        has to be listed here to be reachable at all."""
        agents = ROOT / "plugins/worker/agents"
        own = {f"worker:{a.stem}" for a in agents.glob("*.md")} - {"worker:worker"}
        allowed = self.declared_tools(agents / "worker.md").get("Agent")
        self.assertIsNotNone(allowed, "worker.md has no Agent(...) allowlist; a bare Agent spawns every built-in type")
        self.assertEqual(sorted(allowed), sorted(own))

    def test_every_planner_skill_is_user_invoked_only(self):
        skills = sorted(p.parent.name for p in (ROOT / "plugins/planner/skills").glob("*/SKILL.md"))
        self.assertIn("accept", skills)
        for skill in skills:
            fm = (ROOT / f"plugins/planner/skills/{skill}/SKILL.md").read_text().split("---")[1]
            self.assertIn("disable-model-invocation: true\n", fm, skill)

    def test_the_standardisation_run_is_user_invoked_only(self):
        for skill in ("standardize", "apply"):
            fm = (ROOT / f"plugins/repo-standards/skills/{skill}/SKILL.md").read_text().split("---")[1]
            self.assertIn("disable-model-invocation: true\n", fm, skill)

    def test_every_inline_command_in_a_skill_is_pre_approved(self):
        # A forked skill's !`command` fails silently without a matching allowed-tools rule (verified on 2.1.274).
        for plugin in PLUGINS:
            for skill in plugin.glob("skills/*/SKILL.md"):
                fm, body = skill.read_text().split("---")[1:3]
                commands = re.findall(r"!`([^`]+)`", body)
                if not commands:
                    continue
                rules = re.findall(r"Bash\(([^)]+)\)", fm)
                for cmd in commands:
                    script = cmd.split()[0]
                    self.assertTrue(script.startswith("${CLAUDE_PLUGIN_ROOT}/scripts/"), f"{skill}: {cmd} must be a plugin script")
                    self.assertTrue(any(script == r.rstrip("*") for r in rules), f"{skill}: no allowed-tools rule for {cmd}")

    def test_scripts_referenced_by_skills_and_hooks_exist_and_are_executable(self):
        for plugin in PLUGINS:
            texts = [p.read_text() for p in plugin.glob("skills/*/SKILL.md")]
            hooks = plugin / "hooks/hooks.json"
            if hooks.exists():
                texts.append(hooks.read_text())
            for text in texts:
                for name in re.findall(r"\$\{CLAUDE_PLUGIN_ROOT\}/scripts/([\w.-]+)", text):
                    script = plugin / "scripts" / name
                    self.assertTrue(script.exists(), script)
                    self.assertTrue(script.stat().st_mode & 0o111, f"{script} not executable")

    @unittest.skipUnless(shutil.which("claude"), "claude CLI not installed")
    def test_claude_plugin_validate_strict(self):
        for path in [ROOT, *PLUGINS]:
            r = subprocess.run(["claude", "plugin", "validate", str(path), "--strict"], text=True, capture_output=True)
            self.assertEqual(r.returncode, 0, f"{path}\n{r.stdout}{r.stderr}")


class FactoryGateTests(unittest.TestCase):
    """`factory-go`, the Go part of `make factory`: a tool it needs and cannot find is named with its fix."""

    def gate(self, *tools):
        # The recipe runs with nothing on PATH but the named tools, each a stub that succeeds and prints nothing.
        # It is the Go part alone: `make factory` builds the dashboard first, which needs an npm this PATH has not.
        with tempfile.TemporaryDirectory() as path:
            for tool in tools:
                stub = Path(path) / tool
                stub.write_text("#!/bin/sh\nexit 0\n")
                stub.chmod(0o755)
            return subprocess.run([shutil.which("make"), "factory-go"], cwd=ROOT, env={"PATH": path, "HOME": path},
                                  text=True, capture_output=True)

    def test_a_missing_go_is_named_with_the_fix(self):
        r = self.gate()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("error: go not installed; brew install go", r.stderr)

    def test_a_gofmt_that_cannot_run_fails_the_gate_instead_of_passing_it(self):
        r = self.gate("go")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("error: gofmt could not run", r.stderr)

    def test_a_missing_staticcheck_is_named_with_the_pinned_install(self):
        r = self.gate("go", "gofmt")
        self.assertNotEqual(r.returncode, 0)
        named = re.search(r"error: staticcheck not installed; go install honnef\.co/go/tools/cmd/staticcheck@([0-9.]+)", r.stderr)
        self.assertIsNotNone(named, r.stderr)
        # Local and CI findings match only while both run the same version.
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        self.assertIn(f"go install honnef.co/go/tools/cmd/staticcheck@{named.group(1)}\n", ci)
        # CI installs it only when its cache misses, so the cached binary has to be keyed by that version too.
        self.assertEqual(re.findall(r"key: staticcheck-([0-9.]+)-", ci), [named.group(1)])


class BrowserImageTests(unittest.TestCase):
    """CI runs each browser test in Playwright's image, which carries one browser build."""

    def test_each_browser_job_runs_the_image_of_the_playwright_its_lockfile_installs(self):
        # A tag behind the lockfile leaves the test without its browser, and `playwright install` in the
        # gate would fetch it without the system libraries the image was chosen to carry.
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        for job, ui in (("factory-browser", "factory/ui"), ("local", "dashboard")):
            block = re.search(rf"^  {re.escape(job)}:\n(.*?)(?=^  \S|\Z)", ci, re.S | re.M)
            self.assertIsNotNone(block, f"no job {job} in ci.yml")
            tag = re.search(r"image: mcr\.microsoft\.com/playwright:v([0-9.]+)-noble\n", block.group(1))
            self.assertIsNotNone(tag, f"job {job} runs in no Playwright image")
            lock = json.loads((ROOT / ui / "package-lock.json").read_text())
            self.assertEqual(tag.group(1), lock["packages"]["node_modules/playwright-core"]["version"], job)


class PythonGateTests(unittest.TestCase):
    """`make test`, the Python part of the gate: it runs the suite through the runner, not plain discovery."""

    def test_make_test_runs_the_whole_suite_through_the_runner(self):
        # The recipe runs with nothing on PATH but a python3 that records its arguments, one per line.
        # `-o` takes the dashboard build as done, so the recipe runs without an npm and without a build.
        with tempfile.TemporaryDirectory() as path:
            calls = Path(path) / "python3.argv"
            stub = Path(path) / "python3"
            stub.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{calls}'\n")
            stub.chmod(0o755)
            r = subprocess.run([shutil.which("make"), "-o", "factory/ui/dist/app/index.html", "test"], cwd=ROOT,
                               env={"PATH": path, "HOME": path}, text=True, capture_output=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            # The runner and no argument: a module or class after it would run part of the suite.
            self.assertEqual(calls.read_text().splitlines(), ["tests/run.py"])


class ShimCallLogTests(ShimTest):
    """The harness itself: what the shims log has to be what a test reads back."""

    def test_an_argument_with_a_newline_stays_one_logged_call(self):
        # release.sh passes a multi-line --body, so without escaping the log would read back as two calls.
        subprocess.run(["gh", "pr", "create", "--title", "t", "--body", "one\ntwo"], env=self.env(), capture_output=True)
        self.assertEqual(self.argv_calls(), [["gh", "pr", "create", "--title", "t", "--body", "one\ntwo"]])


class LabelVocabularyTests(ShimTest):
    """repo-standards carries a copy of the label vocabulary, and the contract fixture states it (ADR 0062); a copy
    that differs from the fixture is a bug. The controller's github tools carry the other copy, which its own
    test holds to the fixture."""

    STANDARDS_FILE = str((STANDARDS / "lib.sh").relative_to(ROOT))
    FIXTURE_FILE = "contract/fixture.json"

    def standards_vocabulary(self):
        """WF_LABELS as workspace.sh feeds it into its label loop. Sourced outside a git repository, because
        reading the vocabulary must not need one. Split like every shell reader of the value: a pipe in the
        description belongs to the description."""
        r = subprocess.run(["bash", "-c", r'. "$1/lib.sh"; printf "%s\n" "$WF_LABELS"', "_", str(STANDARDS)],
                           cwd=self.base, text=True, capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        vocabulary = []
        for line in r.stdout.splitlines():
            if not line:
                continue
            entry = tuple(line.split("|", 2))
            self.assertEqual(len(entry), 3, f"{self.STANDARDS_FILE} has a label that is not name|color|description: {line!r}")
            vocabulary.append(entry)
        return vocabulary

    def fixture_vocabulary(self):
        """The vocabulary of the contract fixture, in order."""
        labels = json.loads((ROOT / self.FIXTURE_FILE).read_text())["labels"]["vocabulary"]
        return [(l["name"], l["color"], l["description"]) for l in labels]

    def test_the_standards_copy_of_the_label_vocabulary_follows_the_contract_fixture(self):
        copy, fixture = self.standards_vocabulary(), self.fixture_vocabulary()
        self.assertTrue(copy, f"no labels read from {self.STANDARDS_FILE}")
        for at, (have, want) in enumerate(zip(copy, fixture)):
            if have != want:
                self.fail(f"label {want[0]!r}: {self.STANDARDS_FILE} has {have} at place {at + 1}, the contract fixture {want}. "
                          f"Change the fixture first, then both copies; do not adjust this test.")
        if len(copy) != len(fixture):
            extra = copy[len(fixture):] or fixture[len(copy):]
            self.fail(f"label {extra[0][0]!r}: {self.STANDARDS_FILE} and the contract fixture differ in the labels they carry")

    def test_the_routing_label_of_the_fixture_is_in_the_standards_vocabulary(self):
        """The frontier rule of the contract fixture leaves an issue with the routing label to the factory; a
        repository that lacks the label could not be routed by the name the peers read."""
        routing = json.loads((ROOT / self.FIXTURE_FILE).read_text())["frontier"]["routing_label"]
        self.assertIn(routing, [name for name, _, _ in self.standards_vocabulary()],
                      f"the fixture routes by the label {routing}, which {self.STANDARDS_FILE} does not define")


class TestFileRuleTests(ShimTest):
    """The worker splits the test files among its hunters by the fixed conventions of a test hunt."""

    def test_the_test_file_rule_finds_the_test_files_and_skips_the_rest(self):
        for name in ("tests/test_a.py", "tests/helpers.py", "tests/shim", "tests/fixtures/test_b.py", "spec/x_spec.rb",
                     "a/b_test.go", "a/b.go", "c/d_test.py", "ui/e.test.ts", "ui/f.spec.jsx", "ui/g.ts",
                     "vendor/h_test.go", "node_modules/i.test.js", "testdata/test_j.py", "k/__snapshots__/l.test.js"):
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("")
        self.git("add", "."); self.git("commit", "-qm", "files")
        r = subprocess.run(["bash", "-c", f'. "{WORKER / "lib.sh"}"; git ls-files | wf_test_paths'],
                           cwd=self.repo, env=self.env(), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), [
            "a/b_test.go", "c/d_test.py", "spec/x_spec.rb", "tests/helpers.py", "tests/test_a.py", "ui/e.test.ts", "ui/f.spec.jsx"])


if __name__ == "__main__":
    unittest.main()
