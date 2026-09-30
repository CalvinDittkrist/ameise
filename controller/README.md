# Controller

`ameise` is the local workflow and the peer of the factory: one program per machine that holds the projects of this machine and serves them over a local API. It is TypeScript and shares no code with the factory.

## Install
One npm package, `ameise`, carries the controller, the dashboard and the worker, planner and repo-standards plugins of the tagged commit, released under the package's version ([ADR 0060](../docs/adr/0060-one-release-unit-bundles-the-plugins.md)). It is private and not on npm yet: install it from the tarball on its [GitHub release](https://github.com/CalvinDittkrist/ameise/releases), by its URL. It needs Node 22 or later, Claude Code, git, `jq` and a logged-in `gh`.

```sh
npm install --global https://github.com/CalvinDittkrist/ameise/releases/download/controller/v0.1.0/ameise-0.1.0.tgz
ameise                             # starts the server and opens the dashboard
ameise projects add ~/src/repo     # in a second shell, or from the dashboard
```

The program had another name before `ameise`. It does not read the directories of that name, so a machine that ran it adds its projects again ([ADR 0067](../docs/adr/0067-the-rename-is-a-hard-cut.md)).

The build copies the plugins of the checkout into `dist/plugins`, and every session loads them from there. Packing refuses a build without the dashboard or the plugins.

## Commands
- `ameise` starts the server on the configured loopback address and opens the browser there (`BROWSER` names another browser).
- `ameise --fake` does the same against the scripted `fake/gh` and `fake/claude`, so nothing reaches GitHub or a model.
- `ameise projects` lists the projects with their derived facts.
- `ameise projects add <path>` adds the checkout at `<path>`; `ameise projects remove <path>` removes it.
- `ameise board [<path>]` prints the board of every project, or of the project at `<path>`.
  - It prints a line per project, then one per process, frontier issue, spec ready for acceptance and note.
