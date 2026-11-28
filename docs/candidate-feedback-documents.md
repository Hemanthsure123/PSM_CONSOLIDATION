# Candidate feedback documents (PSM 1.13.0)

A one- or two-page **"Resume Rejection Analysis"** for one Academy assessed candidate and one period,
built from our records and sent to the candidate as a PDF on WhatsApp after a mentor reviews it.
The look follows the sample the team approved (A4, Calibri, black only, numbered sections, plain
tables, "What to Improve" in a box). A long period (more than 12 jobs or 9 resumes) is set a little
tighter (0.75" margins, less space between points, a 10 pt results table) so it still fits on two
pages.

## Who can do what
- Only **assigned** candidates (a name in the Academy sheet's MENTOR column).
- The assigned mentor, leads and admins build, review, open for editing and send. Everyone signed in
  can see that documents exist (the server enforces this with 403 `not_your_candidate`).

## Flow
1. **Build** (`POST /pool/{uid}/feedback-documents { from, to }`). The run takes about a minute and the
   app polls `GET /pool/feedback-runs/{runId}`. A rebuild for the same period rewrites the same Google
   Doc, keeping the same link, and sets it back to draft. At most 2 builds run at once on the server;
   the rest wait their turn.
2. **Review**. `POST …/edit-access` gives the person edit access, and they read and correct the Google
   Doc. The app shows the reviewer notes (`notes`), which are never in the document. Then
   `POST …/review` moves the document from draft to reviewed.
3. **Send**. `GET …/pdf` exports the reviewed Google Doc, edits included, as a PDF; it answers 409
   `not_reviewed` before review. The app sends the PDF on WhatsApp, straight to the candidate's chat,
   then `POST …/shared` records it. A WhatsApp send also becomes the candidate's last contact. A
   repeat from the same person within 2 minutes isn't counted again.

Review, PDF and shared take the `version` the person is looking at; if the document was rebuilt
since, they answer 409 `version_changed` and change nothing, so an unreviewed version is never sent.
One build per candidate at a time: the same period already building is returned as is, another
period answers 409 `run_in_progress`.

The Google Doc lives in the team Drive folder "Candidate feedback documents". Only the builder and
the candidate's mentor can edit it, and it is never shared by link.

## Where the facts come from
| Fact | Source |
|---|---|
| Jobs and their CRP period, tech stack, JD | CRPs master (`app.crp_requirements`); JD link from the master or the HubSpot deal |
| Applications (when, which resume) | Each requirement's **internal sheet** ("Internal sheet Link"): platform applicant exports (Job Id, User Id, Applied Datetime, Resume Link; older exports use `creation_datetime`, `user_id`, `registeredMobileNumber`) and application Google Forms → `app.job_applications` |
| Profiles shared and every company result | Company sheets (`app.company_shares`, 1.10–1.12) |
| Interview dates | EDGE drill-down tab, matched by phone and job id (or company) |
| Reasons | The November Academy review where it read the application (below), else the server's own review of each resume used: see Trust below |
| How the selected candidates compared | `app.job_comparisons`: counts per job from a reviewed analysis (nobody named) |

**The period** covers the jobs whose CRP period overlaps it (the same rule as Companies) **or whose
company ID was done in it** (Company ID Status "ID Done…" with that ID Month): "November CRP +
November ID done". A job without either is placed by its application (or share) date. When one job id
has several CRP rows (batches), the row used is the batch the candidate was sent in, or else the first
drive that ends on or after the application; rows of that same batch that disagree count as ID done
if any of them says so.

## The November Academy review (imported)
The November review (stakeholder sheets "Academy Resume Rejection Analysis – Nov 2026", the Track 1 /
Track 2 trackers, the assignment review; working folder `Downloads\academy-review-nov`) read every
application with checked resume reads. `scripts/review-import.ts --dir <folder> [--apply]` imports it:
- `app.application_reviews` (source `review-2026-11`): per candidate and job, applied / sent / the
  company's decision, the main reason, the read (must-haves met and missing, a project for the job, a
  same-field internship, links, quality issues, fit) and the assignment result. Only Academy assessed
  candidates in the pool, matched by phone (a phone shared by two people matches nobody). A re-run
  replaces that source's rows.
- `app.job_comparisons`: per job, how many the company took forward and how many of them had a
  same-field internship, links, a project for the job, every must-have; counts only.

A job with an imported row uses it: its decision where the company sheet shows no result (the
company sheet's own result always stands), its reasons, its resume, its assignment result. The
review's main reasons map onto the document's: "Meets the basics, others were stronger" → fits;
"JD skills not shown in projects or work" → core skills not used in any project; a job rule (marks,
branch, college list, year) → what the resume shows (missing must-haves, else fits), as in the
approved sample. A comparison is added to a "fits" reason only when at least 2 were taken forward and
60% or more of them had what this resume lacks ("most selected had a same-field internship").

Every other job gets the server's own review, which is also stored (source `live`) so later months
have the same per-application analysis. Comparisons for later companies come from the next reviewed
analysis (import it with another `--source`).

Internal sheets are mostly shared inside the organisation and not with the service account. A sheet
the service account can't open is read as the **team Google account**, using read-only calls, and
`internal_sheets.read_via` records which account read it. The hourly company-sheet run reads at most
60 internal sheets: first the ones never read, then the changed ones (Drive modifiedTime), then the
ones last read more than 24 h ago. The ones neither account can open are listed in
`GET /pool/shares/status` with `kind: internal`.

## Outcomes per job
| Result in the document | Rule |
|---|---|
| Selected by company | A round after resume screening has a result, the screening round says cleared/selected, or the final status says selected. The last round reached is shown, e.g. "TR1 (3 Nov) not cleared". |
| Not taken forward by company | The screening round or the final status says rejected, a round says "not shortlisted", or every round is marked "Rejected" at once (a bulk fill). |
| Not selected | The candidate applied. Profiles for that job were sent (the master's Academy counts, or Academy candidates in its company sheet) or the job is closed, and the candidate wasn't among them. If the job is still open, the reviewer gets a note. |
| Result awaited | The candidate was sent and there is no result yet, or applied while the job is open and nothing has been sent yet. With no readable company sheet the result is still "awaited", plus a reviewer note. |
| Requirement closed by company / Did not attend / Result not known | These follow from the job's state and the candidate's row. "Not known" means no readable sheet and a job that isn't open; the reviewer checks it. |

A rejection is never reopened by a later "Done" or "Completed".

## Reasons, and Trust
One model call reviews each distinct resume (same text = same resume) against every job it was used
for. Nothing the model says is used unchecked:
- **Core skills** (1–3 per job) must come from that job's own tech stack or JD.
- **"Shown in a project"** needs the skill in the projects or experience text. The skill's usual names
  are searched too (React js → React; AI/ML → machine learning, scikit-learn…), or the model's quote
  must be there word for word.
- **"Not shown"** needs the skill to be nowhere in the resume. If the model and the text disagree and
  the quote can't be found, the skill is left out.
- **Alternatives** count as each other (AWS / Azure / GCP, Power BI / Tableau, React / Angular / Vue…).
  With AWS in a project, Azure is not reported as missing.
- **Generic project points and spelling issues** need the model's example to be in the text.
- **Links** are read from the file itself (its link annotations and text), not by the model.
- **The rest of the listed tech stack**: soft or vague items are never reported missing.

| Main reason | When |
|---|---|
| "Fits the job, but stronger candidates were chosen by the company" | Every core skill is shown |
| "The job's core skills not used in any project" | A core skill is only in the skills list, or nowhere |
| "The job needed full-time work experience" | The imported review says so |
| "Your resume file could not be read" | A photo, an unreadable scan |
| "Resume not available for review" | No resume on record, or the file host didn't answer (a reviewer note; the candidate isn't blamed) |
| "The company closed the requirement" / "Did not attend the round" | These follow from the outcome |

**Resumes Used** lists each resume once by its name: the same file uploaded again for another
application (each application keeps its own copy) is the same resume, linked to the newest upload.

Verified results are cached per resume content and job in `automation.judgement_cache`. When no model
is available, the job's listed tech stack is checked against the text instead, and the reviewer gets a
note. Before anything is written, `checkContent` cross-checks every number:
- outcomes add up to the jobs;
- reasons add up to "did not move forward";
- percentages total 100;
- resume job counts match the jobs that have a resume.

## Operations
- **Migration 023** (`db/migrations/023_applications_and_feedback_documents.sql`). Until it is
  applied, the feedback endpoints answer 503 `not_ready` and the sync behaves as in 1.12. After it is
  applied, the next run reads every company sheet again once, silently, to fill in the resume links.
- **`FEEDBACK_LLM_CHAIN`** (optional) overrides the model chain. Default: Gemini 3 Flash →
  2.5 Flash → 3.5 Flash, then OpenAI and Mistral, which are used only when Gemini is rate-limited.
- **Checks**:
  - `npx tsx scripts/feedback-selftest.ts` covers the pure parts.
  - `npx tsx scripts/applications-dryrun.ts [--snapshots <dir>]` gives counts only.
  - `npx tsx scripts/feedback-dryrun.ts --uid … --from … --to … --out <dir outside the repo>
    [--snapshots <dir>] [--review-dir <dir>] [--details]` writes a local .docx without Google Docs or
    database writes. The team account's token can't be used locally, so sheets only it can read need
    `--snapshots` (the review folder's `raw`); `--review-dir` uses the November review as the server
    would after the import.
  - `npx tsx scripts/review-import.ts --dir <review folder>` prints counts; `--apply` writes
    (production: only with approval).
