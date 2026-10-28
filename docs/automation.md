# Sheet-triggered shortlisting automation

Type `start` in a row of the coordination sheet and the app runs the whole Domain shortlisting for that row on its own:

1. It reads the candidate tabs the row names.
2. It screens every resume, matching each candidate to the internal assessments.
3. It checks GitHub and DSA as asked.
4. It validates the result.
5. It writes the shortlist to a `psm_final_shortlisted_<date>` tab.

Nobody has to open the app.

## What you add to the sheet

The coordination sheet is "Edge Team PC || PSM Task Coordination", tab **Profile Shortlisting - New**. The setup script adds four columns at the end of the header row:

| Column | Who fills it | What it holds |
|---|---|---|
| **Screening Instructions** | You | What to screen, in plain text (format below) |
| **Trigger** | You | `start` runs the row. Any other value does nothing. |
| **Automation Status** | The app | `PENDING`, `PROCESSING`, `COMPLETED`, `AWAITING_REVIEW` or `FAILED` |
| **Automation Details** | The app | Progress, then the result or the reason it failed, and the job id |

The app also reads two columns that every row already has:
- **Internal Sheets**: the link to the candidates' spreadsheet.
- **No. of Profiles Required**: how many to shortlist.

No other column is read or changed.

### Screening Instructions

Put one item per line. Labels are optional; the app recognises the items either way.

```
Subsheets: Edge Applied, Academy Applied
Focus: Flutter developers who built and shipped mobile apps with Flutter / Dart; Firebase or REST APIs a must
GitHub: (domain-fit candidates)
DSA: yes
```

| Item | How to write it | If you leave it out |
|---|---|---|
| **Subsheets** | Tab names in the Internal Sheets spreadsheet, separated by commas. Case and spaces don't matter. Quote a name that contains a comma: `'Batch 2, late'`. | Required |
| **Focus** | What a good candidate looks like for this company, in your own words. The model turns it into the domain brief and the must-have skills, keeping only must-haves that your text actually states. | Required |
| **GitHub** | `(domain-fit candidates)` inspects only candidates whose resume fits. `(all candidates)` inspects everyone with a GitHub link. `no` skips GitHub. Add `no review` to skip the code review of the top projects. | Domain-fit candidates, with code review |
| **DSA** | `yes`, `no`, or minimums such as `CF 1400 or CC 1600, 300 solved, 10 contests, DSA score 50` | Off |
| **Top** | `Top: 10` | The row's No. of Profiles Required; if that is blank, everyone who clears every requirement |
| **Sheet** | `Sheet: <link>`, to use another spreadsheet instead of the row's Internal Sheets | The row's Internal Sheets link |

The one-line form also works:

```
Edge Applied, Academy Applied -> MERN developers with deployed full-stack apps -> GitHub (all candidates) -> DSA: yes
```

**Internal assessments are always included.** Every candidate is matched to the eligible pool (Edge 2.0, Edge 1.0, Academy) by phone number first, then user id. Their stage, scores and verdicts come from there, and assessed candidates are ranked first. Nothing about them needs to go in the instructions. A candidate who isn't in the pool counts as external, never as having passed.

### Running it

- **To start:** type `start` in the row's Trigger cell. The status goes to `PENDING`, then `PROCESSING` with progress, then the result.
- **To run the row again later:** type `start` again. If the earlier run `FAILED` and the instructions haven't changed, it continues where it stopped, without screening everyone again.
- **While a row is running,** another `start` on it is ignored.
- **Several rows at once** work: they queue and run one after another.

### What you get

The shortlist goes to the candidates' spreadsheet, in a tab named **`psm_final_shortlisted_<YYYY-MM-DD>`**. The date is the day the job started, in India time.

- The tab is created if it doesn't exist.
- Jobs on the same day add their rows below the rows already there. Existing rows are never changed or removed, and a retried delivery never writes the same rows twice.
- Each row starts with four columns:
  - **Job ID**;
  - **Delivered At**;
  - **Source Tab**;
  - **Review Flags**.
- The rest are Domain shortlisting's columns: rank, domain score, resume core skills, internal standing / stage / product, GitHub and DSA (when screened), and Signals.

