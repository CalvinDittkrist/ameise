---
name: prototype
description: Build throwaway code that answers one design question, then have the controller move it to its own branch and link it from the issue.
disable-model-invocation: true
argument-hint: <question>
---
A prototype is throwaway code that answers one question: $ARGUMENTS

Pick the shape from the question:
- "Does this logic or state model hold?" One runnable file: a script, or a single HTML page a non-developer can click through.
  - It drives the model through the cases that are hard to reason about on paper and prints the full state after every step.
- "What should this look like?" Several clearly different variants of one screen, switchable in place, in the project's own routing convention.

Rules: name it so a reader sees it is a prototype; one command to run; state in memory only; no tests, no error handling beyond what makes it run, no abstractions. Leave it uncommitted in this worktree. Tell the user how to run it and what to look at.

When the question is answered:
1. State the verdict in one paragraph and propose a name of a few words for the prototype.
2. Ask the user to capture it with Capture prototype in the process view of the controller, under that name, and end your turn.
   - The controller commits the worktree's changes to `prototype/<plan>-<name>` and pushes it. The worktree is clean afterwards.
   - Without the controller's github tools in this session, the controller did not start it.
   - Then say that capturing needs a plan process of the controller, and leave the code where it is.
3. Once the user confirms the capture, the branch is at `https://github.com/<owner>/<repo>/tree/prototype/<plan>-<name>`.
   - `<plan>` is the plan branch without `plan/`.
   - Put the verdict and that URL into the spec or ticket. The plan branch stays clean.
