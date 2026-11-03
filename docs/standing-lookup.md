# Standing lookup

Paste UUIDs or phone numbers and get each candidate's internal standing from the eligible pool. You can also find everyone from a college, a graduation year or above a mark.

- The standing comes from the Edge 2.0, Edge 1.0 and Academy assessments only — no resume is read.
- Every row says whether the person is **eligible for job opportunities** (the *Job Eligibility* column). People the Academy assessed who aren't in the eligible pool are found too, and tagged *Not eligible*.
- You can add the details you need, including the **marks** of every Academy exam and interview, each with its verdict, date and recording link (see [`assessment-scores.md`](./assessment-scores.md)).
- **Marks always get columns of their own.** The header is the name with the maximum in brackets, and the cells hold only the marks obtained.

## How to use it

1. Choose the candidates, in one of two ways:
   - **Paste IDs.** Copy a UUID column (or phone numbers) from a sheet and paste it into **Candidates**. You can paste:
     - one candidate per line;
     - a line with both a UUID and a phone number (tab or comma separated);
     - other cells on the line, such as names, which are ignored.

     A header row is left out, and blank lines keep their place.
   - **Find by college / year / marks.** Set any of these filters; together they all apply:
     - **Job eligibility:** Everyone, Eligible (in the eligible pool) or Not eligible (assessed, not in the pool). On its own it lists everyone eligible.
     - **College:** pick from the list or type part of a name ("VIT", "Vignan"). Add several to include each.
     - **Year of graduation:** one or more years.
     - **Minimum marks:** an assessment and a mark. Any attempt counts.

     **Find candidates** puts everyone assessed who matches into the list (UUID and phone; best mark first when a minimum is set, else the eligible first) and looks them up.
