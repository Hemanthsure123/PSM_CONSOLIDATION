/**
 * Contact lookups: a renamed assessment tab is still found (pickTab). Run: npx tsx scripts/contacts-selftest.ts
 */
import "./server-only-shim";
import assert from "node:assert/strict";

async function main() {
  const { pickTab } = await import("@/lib/team/contacts");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  };
  const titles = ["assessment cleared - 18 Nov", "All Assessment Cleared PII DATA - Nov 2026", "Sheet3"];
  check("an existing tab is used as is", () => assert.equal(pickTab(titles, "Sheet3"), "Sheet3"));
  check("a renamed PII tab is found by its words", () =>
    assert.equal(pickTab(titles, "All Assessment Cleared PII DATA - 2027"), "All Assessment Cleared PII DATA - Nov 2026"));
  check("a non-PII tab never picks the PII one", () => assert.equal(pickTab(titles, "Assessment Cleared- 2027 Pooll"), "assessment cleared - 18 Nov"));
  check("nothing close enough → null", () => assert.equal(pickTab(titles, "Interview Feedback Sheet"), null));
  check("no tabs → null", () => assert.equal(pickTab([], "Anything"), null));
  console.log(`${passed} contacts tests passed`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
