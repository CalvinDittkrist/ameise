# Architecture Decision Records

An ADR records a decision that holds today and is hard to reverse or surprising without context. Format: [MADR](https://adr.github.io/madr/), trimmed. Create one with `/repo-standards:adr <title>`.

- The set holds at most `WF_ADR_MAX` ADRs, 20 unless the `Makefile` lowers it.
- A new ADR on a full set removes one, or moves it as a rule with its reason into the document of its area.
- A changed decision edits its ADR in place. A decision that no longer holds is deleted; git keeps the history.
- A status is proposed or accepted, and an ADR names no relation to another. A number is never reused.

Next free number: 0001

| ADR | Title | Status |
| --- | --- | --- |
