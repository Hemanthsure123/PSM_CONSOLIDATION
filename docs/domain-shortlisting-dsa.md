# Domain Shortlisting — DSA screening

With **Also weigh DSA (LeetCode / Codeforces / CodeChef)** on, or any DSA minimum set,
each resume's coding profiles are read the same way DSA Consolidation reads them, and the
shortlist screens on the numbers directly.

## What is read

`src/lib/dsa-resolve.ts` (shared with DSA Consolidation), per platform:

- problems solved;
- rated contests;
- current and highest rating;
- whether the profile exists.

Profile links come from the resume: link annotations, text, short links, and a model call
only when the resume names a platform it gives no link for. A Codeforces handle that was
later renamed is followed to the current handle (`coding-stats.ts`). The read is time-boxed
at 120 s. A profile that couldn't be read is marked *partial* (unknown, not 0). A profile
that doesn't exist is a definite answer.

The DSA numbers are no longer passed to the domain model, so the domain score stays about
the domain.

## DSA score (0-100)

The score is computed in `src/lib/dsa-scoring.ts`. Each platform scores 0-1 from three
parts, each measured against a cap:

| Platform   | Weight | Rating counts from | Full rating at | Solved cap | Contests cap | Mix (rating / solved / contests) |
|------------|--------|--------------------|----------------|------------|--------------|----------------------------------|
| Codeforces | 1.00   | 800                | 2000           | 400        | 30           | 0.5 / 0.3 / 0.2                  |
| CodeChef   | 0.85   | 1400               | 2400           | 400        | 30           | 0.5 / 0.3 / 0.2                  |
| LeetCode   | 0.70   | 1400               | 2400           | 600        | 30           | 0.4 / 0.4 / 0.2                  |

- A LeetCode rating counts only with at least one rated contest.
- The best weighted platform counts, plus 5 points for each other platform with problems
  solved.
- The rank adds up to **+15** from the DSA score. That sits between GitHub (+20) and resume
  presentation (+10), so DSA lifts a candidate among comparable domain fits but never
  overrides a real domain gap.

## DSA minimums (hard gates)

These sit under *Strict requirements*. 0 turns a gate off.

- **Total problems solved**: LeetCode + Codeforces + CodeChef.
- **Total rated contests**.
- **DSA score** (0-100).
- **Rating bars** for Codeforces, CodeChef and LeetCode. Each bar is checked against the
  highest rating reached. With several bars set, a candidate passes if **any** of those
  platforms reaches its bar.

A candidate who fails a gate gets the reason in the complete CSV, for example
`Rating CF 1584 — needs CF 1600`. When a profile couldn't be read, the reason says so, so
the candidate can be re-run. Setting any minimum turns the DSA read on even if the toggle
is off.

## Output

- **Table:** a DSA column with the score, total solved and best ratings. Hovering shows
  every platform.
- **CSV:** the DSA Consolidation columns:
  - DSA Score;
  - per-platform Solved, Contests Participated and Rating;
  - Total Solved and Total Contests;
  - Codeforces Max Rating and CodeChef Highest Rating;
  - profile URLs;
  - DSA Notes.
- **PDF card:** the DSA score, plus solved and rating per platform.

## Tests

`npx tsx scripts/dsa-domain-selftest.ts` runs 43 offline checks covering scores, bonus,
gates, `buildDomainReport` ranking and gating, and the report card.
