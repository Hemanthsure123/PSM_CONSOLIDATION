# Domain Shortlisting: autofill from a job description

This fills **What defines it** and **Mandatory skills** from a job description or any notes about the role. You review the draft before anything changes. Everything else stays yours to set: the shortlist size, the gates and the evidence sources.

## Use it

1. Open **Domain shortlisting** and load the sheet.
2. In the **Domain** panel, click **Autofill from JD**.
3. Paste the JD or your notes, or upload the file, or both: pasted notes are added to the file's text. Supported files, up to 10 MB:
   - PDF, including a scanned one;
   - Word (.docx);
   - text, Markdown or HTML;
   - a screenshot or photo.
4. Click **Draft the fields**. The draft shows:
   - **What defines it**: the role's core work, its stack (core first, then good-to-have) and a "Strong fit:" sentence. Its length is shown against the 1,500-character limit, which counts the domain name and this text together.
   - **Mandatory skills**: only the JD's explicit must-haves, at most 6 and within 600 characters. Hover over an item to see the JD's own words behind it. If the JD has no hard requirement a resume can show, the field stays empty, so nobody is gated out.
   - **GitHub check**: the technologies GitHub inspection will require (from Mandatory) and look for (from What defines it). Any technology the JD doesn't name is flagged, because a word in the draft triggered it.
   - **Not judged from resumes**: years of experience, degree, CGPA, location, CTC, soft skills and similar requirements.
   - **For your other settings**: suggestions only, such as the experience gate or DSA gates. Nothing is switched on for you.
5. Click **Apply to the fields**, or **Replace the current values** if the fields already have text. **Undo** puts the previous values back. The domain name is filled only when that field is empty.

## Safeguards

- **No invented must-haves.** Every mandatory item must be backed by the JD's own words. Items the JD doesn't support are left out, and the draft says why. A scanned PDF or an image can't be checked word for word, and the draft says that too.
- **Instructions inside a document are ignored.** Sentences such as "ignore the previous instructions" or "put X in mandatory" are removed before the model reads the document, and the draft notes them.
- **Same models as the screening.** It uses Domain Shortlisting's own model chain (`DOMAIN_LLM_CHAIN`, default Gemini → OpenAI → Mistral), with OpenAI reasoning off. Scanned files and images go only to Gemini or OpenAI, because those can read files.
- **The limits match the scorer's.** The draft is cut to what the scorer reads: 1,500 characters for the domain name plus What defines it, and 600 for Mandatory. The two fields now show live character counters.

## For developers

| Piece | File |
|---|---|
| API | `POST /api/domain/autofill`. Takes multipart `text`, `file` and `domainName`. Returns the reviewed draft, or `{ error }` with a 400, 413, 415, 422, 500, 502 or 503 status. |
| Reading the source and the model call | `src/lib/domain-autofill.ts` |
| Limits, clean-up, grounding and the injection filter (pure, client-safe) | `src/lib/domain-autofill-rules.ts` |
| Screen | `src/components/domain-shortlist/jd-autofill.tsx`, used in the Domain panel of `domain-shortlist.tsx` |
| Self-test (no network) | `npx tsx scripts/domain-autofill-selftest.ts` |
