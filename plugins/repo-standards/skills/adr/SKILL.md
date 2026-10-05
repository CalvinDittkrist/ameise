---
name: adr
description: Record an architecture decision as a new ADR in docs/adr. Use for a decision that holds today and is hard to reverse or surprising without context.
argument-hint: <decision title>
---
1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/new-adr.sh" $ARGUMENTS`.
   - When it warns that the set is full, remove an ADR or move one as a rule with its reason into the document of its area, in the same change.
2. Fill the created file: Context (forces, links), Decision (one decision, present tense), Consequences (including the rejected alternative).
   - At most 250 words, headings included.
   - Set `Status: accepted` only if the user confirmed the decision; otherwise leave `proposed`.
3. If the decision changes `docs/architecture.md`, update that too.
