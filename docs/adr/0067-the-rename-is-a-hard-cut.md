# 0067. The rename is a hard cut

Date: 2026-09-29
Status: accepted
Extends: [0066](0066-the-product-is-named-ameise-and-its-parts-keep-their-names.md) (how the old name ends)

## Context
- The old name `workflows` is on machines as a command, directories and a marketplace. Spec #302.
- A second name kept alive has to be tested, documented and removed later.

## Decision
- The code does not know the old name. No alias, no second command, no warning period.
- The controller neither reads, moves nor reports directories under the old name. A machine that ran it adds its projects again.
- The standard check gets no rule for the old marketplace; its template names the plugins of `ameise`, and its existing warnings follow from that.
- No repository is created under the old name again, so GitHub keeps redirecting it.

## Consequences
- A maintainer who types the old command learns from the shell that it does not exist.
- The processes and settings of a machine under the old directories stay there until a person removes them.
- Rejected: a migration of the directories. It would keep the old name in the code for one move per machine.
