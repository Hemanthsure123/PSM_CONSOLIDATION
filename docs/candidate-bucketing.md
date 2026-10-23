# Candidate Bucketing — how to use it

Candidate Bucketing puts each candidate in **one of six buckets**, which are also the six TR-2 tracks:

1. MERN Stack
2. Python Full Stack
3. Java Full Stack
4. Generative AI
5. DS / ML
6. Data Analytics

When a candidate can't be bucketed, it gives the reason. Every result comes with:
- an overall score
- an internal-assessment score
- a trust score
- the candidate's tag, for example "MERN TR-2 · Strong hire", "Combined interview · Medium hire", "TR-1 cleared" or "Assessment cleared"

## Priority

**Signals count in this order:**
1. Our internal assessments: the TR-2 verdicts, the TR-1 scores and the assessment.
2. Projects verified end to end on GitHub. A live demo is a bonus, never required. For DS / ML and Generative AI, GitHub is optional, because that work mostly lives in Jupyter notebooks; a notebook on GitHub is still a bonus.
3. Experience.
4. Achievements: hackathons, ranks, publications, merged open-source work, competitive programming. These are good to have.

**Ranking inside every bucket** (and in the *Not bucketed* list):
1. TR-2 strong hire
2. TR-2 medium hire
3. TR-2 low hire
4. TR-1 cleared
5. Assessment cleared

Inside each tier, candidates are ordered by the overall score, then by trust. Processing follows the same order, so TR-2 strong hires run first.

## In the dashboard

1. Open **Dashboard → Candidate Bucketing**.
2. **Load the interview export.** Either upload `candidates_all-colleges_….csv`, or copy its rows from the sheet **together with the header row** and paste them.
   - Columns are found by their names, so their order never matters, and extra columns are ignored.
   - Before anything runs, the screen shows which column groups were found, for example "TR-2 verdicts 7/7" or "TR-1 (DSA interview) 11/11". A missing column is read as empty. A file that isn't the export is refused with a clear message.

   | Columns | What they give |
   |---|---|
   | `phone` | The candidate's key: the resume sheet and newer exports are matched on it |
   | `id`, `name`, `email`, `college` | Identity, carried into the CSV exports. The models never see it. |
   | `TR2 <track> Verdict` (data analytics, ds&ml, gen ai, java fullstack, mern fullstack, product, python fullstack) | TR-2 verdicts. A strong, medium or low hire means the candidate cleared the assessment, TR-1 and TR-2. |
   | `TR2 <track> State` | *assigned* means a TR-2 is booked but not taken yet. It is shown as "TR-2 pending: …". |
   | `combinedInterviewVerdict` / `State`, `interviewPath` | The combined-interview path. A hire counts as TR-2 with no track; *pending* means not taken yet. |
   | `dsaInterviewQualifyingStatus` | The DSA interview, which is the TR-1 round. *Shortlisted* means TR-1 cleared, even when `tr1Status` is blank. |
   | `tr1Status`, the seven `tr1…` ratings and scores, `dsaInterviewDsaScore` / `dsaInterviewCsScore` | TR-1 scores. The DSA-interview scores stand in when the TR-1 AI-interview scores are missing. |
   | `offlineOverallScore` (/160), `dsaCodingScore` (/120), `csFundamentalsScore` (/40), `sqlMcqScore` / `sqlCodingScore` (/15 each) | The assessment |
   | `currentStage`, `journeyStatus` / `Reason` / `Notes` | Where the candidate is in the drive. A **closed journey** (not responding, placed) is listed as *Not bucketed — journey closed*, with no checks run. |

3. **Add the resume sheet.** This is optional but needed for evidence. The export has no resume column, so the resume links come from a sheet with *Phone Number* and *Resume Link* (for example the PII sheet), matched by phone. The *Roll Number* column is never read as a phone number.
   - Without a resume, a TR-2 hire is still placed by their track (flagged *interview only*). Everyone else is listed as *No resume link*.
4. The preview shows the tier mix, the resume coverage and the closed journeys. Name the run and click **Start bucketing**.
5. The run saves as it goes. Reopen it from the dashboard to **Resume** or **Re-run** (for candidates whose evidence was unavailable).
6. **Load a newer export** into a saved run:
   - New phones join the run.
   - A change that can move the bucket (a new TR-2 hire track, a journey closed or reopened, a new resume link) runs that candidate again.
   - A change that only moves the tier, the tag or the scores (a verdict upgrade in the same track, TR-1 cleared, new scores) is re-scored from the saved evidence, with no model or GitHub calls.
   - Before you apply, the screen shows how many candidates fall into each case.
