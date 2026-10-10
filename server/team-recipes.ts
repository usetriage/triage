/**
 * The team recipes triage ships (core/teams/recipe.ts), seeded into every
 * workspace's teams/ folder by TeamLibrary. Literal file text, not serialized
 * specs: these are the examples people copy, so they keep their comments.
 */

export const SHIPPED_RECIPES: Record<string, string> = {
  solo: `---
label: Solo
description: You and one agent build it, then a fresh-context checker verifies. The default for small changes.
use-for: [manual, mention, own-pr-open, own-pr-conflicting]
budget: 3
done: Every criterion on the card is proved by the checker, or two fix rounds are used up.
steps:
  - id: build
    agent: lead            # the session you're in builds it — no manager to pay for
    output: change
    does: Build the card. Verify it the cheapest real way the project offers, then hand off.
  - id: checks
    agent: checks          # the project's own typecheck, lint and tests — free
    on-fail: { back-to: build, max: 2 }
  - id: verify
    agent: reviewer
    output: verdict
    does: Prove each criterion on the card by running something; read the diff for what running can't show.
    on-fail: { back-to: build, max: 2 }
source: triage
---
Keep the card small: one shippable change, 2–4 criteria a checker can prove by running something.
If the item is bigger than that, say so on the card and suggest Build instead.
`,

  build: `---
label: Build
description: The lead splits the work into tasks; each is built by a fresh implementer, checked, and verified by a fresh reviewer. Then one review of the whole change, and the lead reports.
use-for: [issue, bug]
budget: 10
lead: { model: opus, effort: high }
done: Every task verified (or reported unresolved after two fix rounds), and the whole change passes a final review.
steps:
  - id: build
    agent: implementer
    output: change
    for-each: task           # build → checks → verify runs once per task, in order
    context: fresh           # each task starts clean; the plan's notes carry what earlier tasks learned
    does: Build your task and nothing outside it. Verify it the cheapest real way, then hand off — with notes for whoever builds next.
  - id: checks
    agent: checks
    for-each: task
    on-fail: { back-to: build, max: 2 }
  - id: verify
    agent: reviewer
    output: verdict
    for-each: task
    does: Prove each of your task's criteria by running something; read the task's diff for what running can't show.
    on-fail: { back-to: build, max: 2 }
  - id: final
    agent: reviewer
    output: verdict
    does: Review the whole change against the card's criteria — how the tasks fit together, the seams between them. Run the full checks once.
  - id: report
    agent: lead
    output: report
    does: At most eight lines — what changed, what was verified and how, what is unresolved, how to try it.
source: triage
---
Split the work into 2–6 tasks, in order. Each task leaves the project working and can be checked on its own;
work that only makes sense together is one task. Give each task 1–3 criteria a reviewer can prove by running
something. Point at the right files in the task title or criteria; don't design the implementation.
If the item is one small change, it's one task — or use Solo.
`,

  review: `---
label: Review
description: Splits a diff by area, reviewers work in parallel, a validator checks every finding is real, the lead merges.
use-for: [review-requested]
budget: 4
lead: { model: opus }
done: Every finding in the report survived validation, with file:line and a fix.
steps:
  - id: review
    agent: code-reviewer
    fan-out: { by: area, max: 4 }
    output: findings
    does: Review only your slice of the diff against the card's criteria. Real defects only, each with file:line.
  - id: validate
    agent: validator
    fan-out: { by: finding, max: 4 }   # triage splits the findings itself
    output: verdict
    model: sonnet
    does: For each finding, try to prove it wrong — read the code, run it. Keep only what survives.
  - id: report
    agent: lead
    output: report
    does: Merge what survived into one review, worst first, duplicates folded. No style nits.
source: triage
---
Split by what a reviewer needs to hold in its head at once — a feature area, a layer, a risky file —
not by line count. One area for a small diff; four only for a big one.
Give each reviewer its files, how to read the diff (\`gh pr diff 123\`, or \`git diff main...HEAD -- <files>\`),
and the one or two things that could go wrong there.
Reviewers get the diff and the criteria, never anyone's transcript.
`,

  research: `---
label: Research
description: Researchers chase separate questions in parallel; the lead writes one document with sources.
use-for: [digest]
budget: 4
lead: { model: opus }
done: Every question on the card has an answer with a source, or says plainly that none was found.
steps:
  - id: research
    agent: researcher
    fan-out: { by: question, max: 4 }
    output: notes
    does: Answer your question with evidence. Every claim carries a source — a link, a thread, a file:line.
  - id: write
    agent: lead
    output: report
    does: One document — the answer first, then the evidence per question, then what is still unknown.
source: triage
---
Split into questions that don't overlap, so two researchers never read the same pages.
One question is fine when the ask is narrow; parallel research pays off only on breadth.
`,

  debug: `---
label: Debug
description: Investigators each chase one hypothesis, then try to disprove each other; the lead writes the diagnosis.
use-for: [incident]
budget: 5
lead: { model: opus, effort: high }
done: One cause is supported by a repro or hard evidence, and the others are ruled out — or the report says what would settle it.
steps:
  - id: investigate
    agent: investigator
    fan-out: { by: hypothesis, max: 3 }
    output: findings
    does: Find evidence for or against your hypothesis. Reproduce it if you can. Don't fix anything.
  - id: challenge
    agent: investigator
    fan-out: { by: hypothesis, max: 3 }   # same slices: each investigator continues its session
    output: findings
    does: Read the other investigators' findings and try to disprove them. Say which hypothesis still stands.
  - id: report
    agent: lead
    output: report
    does: The diagnosis — the cause, the evidence, what was ruled out, and the smallest fix worth trying.
source: triage
---
Pick hypotheses that predict different things, so evidence can tell them apart.
Two are enough when one is a strong favourite; three when it's a real mystery.
Nobody edits files on this team — the fix is a separate run, usually Solo.
`,
}
