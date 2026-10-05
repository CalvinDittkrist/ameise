# 0071. ADRs are a capped set of decisions that hold today

Date: 2026-10-04
Status: accepted

## Context
- The rule that a decision is never edited made every change of course a new ADR, so the set only grew.
- A reader followed chains of superseding and amending ADRs to find the rule in force, and agents paid tokens for dead decisions.
- Plugins cited ADR numbers that mean nothing in the repositories they run in.
- Issue #431 plans the rule.

## Decision
- An ADR holds a decision that is valid now and hard to reverse or surprising without context.
- A repository keeps at most `WF_ADR_MAX` ADRs, default 20. A new ADR on a full set removes or moves one in the same change.
- A changed decision edits its ADR in place. A decision that no longer holds is deleted; git keeps the history.
- A status is proposed or accepted. An ADR names no relation to another ADR.
- A number is never reused. The index carries the next free number. A merged ADR keeps its target's number and file name.
- A smaller decision moves as one rule with its reason, at most 30 words, into the document of its area.
- A comment or document cites only an ADR that exists, or states the reason itself. No plugin file cites an ADR number.

## Consequences
- Reading the ADRs gives the current architecture, one document per decision.
- A full set forces a choice when a decision is made.
- Rejected: superseding ADRs, because the set only grows.