7. Downloads:
   - **All candidates (CSV)**: every candidate, led by the export's own `id, name, email, phone, college` columns so rows match back to it, then the bucket, tag, interview status, every score and flag
   - **This list (CSV)**: one bucket, or the *Not bucketed* list with its reasons
   - Cells that start with `=`, `+`, `-` or `@` (for example a project title from a resume) are prefixed with `'`, so they never run as spreadsheet formulas.

Click a row to see the evidence behind the decision:
- the internal assessments
- the projects and their GitHub repos, with the commit audit, what the code uses and the demo check
- the domain scores
- experience and achievements
- DSA
- each verifier's verdict
- the agent trace

## How the bucket is chosen

- **TR-2 hire in a track.** The candidate goes to that track's bucket.
  - If they were hired in several tracks, the best verdict wins. A tie goes to the track the resume backs.
  - If the resume doesn't show the track yet, they still go there. The row is flagged *Track not on the resume yet* (`TRACK_MISMATCH`) and marked **Needs review**.
  - If the resume can't be read, or there is no resume link, they are placed by the interview alone. The row is flagged `INTERVIEW_ONLY`, and trust is capped at 75.
- **Everyone else.** This covers combined-interview hires, Product-track hires, TR-1 and Assessment candidates. They are bucketed by a verified project or an in-domain internship or job. Achievements only raise rank.
- **Project validity.** A project with a GitHub repo counts only when the repo:
  - exists and is public;
  - has every non-merge commit by the candidate. A commit by anyone else invalidates the project, and so does a commit with an AI coding-tool signature (Claude Code, Cursor, Copilot, Codex, Devin, aider, Antigravity and others);
  - contains no AI-tool files (`CLAUDE.md`, `.cursorrules`, `.agents/rules/`, and similar).

  A clean audit means *no AI or foreign signatures were found*. It does not prove the code was written by hand, because autocomplete tools leave no trace.
- **Tiers.**
  - Tier A: verified repo with a demo that loads.
  - Tier B: verified repo.
  - Tier R: a DS / ML or GenAI project described on the resume, with no GitHub link.
  - Tier C: demo only. It counts only alongside an in-domain role.
- **Bucket rules** come from what the code proves (dependencies, imports, config), never from the resume's wording. The rules are listed on the setup screen.

## Scores

- **Internal assessment** (0-100):
  - The parts are weighted 50% best TR-2 verdict (strong 100, medium 85, low 70), 30% TR-1 technical score, and 20% assessment score.
  - If a part is missing, the weights are rescaled over the parts that are present.
  - For Data Analytics, the SQL scores join the assessment part.
- **Overall** = 40% internal assessment + 30% projects + 20% experience + 10% achievements.
- **Trust** measures how much of the decision was actually verified, and how far each verifier agreed with its agent. A model's own confidence is never used.
  - When the TR-2 track is confirmed by the resume, trust in the bucket is high.
  - When evidence is missing (GitHub rate limit, model outage), the candidate is marked *Re-run needed*, or flagged on the bucketed row in the case of a TR-2 hire. They are never rejected for it.

You can tune the weights, caps and limits in `src/lib/bucketing/config.ts`.

## Large batches from the terminal

```bash
npx tsx scripts/bucketing-run.ts "<interview export>.csv" "<output folder>" 4 --resumes="<resume sheet>.csv"
```

Options:
- `--scope=tr2`: TR-2 hires only
- `--scope=hires`: strong and medium hires only
- `--limit=N`: only the first N, in priority order
- `--mobiles=a,b,…`: only these candidates
- `--rerun=REASON,…`: re-run finished rows with these reason codes

Behaviour:
- It can be resumed. Run it again and it skips finished candidates, and re-runs *Re-run needed* rows and rows with pending evidence.
- Pointed at a newer export with the same output folder, it plans the update the same way as the dashboard: changed scores are re-scored from the saved evidence, and only a moved TR-2 track, journey or resume runs again.
- The input can be the export as `.csv`, or as tab-separated `.tsv` / `.txt`.
- When the hourly GitHub budget runs low, it pauses instead of failing candidates.
- It writes these files to the output folder:
  - `summary.md`
  - `complete.csv`
  - `bucket-*.csv` (one per bucket)
  - `not-bucketed.csv`
  - `open-in-dashboard.json`: load it with **Candidate Bucketing → Open a results file**

Checks that need no network: `npx tsx scripts/bucketing-selftest.ts`.
