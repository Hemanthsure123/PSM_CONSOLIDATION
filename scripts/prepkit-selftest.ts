/**
 * Self-test for the prep kit's pure parts (no network, no database):
 *   npx tsx scripts/prepkit-selftest.ts
 * Prep document normalising / rendering (HTML, Notion limits), source redaction, email MIME and
 * calendar invites (header injection, line folding), message drafts, call summary cells.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import { normalizePrepDoc, selectSections } from "@/lib/prepdocs/model";
import { renderHtml, renderNotionBlocks, renderText } from "@/lib/prepdocs/render";
import { redact } from "@/lib/prepdocs/sources";
import { buildIcs, buildMime } from "@/lib/team/mail";
import { durationText, summaryCell } from "@/lib/team/summary";
import { draftsFor, istRange, istWhen, meetingEmail, whatsappPrepDoc } from "@/lib/team/templates";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const EMOJI = /\p{Extended_Pictographic}/u;

const raw = {
  title: "Stan SDE Intern 🚀 Technical Round 1 Prep",
  subtitle: "Read this before your interview",
  overview: [
    { label: "Company", value: "Stan" },
    { label: "Round", value: "Technical Round 1" },
  ],
  links: [
    { label: "Website", url: "https://stan.store" },
    { label: "Bad", url: "javascript:alert(1)" },
  ],
  startHere: ["Revise arrays and hashing first.", "Practise explaining your project in 2 minutes."],
  aboutCompany: ["Stan helps creators sell online."],
  whyItMatters: "They ask about product thinking.",
  sayAloud: "I like building tools creators use every day.",
  sections: Array.from({ length: 6 }, (_, i) => ({
    title: `Topic ${i + 1}`,
    tags: ["Must know", "Not a tag"],
    why: "Asked in every report.",
    topics: [{ name: "Two pointers", revise: "Sorted array pair sum." }],
    questionsKind: "asked",
    questions: [`Question ${i + 1}: find two numbers that add up to a target.`, "x".repeat(2500)],
    method: ["Clarify", "Brute force", "Optimise"],
    callout: i === 0 ? { kind: "priority", text: "Most asked." } : null,
  })),
  checklistBefore: ["Test your camera."],
  checklistDuring: ["Think aloud."],
  summary: "Focus on arrays, hashing and your project.",
  changes: [],
  unverified: [],
  noInterviewReports: false,
};

test("normalizePrepDoc removes emojis and unsafe links", () => {
  const doc = normalizePrepDoc(raw);
  assert.ok(doc);
  assert.equal(EMOJI.test(JSON.stringify(doc)), false);
  assert.equal(doc.links.some((l) => l.url.startsWith("javascript:")), false);
  assert.ok(doc.sections.length >= 5);
  assert.ok(doc.sections.every((s) => s.questions.length >= 1));
});

test("normalizePrepDoc rejects junk", () => {
  assert.equal(normalizePrepDoc(null), null);
  assert.equal(normalizePrepDoc({ title: "x" }), null);
});

test("selectSections keeps the chosen parts only", () => {
  const doc = normalizePrepDoc(raw)!;
  const only = selectSections(doc, ["topics"]);
  assert.equal(only.startHere.length, 0);
  assert.equal(only.checklistBefore.length, 0);
  assert.ok(only.sections.length > 0);
});

test("renderHtml escapes text and includes every question", () => {
  const doc = normalizePrepDoc({ ...raw, summary: "<script>alert(1)</script>" })!;
  const html = renderHtml(doc);
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  for (const s of doc.sections) for (const q of s.questions) assert.ok(html.includes(q.slice(0, 40).replace(/&/g, "&amp;")), `missing question ${q.slice(0, 20)}`);
  assert.ok(renderText(doc).includes("SUMMARY"));
});

test("Notion blocks respect the 2,000-character rich-text limit", () => {
  const blocks = renderNotionBlocks(normalizePrepDoc(raw)!);
  assert.ok(blocks.length > 10);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "text" && o.text && typeof (o.text as { content?: unknown }).content === "string") {
        assert.ok(((o.text as { content: string }).content).length <= 2000);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(blocks);
});

test("redact removes emails, phone numbers and candidate names", () => {
  const out = redact("Ravi Kumar (ravi.k@gmail.com, +91 98765 43210) said the interviewer asked about joins. ravi kumar again.", ["Ravi Kumar"]);
  assert.equal(/ravi/i.test(out), false);
  assert.equal(out.includes("@gmail.com"), false);
  assert.equal(/98765/.test(out), false);
  assert.ok(out.includes("asked about joins"));
});

test("email headers can't be injected and the body is base64", () => {
  const mime = buildMime(
    { to: ["a@x.com\r\nBcc: evil@y.com"], replyTo: "m@nxtwave.in", subject: "Prep\r\nBcc: evil@y.com", text: "Hello — namaste" },
    { email: "team@nxtwave.tech", name: "NxtWave Placements" },
  );
  const headerBlock = mime.split("\r\n\r\n")[0];
  assert.equal(/^Bcc:/im.test(headerBlock), false);
  assert.ok(/Subject: Prep Bcc: evil@y.com/.test(headerBlock) || /Subject: =\?UTF-8\?B\?/.test(headerBlock));
  assert.ok(mime.includes(Buffer.from("Hello — namaste", "utf8").toString("base64")));
});

test("calendar invite: escaped text, folded lines, UTC times", () => {
  const start = new Date("2026-11-12T10:30:00Z");
  const ics = buildIcs(
    {
      uid: "abc@google.com",
      sequence: 0,
      start,
      end: new Date(start.getTime() + 45 * 60_000),
      title: "Interview prep: Stan, TR1; notes",
      description: `Line one\nGoogle Meet: https://meet.google.com/abc-defg-hij ${"long ".repeat(40)}`,
      location: "https://meet.google.com/abc-defg-hij",
      attendees: [{ email: "c@gmail.com", name: "Candidate" }],
      method: "REQUEST",
    },
    { email: "team@nxtwave.tech", name: "NxtWave Placements" },
  );
  assert.ok(ics.includes("DTSTART:20261112T103000Z"));
  assert.ok(ics.includes("SUMMARY:Interview prep: Stan\\, TR1\\; notes"));
  assert.ok(ics.includes("Line one\\nGoogle Meet"));
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line too long: ${line.length}`);
  assert.ok(ics.includes("METHOD:REQUEST") && ics.includes("BEGIN:VALARM"));
});

test("drafts: no emojis, doc link included, placeholders kept for the Meet link", () => {
  const c = { candidate: "RAVI kumar", company: "Stan - SDE Intern", round: "TR 1", mentor: "Hemanth", docUrl: "https://docs.google.com/document/d/x/edit", meetUrl: "{meet_link}", meetWhen: "{when}" };
  const d = draftsFor(c);
  assert.equal(EMOJI.test(JSON.stringify(d)), false);
  assert.ok(whatsappPrepDoc(c).startsWith("Hi Ravi,"));
  assert.ok(d.whatsappPrepDoc.includes(c.docUrl));
  assert.ok(d.email.prep.body.includes("{meet_link}") && d.email.prep.body.includes("{when}"));
  assert.ok(meetingEmail("guidance", { company: "Stan", mentor: "Hemanth" }).body.startsWith("Hi everyone,"));
});

test("IST times", () => {
  const s = new Date("2026-11-12T10:30:00Z");
  assert.equal(istWhen(s), "Thu, 12 Nov, 4:00 PM IST");
  assert.equal(istRange(s, new Date(s.getTime() + 45 * 60_000)), "Thu, 12 Nov, 4:00 PM – 4:45 PM IST");
});

test("call summary cell and durations", () => {
  const cell = summaryCell({ overview: "Covered DSA.", keyPoints: [], candidatePerformance: "Good.", improvements: ["SQL joins"], guidance: [], nextActions: ["Mock on Friday"] });
  assert.ok(cell.includes("Improve: SQL joins") && cell.length <= 1500);
  assert.equal(durationText(65), "1 m 05 s");
  assert.equal(durationText(42), "42 s");
});

console.log(`${passed} prep kit tests passed${process.exitCode ? " — with failures above" : ""}`);
