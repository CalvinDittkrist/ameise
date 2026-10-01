---
name: finish
description: End the planning session. Lists what it wrote, then hands the removal of the worktree to the controller.
disable-model-invocation: true
---
1. List the issues this session created or changed, one line each with number and title, so the user has the summary.
2. Check the worktree with `git status --porcelain`.
   - When it holds changes, say that a finish loses them unless `/planner:prototype` captures them first.
3. Say that Finish in the process view of the controller ends the session.
   - It stops the session and removes this worktree and the plan branch.
   - It refuses changes not captured unless forced.
   - Without the controller's github tools in this session, the controller did not start it.
   - Then the worktree is the user's to remove with `git worktree remove`; nothing on GitHub is lost.

Remove nothing yourself; this session runs in the worktree a finish removes.
