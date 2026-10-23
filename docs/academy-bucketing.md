# Academy bucketing

Sorts the academy-assessed pool into tech-stack buckets for mentor assignment:
**Frontend**, **Backend**, **AI-ML** (AI / ML, data science, GenAI) and **Full Stack**, with
**Mixed** for candidates who are nearly equally strong in two directions. Each candidate goes to
exactly one sheet. Sidebar: *Screening › Academy bucketing*.

## Inputs (read only)

| Sheet | Tab(s) | Used for |
|---|---|---|
| 1 — assessed pool | "Sahana Working New Criteria" (auto-detected) | Eligibility, Active Pool, placement, preference, resume link, old-process TR rounds, competency levels. **The only sheet eligibility is read from.** |
| 2 — competency interviews | Every tab with UID + Template / Overall Score (Frontend Development, DSA 2.0, DSA (discontinued), Backend Development, SE Fundamentals) | Interview detail per competency (ratings, remarks, recording links) |
| 3 — old process | The tab with Bucket + overall_candidate_score ("Offline Attended - Old Process") | Bucket A–D, section scores, college, YOG |

Nothing is written to the sheets (`actions/academy.ts` uses the read-only Sheets scope).

**Reading sheet 1.** The header row is found, not assumed — the master tab has a group row above it.
Repeated headers get the group above them ("Frontend · Overall Score (out of 100)") or the TR round
before them ("Bucket A TR 1 · TR1 recording"). Competency blocks are found by their "<Name> Levels"
column, so a new competency (e.g. "GenAI Levels") is picked up without code changes.

**Joins.** Sheet 2 by UID, then email; a candidate with several interviews in one tab gets the latest
completed one, and the attempts are listed. Sheet 3 by UID, then mobile (last 10 digits), then email.
Columns that repeat sheet 1 (name, email, mobile, UID, level, verdict, clearance) only fill sheet 1's
blanks; the card rubric text in sheet 2 is dropped because its rating column carries the same value.

## Who is bucketed

- **Eligible** (any one): a competency at **L3 / L4**, **DSA Offline cleared** (or a score ≥ 50), or old
  process **Bucket A**.
- **Active Pool = Yes** only.
- **P1** = Active · not placed, **P2** = Active · placed (switch: *Bucket already-placed candidates*).

## Signals (each switchable)

Each signal scores the four buckets 0-100; the final score is, per bucket, their weighted average
(default weights 45 / 25 / 20 / 10) by how much each signal can speak for that bucket: a competency
interview counts fully for its own stack and at half weight for the others (a Frontend interview says
little about AI-ML); GitHub counts at half weight for a stack the candidate has no repo of (not every
project is on GitHub). Signals a candidate doesn't have are left out.

| Signal | How it scores |
|---|---|
| **Resume** | One model read lists every project / internship / job with its technologies, depth and a quote. The program checks each against the resume text and decides the stack from the technologies (UI only → Frontend, server / database only → Backend, both → Full Stack, ML / GenAI → AI-ML); the model's reading counts only when the technologies don't decide. Points = 25 × kind (job 1.6, internship 1.3, freelance 1.2, project 1) × depth (production 1.25, substantial 1, basic 0.5). A Full Stack item also counts half to Frontend and Backend; separate frontend + backend work counts toward Full Stack. The Skills list adds up to 12 per stack. |
| **GitHub** | The deep code inspection (manifests, imports, config), reused for 24 h. Each repo is classified the same way by what its code proves (here "REST APIs" counts as backend — the code shows the server); 30 points per repo — practice / assignment repos 0.3, the academy's course projects (NxtTrendz, NxtWatch …) 0.5, repos with AI-written commits half. |
| **Competency TR** | Frontend / Backend levels from sheet 1: L4 100 · L3 80 · L2 55 · L1 35 · Below 15. A single frontend or backend interview counts 0.8 toward Full Stack (it proves most of what full-stack work needs). DSA and SE Fundamentals name no stack. |
| **Student preference** | The roles / stacks named in the Student Preference note, in order (100, 80, 65, 50); location, CTC, bond and joining parts are ignored, a Skills list counts half. |
| **DSA profiles** | LeetCode / Codeforces / CodeChef via the resume links. Ranking only — never moves a candidate between buckets. |

