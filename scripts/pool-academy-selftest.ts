/**
 * Self-test for the Academy priority pool's pure parts (no network, no database):
 *   npx tsx scripts/pool-academy-selftest.ts
 * Reading the "> 8LPA Assessed Pool" tab (only the agreed columns, header row below a banner, rows
 * without a MENTOR skipped), track names, phone numbers, tags, resume types and file names, the
 * inbox sentences of pushes, and the pool meeting drafts.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import {
  cleanStack,
  cleanTags,
  findPoolColumns,
  normHeader,
  parsePoolRows,
  phone10,
  resumeFileName,
  resumeType,
  trackOf,
} from "@/lib/mobile/pool/parse";
import { inboxText } from "@/lib/mobile/push";
import { poolDraftsFor, poolMeetingEmail } from "@/lib/team/templates";

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

// The real tab's layout: a banner row, then the header row (with line breaks and curly apostrophes),
// sensitive columns we must never read (parent details, remarks), and TechStack / MENTOR at the end.
const banner = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Frontend (Last Updated on Oct 15,2026)"];
const header = [
  "UID", "DSA Offline", "YOG", "Name", "Email Address", "StudentNumber", "Location/State", "Parent Name", "Parent Contact",
  "Bachelor’s College Name\n", "Bachelor’s Course Name\n", "Bachelor's Specialization", "Student Preference/Call Remarks",
  "Overall Score (out of 100)", "Overall Score (out of 100)", "TechStack", "MENTOR",
];
const row = (uid: string, name: string, phone: string, stack: string, mentor: string, email = "a@b.com") => [
  uid, "Cleared", "2025", name, email, phone, "Test State", "Parent X", "9000000099", "Test Institute", "B Tech", "CSE", "private remark", "96", "80", stack, mentor,
];
const UID1 = "11111111-2222-4333-8444-555555555551";
const UID2 = "11111111-2222-4333-8444-555555555552";
const UID3 = "11111111-2222-4333-8444-555555555553";

test("headers are matched by text, below a banner row", () => {
  const cols = findPoolColumns([banner, header]);
  assert.equal(cols.headerRow, 1);
  assert.equal(cols.index.uid, 0);
  assert.equal(cols.index.phone, 5);
  assert.equal(cols.index.college, 9);
  assert.equal(cols.index.course, 10);
  assert.equal(cols.index.specialization, 11);
  assert.equal(cols.index.techStack, 15);
  assert.equal(cols.index.mentor, 16);
  assert.equal(normHeader("Bachelor’s College Name\n"), "bachelor s college name");
});

test("a missing required column is a clear error", () => {
  assert.throws(() => findPoolColumns([header.filter((h) => h !== "StudentNumber")]), /STUDENTNUMBER/);
  assert.throws(() => findPoolColumns([["a", "b"], ["c"]]), /UID/);
});

test("only mentored rows, only the agreed columns", () => {
  const r = parsePoolRows([
    banner,
    header,
    row(UID1, "ASHA RAO", "9000000001", "Backend", "Asif", "Asha.Rao@Example.com"),
    row(UID2, "Ravi Kumar", "+91 90000 00002", "FULL STACK", "Rakesh"),
    row(UID3, "No Mentor Yet", "9000000001", "AI/ML", ""),
    [],
  ]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.read, 3);
  const a = r.rows[0];
  assert.equal(a.uid, UID1);
  assert.equal(a.email, "asha.rao@example.com");
  assert.equal(a.phone, "9000000001");
  assert.equal(a.track, "backend");
  assert.equal(a.mentor, "Asif");
  assert.equal(a.yog, 2025);
  assert.equal(a.college, "Test Institute");
  assert.equal(a.sheetRow, 3);
  assert.equal(r.rows[1].phone, "9000000002");
  assert.equal(r.rows[1].track, "fullstack");
  // Nothing outside the agreed columns is kept.
  const keys = Object.keys(a).sort();
  assert.deepEqual(keys, ["college", "course", "email", "location", "mentor", "name", "phone", "sheetRow", "specialization", "techStack", "track", "uid", "yog"].sort());
  assert.ok(!JSON.stringify(r.rows).includes("Parent X") && !JSON.stringify(r.rows).includes("private remark"));
});

test("bad UIDs, repeats and bad phones are reported, not guessed", () => {
  const r = parsePoolRows([
    header,
    row("x", "Bad", "9000000001", "Backend", "Asif"),
    row(UID1, "First", "9000000001", "Backend", "Asif"),
    row(UID1, "Repeat", "9000000001", "Backend", "Asif"),
    row(UID2, "Bad phone", "h", "Backend", "Asif"),
    row(UID3, "Mentor typo spaces", "9000000001", "Frontend", "Gaurav "),
  ]);
  assert.deepEqual(r.rows.map((x) => x.name), ["First", "Bad phone", "Mentor typo spaces"]);
  assert.equal(r.rows[1].phone, null);
  assert.equal(r.rows[2].mentor, "Gaurav");
  assert.equal(r.issues.length, 3);
  assert.match(r.issues[0].message, /UID/);
  assert.match(r.issues[1].message, /repeats row 3/);
  assert.match(r.issues[2].message, /StudentNumber/);
});

test("tracks", () => {
  assert.equal(trackOf("FULL STACK"), "fullstack");
  assert.equal(trackOf("Full-Stack"), "fullstack");
  assert.equal(trackOf("AI/ML"), "aiml");
  assert.equal(trackOf("AI ML"), "aiml");
  assert.equal(trackOf("Frontend"), "frontend");
  assert.equal(trackOf("Backend"), "backend");
  assert.equal(trackOf("Java"), null);
  assert.equal(trackOf(""), null);
});

test("phones", () => {
  assert.equal(phone10("9000000001"), "9000000001");
  assert.equal(phone10("+91 90000 00001"), "9000000001");
  assert.equal(phone10("09000000001"), "9000000001");
  assert.equal(phone10("1234567890"), null);
  assert.equal(phone10("h"), null);
});

test("tags: trimmed, de-duplicated, capped", () => {
  assert.deepEqual(cleanTags([" React ", "react", "Node.js", "", "  Spring   Boot "]), ["React", "Node.js", "Spring Boot"]);
  assert.equal(cleanTags("React"), null);
  assert.equal(cleanTags(Array.from({ length: 21 }, (_, i) => `t${i}`)), null);
  assert.equal(cleanTags(["x".repeat(60)])?.[0].length, 40);
  assert.equal(cleanStack("  Backend "), "Backend");
  assert.equal(cleanStack(""), null);
  assert.equal(cleanStack("x".repeat(41)), null);
});

test("resume types and names", () => {
  assert.deepEqual(resumeType("application/pdf", "a.pdf"), { mime: "application/pdf", ext: "pdf" });
  assert.deepEqual(resumeType("application/octet-stream", "CV.DOCX"), { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" });
  assert.equal(resumeType("image/jpeg", "photo.jpg"), null);
  assert.equal(resumeFileName("Asha / Rao: Kumar", "AI/ML", "2026-11-08", "pdf"), "Asha Rao Kumar - AI ML - 2026-11-08.pdf");
});

test("inbox sentences: own title wins, otherwise a plain line per kind", () => {
  assert.deepEqual(inboxText("prep_overdue", { title: "Prep overdue · Stan", body: "x" }), { title: "Prep overdue · Stan", body: "x" });
  assert.equal(inboxText("assignment", { company: "Nobroker", profilesRequired: "15" }).title, "New task · Nobroker");
  assert.equal(inboxText("assignment", { company: "Nobroker", profilesRequired: "15" }).body, "15 profiles required.");
  assert.equal(inboxText("prep_reminder", { candidate: "Asha", company: "Maersk", round: "TR3" }).title, "Prep due soon · Asha · Maersk · TR3");
  assert.equal(inboxText("test", {}).title, "Test notification");
  assert.ok(inboxText("prep_digest", { title: "x".repeat(300) }).title.length <= 200);
});

test("pool meeting drafts: no company placeholders, plain text", () => {
  const one = poolMeetingEmail("mock", { candidate: "ASHA RAO", track: "Backend", mentor: "Asif" });
  assert.equal(one.subject, "Mock interview: Backend");
  assert.match(one.body, /^Hi Asha,/);
  assert.match(one.body, /your Backend track/);
  const group = poolDraftsFor({ mentor: "Faraaz" });
  assert.match(group.email.guidance.body, /^Hi everyone,/);
  assert.ok(!/undefined|null| for {2}/.test(JSON.stringify(group)));
  assert.match(group.whatsapp.mock, /Your mock interview is scheduled/);
});

console.log(process.exitCode ? `pool-academy selftest: FAILED (${passed} passed)` : `${passed} pool-academy tests passed`);
