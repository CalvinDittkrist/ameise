---
name: accept
description: Points to the acceptance of a finished spec, which the controller runs from its board with a read-only checker.
disable-model-invocation: true
argument-hint: [spec]
---
The controller `ameise` runs the acceptance of a spec, not this session. Tell the user, in one short reply:

- The board lists a spec whose tickets are all closed as ready for acceptance.
- Accept there, or `ameise accept <spec>`, opens a plan process of its own on it.
- The controller gathers the facts, runs a read-only spec checker and shows every item with its verdict, evidence and confidence in the process view.
- Per item not met the maintainer picks a gap ticket, an accepted deviation or no finding there.
- The controller writes them and closes the spec once nothing is open.

When the spec ($ARGUMENTS, or the issue of this session) is not ready yet, say which of its tickets are still open: `gh api 'repos/{owner}/{repo}/issues/<spec>/sub_issues?per_page=100' --jq '.[] | select(.state == "open") | "#\(.number) \(.title)"'`.

Write nothing to GitHub and change no file.
