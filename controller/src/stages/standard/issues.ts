// The approved findings with the action issue become agent-ready issues (label ready-for-agent), one per
// finding, so code changes go through the worker pipeline instead of the cleanup pull request. An issue is
// found again by its title, `Standard (<category>): <target>`, so a second run opens nothing twice.
import { approvedFindings, type Ctx, decisions, ensureLabel, gh, githubRepo, last, listAll, say, Stop, tag } from './lib.js'

export async function issues(c: Ctx) {
  const { findings, answers } = await decisions(c)
  const todo = approvedFindings(findings, answers, 'issue')
  if (todo.length === 0) {
    say(c, 'issues: none approved')
    return
  }
  const repo = await githubRepo(c)
  await ensureLabel(c, repo, 'ready-for-agent')
  const titles = (await listAll<{ number: number; title: string; pull_request?: unknown }>(c, `repos/${repo.nwo}/issues?state=all&per_page=100`, `cannot list the issues of ${repo.nwo}`)).filter(
    (i) => (i.pull_request ?? null) === null,
  )
  let opened = 0
  let kept = 0
  for (const f of todo) {
    const title = `Standard (${f.category}): ${f.target}`
    const known = titles.find((i) => i.title === title)
    if (known) {
      say(c, `kept: #${known.number} ${title}`)
      kept++
      continue
    }
    // The reason is an auditor's judgement of repository content: quoted, so it reads as a finding, not a brief.
    const body = `## What to build\nResolve this finding of the standardisation run (the standardize process of the controller), from its \`${f.category}\` audit of \`${f.target}\`, confidence ${f.confidence}:\n\n> ${f.reason}\n\nThe state before the run is tagged \`${tag}\`.\n\n## Acceptance criteria\n- [ ] \`${f.target}\` no longer has the problem the finding describes.\n- [ ] \`make check\` passes.`
    const r = await gh(c, ['api', '--method', 'POST', `repos/${repo.nwo}/issues`, '--input', '-'], { title, body, labels: ['ready-for-agent'] })
    if (r.code !== 0) throw new Stop(`cannot open the issue ${title}: ${last(r.stderr)}`)
    say(c, `opened: #${(JSON.parse(r.stdout) as { number: number }).number} ${title}`)
    opened++
  }
  say(c, `issues: ${opened} opened, ${kept} kept`)
}
