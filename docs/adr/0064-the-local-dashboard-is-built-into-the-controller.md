# 0064. The local dashboard is built into the controller

Date: 2026-09-28
Status: accepted
Extends: [0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md) (the dashboard is the control surface)

## Context
- Spec #253 makes the dashboard a unit beside the controller, which serves it as the factory serves its own ([ADR 0033](0033-the-dashboard-is-built-into-the-factory-binary.md)).
- The approved look is a shadcn/ui prototype on Tailwind. The controller is Node, so nothing is embedded.

## Decision
- The dashboard is React, Vite and TypeScript in `dashboard/`, on shadcn/ui with the base colour neutral.
- Its shadcn components are copied into its source. It takes no dependency on the `shadcn` command line.
- Its build goes into `controller/dist/dashboard`, which the controller serves at `/`, beside `/api`.
- The page lives in the URL's fragment, so the server answers only the build's files. Without a build, `/` answers 404 with the fix.
- Light and dark follow the `prefers-color-scheme` media query, with no script.
- A content security policy allows the server's own scripts alone and no framing.

## Consequences
- A package of the controller's build carries the dashboard ([ADR 0060](0060-one-release-unit-bundles-the-plugins.md)).
- The gate runs its lint, type check, build and a browser test against the real controller in fake mode.
- The controller's tests give the binary a build of their own, or none.
- Rejected: the dashboard inside `controller/`, which mixes the browser's toolchain into the server's package.
- Rejected: a script that toggles a dark class. The policy refuses inline scripts, and the first paint would be in the wrong scheme.
