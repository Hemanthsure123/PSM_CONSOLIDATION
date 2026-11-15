/**
 * Self-test for the prep actions' pure parts (documents, meetings, calls) (no network, no database):
 *   npx tsx scripts/prep-actions-selftest.ts
 * Prep document normalising / rendering (text, Notion limits), source redaction, email MIME and
 * calendar invites (header injection, line folding), message drafts, call summary cells.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import { normalizePrepDoc, selectSections } from "@/lib/prepdocs/model";
import { renderNotionBlocks, renderText } from "@/lib/prepdocs/render";
import { redact } from "@/lib/prepdocs/sources";
import { buildIcs, buildMime } from "@/lib/team/mail";
import { istLabel, messageLine, withEntry } from "@/lib/team/sheetlog";
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
  sourceLine: "Built from a previously appeared candidate's round 🚀",
  overview: [
    { label: "What this round is", value: "A 45-minute technical round." },
    { label: "What they test", value: "Arrays, hashing and your project." },
  ],
  startHere: ["Revise arrays and hashing first.", "Practise explaining your project in 2 minutes."],
  aboutCompany: ["Stan helps creators sell online."],
  sections: Array.from({ length: 6 }, (_, i) => ({
    title: `${i + 1}. Topic ${i + 1}`,
    tag: i < 5 ? "HIGHEST PRIORITY" : "Must know",
    intro: "Asked in every report.",
    topics: [{ name: "Two pointers", revise: "Sorted array pair sum." }],
    asked: [`Find two numbers in a sorted array that add up to a target`, "Explain how a hash map handles collisions"],
    practise: [],
    grid: null,
    box: i === 0 ? { label: "Not a label", body: ["Most asked."] } : null,
  })),
  checklist: { beforeHeading: "The night before", before: ["Test your camera."], duringHeading: "In the round", during: ["Think aloud."] },
  inShort: "In short: focus on arrays, hashing and your project.",
  sources: [
    { title: "Website", url: "https://stan.store" },
    { title: "Bad", url: "javascript:alert(1)" },
  ],
  changes: [],
  unverified: [],
  noInterviewReports: false,
};

test("normalizePrepDoc removes emojis, unsafe links and numbering; keeps the vocabularies", () => {
  const doc = normalizePrepDoc(raw);
  assert.ok(doc);
  assert.equal(EMOJI.test(JSON.stringify(doc)), false);
  assert.equal(doc.sources.some((l) => l.url.startsWith("javascript:")), false);
  assert.ok(doc.sections.length >= 5);
  assert.equal(doc.sections[0].title, "Topic 1");
  assert.equal(doc.sections.filter((s) => s.tag).length, 3, "at most 3 priority tags");
  assert.equal(doc.sections[5].tag, "", "unknown tag dropped");
  assert.equal(doc.sections[0].box?.label, "WHAT TO KEEP IN MIND", "unknown box label replaced");
  assert.equal(doc.inShort.startsWith("In short"), false);
});

test("normalizePrepDoc rejects junk", () => {
  assert.equal(normalizePrepDoc(null), null);
  assert.equal(normalizePrepDoc({ title: "x" }), null);
});

test("selectSections keeps the chosen parts only", () => {
  const doc = normalizePrepDoc(raw)!;
  const only = selectSections(doc, ["topics"]);
  assert.equal(only.startHere.length, 0);
  assert.equal(only.checklist.before.length, 0);
  assert.equal(only.inShort, "");
  assert.ok(only.sections.length > 0);
});

test("renderText includes every question and the fixed headings", () => {
  const doc = normalizePrepDoc(raw)!;
  const text = renderText(doc);
  for (const s of doc.sections) for (const q of s.asked) assert.ok(text.includes(q), `missing question ${q.slice(0, 20)}`);
  assert.ok(text.includes("START HERE") && text.includes("IN SHORT") && text.includes("Questions asked in real interviews"));
});

test("Notion blocks respect the 2,000-character rich-text limit", () => {
  const blocks = renderNotionBlocks(normalizePrepDoc({ ...raw, startHere: ["x".repeat(2500)] })!);
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

test("sheet call entries: newest first, a retry replaces its own entry", () => {
  const a = withEntry("", "#c11111111", "[8 Nov · Phone call] #c11111111\nfirst");
  const b = withEntry(a, "#m22222222", "[9 Nov · Google Meet] #m22222222\nsecond");
  assert.ok(b.indexOf("second") < b.indexOf("first"));
  const c = withEntry(b, "#c11111111", "[8 Nov · Phone call] #c11111111\nfirst again");
  assert.equal(c.match(/#c11111111/g)?.length, 1);
  assert.ok(c.startsWith("[8 Nov · Phone call] #c11111111\nfirst again"));
  assert.ok(c.includes("second"));
});

test("sheet cells stay under the cell limit (oldest dropped, newest kept)", () => {
  let cell = "";
  for (let i = 0; i < 30; i++) cell = withEntry(cell, `#c${String(i).padStart(8, "0")}`, `[call ${i}] #c${String(i).padStart(8, "0")}\n${"x".repeat(4000)}`);
  assert.ok(cell.length <= 45_000);
  assert.ok(cell.startsWith("[call 29]"));
  assert.ok(!cell.includes("[call 0]"));
  const huge = withEntry("", "#c99999999", `[big] #c99999999\n${"y".repeat(60_000)}`);
  assert.ok(huge.length <= 45_000 && huge.endsWith("(cut at the sheet's cell limit)"));
});

test("message lines read in IST, with who and how", () => {
  const at = new Date("2026-11-08T10:40:00Z");
  assert.equal(istLabel(at), "8 Nov 2026, 4:10 PM");
  assert.equal(
    messageLine({ at, channel: "WhatsApp", purpose: "Meet link", to: "9876543210", status: "opened", by: "Hemanth" }),
    "8 Nov 2026, 4:10 PM · WhatsApp · Meet link · to 9876543210 · opened · Hemanth",
  );
});

console.log(`${passed} prep action tests passed${process.exitCode ? " — with failures above" : ""}`);