2. Optional: pick **Requirements**, the details you want added. They are grouped by the way the assessments run (see [Requirements you can pick](#requirements-you-can-pick)).
   - A chip with **#** is a mark.
   - **All** / **None** picks a whole group.
3. Optional, once something is picked:
   - **Repeat attempts** (when an exam or interview is picked): show the *best*, the *latest* or *all* attempts.
   - **With each mark:** which columns come beside each mark.
     - *Verdict* (on by default).
     - *Date* (off by default).
     - *Recording link* (on by default; interviews only).
   - **Other details** (when a non-mark detail is picked): *One Requirements column*, with one line per item in a single cell, or *A column each*.
   - **Columns of the result** lists exactly the columns you will get.
4. **Look up standings.**
5. Get the results in one of three ways:
   - **Copy results** copies only the result columns, to paste beside your IDs in the sheet.
   - **Copy table** copies every column.
   - **Download CSV** saves the file.

Rows keep the pasted order, so a pasted result lines up with the source. The header row is copied only when your paste had one.

## Columns

| Column | When | Value |
|---|---|---|
| UUID | Always | As pasted. When only a phone number was pasted, the UUID is taken from the database. |
| Phone | Only when phone numbers were pasted (Find always adds them) | As pasted, as 10 digits |
| Internal Standing | Always | Their best standing across products, e.g. "Edge 2.0 · MERN TR-2 · Strong hire". Tier 4 people get "… (not eligible)". Assessed by the Academy but not in the pool: "Assessed · not in the eligible pool". Anyone else: "External". |
| Internal Stage | People in the pool | TR-2 / top, TR-1, Assessment, Not eligible |
| Internal Product | People in the pool | The product of that best standing: Edge 2.0, Edge 1.0 or Academy |
| Job Eligibility | Always | *Eligible*: in the eligible pool with an eligible standing (tier 1–3). *Not eligible*: in the pool but not cleared, or assessed and not in the pool. Empty for someone unknown (External). |
| Requirements | Non-mark details picked, *One Requirements column* | One line per picked item that the candidate has a result for. Items without a result are skipped. |
| One column per detail | Non-mark details picked, *A column each* | Each picked detail under its own header. Empty when the candidate has no result. |
| *Name (max)* | Each picked mark | Only the marks obtained, e.g. header *DSA offline exam (130)*, cell `92`. Empty when the candidate has no result. |
| *Name – verdict* | *Verdict* on | The sheet's verdict, e.g. *Qualified*, *L3 · Medium Hire · Cleared*, *Good – Hire with positive feedback · Cleared* |
| *Name – date* | *Date* on | The exam or interview date, e.g. *25 Oct 2026* (the old offline assessment: its cycle) |
| *Name – recording* | *Recording link* on, interviews | The recording link. On screen it shows as *Recording ↗*; copies and the CSV have the full link. |

The three standing columns are the same values that Domain shortlisting exports; Job Eligibility is the lookup's own.

**The figures above the results:** looked up · eligible for jobs (by stage) · not eligible (assessed outside the pool, or didn't clear) · external.

**Repeat attempts.**
- **Best / latest:** one set of columns per mark. A tie for best goes to the latest.
- **All:** the set repeats, oldest first:
  - an exam once per exam date: *DSA offline exam 27 Sep 2026 (130)*, *DSA offline exam 25 Oct 2026 (130)*;
  - an interview once per attempt: *Bucket B TR-1 #1 (15)*, *Bucket B TR-1 #2 (15)*.

**Edge cases.**
- **Logged twice.** The same interview logged in two sheets (same date and score) counts once. Its recording or verdict is taken from whichever copy has it.
- **Other maximum.** An exam set out of another maximum puts that maximum in the header. Only a column that mixes maxima writes the odd marks as *60/140*; today's data has none.
- **Bucket C TR-1** comes from the Academy pool sheet, which states no maximum, so its header has no brackets.
- **No stored marks.** When the marks tables hold nothing for an Academy item, the Academy pool sheet's result is used:
  - competency interviews: score and verdict;
  - Bucket A / B / C rounds: score and status;
  - the old assessment's bucket and the DSA offline tag: as the verdict.

  Bucket A TR-1's sheet has no verdict column, so its verdict always comes from the pool sheet.

## Requirements you can pick

| Group | Items |
|---|---|
| Candidate | Name · College · Year of graduation · Degree & department · Resume link (the pool's reference copy) · Other products (standings in the person's other products) · Score within stage (0–100, a tie-break inside a stage) |
| Offline exams (Academy · marks) | Old process (230) · DSA (130) · Frontend (115) · Backend (95) · Software Engineering (215) |
| Competency interviews (Academy · marks) | DSA · Frontend · Backend · Software Engineering (each 100) |
| Bucket interviews (Academy TR-1 / TR-2 · marks) | Bucket A TR-1 (100) · Bucket A TR-2 (100) · Bucket B TR-1 (15) · Bucket B TR-2 (10) · Bucket C TR-1 |
| Academy pool | Active pool · Previous placement · Preference |
| Edge 2.0 | Candidate stage · **Assessment scores**: offline (160), DSA coding (120), CS fundamentals (40), SQL MCQ (15), SQL coding (15) · **TR-1 ratings**: overall technical (100), DSA, problem solving, coding, debugging, communication, self intro (each 10) · TR-2 verdicts per track |
| Edge 1.0 | Assessment · TR-1 · TR-2 |

Edge 2.0's assessment scores and TR-1 ratings are marks too, so they get one column per score, e.g. *Edge 2.0 DSA coding (120)*. Edge 2.0 and Edge 1.0 standings, stages and verdicts are unchanged.

Your picks and options are remembered in this browser. A choice saved under an older name still works: the old *Bucket interviews* item becomes the five bucket rounds, and *Old assessment bucket* becomes *Old process*.

If you add a requirement after a lookup, only the missing details are fetched; there is no need to look up again.

## Matching

- Each line is matched by phone number first, then by UUID, the same way as Domain shortlisting.
- What counts as a phone number: 10 digits, written with or without +91 / 0, spaces or dashes.
- What counts as a UUID: the standard 36-character form, or the same without dashes.
- Anything else on its own line is reported as **Not a UUID or phone number**. That includes a 9- or 11-digit number, which is most likely a mistyped phone number.
- Up to 20,000 lines per lookup (and per Find).
- The results are only as current as the data:
  - The results header shows when each product was last refetched; refetch it on the **Eligible pool** screen.
  - Marks are as current as their last import: the **Assessment marks** panel on the same screen.

## For developers

| What | Where |
|---|---|
| Reading the paste, requirements and their groups, marks (best / latest / all), rows, columns, clipboard formats (pure) | `src/lib/pool/lookup.ts` |
| Records behind a batch of standings | `poolRecords` in `src/lib/pool/queries.ts` |
| People assessed outside the pool, marks, profiles, the Find filter | `src/lib/pool/scores/queries.ts` |
| API | `POST /api/pool/lookup` with `{ people, include? }`: always returns `standings` and `assessed` (people with marks outside the pool); `include` takes products (records per candidate id), `"scores"` and `"profile"`. `POST /api/pool/find` with `{ colleges?, yogs?, assessment?, minScore?, eligibility? }`. |
| Screen | `src/components/pool/standing-lookup.tsx` · `lookup-requirements.tsx` (the picker, options and column preview) · `lookup-find.tsx` (the Find filter) |
| Self-test | `npx tsx scripts/standing-lookup-selftest.ts` |
