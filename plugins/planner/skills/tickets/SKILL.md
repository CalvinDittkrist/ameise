---
name: tickets
description: Break the spec into agent-ready issues, each a complete vertical slice with its blocking edges, published in dependency order.
disable-model-invocation: true
argument-hint: [spec issue]
---
Source: the spec issue named in the argument ($ARGUMENTS), or the spec this session wrote. Fetch it with `gh issue view <n> --comments` when it is not in context.

1. Explore the code if you have not. Use the project's vocabulary; respect ADRs in the area.
   - Look for a refactor that would make the change easy; if there is one, it is the first ticket.
2. Cut the work into vertical slices. Never one layer per ticket.
   - Each ticket is a narrow but complete path through every layer it touches, demoable or verifiable on its own, sized for one fresh agent session.
   - Exception: a wide mechanical change (rename a column, retype a shared symbol) is sequenced as expand, migrate in batches, contract.
   - Each batch is blocked by the expand; the contract is blocked by every batch.
3. Give every ticket its blockers: the tickets that must be closed before it can start. The fewest edges that are true.
4. Show the breakdown as a numbered list: title, blocked by, what it delivers. Ask whether granularity and edges are right. Iterate until the user approves.
5. Ask once which milestone the tickets belong to. Show the open ones with `"${CLAUDE_PLUGIN_ROOT}/scripts/issue.sh" milestones`.

   Accepted answers: an open milestone, a new `vX.Y.Z` (its description is the spec's goal in one sentence), or none. For a new one run:

       "${CLAUDE_PLUGIN_ROOT}/scripts/issue.sh" milestone <vX.Y.Z> --description "<goal>"

6. Ask once whether the spec is a spec run or a normal run, then who gets each ticket, following [routing.md](routing.md).
   - Give one line per ticket with the recommendation, and the reason for every ticket you advise against.
   - A normal run routes only the tickets the maintainer names to the factory.
   - A spec run asks per ticket only whether an agent or a person works it. No ticket gets `factory`.
7. Publish in dependency order, blockers first, so edges can name real numbers.

   For each ticket write the body with [template.md](template.md) and run (`--milestone` and `attach` only when a milestone was chosen):

       "${CLAUDE_PLUGIN_ROOT}/scripts/issue.sh" create --title "<title>" --body-file <file> --label ready-for-agent --parent <spec> --milestone <vX.Y.Z>   # plus --label factory for a routed ticket
       "${CLAUDE_PLUGIN_ROOT}/scripts/issue.sh" block <ticket> --by <n>,<m>

   In a spec run, label the spec first with `label <spec> --add factory:spec-run`. An agent ticket then takes `--label factory:spec-run` beside `ready-for-agent`; a person's ticket takes `--label ready-for-human` instead of both.

   A ticket created with a milestone attaches the spec to the same milestone, so the release waits for the acceptance; a warning means the spec already carries a different one. The first ticket also carries the spec's glossary terms and ADRs under Docs. If the spec fits one session, create no tickets:

       "${CLAUDE_PLUGIN_ROOT}/scripts/issue.sh" label <spec> --add ready-for-agent   # plus --add factory when it is routed
       "${CLAUDE_PLUGIN_ROOT}/scripts/issue.sh" attach <spec> --milestone <vX.Y.Z>

8. Reply with the milestone (or none), the spec's milestone, a line per ticket (number, title, blocked by, routed or not, or who works it in a spec run).
   - End with `next: the controller claims from the frontier on its board; /planner:finish ends this session`.

No em dash character (U+2014) anywhere in the body. Do not close or edit the spec; its milestone is the script's job. Bodies carry no file paths and no code; the prototype exception from the spec applies.
