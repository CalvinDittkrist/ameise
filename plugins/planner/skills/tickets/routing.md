# Routing to the factory

The factory host works a routed issue unattended: a worker session on a machine of its own, no screen, nobody to ask, ending in a pull request. Routing is decided here, where the acceptance criteria are written, because the criteria say whether that is possible.

**Ask once first: a spec run or a normal run.** In a spec run the factory works the whole spec on a spec branch, its tickets in the order of their blocking edges. In a normal run it works the tickets routed to it one by one.

**Judge the acceptance criteria, one ticket at a time.** Recommend routed when every criterion can be met and checked by a worker with a checkout, a shell and the gate: code, tests, documentation, a script, a headless command. In a spec run that means an agent works it.

Recommend not routed (in a spec run: a person works it), and name the reason, when a criterion needs:
- A terminal: a window, a pane, a session or a notification the worker would have to create or see.
- a screen: a browser, a screenshot, a rendered interface judged by eye, a device.
- a person: a secret only the maintainer holds, an account or environment the host cannot reach, a decision taken during the work, a release or deploy.

## A normal run

A `ready-for-human` issue is never routed, whatever its criteria say; the controller's tools refuse that combination and the one where the routing label would sit without `ready-for-agent`.

**Ask once**, with the breakdown in front of you: one line per ticket with number or position, title, the recommendation and the reason for every ticket you advise against. The maintainer answers with the tickets to route (all, none or a list). Nothing is routed by default and nothing the maintainer did not name is routed, whatever you recommended.

Route a ticket by adding the label `factory` when it is created (`create_issue` with `ready-for-agent` and `factory`) or afterwards (`set_labels` adding `factory`).

Setting or removing the label by hand on GitHub stays possible, and is how the maintainer routes a ticket later or cancels a run.

## A spec run

**Ask once per ticket only whether an agent or a person works it**, in the same one-line form. Then:
- The spec and every agent ticket carry the spec-run label `factory:spec-run`. The spec needs no `ready-for-agent` for it.
- Label the spec before its tickets: a ticket carries the label only when its spec does.
- A person's ticket carries `ready-for-human` and no spec-run label. The factory waits for it.
- No issue of a spec run carries `factory`.
- The controller's tools refuse `factory:spec-run` next to `factory` or `ready-for-human`, and on an issue that is neither a `spec` nor a ticket of a spec run.

So `set_labels` on the spec adds `factory:spec-run` first. Then `create_issue` makes each agent ticket with `ready-for-agent` and `factory:spec-run`, and each person's ticket with `ready-for-human`, both with the spec as parent.

Removing the spec-run label from the spec, or closing the spec, cancels the run.