| Final status | Meaning |
|---|---|
| `COMPLETED` | Delivered, and nothing needs a second look |
| `AWAITING_REVIEW` | Delivered, but something needs a look; Automation Details says what. Possible reasons:<br>• a shortlisted candidate has a review flag (borderline fit, score lowered for missing evidence, GitHub account not theirs, a must-have not proven in their code, high AI-commit signal);<br>• some resumes couldn't be screened;<br>• fewer candidates than requested cleared every requirement;<br>• the model couldn't draft the criteria. |
| `FAILED` | Nothing was delivered. Automation Details says why and what to change, for example a wrong tab name or a sheet that isn't shared. |

## One-time setup in the Google Sheet

Someone with edit access to the coordination sheet does this once.

1. **Share the sheets with the app.** The service account is `<the GCP_SERVICE_ACCOUNT_CLIENT_EMAIL in .env.local>`.
   - It needs **Editor** access on the coordination sheet, to write status.
   - It also needs Editor access on each company's Internal Sheets spreadsheet, to write the shortlist tab. It already has this on most of them. A sheet it can only read fails at delivery with a message saying so.
2. **Open Extensions → Apps Script.** Replace the contents of `Code.gs` with [`integrations/google-sheets/psm-automation.gs`](../integrations/google-sheets/psm-automation.gs), then save.
3. **Add two script properties** under Project Settings (gear icon) → Script properties:
   - `APP_URL`: `https://psm-placements.onrender.com`
   - `AUTOMATION_TOKEN`: the value of `AUTOMATION_TOKEN` in `.env.local` (the same value is set on Render).
4. **Run `setup` once.** In the editor, pick `setup` and click Run, then allow the permissions it asks for: the spreadsheet, external requests, and triggers. It does four things:
   - adds the four columns;
   - adds a `start` drop-down to Trigger;
   - installs an on-edit trigger and a 5-minute check;
   - wakes the app.
5. **Try it on one row:** fill in Screening Instructions, then type `start`.

The script never sends candidate data. It sends only the row number and a request id; the app reads the row itself. The token lives in Script properties, not in the code. People who can edit the coordination sheet can see Script properties, so treat the token like a password. To rotate it, change it on Render and in Script properties.

## How it works

```
Sheet: "start" ──onEdit──▶ Apps Script ──wake /api/health──▶ Render (may be asleep)
                              │ POST /api/automation/jobs {row, requestId}   (Bearer token)
                              ▼
                         Postgres: automation.jobs (PENDING) ◀── idempotent per requestId
                              │
              worker (in the app, one job at a time, lease + heartbeat)
   ┌──────────┬───────────┬────────────┬────────────┬───────────┐
 Planner   Screening   Evaluation   Validation    Delivery
 tabs, focus resumes →  GitHub +     rank, flags,  psm_final_shortlisted_<date>
 → criteria  domain fit code review  verdict       + status on the row
 (checkpoint: plan) (per-candidate checkpoints)    (Job ID → no duplicates)
```

**Agents.** Each step is a separate module in `src/lib/automation/`:

| Agent | Module | What it does |
|---|---|---|
| Planner | `planner.ts` | Reads the instructions without a model (`instructions.ts`), checks the tabs and their columns, and drafts the criteria with Domain shortlisting's JD autofill |
| Screening | `screening.ts` | Reads the rows once, merges duplicates, matches internal assessments, and screens each resume |
| Evaluation | `evaluation.ts` | GitHub inspection in the requested scope, paced by GitHub's hourly limit, plus the code review of the strongest candidates |
| Validation | `validation.ts`, `delivery.ts` | Ranks with the same report builder as the screen, then applies deterministic review flags and the verdict |
| Delivery | `delivery.ts` | Writes the tab by column name and updates the row |

The **orchestrator** (`orchestrator.ts`) runs the agents in order and decides retries and the final status; agents never set the status themselves. The same scoring code as the Domain shortlisting screen does the work, so a job and a manual run judge candidates the same way.

