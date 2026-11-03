# Assessment marks

The final score of every Academy exam and interview, with its **verdict, date and recording link**. They are kept in the database so the **Standing lookup** can show marks in columns of their own: a column *DSA offline exam (130)* holds only the marks obtained, for example `57`. The database also keeps each person's **year of graduation and college**, so you can pull everyone from a college or a batch.

Rules:

- **Only one final score per assessment** is stored: `overall_candidate_score`, `Total (/15)`, `Overall Score (out of 100)` and so on. Section scores (coding, MCQs, the rating cards) are never stored.
- **Everyone the Academy assessed keeps their marks**: about 3,300 people.
- **Job eligibility is a tag on each of them**:
  - **Eligible** means in the eligible pool (an Academy, Edge 2.0 or Edge 1.0 record) with an eligible standing (tier 1–3). These are the people who can be put forward for job opportunities: about 420 (the Academy pool's ~414, plus a few in the pool through Edge).
  - **Not eligible** means assessed but not in the eligible pool.
  - The tag is derived from the eligible pool, never stored, so it changes as soon as the pool is refetched. Someone added to the Academy pool sheet becomes Eligible on the next refetch, with all their marks already there.

## Job eligibility

| Where | What you see |
|---|---|
| Standing lookup | A **Job Eligibility** column on every row (*Eligible* / *Not eligible*; empty for someone unknown). People assessed outside the pool read *Assessed · not in the eligible pool*. |
| Standing lookup › Find | **Job eligibility:** Everyone / Eligible / Not eligible, alone or with college, year and minimum marks |
| Assessment marks panel | *Eligible for jobs* and *Not eligible* counts, and an *Eligible* column per assessment |
| Import results | *"people 314 (eligible 69)"* for each export |
| Database | The view `placement.assessed_people`: one row per person, with `eligible` (true / false) and `job_eligibility` ('Eligible' / 'Not eligible') |

The rule is written once, in the view (migration 005). The lookup applies the same rule to each standing (`isAssessed`: eligible and tier 1–3).

## What is stored

| Assessment | Out of | Comes from | Final-score column | Verdict kept with it | Recording |
|---|---|---|---|---|---|
| Old offline assessment | 230 | "Post Assessment eligible students for Placement Pool" › *Offline Attended - Old Process* (sheet or CSV) | `overall_candidate_score` | Bucket A–D, cycle | — |
| DSA offline exam | 130 | "Competency Assessments Results - <date> DSA offline" CSVs | `overall_candidate_score` (older exports: `Overall Score`) | Qualified / Not Qualified | — |
| Frontend offline exam | 115 | "… - <date> FE / Frontend offline" CSVs | `overall_candidate_score` | Qualified / Not Qualified | — |
| Backend offline exam | 95 | "… - <date> BE / Backend offline" CSVs | `overall_candidate_score` | Qualified / Not Qualified | — |
| Software Engineering offline exam | 215 | "… - <date> SE / Software offline" CSVs | `overall_candidate_score` | Qualified / Not Qualified | — |
| DSA, Frontend, Backend and Software Engineering competency interviews | 100 | "Post Offline Competency Interview Evaluation" › *DSA 2.0 (current)*, *DSA (discontinued)*, *Frontend Development*, *Backend Development*, *SE Fundamentals* (sheet or CSV) | `Overall Score (out of 100)` | Level · verdict band · clearance (*L3 · Medium Hire · Cleared*) | `Recording Link` |
| Bucket A TR-1 | 100 | "Academy Interviews - Bucket A - External Panelist's - Round 1 - Scheduled Interviews" CSV | `Total Score (out of 100)` | None in this sheet. The lookup shows the Academy pool sheet's TR-1 status. | `Interview Recording Link` |
| Bucket A TR-2 | 100 | "… - Round 2 - Scheduled Interviews" CSV | `Overall Score` | Pool eligibility, then the panel's verdict per bucket (*Shortlisted · Frontend Medium Hire · Backend Low Hire · Full Stack Low Hire*) | `Recording Link` |
| Bucket B TR-1 | 15 | "Academy Bucket B - … - TR 1 - Interview Audit & Evaluation" and "… - TR1 - Conducted in app" CSVs | `Total (/15)` · `Final Score ( 15 points)` | Performance band · clearance status (in the app: overall recommendation · clearance status) | `Interview Recording Link` · `Recording Link` |
| Bucket B TR-2 | 10 | "… - TR 2 - Interview Audit & Evaluation" and "… - TR-2 Conducting in App" CSVs | `Total (/10)` · `Final Score (10)` | Performance band · final status (in the app: overall recommendation · clearance status) | `Interview Recording Link` · `Recording Link` |

Notes on the table:

- **Maximum.** The sheet's own (`overall_total_score`) when it has one, else the value above.
- **Recordings.** Only real links (http / https) are kept. A note such as *"Event not found in Calendar"* means there is no recording.
- **Profiles.** Year of graduation, college, degree and department.
  - Sources: the old offline assessment roster (the main source), the Bucket B audit sheets (`College Combined`, `Bach. Degree`, `Bach. Department`), and the exam exports' `YOG`.
  - The roster may overwrite a value; the other sheets only fill a gap.
  - For people in the Academy pool sheet, its YOG is used when nothing else has one.
- **Bucket C TR-1** has no marks export. Its score and status come from the Academy pool sheet, which states no maximum, so its lookup header carries no "(max)".

### Only real results

A row is stored only when it has a valid candidate id **and** a final score. These rows are counted as *skipped* instead:

- not attempted;
- cancelled, rescheduled or a no-show;
- an interview marked completed without a score;
- a `test` row.

**A person is added to the database only for a score.** Someone who only registered for an exam is never added.

**Repeat attempts are kept separately.** Examples: an exam taken on 27 Sep and again on 25 Oct, or a re-interview. The lookup shows the best, the latest or all of them.

**The same interview logged in two sheets counts once.** That is the audit sheet and the in-app one, with the same date and score. If one copy has a recording or verdict the other lacks, the lookup uses it.

## Importing

**On the Eligible pool screen, in the *Assessment marks* panel:**

- **Choose CSVs.** You can pick several files at once.
  - Each file is recognised from its headers and previewed before anything is sent, for example *"DSA offline exam · 25 Oct 2026 — 143 final scores of 259 rows · 116 without one (not attempted)"*. Interview files also show how many recordings they hold.
  - A file that isn't an assessment export is flagged and not sent.
  - If an offline exam's date is in neither the file nor its name, you are asked for it.
- **Import.** The files go one after another. Each shows what changed (new, updated, unchanged, removed), how many people the export has and how many of them are eligible, and how many people were added.
- **Refetch from Google Sheets.** The tabs the service account can read (the old offline roster and the five competency-interview tabs) refetch without a CSV.
- **Import history** lists the last 20 imports.
- **The panel's figures:**
  - people with marks;
  - eligible for jobs (of them in the Academy pool, the rest through Edge), and not eligible;
  - per assessment: people, eligible, scores, recordings and exports.

**From the command line:**

```bash
npm run scores:import -- "Competency Assessments Results - 25th Oct SE Offline.csv" "…TR 1 - Interview Audit & Evaluation.csv"
npm run scores:import -- --sheets            # refetch every readable tab
npm run scores:import -- --dry-run *.csv     # only say what each file is and what it holds
```

Options:
- `--date=YYYY-MM-DD` sets the exam date for a file without one.
- `--allow-shrink` is explained in the list below.

**What a re-import does:**

- **Each file is one export**, for example "DSA offline exam of 25 Oct" or "Bucket B TR-1 audit sheet".
  - Importing it again replaces exactly that export's scores: new rows are added, changed ones updated, and rows no longer in it removed.
  - Unchanged rows aren't written at all. The same file twice changes nothing.
  - A changed verdict or recording counts as an update.
- **Safety:** an export that would remove more than a fifth of what is stored for it stops and asks first, for example a half-downloaded file. On the screen, click *Replace anyway*. On the command line, pass `--allow-shrink`.
- **People:**
  - A person new to the database is added for a real score, with their phone and name when the sheet has them.
  - A known person's missing phone or name is filled in; their existing phone and name are never overwritten (the product sheets stay the source for both).
  - A phone number already used by someone else is never taken over; the import lists it as an issue.
- Imports and the eligible-pool syncs take the same lock, so they never interleave.

## Adding a new kind of sheet

Each kind of export is one entry of `SOURCES` in `src/lib/pool/scores/parse.ts`. An entry says:

- how to recognise the sheet: the key column, and the columns that must be present;
- which column is the final score, and the maximum, verdict and recording columns;
- the status column, if any, with the value that means "assessed";
- how attempts are told apart: one per person, per date, or per cycle;
- where the name, phone and profile fields are.

A new assessment also needs:

- A line in `ASSESSMENTS` in `catalogue.ts`, which gives its label and maximum.
- An item in `MARK_ITEMS` in `src/lib/pool/lookup.ts`, which gives its chip and columns in the lookup.
- A case in `scripts/scores-selftest.ts` with the sheet's real header shape.

## Database

Migrations `004_assessment_scores.sql` and `005_recordings_and_eligibility.sql`, schema `placement`:

| Table | One row per | Holds |
|---|---|---|
| `assessments` | assessment | Label, product, usual maximum (the app's catalogue, upserted on every import) |
| `assessment_scores` | person × export × attempt | Score, maximum, date, the sheet's verdict, passed (true / false / null), recording link, row hash |
| `candidate_profiles` | person | Year of graduation, college, degree, department, source rank |
| `score_imports` | import | Export, sheet or CSV, status, counts (read / new / updated / unchanged / removed / skipped / people added), the first 200 row issues, error |
| `assessed_people` (view) | person the assessments know | Identity, `eligible` / `job_eligibility`, their pool standing and product, whether they are in the Academy pool, year / college / degree, how many scores and assessments, the last date assessed |

**Keys.** The export is the `source_key`, for example `dsa_offline@2026-10-25`, `bucket_b_tr1:audit` or `dsa_interview:v2`. The primary key of `assessment_scores` is (candidate id, source key, attempt).

**Indexes:** none beyond the primary keys.
- The lookup reads scores by candidate id, which leads the primary key.
- An import reads its own export's rows, and the college / year filter scans the profiles. At a few thousand rows both take about a millisecond, so another index would only slow the writes.

**People assessed outside the pool.** They are rows in `placement.candidates` (the same phone / user-id rules apply), with no product record, so no standing. The eligible pool's counts and Domain shortlisting don't change. Deleting a person removes their marks and profile with them.

**The view** reads the `candidate_standing` materialized view: a migration that drops `candidate_standing` must drop and recreate `assessed_people` too. It runs with the caller's rights (`security_invoker`), and the schema stays closed to Supabase's anon / authenticated roles.

## For developers

| What | Where |
|---|---|
| Catalogue and shared types | `src/lib/pool/scores/catalogue.ts` |
| Reading every export (pure, also runs in the browser) | `src/lib/pool/scores/parse.ts` |
| Readable Google Sheets tabs | `src/lib/pool/scores/sources.ts` (override with `SCORES_INTERVIEWS_SHEET`, `SCORES_OLD_OFFLINE_SHEET`) |
| Import (transaction, people, replace per export, shrink guard, profiles, eligible count) | `src/lib/pool/scores/sync.ts` |
| Reads (people assessed outside the pool, scores, profiles, the filter, the summary) | `src/lib/pool/scores/queries.ts` |
| API | `GET /api/pool/scores` · `POST /api/pool/scores/upload` · `POST /api/pool/scores/sync` · `POST /api/pool/find` · `POST /api/pool/lookup` with `include: ["scores", "profile"]` |
| Screen | `src/components/pool/assessment-scores.tsx` (Eligible pool) |
| CLI | `scripts/scores-import.ts` |
| Self-test | `npx tsx scripts/scores-selftest.ts`. Add `SCORES_TEST_DATABASE_URL` pointing at an empty local database to also test the import itself. |
