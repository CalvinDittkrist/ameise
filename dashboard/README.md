# Dashboard

The browser interface of the [controller](../controller/README.md): React, Vite and TypeScript on shadcn/ui with Tailwind, base colour neutral ([ADR 0064](../docs/adr/0064-the-local-dashboard-is-built-into-the-controller.md)). It talks to the controller's API alone.

## Pages
- The sidebar holds the Orchestrator entry, the projects of `GET /api/projects` and the action that adds one.
- Its footer holds the quota. The sidebar collapses to its icons, which hides the footer.
- The pages read the board of `GET /api/board` when they open, when the window comes back into focus and every half minute.
- The Orchestrator page, at `#`, has the sections needs you, running and ready to start over every project.
  - Needs you holds the processes that wait for a person and the specs ready for acceptance. Running holds every other process.
  - A process row shows its state as a dot, its issue and branch, its note, stage and age, and its one primary action.
- A project's page, at `#project=<path of its checkout>`, has its actions and the sections processes and ready to start.
  - Ready for acceptance follows when a spec of the project is.
- A project whose checkout no longer derives shows the controller's reason. What GitHub did not answer shows as a note above the sections.
- The controller carries out no action and reads no quota yet. Until it does, the actions are disabled.
- Light and dark follow the system.

## Development
- `npm --prefix dashboard run build` writes the build into `controller/dist/dashboard`, which the controller serves at `/`.
- `npm --prefix dashboard run dev` serves it with hot reload. It sends `/api` to a controller on the default address.
- `make dashboard` runs eslint, the type check, the build and the browser test.
- The browser test starts the built controller in fake mode with two checkouts and a directory that is no checkout.
  - The checkouts hold worktrees and process records, and the canned GitHub their pull requests, issues and specs, so the board has a row of every kind.
- It compares a screenshot of each page in light and dark with the one approved for the operating system.
- After a change to the look, delete `tests/screenshots/*.png`, run the test, and approve the new ones against the prototype.
- CI renders the Linux ones in Playwright's image, so they are written there:
  `docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work/dashboard mcr.microsoft.com/playwright:v<version>-noble npx playwright test`.
- `<version>` is the Playwright version in the lockfile.
- A shadcn component is copied into `src/components/ui`, with its `cn` import pointed at `@/lib/utils`.
