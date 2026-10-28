/**
 * Self-test: Domain evidence ignores the Skills section and the profile summary.
 *   npx tsx scripts/resume-sections-selftest.ts
 */
import "./server-only-shim";
import { evidenceText } from "@/lib/resume-sections";
import { mandatoryTechsAbsent } from "@/lib/github-analysis";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

// 1. A typical single-column resume.
const r1 = [
  "Asha Kumar",
  "asha@example.com | +91 98765 43210",
  "PROFESSIONAL SUMMARY",
  "Full-stack developer skilled in Kubernetes, GraphQL and Rust.",
  "EDUCATION",
  "B.Tech CSE, 2026 — CGPA 8.4",
  "TECHNICAL SKILLS",
  "Languages: Java, Python, Rust",
  "Frameworks: React, Spring Boot, Django",
  "Tools: Docker, Kubernetes",
  "PROJECTS",
  "ShopKart — e-commerce platform",
  "Overview",
  "Built a React + Node.js storefront with MongoDB and Stripe payments.",
  "Skills: React, Express",
  "EXPERIENCE",
  "Backend Intern, Acme — built REST APIs in Spring Boot with PostgreSQL.",
  "CERTIFICATIONS",
  "AWS Certified Cloud Practitioner",
  "ACHIEVEMENTS",
  "Winner, Smart India Hackathon 2025",
  "Languages Known",
  "English, Hindi, Telugu",
].join("\n");
const e1 = evidenceText(r1);
check("trusted layout", e1.trusted);
check("skills section removed", !e1.text.includes("Frameworks: React, Spring Boot, Django") && !e1.text.includes("Tools: Docker, Kubernetes"));
check("summary removed", !e1.text.includes("Kubernetes, GraphQL and Rust"));
check("languages-known removed", !e1.text.includes("Telugu"));
check("projects kept (with their own Overview / Skills lines)", e1.text.includes("React + Node.js storefront") && e1.text.includes("Overview") && e1.text.includes("Skills: React, Express"));
check("experience kept", e1.text.includes("Spring Boot with PostgreSQL"));
check("certifications kept", e1.text.includes("AWS Certified Cloud Practitioner"));
check("achievements kept", e1.text.includes("Smart India Hackathon"));
check("education kept", e1.text.includes("B.Tech CSE"));
check("removed list", ["Skills", "Summary", "Languages"].every((s) => e1.removed.includes(s as never)), e1.removed.join(","));

// 2. Mandatory check: a technology only in Skills / Summary isn't evidence.
check("Kubernetes only in skills → absent", mandatoryTechsAbsent("Kubernetes", e1.text).length === 1);
check("Spring Boot in experience → present", mandatoryTechsAbsent("Spring Boot", e1.text).length === 0);
check("Rust only in summary + skills → absent", mandatoryTechsAbsent("Rust", e1.text).length === 1);

// 3. Inline "Skills:" line with no Skills heading, outside projects.
const r2 = ["Ravi", "Skills: Kubernetes, Terraform", "Projects", "Chat app with Socket.io and Redis"].join("\n");
const e2 = evidenceText(r2);
check("labelled skills line removed", !e2.text.includes("Terraform") && e2.text.includes("Socket.io"));

// 4. Side-by-side columns (headings on consecutive lines) → only labelled lines go.
const r3 = ["SKILLS", "PROJECTS", "Python, Django", "Built a Django blog with Celery", "Skills: Go"].join("\n");
const e3 = evidenceText(r3);
check("interleaved columns → untrusted", !e3.trusted);
check("interleaved: project text kept", e3.text.includes("Built a Django blog"));
check("interleaved: labelled line still removed", !e3.text.includes("Skills: Go"));

// 5. A "section" that would swallow the resume (skills heading near the top, no later heading).
const r4 = ["Skills", ...Array.from({ length: 30 }, (_, i) => `Built feature ${i} of a Flask app with PostgreSQL`)].join("\n");
const e4 = evidenceText(r4);
check("runaway section → untrusted, text kept", !e4.trusted && e4.text.includes("feature 29"));

// 6. Nothing to remove.
const r5 = ["Projects", "Built an LLM chatbot with LangChain", "Experience", "ML intern at X"].join("\n");
const e5 = evidenceText(r5);
check("nothing removed", e5.removed.length === 0 && e5.text === r5);

// 7. A joined, hyphenated heading ends the Skills section ("Achievements & Co-Curriculars").
const r6 = ["Technical Skills", "Back-End: Flask, FastAPI", "Achievements & Co-Curriculars", "Runner Up, IIIT Una Hackathon"].join("\n");
const e6 = evidenceText(r6);
check("joined heading ends the skills section", e6.text.includes("IIIT Una Hackathon") && !e6.text.includes("FastAPI"));

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