Raw points become a score with diminishing returns: `100 × (1 − e^(−points / 50))`
(25 → 39, 50 → 63, 100 → 86, 200 → 98), so more evidence keeps counting but never runs off.

## Choosing the bucket

1. The highest bucket wins.
2. **Mixed** when the runner-up is within **10 points** (adjustable) and both are at least **50**
   (adjustable). Mixed rows list the near-equal stacks with their scores and carry the tag
   **"Verify over call on priority"**.
3. Frontend / Backend / Full Stack close together count as one direction, **Full Stack** (it covers
   both halves): alone they make the candidate Full Stack; beside a close AI-ML they make
   Mixed (Full Stack + AI-ML). Switch *Frontend and Backend close together = Full Stack* off to keep
   them separate.
4. No signal at all → **Needs evidence**. A read that failed for a passing reason (rate limit,
   timeout) → Needs evidence with the bucket the other signals suggest, until it is re-run. A resume
   that can't be read at all (not shared with the service account, deleted, not a resume) is treated
   like no resume: bucketed from competency + preference and tagged.

Other tags: *No resume — verify over call* (bucketed from competency + preference), *Resume can't be
read (not shared with the service account) — verify over call*, *Resume link is not a resume — verify
over call*, *Low confidence — verify over call*.

A resume link that is a **Drive folder** is opened and the resume inside it is read (a file named like
a resume first, documents before images, the newest).

## Rebalancing: Full Stack → Backend (temporary)

The academy's work is React-heavy, so most web candidates score Full Stack and Backend stays small. The
nudge (on by default, switchable, clearly tagged) moves Full Stack candidates whose **own work is mostly
backend** into Backend:

- **Backend share** = the backend part of their frontend + backend work. Backend-only projects,
  internships, jobs and repos count fully; full-stack ones by the side the resume says they worked on
  more (backend 75%, frontend 25%, balanced 50% — the resume reader reports this per item), or, for a
  repo, by its technologies per layer (UI + styling vs server + data + API, so a MERN app is 50/50).
  Skills lists and interviews don't count. At least one project's worth of web work is needed.
- A candidate moves when the share is at least **50%** and their Backend score at least **50**
  (both adjustable), most backend-leaning first, at most **half the Full Stack − Backend gap** (or a
  number you set), so Backend never overtakes Full Stack. Low-trust candidates are never moved.
- A moved candidate is ranked in Backend with their Backend score as fit, tagged
  "Nudged from Full Stack (N% backend work) — verify over call", and "Tech Stack Based" says
  "Backend (nudged from Full Stack)". Switching the nudge off puts everyone back instantly.

## Trust agent

A second model (leading with a different Gemini model than the resume reader, so no model checks its
own reading) reviews whether the profile can be trusted. It gets the resume and an evidence block: the
sheet's name, the program's identity check, the competency levels, the interviewers' integrity scores and
notes from sheet 2, what the GitHub code proves, the coding-profile numbers and how the resume was read.
It reports doubts only — each with the exact words it rests on — in eight kinds: identity, inflated
claim, timeline, course project passed off as original, contradiction with other evidence, copied text,
GitHub authorship, interview integrity. A lack of proof is not a doubt.

The program then scores trust (0-100, in the browser, so the rules can change without re-reading):