- `ameise claim <issue> [--yolo] [--force] [--env NAME=VALUE]... [--project <path>]` claims the issue into a work process; see [Claim and abandon](#claim-and-abandon).
- `ameise abandon <issue> [--force] [--project <path>]` removes the issue's worktree and process.
- `ameise resume <issue> [--project <path>]` goes on with the interrupted session of the issue's process; see [Restart](#restart).
- `ameise adopt <issue> [--project <path>]` takes the issue's foreign worktree into a process.
- `ameise merge <pr> [--project <path>]` merges a ready pull request; see [Merge](#merge).
- `ameise release <vX.Y.Z> [--project <path>]` releases a finished milestone; see [Release](#release).
- `ameise accept <spec> [--project <path>]` opens a plan process on a spec; see [Acceptance start](#acceptance-start).
- `ameise plan [<idea>... | <issue>] [--project <path>]` opens a plan process from an idea, an issue or nothing; see [Plan process](#plan-process).
- `ameise hunt [--project <path>]` opens a hunt process and starts its test hunt; see [Hunt process](#hunt-process).
  - Without `--project` each acts on the project of the current directory.
- Every command but the first talks to the running server. Without one it prints `error:` with the command that starts it and exits non-zero.

## Start
The start stops with one `error:` line that names the fix when:
- the configuration is malformed,
- `gh` is missing or not logged in,
- `claude` is missing, outside fake mode, which runs on the scripted `fake/claude` it ships.

## Configuration
One file per machine: `$XDG_CONFIG_HOME/ameise/config.json`, else `~/.config/ameise/config.json`. Without it the defaults hold.

```json
{
  "listen": "127.0.0.1:7420",
  "quota_axi": "",
  "quota_minimum": 12,
  "notifications": true,
  "notifier": "",
  "terminal": "",
  "projects": ["/home/me/src/repo"]
}
```

- `listen` is a loopback address; the controller is never reachable from another machine.
- `quota_axi` names the quota-axi command by its absolute path; empty switches the quota check off. `quota_minimum` is a percentage. See [Quota](#quota) for the install.
  - The controller runs the path as one program, without a shell.
  - A relative path or one with whitespace, such as `npx quota-axi`, stops the start and every later read of the file.
- `notifications` switches the native notifications on or off. `notifier` names the command they are sent through; empty is the platform's own. See [Notifications](#notifications).
- `terminal` names the command that opens a session in a terminal window; empty is the platform's own. See [Open in terminal](#open-in-terminal).
- A project is the absolute path of a checkout, stored as the top of its working tree.
- Listing, adding and removing projects read this file again, so a change made by hand while the server runs shows at once and is kept.
- The rewrite fills in any field the file lacks with its default.
- A changed `listen` takes effect at the next start. Until then the CLI finds the server at the address it started on.

## Projects
Owner and name come from the checkout's origin, which must be on GitHub. The base branch follows the base branch rule, whose cases [`contract/base-branch.json`](../contract/base-branch.json) states:
1. `WF_BASE_BRANCH` in the env block of the checkout's `.claude/settings.json`, when git accepts it as a branch name,
2. the head `origin` points at,
3. the default branch GitHub names,
4. `main`.

All of them are derived on every read and never stored. A path that is no git checkout, or whose origin is missing or not on GitHub, is refused with the reason.

## Board
The board is derived on every request from the state directory, git and GitHub, and stored nowhere. A project's board is its facts and:
- `processes`: one per worktree of the checkout whose branch names a process kind, and one per process record in the state directory.
  - Each has `id`, `kind`, `state`, `stage`, `issue`, `branch`, `worktree`, `pr`, `checks`, `since` and a one-line `note`.
  - The kind comes from the branch: `plan/` is `plan`, `hunt/` is `hunt`, `chore/standardize` is `standardize`, an issue branch is `work`.
  - A record decides state, stage and note.
  - A work worktree without one is `foreign`: this controller did not start it, and its note names its pull request when it has one.
  - A worktree of another kind without one is read from its pull request: green and not a draft is `ready`, pending checks `waiting`, anything else `running`.
  - `id` names its record, the file `processes/<id>.json`, and is null for a worktree without one.
  - `unseen` says it turned `blocked`, `ready` or `failed` and its page has not been opened since.
  - A claimed process is `created` until its first session starts.
  - `blocked`, `approval`, `ready`, `input`, `interrupted`, `foreign` and `done` wait for a person: `needs` is true and `action` is `Answer`, `Approve`, `Merge`, `Continue`, `Resume`, `Adopt` or `Finish`.
  - `done` is a hunt that removed nothing and opens no pull request.
  - `failed` waits for a person as well, with the action `Open`: its note is the reason. Every other process runs, with the action `Open`.
- `frontier`: the agent-ready issues without assignee, open blocker, routing label or process of this machine.
  - A ticket of a spec run is held unless it carries `ready-for-human`; one whose parent cannot be read is held too.
  - The tests hold it to the frontier of the [contract fixture](../contract/fixture.json).
- `acceptance`: the open specs that have sub-issues, all of them closed, and no process of this machine.
- `notes`: what GitHub did not answer, so an empty section reads as unknown and not as idle.

## Claim and abandon
A claim takes an issue of a project into a work process. It refuses, with the reason and `409`:
- an issue that is not `ready-for-agent`,
- an issue routed to the factory (`factory`),
- a ticket of a spec run without `ready-for-human`: it carries `factory:spec-run`, or its parent does,
- an issue whose branch is on origin already, which another claimer created,
- an issue that has a process on this machine already: a worktree of its branch or a process record.
  - The answer names the process and carries it as `process`: `{id, branch, worktree, state}`.
  - For a worktree without a record, `id` is null and `state` is `foreign`.

Force lifts the first four and never the last. Each refusal it lifts comes back as a warning. On a branch on origin it adopts that branch, so the worktree goes on from its work. A closed issue is refused always.

The mode is `manual` or `yolo`. The overrides set worker knobs for the process, each `NAME=VALUE`: `WF_REVIEWERS`, `WF_REVIEW_ROUNDS`, `WF_CI_REPAIR_ROUNDS`, `WF_PR_BOT_REVIEWERS`, `WF_PR_REVIEW_WAIT` and `WF_DOCS_TIMEOUT`, and the [gate's](#gate-stage) `WF_GATE`, `WF_GATE_ROUNDS`, `WF_GATE_TIMEOUT`, `WF_CHECKS_GRACE` and `WF_STAGE_TIMEOUT`. A malformed override, another name or a name given twice is refused with `400` before anything is created. So is a `WF_GATE` that is no gate form, whether an override or the checkout's settings set it.

A claim then:
1. names the branch by the branch contract of the [contract fixture](../contract/fixture.json): `<type>/<number>-<slug>`,
2. creates it from `origin/<base>` and its worktree in `.claude/worktrees/` of the checkout, which git ignores through `.git/info/exclude`,
3. assigns the issue to the user gh is logged in as, and undoes the two when GitHub refuses,
4. writes the process record `processes/<id>.json` with the mode and the overrides, in the state `created`,
   - its `base` is the ref the branch merges into,
   - its `start` is the ref the worktree started from, which a forced claim that adopts a branch on origin sets to that branch,
5. opens its event log `processes/<id>.events.jsonl`,
6. starts its [implement session](#implement-session), and answers with the record in the state `running`.

The claim reads the [quota](#quota) of Claude beside these steps, and its session starts without waiting for it. Its answer waits at most two seconds for the reading. It carries `quota`: a line when Claude is below the minimum, which the CLI prints as a warning. A work process spends Claude alone, so a Codex below the minimum warns no claim. The claim goes on either way.

In fake mode the claim fetches nothing and branches from what the checkout has of origin.

An abandon stops the process's session and waits for its runtime to exit, then removes the worktree, the record and the event log. It leaves the branch and the issue, assignment included. It refuses a worktree whose branch has commits on no branch of origin, or changes not committed, unless forced. It checks before the stop and again after it, so work the session wrote until it stopped is refused too; a refusal after the stop ends the process `failed`.

## Implement session
A claimed process runs Claude Code headless through the Agent SDK in its worktree. The session is started with:
- the machine's `claude` from `PATH` as the executable,
- the bundled worker and repo-standards plugins (`dist/plugins`) loaded, and the marketplace's copies of the workflow's plugins switched off,
- the user's, the repository's and the local settings, the `auto` permission mode and the `worker` agent,
- session settings over them: `WF_MODE`, `WF_ISSUE`, `WF_BASE_BRANCH`, the claim's overrides, foreground subagents and the compact pin (80% of 312 500 tokens),
- `AMEISE_STAGE` in its environment, the stage it runs, which the scripted claude of fake mode plays by.

The brief names the issue, the branch, its base and the `gh` and `git` reads the session does itself. It carries no text of the issue. It asks the session to implement and commit only: the worker's gate, review, pr and ci skills are not invoked, since the controller runs those stages.

- The stream goes into the event log, each message as a `stream` event, and the session id into the record as `session_id`.
- The record's `context` is the size of the session's context in tokens: input, cached input and output of its latest message, leaving out subagents.
- The session reports through a structured result: `complete` with its commits, or `blocked` with the question, each with a message.
  - `complete` starts the [gate stage](#gate-stage) once its runtime has exited, unless the process is held.
  - `blocked` ends the process `blocked` with the question as the note.
- A hold (`POST /api/processes/hold`) keeps the session open at its next `complete`: the hold is spent and the process turns `input`, which a restart keeps.
  - The next message resumes the session, whose next `complete` starts the gate.
- Every session's end is an attempt in the record's `history`: `{stage, kind: "session", result, session_id, commits, note, at}`.
- A record or event that cannot be written, as on a full disk, ends the process `failed` where it still can and is told on the controller's stderr.
- A session that ends without that report, and a runtime that cannot start, end the process `failed` with the reason as the note.

A session that ends `blocked` or `failed`, a gate, review or pr stage that ends `failed`, and a ci stage that ends `ready`, `blocked` or `failed` mark the record `unseen` and send one [notification](#notifications).

In fake mode the scripted `fake/claude` is the executable. `AMEISE_FAKE_CLAUDE` names a directory of plays (see the script):
- `play` says what the implement session does, `resume` what a resumed session does.
- `gate`, `review` and `ci` say what a fix session of the gate, of the review and of the ci stage does.
- `address-reviews` says what the address-reviews session does: `reply <thread> <body>` and `answer <text>` are what it reports for the controller to post, `fixed` and `declined` the points.
- `reviewer-<name>` says what that reviewer reports, `reviewer` what every other one reports. Without either a reviewer passes.
- `author` says what the author session of the pull request reports. Without it, it reports the title `Fake pull request`.

In fake mode the scripted `fake/gh` answers GitHub from `AMEISE_FAKE_GH` (see the script):
- `next-pull` is the number `gh pr create` gives.
- The files in `pulls/<n>.readings/` are what the gate on CI and the ci stage read of that pull request, in their order, the last one for good.
- A draft `gh pr create --draft` opens is written to `draft-<n>.json`, which `gh pr list` answers after `pulls.json` and `gh pr ready` marks not a draft.
- `runs/<id>.log` is a run's failed log, and `login` the login of `gh api user`.
- `pulls/<n>.threads.json` are the review threads of a pull request. The resolve mutation resolves a thread written with its id first, and `gh pr comment` appends to `pulls/<n>.comments`.
- Once `gh pr merge` merged a canned pull request, `pulls/<n>.merged.json` answers before its readings.

## Gate stage
The controller runs the gate itself, in the stage `gate` ([ADR 0058](../docs/adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)):
1. It fetches the base, outside fake mode, and merges it into the branch.
2. It runs the gate command in the worktree, in a process group of its own, within `WF_GATE_TIMEOUT` seconds (2700).
3. A pass starts the [review stage](#review-stage).

`WF_GATE` names the gate form, in one of four forms:
- unset: the gate command `make check`.
- a command, such as `make check` or `npm test`: an argument list split on whitespace and run without a shell.
  - A command with shell syntax, such as a pipe or a quote, is refused.
- `none`: no gate runs. The process goes from implement, and from every fix session of the review, straight to the review, with no merge of the base.
- `ci` or `ci:<jobs>`, such as `ci:check,browser`: the [gate on CI](#gate-on-ci), which reads every check of the gate's draft, or the named ones.

Anything else is refused with the forms: at the claim before anything is created, and at the gate, which ends the process `failed`.

A merge that conflicts is aborted, and a gate command that fails or runs past its timeout counts as a failure. Either starts a fix session of the gate:
- a fresh headless session, not a resume, without the worker's agent, with the conflicted files or the exit and the last 20 lines of the output in its brief,
- with the stage timeout `WF_STAGE_TIMEOUT` seconds (1800), past which it ends the process `failed`,
- reporting `complete` or `blocked` as the implement session does. On `complete` the gate runs again from its merge.
  - On `blocked` the process is `blocked` in `gate`, and the answer resumes the fix session.

`WF_GATE_ROUNDS` (3) is the gate's budget: the fix sessions it may start since the last session of another stage, a resumed one counted once. A failure with the budget spent ends the process `failed`, with the failure and the end of the output as the note.

Each merge that conflicts and each run is an attempt in `history`: `{stage: "gate", kind: "merge", result: "conflict", files, commit, at}` or `{stage: "gate", kind: "run", result: "pass"|"fail", gate, commit, dirty, exit, tail, at}`, whose `gate` is the command that ran.
The form `none` leaves `{stage: "gate", kind: "run", result: "skipped", gate: "none", commit, at}`. The process page names the form of each run.

The event log carries `gate-start`, a `gate` event per attempt and `gate-end`, whose state is `pass`, `skipped` or `failed`.

The knobs are read from the claim's overrides, then the env block of the checkout's `.claude/settings.json`, then the defaults. A value that is no whole number, and a `WF_GATE` that is no gate form, end the process `failed` with the reason.
- A message to a process whose gate command runs is refused with `409`.
- A stop while the gate command runs ends it and marks the process `interrupted`, and a resume runs the gate again.
- A stop while a fix session runs marks it `interrupted` the same way, and a resume goes on with that session.

### Gate on CI
A gate on CI reads the checks of a pull request instead of running a command in the worktree, as the factory's does:
1. It pushes the branch, never forced. Fake mode pushes nothing.
2. It reads the branch's open pull requests (the contract fixture's takeover rule).
   - The one the record names, of the branch and opened by the login `gh` is logged in as, is taken over.
   - Any other ends the process `failed` with a note naming it. Nothing is written on the issue: close that pull request or delete the branch, and claim again.
   - With none open it opens the gate's draft against the base: the first line of the issue's title, and the body `Closes #<issue>` alone.
3. The record gets `pull` and `draft: true`. The draft flag is the controller's record, never GitHub's draft state.
   - A person who marks the draft ready changes no stage and spends no budget.
4. It reads the checks of the pushed head every 30 seconds, with the state `waiting` and what it waits for in `wait`, as the ci stage does.
   - A check still running is waited for.
   - `ci` reads every check. Its pass stands only on two readings a poll apart that show the same checks, because GitHub registers a head's checks one workflow at a time.
   - `ci:<jobs>` reads the named checks and passes once they pass.
5. A pass starts the review. The run names each check read, and the reviewers get them as the gate result.

A failed check is a failed gate. Its fix session gets the failed checks and the end of their failed logs (`gh run view <id> --log-failed`). Its `complete` runs the gate again, which pushes and reads the new head. `WF_GATE_ROUNDS` is the budget, and past it the process ends `failed` naming the failing checks.

A named check that has not appeared `WF_CHECKS_GRACE` seconds (600) after the push, or a head with no check at all by then, ends the process `failed` naming what is missing. A draft that conflicts with the base gets the base merged in and pushed, and its new head is read. A merge that conflicts in files starts a fix session within the same budget. `WF_GATE_TIMEOUT` bounds one run of the gate on CI, past which the process ends `failed`.

A run is `{stage: "gate", kind: "run", result: "pass"|"fail"|"missing", gate, commit, pr, url, checks, tail, at}`. The event log carries `gate-wait` per change of the wait and `gate-note` for the draft. The process page shows the draft, the checks read and the wait in the gate stage. The board reads the stage from the record, so it says `gate` while the draft exists.

A stop while the gate waits marks the process `interrupted`. A resume takes the draft over and reads the head again, and a resume after the pass goes on with the review. The pr stage finishes the gate's draft rather than open a second pull request.

The draft's workflows run with the repository's Actions secrets on commits no reviewer has read yet, as a pull request's do. Gate a repository on CI only where its workflows may run those secrets on unread code.

## Review stage
After the gate passes the controller runs the repository's reviewers, in the stage `review`. A round runs its reviewers in parallel:
- each a fresh headless session with the stage timeout, as the worker's reviewer agent of its name (`worker:code-reviewer` for `code`),
- read-only: without `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `Agent`, and in the permission mode `default` rather than `auto`, so each call the runtime does not know as read-only is a card,
- briefed with the diff range, the issue and the gate's last run with the end of its output,
- reporting through a schema: a verdict `pass` or `fix` and findings, each a severity `S1`, `S2` or `S3`, a place, a claim and a fix.
  - A finding of `S1` or `S2` makes the verdict `fix`.

Their streams stay out of the event log and their ids out of the record's `session_id`. A permission a reviewer asks for is a card as any other, but any answer that allows it allows that one call. A reviewer's grant is kept for no later call, and the process's allowances do not reach a reviewer.

`WF_REVIEWERS` names the reviewers, comma-separated among `code`, `security`, `docs`, `tests` and `senior`; unset, it is all five. Round 1 runs every one, a later round those whose last verdict is `fix`.

- Every reviewer at `pass` ends the review with the panel `pass`, and the [pr stage](#pr-stage) follows.
- A `fix` verdict starts one fix session of the review, a fresh session with the stage timeout. Its brief carries every finding of the round by its id, `<reviewer>-<round>-<n>`.
  - It reports as the implement session does, and names in `fixes` what it did with each finding: `fixed` or `declined`, with a note.
  - On `complete` the [gate](#gate-stage) runs again, and its pass starts the next round. On `blocked` the answer resumes it.
- `WF_REVIEW_ROUNDS` (3) is the review's budget: the rounds since the implement session last ended. A round at that number with a `fix` verdict ends the review with the panel `failed`.
  - The process is not stopped: the pr stage follows, and the pull request names the failed panel.
- A reviewer that reports no verdict, and a knob that is wrong, end the process `failed` with the reason.

Each round is an attempt in `history`: `{stage: "review", kind: "round", result: "pass"|"fix"|"failed", round, commit, verdicts, at}`.
- Each verdict is `{reviewer, verdict, session_id, findings, note}`, and each finding is `{id, severity, where, claim, fix}`.
- A fix session is `{stage: "review", kind: "session", ..., fixes}`, each fix `{finding, outcome, note}`.
- The record's `panel` is `pass` or `failed` once the review has ended.
- The event log carries `review-start` per round, a `review` event per round and `review-end`.

A message while the reviewers run is refused with `409`. A stop while they run marks the process `interrupted`, and a resume runs the round again. A stop while its fix session runs is resumed as the gate's is.

## Pr stage
After the review the controller opens the pull request, in the stage `pr`:
1. It pushes the branch to origin, never forced. Fake mode pushes nothing.
2. A read-only author session writes the title and the body from the diff, the commits and the issue.
   - It runs beside the process's session as a reviewer does, without the worker's agent, and reports `{title, body}` through a schema.
3. The controller adds `Closes #<issue>` where the body does not close the issue, and appends a `## Verification` section.
   - The section names the last gate run and each reviewer's last verdict.
   - A failed panel names the reviewers that did not pass and the findings of its last round.
4. It runs `gh pr create` against the base, never as a draft.
5. It asks each bot of `WF_PR_BOT_REVIEWERS` for a review with `gh pr edit --add-reviewer`. A refusal is a `pr-note` event and stops nothing.

An open pull request of the branch into the base, as after a follow-up message, takes the push and is asked of the bots, and no other is opened. One into another base is left alone. The record's `pull` is `{number, url}`.

The gate's draft of a [gate on CI](#gate-on-ci) is finished instead of a new one opened, while `gh pr view` reads it open.
- It gets the author's title and the body with its verification section through `gh pr edit`.
- `gh pr ready` lifts its draft state, and the bots are asked for a review after that, as they skip drafts.
- The record drops `draft` and notes the time in `readied`.
- A draft closed or merged meanwhile is left, and the stage opens a pull request as above.

The opening is an attempt in `history`: `{stage: "pr", kind: "open", result: "opened"|"found"|"finished", pr, url, commit, at}`. The event log carries `pr-start` and `pr-end`. A push, an author session, or a `gh pr create` or `gh pr edit` that fails ends the process `failed` with the reason. A resume runs the stage again.

## Ci stage
The controller waits on the pull request itself, in the stage `ci`, with the state `waiting`. No session polls. It reads the pull request every 30 seconds, one wait at a time:
1. GitHub's answer whether the branch merges into its base. A conflict comes first, because GitHub runs no check on such a branch.
2. The checks. An empty rollup in a repository with workflows waits up to 600 seconds for GitHub to register them.
3. A review of a bot of `WF_PR_BOT_REVIEWERS` (`chatgpt-codex-connector`; empty for none), within `WF_PR_REVIEW_WAIT` seconds (1200) of the checks' end.
4. Any standing request for changes, and any review thread not resolved. The threads are read only once the waits before have passed.
5. GitHub's merge state, which must be `CLEAN`, as the merge requires.

The record's `wait` says what it waits for, and `checks` holds the checks it read last, each `{name, url, state}`.

A gate's draft the pr stage marked ready carries the draft's checks.

- In a repository whose workflows name the `ready_for_review` event, marking it ready starts checks of their own.
  - There the stage waits after the checks until one has finished since `readied`, or until `WF_CHECKS_GRACE` seconds (600) have passed.
  - The workflows are read as text: one that only mentions the event costs the wait of the grace.
- In every repository the bot review's wait counts from the ready at the earliest.

- Green ends a `manual` process `ready`, and the board offers the merge.
  - A `yolo` process whose panel passed is merged at once, by the rules of the [merge](#merge), which remove its worktree, branch and record.
  - The notification tells of it as merged. A merge refused, or taken by a merge queue, leaves it `ready` with the reason.
  - A `yolo` process whose panel failed waits for the merge as a `manual` one does.
- A conflict or failed checks start a fix session of the ci stage, a fresh session with the stage timeout.
  - Its brief names the conflict or the failed checks. It commits and pushes nothing.
  - On `complete` the controller pushes and waits again. On `blocked` the answer resumes it.
- A writer's request for changes, or an unresolved thread a writer or a bot opened, that no round has answered starts the [address-reviews stage](#address-reviews-stage).
- `WF_CI_REPAIR_ROUNDS` (3) is the repair budget of the pull request. It counts the fix sessions and the address-reviews sessions of a bot's review.
  - The count starts when the pull request was opened or found, and again at each address-reviews session of a writer's request.
  - A failure with it spent ends the process `failed`.
  - A bot's review with it spent also ends it `failed`, and the controller comments on the pull request that the points are left to a person.
  - The comment mentions the writers whose points stand, never a bot.
  - The record's `repairs` holds `{spent, of}` as the stage read it last.
- These are never green: a request for changes that is answered and stands, a request or thread of somebody no writer, a merge state such as `BEHIND` or `BLOCKED`.
  - The process turns `blocked` with who asked or the state.
  - A message resumes its session as a fix session of the ci stage, whose `complete` pushes and waits again.
- A pull request merged meanwhile turns the process `blocked`, for the maintainer to abandon it. A closed one ends it `failed`.

Each verdict that ends a wait is an attempt in `history`: `{stage: "ci", kind: "wait", result, pr, url, commit, checks, reviews, at}`. The result is `green`, `conflicts`, `checks-failed`, `review-comments`, `answered` (only answered requests stand), `unmergeable`, `merged` or `closed`. The event log carries `ci-start`, a `ci-wait` event each time the wait changes, a `ci` event for each verdict that starts a fix session, a `ci-note` when the base cannot be fetched for a conflict, and `ci-end`.

A message while the stage waits is refused with `409`. A stop while it waits marks the process `interrupted`, and a resume waits again. A stop while its fix session runs is resumed as the gate's is.

## Address-reviews stage
The stage `address-reviews` answers what reviewers ask for on the pull request, as the factory's does ([ADR 0058](../docs/adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)).
- A writer is an author who may push to the repository, as `repos/<owner>/<name>/collaborators/<login>/permission` answers.
  - Only an author GitHub associates as `OWNER`, `MEMBER` or `COLLABORATOR` is asked, once per review or comment.
  - Nobody else's review reaches a session, since it becomes the brief of a session that pushes.
- Its points are the latest request for changes of each writer and every unresolved thread whose first comment is a writer's or a bot's, which no answer in `history` covers.
- Its mandate is a writer's request when a request no session was asked yet is among them, and a bot's review otherwise.
  - A writer's request starts the repair count afresh, once: its session counts no round.
  - A request asked again, as when its answer could not be posted, is a repair round. The wait's `asked` holds the keys it gave the session.
  - A bot's review is a repair round, refused once the budget is spent.

It runs one fresh session with the stage timeout. Its brief lists the requests and the threads by id, as reviewer text. It fixes or declines each point, commits, and pushes, replies and resolves nothing.
- It reports `complete` or `blocked` with its commits, a reply per thread in `replies`, one `answer` to the requests, and the points `fixed` and `declined`.
- On `complete` the record's `addressing.reported` keeps the replies and the answer until they are posted, so a resume after a stop posts them.
- The ci stage pushes, then posts:
  - a reply to each thread the brief listed, the first one to each, and resolves that thread,
  - the answer as one comment on the pull request, when the brief listed a request.
- A reply to a thread the brief did not list is posted nowhere.
- What cannot be posted is a `ci-note`, and a thread whose reply failed is asked again by the next round.
- Then the ci stage waits again. A request stands until its writer reviews again, so the stage then ends `blocked` with the result `answered`.
- On `blocked` the answer resumes the session.

The session's end is `{stage: "address-reviews", kind: "session", result, mandate, commits, fixed, declined, at}` in `history`. What was posted is `{stage: "address-reviews", kind: "answer", result: "posted"|"partial", answered, replied, pr, url, at}`: the keys of the requests it commented on and the ids of the threads it replied to.

### Follow-up
The controller reads the pull request of each process the ci stage left `ready`, or `blocked` on a review, every four polls (two minutes, less in fake mode).
- It starts the ci stage again when a review asks for an answer no round gave, such as a new request for changes of a writer on a ready process.
- It starts it again for a ready one when any review stands, even one no session may answer.
- It starts it again for a blocked one when the reviews say something other than what it was blocked on, such as an approval of the writer it answered.
- A pull request that cannot be read is read again next time, and told once on stderr.

## Conversation
The session takes its input as a stream, so the maintainer talks to it from the process page while it runs.
- A permission the `auto` classifier does not settle reaches the controller through the SDK's permission callback.
  - It becomes a `permission` event with the tool, the call and the reason.
  - The process turns `approval`, with the request and the call as its note.
  - The session waits until it is answered: `once` allows the call, `deny` refuses it, and `process` allows it and every call like it for the rest of the process.
  - `process` keeps the rules the runtime suggests for the call in the record's `allowed`, or the call itself when it suggests none.
  - A later call they cover runs without a card, as an `allowed` event.
  - Those rules reach the session for its own lifetime and never a settings file.
- A question the session asks with `AskUserQuestion` becomes a `question` event, and the process turns `input` with the question as its note. The next message answers it.
  - A call that asks several questions takes the one message as the answer to each.
- Each answer is an `answer` event. Once no request waits, the process is `running` again.
- A message to a running session with no question waiting is its next turn, as a `message` event.
- A message to a process whose session has ended resumes that session by its id, with the message as its turn.
- A request its session leaves unanswered as it ends is `closed`.

## Open in terminal
The process page opens the process's session in a terminal window. The controller writes `processes/<id>.command`: a shell script that changes into the worktree and runs `claude --resume <session id>` with the plugins and agent of its kind, `worker` or `planner`, and the session's settings. It runs `<terminal> <script>`; the default is `open -a Terminal` on macOS and `x-terminal-emulator -e` on Linux. A command that still runs after two seconds counts as open and is left running with its window.

While the headless session still runs, the terminal is a second runtime on the same session. Its turns stay out of the process's event log.

## Restart
Stopping and starting the controller loses no process.
- A stop (`SIGINT` or `SIGTERM`) stops every running session, waits for its runtime to exit and marks its process `interrupted`.
- The start reads every record before it answers a request.
- A work or hunt process still `running`, `waiting`, `created`, `approval` or `input` lost its session or its wait with the last run, as after a kill.
  - It is marked `interrupted` too.
  - Its note says so, or that its worktree is gone, in which case only an abandon helps.
- A plan process `running` or `approval` lost its session the same way.
  - It turns `input` when its session had started, so a message resumes it, and `failed` when it had not.
- Every other process shows as it was. An interrupted one keeps its `session_id`.
- A resume goes on with an interrupted process: its implement or hunt session, gate, review round, pr stage, wait on the pull request or address-reviews session.
  - One interrupted before its address-reviews session started waits on the pull request again.
  - It uses the runtime's resume by that session id, and a short brief to go on.
  - A process without a session id starts a fresh session with the usual brief.
  - It refuses with `409` a process that is not interrupted and one whose worktree is gone.
- An adopt takes a `foreign` work worktree into a process: a record in `manual` mode on the base of the project.
  - The record is `interrupted` without a session, and a resume starts its session.
  - It refuses an issue that has a process already and one without a work worktree.
  - A foreign worktree is removed by an abandon, as any other.

In fake mode the scripted claude plays a resumed session under the id it resumes.

## Merge
A merge takes a ready pull request of a project into its base. It refuses, with the reason and `409`, a pull request that is:
- not open, a draft, or in conflict, or whose conflicts GitHub has not computed yet,
- not green: a check failed or pending, or a merge state other than `CLEAN`,
- asked for changes.

It refuses a local branch with commits on no branch of origin, and a worktree with changes not committed, since the merge removes both. Then it:
1. squash-merges the pull request and deletes its branch on origin,
2. removes the worktree, the local branch, the record and the event log of its process,
3. closes the issue of the head branch, with a comment that names the pull request, when the base is not the default branch. GitHub closes a linked issue only there.

A promotion from `dev` or `main` gets a merge commit and keeps its branch. A pull request from a fork keeps every local branch and closes no issue.

## Release
A release takes a milestone named as `v1.2.3`. It refuses, with `409`, a milestone that is missing, closed or has open issues, and a tag of that name that exists. The default branch decides the model:
- `main`: the release tags the head of `main`.
- `dev`: it opens the promotion `chore(release): <milestone>` from `dev` to `main`, or finds it, and merges it as a merge does. It tags the merge commit.
  - A promotion that is not green answers `waiting` with the reason; the next release goes on from it.
  - Another open promotion is refused.

Then it publishes the release with generated notes and closes the milestone.

## Acceptance start
An acceptance start opens a plan process on a spec ready for acceptance. It creates the branch `plan/<slug of the title>` from `origin/<base>` and its worktree. Its record has the route `accept` and the state `created`. It refuses, with `409`:
- an issue that is not an open spec,
- a spec without tickets or with a ticket open,
- a spec that has a process.

The spec then leaves `acceptance`. No session starts yet.

## Plan process
A plan opens a plan process from an idea, an issue or nothing, an open session. It creates the branch `plan/<slug>` from `origin/<base>` and its worktree:
- the slug of the idea,
- the slug of the issue's title,
- or `open-<local time to the second>` for an open session.

The branch's description holds `topic: <idea>`, `issue: #<n>` or `open: <time>`, as the planner's scripts read it. It refuses, with `409`, an issue that is not open, an issue with a process, and a plan branch that exists; with `400`, an idea and an issue at once, and an idea without letters or digits.

`WF_PLANNER_LANGUAGE` names the language the planner talks in, such as `german`. The [planner's readme](../plugins/planner/README.md#configuration) documents it.
- The controller reads it from the env block of the checkout's `.claude/settings.json`, and the plan records the value when it opens.
- What the planner writes into issues stays English, and work sessions do not read it.
- A value that is not text, is longer than 32 characters or holds a control or format character is refused with `400`.
  - The refusal names the reason and comes before the plan branch is created.

The record has the route `idea`, `issue` or `open`, the topic, and the stage `plan`. Its planner session starts at once, as the implement session does, with:
- the bundled planner and repo-standards plugins and the `planner` agent,
- session settings: `WF_PLAN`, `WF_PLAN_ISSUE` for an issue, `WF_BASE_BRANCH` and foreground subagents,
  - and `WF_PLAN_CONTROLLER=1`, which silences the planner's start hook,
  - and the runtime's `language` setting from `WF_PLANNER_LANGUAGE`, when the repository sets it,
- a brief that runs `/planner:plan` and carries the start context the hook gives in a pane.
  - That is the plan, the branch, the role, the glossary, and the topic, the open session or the issue with the `gh` read of it.
  - It carries no text of the issue.

A planner reports no structured result. When it ends a turn, the process turns `input` with the last line it said as the note, and the board's action is `Continue`. The next message resumes the session by its id, and a slash command such as `/planner:grill` reaches it as written.

A capture moves the prototype the session left in the worktree to the branch `prototype/<plan slug>-<name>`: every change, untracked files included, as one commit on the plan branch's start. It pushes the branch and cleans the worktree, so the plan branch carries no commit.
- It refuses, with `409`, a clean worktree, a session at work (`created`, `running` or `approval`) and a prototype branch that exists.
- A push that fails keeps the commit on the local branch and the worktree as it was.
- In fake mode it pushes nothing.

A finish stops the session, then removes the worktree, the plan branch and the process. It refuses, unless forced, changes not captured and commits on the plan branch. It checks before the stop and again after it; a refusal after the stop leaves the process `input`. `/planner:finish` in the chat checks the same and leaves the removal to the finish.

## Hunt process
A hunt opens a hunt process: a test hunt that works no issue ([ADR 0045](../docs/adr/0045-a-test-hunt-runs-on-a-branch-without-an-issue.md)). It creates the branch `hunt/tests-<local date>` from `origin/<base>` and its worktree, in `manual` mode. It refuses, with `409`:
- a hunt process, a `hunt/` worktree or a local `hunt/` branch,
- a `hunt/` branch on origin; a list of origin's branches that cannot be read is a warning instead,
- a base without a test file by the hunt's rule:
  - `test_*.py`, `*_test.py`, `*_test.go`, `*.test.*` and `*.spec.*` of JavaScript and TypeScript,
  - code files in a `tests` or `spec` directory, leaving out fixtures, testdata, `__snapshots__`, `node_modules` and `vendor`.

Its hunt session starts at once, in the stage `hunt`, as the implement session does, without `WF_ISSUE`. Its brief starts with `/worker:hunt-tests`, so the worker runs its rounds with the `test-hunter` agents and removes and commits only.
- The record's `hunt` is the hunt record as the worker's `hunt.sh json` prints it: `rounds`, `max_rounds`, `ended`, `removed`, `kept` and `stale`.
  - The controller reads it again after each tool result of the session and once the session reports `complete`.
- A hunt that removed a test goes on to the [gate](#gate-stage), the [review](#review-stage), the [pr](#pr-stage) and the [ci](#ci-stage) stages of a work process.
  - Each brief names the hunt record, which its session reads with `hunt.sh print`, in place of the issue.
  - The review checks each removal against its reason.
  - The pull request, and the gate's draft on CI, close no issue.
  - A merge removes it as it removes a work process.
- A hunt that removed nothing opens no pull request. It turns `done`, and its note says so with its rounds and the candidates it kept.
  - A finish stops its session, then removes the worktree, the hunt branch and the process. It refuses, unless forced, changes not committed and commits not on origin.

## Quota
The controller reads the quota of Claude, then Codex. It runs `<quota_axi> --provider <runtime> --json` for both at once on each request and reads the `all_models` scope of quota-axi's report in schema version 5. It answers the percentage left and the latest reset of the windows that limit it. A runtime under `quota_minimum` is marked `below`. Only Claude below the minimum warns a [claim](#claim-and-abandon), since every stage session of a work process runs on Claude.

A reading is unknown, with the reason, when quota-axi is not installed or fails. So is one that answers no such provider, takes longer than 30 seconds or prints a report it cannot read. An unknown reading warns of nothing and holds no claim. With `quota_axi` empty the check is off: the quota answers `off: true` and no runtime.

Install quota-axi the way the [factory runbook](../docs/factory-runbook.md) does:

```sh
npm install -g quota-axi@0.1.49
command -v quota-axi   # the path for quota_axi
```

- Configure the absolute path `command -v` printed.
- `npx quota-axi` does not work: the value is one program, and the configuration refuses a value with whitespace or one that is not absolute.

## Notifications
A process that turns `blocked`, `ready` or `failed` gets one native notification: the project, the issue (the branch of a plan without one) and the state as the title, the note as the body. The event log `events.jsonl` records a `turned` event for it.
- The notifier is the command `notifier` names, called as `<notifier> <title> <body>`.
- Without one it is `osascript` on macOS and `notify-send` on Linux. Other platforms get none.
- With `notifications` false nothing is sent, and the process is marked all the same.
- A notifier that fails is told on the controller's stderr and changes nothing of the process.

The record keeps `unseen` until the process's page is opened, so the dashboard shows a badge until then.

## API
- `GET /`: the [dashboard](../dashboard/README.md), which `npm --prefix dashboard run build` writes into `dist/dashboard`.
- Without that build `/` answers `404` with the command, and the API works.
- `GET /api/projects`: the projects, each `{path, owner, name, base}`, or `{path, error}` when its checkout no longer derives.
- `POST /api/projects` with `{"path": "<absolute path>"}`: adds a project and answers `201`. `400` with `{error}` refuses it, `409` says it is a project already.
- `DELETE /api/projects` with `{"path": "<absolute path>"}`: removes a project and answers `200`. `400` with `{error}` refuses a path that is not absolute, `404` says it is no project.
- `GET /api/board`: the [board](#board) of every project, `{projects: [...]}`, each a project's board or `{path, error}`.
- `GET /api/board?project=<path>`: the board of the project at that checkout; `404` says it is no project.
- `POST /api/processes` with `{"project": "<path>", "issue": <n>, "mode": "manual"|"yolo", "env": ["NAME=VALUE", ...], "force": false}`: claims the issue, starts its session and answers `201` with `{record, warnings, quota}`.
  - `400` refuses a malformed request, `404` a path that is no project, `409` an issue a claim refuses, `502` a GitHub that does not answer.
- `POST /api/processes/seen` with `{"id": "<id>"}`: marks the process seen, which clears its badge, and answers `200` with `{id}`. `400` refuses a malformed id, `404` an id that is no process.
- `GET /api/processes/events?id=<id>`: the process page's stream of server-sent events.
  - It sends `record` with the record and `compact_at`, the context size at which the session compacts.
  - Then it sends `entries` with the conversation so far, then each change as it is written. `gone` ends it once the process is removed.
  - An entry is `{seq, kind, ...}`, `seq` being the line of the event log it comes from.
  - The kinds are `text` and `tool` of the session and `you` for a message. `permission`, `question`, `answer`, `allowed` and `closed` are the requests, and `start` and `end` each session.
  - Tool results, thinking and the messages of subagents stay in the log and out of the conversation.
- `POST /api/processes/message` with `{"id": "<id>", "text": "..."}`: writes to the process's session and answers `200` with `{id, delivered}`, which is `answered`, `sent` or `resumed` (see [Conversation](#conversation)).
  - `400` refuses an empty text, `409` a process without a session.
- `POST /api/processes/hold` with `{"id": "<id>", "hold": true|false}`: sets whether the implement session's next `complete` keeps it open, and answers `200` with `{id, hold}`.
  - `409` refuses a process that is no work process, and a hold of one past implement.
- `POST /api/processes/answer` with `{"id": "<id>", "request": "<request>", "answer": "once"|"process"|"deny"}`: answers a permission request and answers `200`. `409` says no such request waits.
- `POST /api/processes/terminal` with `{"id": "<id>"}`: opens the session in a terminal and answers `200` with `{id, script}`.
  - `409` refuses a process without a session, `502` a terminal that fails.
  - `501` refuses on a platform without a known terminal while no `terminal` is configured.
- Each of these refuses a malformed id with `400` and an id that is no process with `404`.
- `GET /api/quota`: the [quota](#quota), `{minimum, runtimes: [...]}` with `claude` then `codex`.
  - Each runtime is `{runtime, known: true, remaining, reset, below}`, or `{runtime, known: false, reason, below: false}`.
  - With the check off it is `{minimum, off: true, runtimes: []}`. With a command configured it has no `off`.
- `DELETE /api/processes` with `{"project": "<path>", "issue": <n>, "force": false}`: abandons the issue's process and answers `200` with `{issue, branch, worktree}`.
  - `404` says the issue has no process, `409` refuses work not on origin.
- `POST /api/processes/resume` with `{"project": "<path>", "issue": <n>}`: resumes the issue's interrupted process and answers `200` with `{record}`.
  - `{"id": "<id>"}` resumes an interrupted hunt process, which has no issue.
  - `404` says the issue has no process.
  - `409` refuses one that is not interrupted, or whose worktree is gone or no longer on its branch.
- `POST /api/processes/adopt` with `{"project": "<path>", "issue": <n>, "branch": "<branch>"}`: adopts the issue's foreign worktree on the branch and answers `201` with `{record}`.
  - The branch may be left out when the issue has one worktree.
  - `404` says the issue has no such worktree.
  - `409` refuses an issue that has a process, and one with more than one worktree when no branch is named.
- `POST /api/merges` with `{"project": "<path>", "pr": <n>}`: merges the pull request and answers `200` with `{pr, title, method, base, branch, kept, worktree, closed, queued, warnings}`.
  - It refuses a pull request with an unresolved review thread.
  - A pull request a merge queue takes answers `queued: true` and keeps its branch, worktree and process until GitHub merges it.
  - `409` refuses a pull request that is not ready or work not on origin, `502` a GitHub that does not answer.
- `POST /api/releases` with `{"project": "<path>", "milestone": "v1.2.3"}`: releases the milestone and answers `201` with `{status: "released", milestone, model, target, release, promotion}`.
  - `202` with `{status: "waiting", milestone, model, promotion, reason}` says the promotion is not green yet. `409` refuses the milestone.
- `POST /api/acceptances` with `{"project": "<path>", "spec": <n>}`: opens the plan process and answers `201` with `{record}`; `409` refuses the spec.
- `POST /api/plans` with `{"project": "<path>", "idea": "..."}`, `{"project": "<path>", "issue": <n>}` or `{"project": "<path>"}`: opens a [plan process](#plan-process), starts its session and answers `201` with `{record}`.
- `POST /api/hunts` with `{"project": "<path>"}`: opens a [hunt process](#hunt-process), starts its session and answers `201` with `{record, warnings}`; `409` refuses the hunt.
- `POST /api/processes/capture` with `{"id": "<id>", "name": "..."}`: captures the plan's prototype and answers `201` with `{id, branch, url}`.
- `POST /api/processes/finish` with `{"id": "<id>", "force": false}`: finishes the plan or the hunt and answers `200` with `{id, branch, worktree}`.
- A body larger than 64 KiB is refused with `413`.

The server answers only a `Host` that names it, and takes a write only as `application/json`, so a page of another site cannot write through the browser. It answers any other `Host` with `403` and a write of another type with `415`. Every refusal carries `{error}` with the reason.

## State
One directory per machine: `$XDG_DATA_HOME/ameise`, else `~/.local/share/ameise`. It holds the event log `events.jsonl`, a record per process in `processes/<id>.json` with its event log `processes/<id>.events.jsonl` and the script that opens its session in a terminal, `processes/<id>.command`, and while the server runs, `listen`: the address it started on, which the CLI reads first.

## Development
- `make controller` runs eslint, the type check and the tests. `make dashboard` builds the dashboard into this build and reads it in a browser.
- The tests build the binary and start it in fake mode on a temporary machine: its own configuration, state, `PATH`, canned GitHub (see `fake/gh`) and canned runtime (see `fake/claude`).
- They watch it over the API, its files and its output.
- A release bumps `version` in `package.json`, commits, and runs `scripts/release.sh controller --push` on `main`.
  - It refuses what the factory's release refuses: another branch, a dirty tree, a red gate and a tag that exists.
  - It tags `controller/v<version>`. From that tag CI's `controller-release` packs, installs and starts the package.
  - Then it attaches the tarball, its checksums and its build attestation to the release `ameise controller v<version>`, which is not the latest.
  - A release that already carries them is refused, so a released version is never overwritten.
