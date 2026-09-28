# Dashboard

The browser interface of the [controller](../controller/README.md): React, Vite and TypeScript on shadcn/ui with Tailwind, base colour neutral ([ADR 0064](../docs/adr/0064-the-local-dashboard-is-built-into-the-controller.md)). It talks to the controller's API alone.

## Pages
- The sidebar holds the Orchestrator entry, the projects of `GET /api/projects` and the action that adds one.
- Its footer holds the quota. The sidebar collapses to its icons, which hides the footer.
- The Orchestrator page, at `#`, has the sections needs you, running and ready to start.
- A project's page, at `#project=<path of its checkout>`, has its actions and the sections processes and ready to start.
- A project whose checkout no longer derives shows the controller's reason.
- The controller serves no processes, frontier or quota yet. Until it does, the sections are empty and the actions disabled.
- Light and dark follow the system.

## Development
- `npm --prefix dashboard run build` writes the build into `controller/dist/dashboard`, which the controller serves at `/`.
- `npm --prefix dashboard run dev` serves it with hot reload. It sends `/api` to a controller on the default address.
- `make dashboard` runs eslint, the type check, the build and the browser test.
- The browser test starts the built controller in fake mode with two checkouts and a directory that is no checkout.
- It compares a screenshot of each page in light and dark with the one approved for the operating system.
- After a change to the look, delete `tests/screenshots/*.png`, run the test, and approve the new ones against the prototype.
- CI renders the Linux ones in Playwright's image, so they are written there:
  `docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work/dashboard mcr.microsoft.com/playwright:v<version>-noble npx playwright test`.
- `<version>` is the Playwright version in the lockfile.
- A shadcn component is copied into `src/components/ui`, with its `cn` import pointed at `@/lib/utils`.
