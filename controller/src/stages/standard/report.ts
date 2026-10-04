// The report and the answers of a standardize process.
//
// report merges the auditors' finding lines into one report grouped by category and stores them for the apply.
// Only lines of the fixed format count, other text is ignored:
//   finding: <category> | <target> | <action> | <reason> | <confidence>
// category: files, agent-config, docs, tests-ci, workspace, security; action: delete, replace, create, configure,
// issue; confidence: high, medium, low. A target other than a GitHub setting (configure) is a path inside the
// repository: no leading / or ~, no .. segment; only the workspace category configures; no target starts with -.
// Any malformed finding line fails the whole report and stores nothing.
// Per category the report keeps the findings the run works through one by one (delete, replace, create, and
// issue apart) away from the `configure` ones, which only describe what the workspace step decides for itself,
// and it says what approving the category triggers beyond its lines; approval stays per category (docs/repo-standard.md).
// A category scaffold.sh has templates for is asked about even without findings, because approving it creates
// its missing baseline files and rejecting it is what keeps the apply out of it (docs/repo-standard.md).
// The findings go to <git dir>/standardize/findings; earlier approvals and the record of what the apply already
// applied are cleared, because they answered another report. Nothing in the working tree or on GitHub changes.
//
// approve records the maintainer's answer per category of the last report and reports the state of all. A later
// answer for a category replaces the earlier one. An unanswered category is `pending` when it has findings, which
// stops the apply, and `unanswered` when it is only scaffolded, which does not: the apply scaffolds it as an
// approval would, and rejecting it is what keeps the apply out (docs/repo-standard.md).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerable, categories, type Ctx, ensureDir, type Finding, hasFindings, lines, readApprovals, readFindings, say, scaffoldCategories, stateDir, Stop } from './lib.js'

const actions = ['delete', 'replace', 'create', 'configure', 'issue']
const confidences = ['high', 'medium', 'low']

// trim takes the whitespace off both ends of a field and turns its tabs into spaces, as the store is tab separated.
const trim = (s: string) => s.replace(/^\s+|\s+$/g, '').replace(/\t/g, ' ')

