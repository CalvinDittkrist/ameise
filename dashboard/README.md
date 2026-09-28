# Dashboard

The browser interface of the [controller](../controller/README.md): React, Vite and TypeScript on shadcn/ui with Tailwind, base colour neutral ([ADR 0064](../docs/adr/0064-the-local-dashboard-is-built-into-the-controller.md)). It talks to the controller's API alone.

## Pages
- The sidebar holds the Orchestrator entry, the projects of `GET /api/projects` and the action that adds one.
- Its footer holds the quota of `GET /api/quota`: per runtime the percentage left as a bar and the time to its reset.
  - A runtime below the configured minimum is red and says so. One the controller could not read says unknown, with the reason on hover.
  - It is read when the page opens, on focus and every minute.
- The sidebar collapses to its icons, which hides the footer.
- A process that turned blocked, ready or failed carries a badge, `new`, on its row until its page is opened. The Orchestrator entry counts them.
- The pages read the board of `GET /api/board` when they open, when the window comes back into focus and every half minute.
- The Orchestrator page, at `#`, has the sections needs you, running and ready to start over every project.
  - Needs you holds the processes that wait for a person and the specs ready for acceptance. Running holds every other process.
  - A process row shows its state as a dot, its issue and branch, its note, stage and age, and its one primary action.
- A project's page, at `#project=<path of its checkout>`, has its actions and the sections processes and ready to start.
  - Ready for acceptance follows when a spec of the project is.
- A process's page, at `#process=<id>`, shows its facts. Its branch on the row opens it, and opening it clears the badge.
- A project whose checkout no longer derives shows the controller's reason. What GitHub did not answer shows as a note above the sections.
- Claim on a ready-to-start row opens a dialog for the mode, manual or yolo, and the worker knobs to override, one `NAME=VALUE` per line.
  - Force claims an issue the controller refuses as not agent-ready, routed, held in a spec run or claimed on origin.
  - The controller's reason for a refusal shows in the dialog.
  - A runtime whose quota is below the minimum is a warning in the dialog, whose button then reads Claim anyway. Nothing waits for the reset.
- The cross on the row of a work process abandons it after a dialog: the worktree and the process go, the branch and the issue stay.
  - Force abandons work not on origin.
- Resume on the row of an interrupted process goes on with its session.
- Adopt on the row of a foreign worktree takes it into a process, and the cross removes it.
  - The controller's reason for refusing a resume or an adopt shows beside the button.
- The controller carries out no other action. Until it does, the other actions are disabled.
- Light and dark follow the system.

## Development
- `npm --prefix dashboard run build` writes the build into `controller/dist/dashboard`, which the controller serves at `/`.
- `npm --prefix dashboard run dev` serves it with hot reload. It sends `/api` to a controller on the default address.
- `make dashboard` runs eslint, the type check, the build and the browser test.
- The browser test starts the built controller in fake mode with two checkouts and a directory that is no checkout.
  - A scripted quota-axi answers that Claude is below the minimum.
  - The checkouts hold worktrees and process records. The canned GitHub answers their pull requests, issues and specs, so the board has a row of every kind.
  - It leaves the specs of the checkout the add-project test adds unanswered, so the board shows a note.
  - The claim test claims an issue of the frontier and abandons it again, so the board reads the same after it.
- It compares a screenshot of each page in light and dark with the one approved for the operating system.
- After a change to the look, delete `tests/screenshots/*.png`, run the test, and approve the new ones against the prototype.
- CI renders the Linux ones in Playwright's image, so they are written there:
  `docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work/dashboard mcr.microsoft.com/playwright:v<version>-noble npx playwright test`.
- `<version>` is the Playwright version in the lockfile.
- A shadcn component is copied into `src/components/ui`, with its `cn` import pointed at `@/lib/utils`.
