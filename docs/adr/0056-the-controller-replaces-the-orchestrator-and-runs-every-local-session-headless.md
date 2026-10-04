# 0056. The controller drives every local session headless, and a person merges

Date: 2026-09-27
Status: accepted

## Context
- Hands-on work spans the repositories of one machine, with a person at hand. Spec #253.
- The factory drives its stages in Go, one fresh session each ([ADR 0040](0040-the-factory-owns-the-delivery-lifecycle-in-go.md)).

## Decision
- The controller `ameise` is one program per machine that holds projects, worktrees and processes and serves a dashboard on loopback.
- The dashboard is the control surface: every action is a click or a CLI command against the controller's API, the only writer.
- Every local session runs headless through the Agent SDK. An unsettled permission and every question reach the process view as a dialog.
- A `work` process runs implement, gate, review, pr, ci and address-reviews.
- Implement is the one multi-turn session. It compacts at the compact pin and never hands over.
- Every later stage is one fresh session with a stage timeout and a result schema.
- The process record holds each gate result and review round.
- Merge is the maintainer's click in manual mode, and automatic in yolo mode once CI is green and the panel is ready.
- There is no local validate stage.

## Consequences
- A person sees every project on one board.
- No session hands itself over, and nothing depends on a status line.
- A session opens in a terminal by its session id when the dashboard lacks something.
- Rejected: the Vercel AI SDK harnesses, which have no sandbox for a local directory.