| Check | Points |
|---|---|
| Resume carries the sheet's email or mobile | 0 (identity proven) |
| Resume name differs and neither email nor mobile is on it — may be someone else's resume | −55 (Low on its own) |
| Name matches but email and mobile differ | −3 |
| Agent flag — high / medium / low | −15 / −8 / −3; a further flag of the same kind −2; all flags at most −40 |
| AI-written commits on GitHub (when the agent didn't flag it) | −6 per repo, at most −12 |
| Interview integrity below 3/5 / below 4/5 | −15 / −8 |
| An interviewer's note like "reading from somewhere", camera off, outside help | −12 |
| Frontend interview Below L1 / L1 but 2+ substantial frontend / full-stack items | −8 |

Flags whose words aren't in the resume or the evidence are dropped; flags that only point at something
missing ("interviews: none"), flags whose own reasoning refutes them, a no-show called an integrity
issue, and "solved N+" disputes the linked profiles meet are set aside. Bands: **High ≥ 80, Medium ≥ 60,
Low** below; **Unverified** when there is no resume reading.

What trust changes: below **60** (adjustable) the resume and GitHub count at half weight, the candidate is
tagged "Low trust (N/100) — verify over call", confidence becomes Low and they are never nudged. Medium
trust caps confidence at Medium. The priority score is multiplied by 0.6 + 0.4 × trust / 100.

**Confidence** — High: the resume plus at least one more signal agree and the lead is ≥ 15. Medium: the
resume leads by ≥ 8, or two signals agree. Low: otherwise.

## Ranking inside a bucket

P1 before P2, then the **priority score** = weighted average of stack fit (45), the best internal
assessment (35) and DSA (20), then the old bucket (A > B > C > D).

- **Stack fit** is the bucket's score × (0.5 + 0.5 × evidence coverage), where coverage is the share of
  the switched-on evidence that speaks for that bucket — so a candidate placed only from the preference
  note (coverage 10%) ranks below one backed by the resume, GitHub and an interview.

- **Assessment** — the best of: a competency interview's overall score; DSA Offline cleared (70); the
  old bucket (A 70 · B 45 · C 30 · D 15) moved by its TR rounds (Strong Hire +20, Medium +10,
  Shortlisted / Cleared +10, Not Cleared −5, Rejected −20).
- **DSA** — the best of: coding profiles, the DSA interview, DSA Offline cleared (60), the old coding
  exam (score / 120).

## Outputs

**Excel workbook** — Summary, Frontend, Backend, AI-ML, Full Stack, Mixed, Needs evidence, All candidates
— and a **CSV** per tab. Every tab has the same columns:

1. The decision: rank in bucket, bucket, Mixed tech stacks, nudged from, tag, priority, confidence,
   priority score, fit, the four bucket scores, why, signals used, trust score / band / checks / summary,
   identity check, backend share of their own web work, eligible via, assessment / DSA with their basis.
2. The evidence: resume items by stack, skills, profile and remarks; GitHub repos by stack and proven
   technologies; LeetCode / Codeforces / CodeChef; how the preference was read.
3. Every column of the three sheets once (empty-for-everyone columns dropped, except the ones the team
   fills: Psm Mentor, Tech Stack Based, Priority Tag). **Tech Stack Based** is filled with the bucket.

## Runs, re-runs and caching

- A run is saved in the browser (IndexedDB): settings, the sheets as read, and each candidate's reading.
- **Reload sheets** re-reads all three sheets; readings are kept, and only candidates whose resume link
  changed (or who newly entered scope) are read again.
- Changing a rule or a switch re-buckets instantly. Switching GitHub / DSA on later offers a re-read of
  just those candidates.
- Resume readings are cached for 24 h per file content (`.cache/github-inspect/`, same TTL setting as
  the GitHub cache), so a re-run doesn't spend model quota again.

## Files

| File | Role |
|---|---|
| `lib/academy/types.ts` | Types, buckets, default rules |
| `lib/academy/parse.ts` | Header detection, column naming, joins, eligibility (pure) |
| `lib/academy/scoring.ts` | Stack classification, signals, Mixed rule, ranking (pure, browser) |
| `lib/academy/evaluator.ts` | One candidate: resume read + checks, identity check, GitHub, DSA (server) |
| `lib/academy/trust-agent.ts` | The trust agent: evidence block, model call, grounding of its flags (server) |
| `lib/academy/export.ts`, `xlsx.ts` | CSV / workbook columns; dependency-free .xlsx writer |
| `lib/academy/store.ts` | IndexedDB runs, sheets, results |
| `actions/academy.ts` | Read-only sheet reading |
| `app/api/academy/evaluate/route.ts` | The per-candidate route |
| `components/academy/*` | Setup, results, rules |
| `scripts/academy-selftest.ts` | Offline checks |

## Known limits

- Eligibility and competency levels come from sheet 1 only, as asked; a level recorded in sheet 2 but
  not yet copied to sheet 1 doesn't count until sheet 1 is updated.
- Student preference is free text read with keyword rules; it is the lightest signal for that reason.
- Mobile-only, testing, DevOps and embedded work has no bucket of its own and counts as "Other".
