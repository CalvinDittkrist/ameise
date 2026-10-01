---
name: plan
description: Driver of a planning session. Shows the routes, recommends one, then hands over to the stage skills the user invokes.
disable-model-invocation: true
---
The session's context is the brief the controller started it with: the plan branch, its base, and the topic or the issue it plans, or an open session without a topic.

Without the controller's github tools (`create_issue` and the others) in this session, the controller did not start it.
- Say once that writing GitHub, capturing a prototype and finishing need a plan process of the controller `ameise`.
- Plan on its board or `ameise plan` opens one.
- `/planner:grill` and `/planner:research` work here as well; ask the user for the topic.

Routes:
- **Idea to tickets.** `/planner:grill` asks question rounds until nothing is open, `/planner:spec` writes one spec issue, `/planner:tickets` cuts it into agent-ready issues with blocking edges.
- **Existing issue.** `/planner:triage` verifies the claim, grills when needed, posts the agent brief and sets the labels.
- **Finished spec.** The controller runs the acceptance: Accept on its board's list of specs ready for acceptance. `/planner:accept` says so.
- **Tools for any route.** `/planner:research` settles a fact from outside the repo. `/planner:prototype` builds throwaway code for a question that talking does not settle.
- `/planner:finish` ends the session.

Do now:
1. Read AGENTS.md, docs/architecture.md and docs/glossary.md when they exist. Nothing else yet.
2. If the session starts from an issue, read it with the command the brief names and summarize it in three lines.
   - In an open session, say that the session has no topic and ask for the question.
   - Otherwise restate the topic in one line.
3. Recommend one route in one sentence and stop.
   - An open session names no route until a topic exists; then it continues through the stage skills.
   - The user invokes the stage skills; you never start a stage on your own.
