---
name: spec
description: Turn the current conversation into one spec issue. Synthesis only, no new questions.
disable-model-invocation: true
---
Without the controller's github tools (`create_issue` and the others) in this session, the controller did not start it: say that writing the spec needs a plan process of the controller `ameise`, opened with Plan on its board or `ameise plan`, and stop.

Write the spec from what the conversation has settled. Do not interview. If something material is still open, list it under Open questions instead of guessing.

1. If you have not explored the code yet, do it now: the modules the change touches, the tests around them, the ADRs in the area.
2. Propose the test seams: where the behaviour is verified end to end. Prefer existing seams; as few and as high as possible.
   - One line to the user; continue unless they object.
3. Write the body with [template.md](template.md) and publish it with the `create_issue` tool: the title, the body and the label `spec`.

   When the session started from an issue, put `Refines #N` at the top of the body.
4. Reply with the issue URL and `next: /planner:tickets`. If the whole spec fits one agent session, say so; tickets will then label the spec itself.

No em dash character (U+2014) anywhere in the body. No file paths and no code in the spec; they go stale. One exception: a prototype result that states a decision more precisely than prose (a type, a schema, a state table) may be quoted, trimmed to the decision.
