# Standing lookup

Paste UUIDs or phone numbers and get each candidate's internal standing from the eligible pool. The standing comes from the Edge 2.0, Edge 1.0 and Academy assessments only — no resume is read.

## How to use it

1. Copy a UUID column (or phone numbers) from a sheet and paste it into **Candidates**. You can paste:
   - one candidate per line;
   - a line with both a UUID and a phone number (tab or comma separated);
   - other cells on the line, such as names, which are ignored.

   A header row is left out, and blank lines keep their place.
2. Optional: pick **Requirements**, the assessment results you want added.
3. **Look up standings.**
4. Get the results in one of three ways:
   - **Copy results** copies only the result columns, to paste beside your IDs in the sheet.
   - **Copy table** copies every column.
   - **Download CSV** saves the file.

Rows keep the pasted order, so a pasted result lines up with the source. The header row is copied only when your paste had one.

## Columns

| Column | When | Value |
|---|---|---|
| UUID | Always | As pasted. When only a phone number was pasted, the UUID is taken from the pool. |
| Phone | Only when phone numbers were pasted | As pasted, as 10 digits |
| Internal Standing | Always | The person's best standing across products, e.g. "Edge 2.0 · MERN TR-2 · Strong hire". Tier 4 people get "… (not eligible)". People not in the pool get "External". |
| Internal Stage | Matched people | TR-2 / top, TR-1, Assessment, Not eligible |
| Internal Product | Matched people | The product of that best standing: Edge 2.0, Edge 1.0 or Academy |
| Requirements | Only when requirements are picked | One line per picked item that the candidate has a result for. Items without a result are skipped. |

These are the same three standing values that Domain shortlisting exports.

## Requirements you can pick

| Group | Items |
|---|---|
| Any product | Name · Other products (standings in the person's other products) · Score within stage (0–100, a tie-break inside a stage) · Resume link (the pool's reference copy) |
| Edge 2.0 | Candidate stage · Assessment scores (offline /160, DSA coding /120, CS fundamentals /40, SQL MCQ /15, SQL coding /15) · TR-1 ratings · TR-2 verdicts per track |
| Edge 1.0 | Assessment · TR-1 · TR-2 |
| Academy | Bucket interviews (TR-1 / TR-2 with score) · DSA, Frontend, Backend and Software Engineering competency (level, score, verdict, clearance) · Old assessment bucket · DSA offline exam · Active pool · Previous placement · Preference · Year of graduation |

Your picks are remembered in this browser. If you add a requirement after a lookup, only the missing details are fetched; there is no need to look up again.

## Matching

- Each line is matched by phone number first, then by UUID, the same way as Domain shortlisting.
- What counts as a phone number: 10 digits, written with or without +91 / 0, spaces or dashes.
- What counts as a UUID: the standard 36-character form, or the same without dashes.
- Anything else on its own line is reported as **Not a UUID or phone number**. That includes a 9- or 11-digit number, which is most likely a mistyped phone number.
- Up to 20,000 lines per lookup.
- The results are only as current as the eligible pool. The results header shows when each product was last refetched; refetch it on the **Eligible pool** screen.

## For developers

| What | Where |
|---|---|
| Reading the paste, requirements, rows, columns, clipboard formats (pure) | `src/lib/pool/lookup.ts` |
| Records behind a batch of standings | `poolRecords` in `src/lib/pool/queries.ts` |
| API | `POST /api/pool/lookup` with `{ people, include? }`; `include` adds `records` per candidate id |
| Screen | `src/components/pool/standing-lookup.tsx` |
| Self-test | `npx tsx scripts/standing-lookup-selftest.ts` |