**Reliability.**
- **Durable jobs.** A job is a database row with a step checkpoint and per-candidate checkpoints. After a restart, deploy or crash, the worker takes it up again: when its 3-minute lease expires, on server start, or when someone checks on it. Finished candidates are never screened again.
- **Idempotency.**
  - The same request id always maps to the same job.
  - Each row can have only one active job.
  - Delivery checks the Job ID column before writing.
- **Retries:**
  - Passing failures are retried, from network errors, rate limits and Google / database hiccups up to a model or GitHub outage.
  - Each resume gets up to 5 tries over about 45 minutes, while the job carries on with the others.
  - A whole job gets up to 8 takes with growing pauses (1, 2, 4 … 30 minutes).
  - Problems you must fix (a wrong tab name, a sheet not shared) fail at once with the reason.
- **Time limits:**
  - 3 minutes per resume.
  - Retries stop 12 hours after the job started; whatever is still unscreened is reported.
- **Render sleeping.**
  - The Apps Script wakes the app before sending, waiting up to 4 minutes. If the app doesn't answer in time, the row stays `PENDING` and the 5-minute check sends it later.
  - While a job runs, the app keeps itself awake.
  - The 5-minute check also asks after running jobs, which restarts an interrupted one and catches up a status whose write was lost.
- **Status writes never stop a job.** The row is found by its job id, so moved rows are fine.

**Tested** on throwaway copies (a local database and two temporary sheets):
- invalid trigger values;
- repeated and concurrent triggers;
- two jobs queued;
- both GitHub scopes;
- DSA on and off;
- internal assessments;
- duplicate people across tabs;
- resumes that aren't shared;
- a server killed mid-screening, which resumed without redoing work;
- a database outage of 75 s;
- a crash after delivery, which caused no duplicate rows;
- a wrong tab name;
- re-running a failed row, which resumed.

The self-tests are `scripts/automation-selftest.ts` (instructions, columns, flags, delivery rules, status text) and `scripts/apps-script-selftest.ts` (the real `.gs` file against a simulated sheet).

## Operations

| Task | How |
|---|---|
| See a job | `GET /api/automation/jobs/<id>?events=1` with `Authorization: Bearer <AUTOMATION_TOKEN>`. Returns status, step, progress, result and the event log. |
| Recent jobs | `GET /api/automation/jobs?limit=20` |
| Database | Schema `automation`: `jobs`, `job_requests`, `job_events`, `job_candidates`. Checkpoints of jobs finished more than 30 days ago are pruned; the jobs and their events stay. |
| Turn the worker off | Set `AUTOMATION_WORKER` to anything but `on`. Jobs wait as `PENDING` until it is on again. |
| Speed | `AUTOMATION_CONCURRENCY` (default 4) sets how many resumes are screened at once. Keep it at 3–4 on the free plan's 512 MB. |

Server settings (Render → Environment):

| Variable | Value |
|---|---|
| `AUTOMATION_TOKEN` | A long random secret, shared with the Apps Script |
| `AUTOMATION_WORKER` | `on` |
| `AUTOMATION_SPREADSHEET_IDS` | The coordination sheet's id. Requests from any other sheet are refused. |
| `AUTOMATION_CONTROL_TABS` | Optional; defaults to `Profile Shortlisting - New` |
| `AUTOMATION_CONCURRENCY` | Optional; defaults to 4 |

## Troubleshooting

| Automation Details says | Do this |
|---|---|
| `Tab "X" not found (did you mean "Y"?)` | Fix the name in Subsheets, then type start. |
| `The candidates' sheet can't be opened — share it with …` | Share it with the service account as Editor, then type start. |
| `Can't write to "…" — give … edit access` | Give edit access, then type start. Screening is kept: the job continues at delivery. |
| `GitHub inspection can't run: …` | Renew `GITHUB_TOKEN` on Render, or write `GitHub: no`. |
| Stays `PENDING` "Waiting for the app to wake up" | The app is starting or down. The 5-minute check retries. If it never moves, open `/api/health`, then check Render. |
| `PROCESSING` "retrying after an error" | A passing problem, such as a rate limit or a Google hiccup. It continues on its own. |