// parse reads the finding lines of the replies, one record per finding with duplicates dropped, and names every
// malformed one with why.
function parse(text: string[]): { findings: Finding[]; bad: string[] } {
  const findings: Finding[] = []
  const bad: string[] = []
  const seen = new Set<string>()
  for (const raw of text.join('\n').split('\n')) {
    const line = raw
      .replace(/\r$/, '')
      .replace(/^\s*([-*]\s+)?`?/, '')
      .replace(/`\s*$/, '')
    if (!line.startsWith('finding:')) continue
    const body = line.replace(/^finding:\s*/, '')
    const f = body === '' ? [] : body.split('|').map(trim)
    const [cat = '', target = '', action = '', reason = '', confidence = ''] = f
    let why = ''
    if (f.length !== 5) why = `has ${f.length} fields, needs 5: category | target | action | reason | confidence`
    else if (!(categories as readonly string[]).includes(cat)) why = `unknown category ${cat}; use one of ${categories.join(' ')}`
    else if (target === '') why = 'empty target'
    else if (!actions.includes(action)) why = `unknown action ${action}; use delete, replace, create, configure or issue`
    else if (action === 'configure' && cat !== 'workspace') why = 'configure is for GitHub settings, which only the workspace category proposes'
    else if (action !== 'configure' && (/^[/~]/.test(target) || /(^|\/)\.\.(\/|$)/.test(target))) why = `target ${target} leaves the repository; use a path relative to its root`
    else if (target.startsWith('-')) why = `target ${target} starts with -; name the path without a leading dash`
    else if (reason === '') why = 'empty reason'
    else if (!confidences.includes(confidence.toLowerCase())) why = `unknown confidence ${confidence}; use high, medium or low`
    if (why !== '') {
      bad.push(`error: ${why}: ${line}`)
      continue
    }
    const key = `${cat}\t${target}\t${action}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({ category: cat, target, action, reason, confidence: confidence.toLowerCase() })
  }
  return { findings, bad }
}

const baseline = 'creates every baseline file of the category that is missing'
const settings =
  '  approving agent-config also brings .claude/settings.json to the template: the workflow plugins enabled, every other project plugin disabled, the template permissions and env merged'

// report stores the findings of the replies and reports them per category.
export async function report(c: Ctx, replies: string[]) {
  const dir = await stateDir(c)
  const { findings, bad } = parse(replies)
  if (bad.length > 0) {
    say(c, ...bad)
    throw new Stop('malformed findings, nothing stored; correct those lines and run report.sh again')
  }
  ensureDir(dir)
  writeFileSync(join(dir, 'findings'), findings.map((f) => [f.category, f.target, f.action, f.reason, f.confidence].join('\t') + '\n').join(''))
  // A new report answers for a new run: the approvals and the settings the last run worked on go.
  rmSync(join(dir, 'approvals'), { force: true })
  rmSync(join(dir, 'workspace-handled'), { force: true })

  // The categories asked about come from answerable, the same function approve answers for, so the report and
  // the answer cannot drift apart.
  const order = answerable(findings)
  const of = (cat: string) => findings.filter((f) => f.category === cat)
  const total = findings.length
  if (total === 0) say(c, 'findings: 0; the repository matches the standard')
  else {
    const cats = order.filter((cat) => of(cat).length > 0).length
    const issues = findings.filter((f) => f.action === 'issue').length
    say(c, `findings: ${total} in ${cats} categor${cats === 1 ? 'y' : 'ies'}; ${total - issues} for the run, ${issues} as issues`)
  }
  for (const cat of order) {
    const mine = of(cat)
    // An answerable category without findings is one scaffold.sh has templates for: the apply creates its missing
    // baseline files, and rejecting it is the only way to keep the apply out of it (docs/repo-standard.md).
    if (mine.length === 0) {
      say(c, '', `${cat}: no findings`, `  approving ${cat} ${baseline}`)
      if (cat === 'agent-config') say(c, settings)
      say(c, `  rejecting ${cat} leaves it alone: the apply phase creates none of them${cat === 'agent-config' ? ' and leaves .claude/settings.json as it is' : ''}`)
      say(c, `  leaving ${cat} unanswered scaffolds it: only a rejection keeps the apply phase out`)
      continue
    }
    const counts = actions.flatMap((a) => {
      const n = mine.filter((f) => f.action === a).length
      return n > 0 ? [`${a} ${n}`] : []
    })
    const row = (f: Finding) => `    ${f.action} ${f.target}: ${f.reason} (${f.confidence})`
    // The action decides the group, not the category: delete, replace and create name a target the run works
    // through one by one, configure names a setting the workspace step decides for itself (docs/repo-standard.md).
    const per = mine.filter((f) => f.action !== 'issue' && f.action !== 'configure')
    const dec = mine.filter((f) => f.action === 'configure')
    const iss = mine.filter((f) => f.action === 'issue')
    // A target two auditors delete is shown in both.
    const del = mine
      .filter((f) => f.action === 'delete')
      .map((f) => {
        const also = findings.filter((o) => o.action === 'delete' && o.target === f.target && o.category !== cat).map((o) => o.category)
        return f.target + (also.length > 0 ? ` (also ${also.join(', ')})` : '')
      })
    say(c, '', `${cat}: ${mine.length} finding${mine.length === 1 ? '' : 's'} (${counts.join(', ')})`)
    say(c, `  deletes: ${del.length > 0 ? del.join(', ') : 'nothing'}`)
    if (per.length > 0) say(c, '  the run performs, one by one:', ...per.map(row))
    else say(c, '  the run performs, one by one: nothing')
    if (dec.length > 0) {
      say(c, '  workspace.sh decides these; the lines are what it found at the audit:', ...dec.map(row))
      say(
        c,
        `  approving ${cat} applies the whole difference between the GitHub workspace and the standard, recomputed after the cleanup pull request is merged, so it can differ from the lines above`,
      )
    }
    if (scaffoldCategories.includes(cat)) say(c, `  approving ${cat} ${per.length > 0 || dec.length > 0 ? 'also ' : ''}${baseline}, whether a finding above lists it or not`)
    // scaffold.sh writes the settings of the agent-config category through the plugin commands, existing file or not.
    if (cat === 'agent-config') say(c, settings)
    if (iss.length > 0) say(c, '  become issues:', ...iss.map(row))
    else say(c, '  become issues: none')
  }
  say(c, '', 'next: ask for approval per category, then record the answers with approve.sh <category>=approve|reject ...')
}

// approve records the answers given as <category>=approve|reject and reports the state of every category.
export async function approve(c: Ctx, args: string[]) {
  const dir = await stateDir(c)
  const findings = readFindings(dir)
  if (!findings) throw new Stop('no findings recorded; run the audit and report.sh first')
  // The categories the report asked about: those with findings and the scaffolded ones, which the apply creates
  // baseline files for whether a finding lists them or not (docs/repo-standard.md).
  const cats: string[] = answerable(findings)

  // Validate every argument before recording any, so a typo records nothing.
  const given: [string, string][] = []
  for (const a of args) {
    const at = a.indexOf('=')
    if (at < 0) throw new Stop(`${a}: use <category>=approve or <category>=reject`)
    const cat = a.slice(0, at)
    const v = a.slice(at + 1)
    if (!cats.includes(cat)) throw new Stop(`${cat} is not in the last report and is not scaffolded, so there is nothing to answer for it; the report asks about: ${cats.join(' ')}`)
    if (v !== 'approve' && v !== 'reject') throw new Stop(`${a}: the answer is approve or reject`)
    given.push([cat, v])
  }
  const file = join(dir, 'approvals')
  if (!existsSync(file)) writeFileSync(file, '')
  for (const [cat, v] of given) {
    const kept = lines(readFileSync(file, 'utf8')).filter((l) => l.split('\t')[0] !== cat)
    writeFileSync(`${file}.tmp`, [...kept, `${cat}\t${v}`].map((l) => l + '\n').join(''))
    renameSync(`${file}.tmp`, file)
  }

  const recorded = readApprovals(dir)
  const approved: string[] = []
  const rejected: string[] = []
  const pending: string[] = []
  const unanswered: string[] = []
  for (const cat of cats) {
    const v = recorded.get(cat)
    if (v === 'approve') approved.push(cat)
    else if (v === 'reject') rejected.push(cat)
    else if (hasFindings(findings, cat)) pending.push(cat)
    else unanswered.push(cat)
  }
  const list = (xs: string[]) => (xs.length > 0 ? xs.join(', ') : 'none')
  say(c, `approved: ${list(approved)}`, `rejected: ${list(rejected)}`, `pending: ${list(pending)}`, `unanswered: ${list(unanswered)}`)
  if (unanswered.length > 0) say(c, 'note: the unanswered categories have no findings; the apply phase scaffolds them unless they are rejected')
}
