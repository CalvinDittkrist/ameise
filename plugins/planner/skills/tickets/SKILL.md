---
name: tickets
description: Break the spec into agent-ready issues, each a complete vertical slice with its blocking edges, published in dependency order.
disable-model-invocation: true
argument-hint: [spec issue]
---
Without the controller's github tools (`create_issue` and the others) in this session, the controller did not start it: say that publishing tickets needs a plan process of the controller `ameise`, opened with Plan on its board or `ameise plan`, and stop.

Source: the spec issue named in the argument ($ARGUMENTS), or the spec this session wrote. Fetch it with `gh issue view <n> --comments` when it is not in context.

1. Explore the code if you have not. Use the project's vocabulary; respect ADRs in the area.
   - Look for a refactor that would make the change easy; if there is one, it is the first ticket.
2. Cut the work into vertical slices. Never one layer per ticket.
   - Each ticket is a narrow but complete path through every layer it touches, demoable or verifiable on its own, sized for one fresh agent session.
   - Exception: a wide mechanical change (rename a column, retype a shared symbol) is sequenced as expand, migrate in batches, contract.
   - Each batch is blocked by the expand; the contract is blocked by every batch.
3. Give every ticket its blockers: the tickets that must be closed before it can start. The fewest edges that are true.
4. Show the breakdown as a numbered list: title, blocked by, what it delivers. Ask whether granularity and edges are right. Iterate until the user approves.
5. Ask once which milestone the tickets belong to. Show the open ones with `gh api 'repos/{owner}/{repo}/milestones?state=open&per_page=100' --jq '.[] | "\(.title) \(.open_issues) open, \(.closed_issues) closed: \(.description)"'`.

   Accepted answers: an open milestone, a new `vX.Y.Z` (its description is the spec's goal in one sentence), or none. Create a new one with the `create_milestone` tool, the goal as its description.

6. Ask once whether the spec is a spec run or a normal run, then who gets each ticket, following [routing.md](routing.md).
   - Give one line per ticket with the recommendation, and the reason for every ticket you advise against.
   - A normal run routes only the tickets the maintainer names to the factory.
   - A spec run asks per ticket only whether an agent or a person works it. No ticket gets `factory`.
7. Publish in dependency order, blockers first, so edges can name real numbers.

   For each ticket write the body with [template.md](template.md), then:
   - `create_issue` with the title, the body, the label `ready-for-agent` (plus `factory` for a routed ticket), the spec as its parent and the milestone when one was chosen;
   - `block` with the ticket and the tickets that block it.

   In a spec run, label the spec first: `set_labels` on the spec adding `factory:spec-run`. An agent ticket then takes `factory:spec-run` beside `ready-for-agent`; a person's ticket takes `ready-for-human` instead of both.

   A ticket created with a milestone attaches the spec to the same milestone, so the release waits for the acceptance; a warning means the spec already carries a different one. The first ticket also carries the spec's glossary terms and the ADRs to write, change or remove under Docs. If the spec fits one session, create no tickets: `set_labels` on the spec adding `ready-for-agent` (plus `factory` when it is routed), then `attach_milestone` on the spec when a milestone was chosen.

8. Reply with the milestone (or none), the spec's milestone, a line per ticket (number, title, blocked by, routed or not, or who works it in a spec run).
   - End with `next: the controller claims from the frontier on its board; /planner:finish ends this session`.

No em dash character (U+2014) anywhere in the body. Do not close or edit the spec; its milestone is the job of `create_issue`. Bodies carry no file paths and no code; the prototype exception from the spec applies.
