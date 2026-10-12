/**
 * Telling a resume LINK from resume TEXT in pasted input. Shared by the browser
 * (paste parsing) and the server (a safety net for runs saved before the parser
 * knew this) — pure, no I/O.
 */

const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s"'<>]+/i;

/**
 * The URL when `s` is only a link — however long (S3 / Drive links run past 150
 * characters) and even with a short label around it ("Resume: https://…") — else "".
 * Real resume text that merely contains a link is NOT a link.
 */
export function linkOnly(s: string | undefined | null): string {
  const t = (s ?? "").trim();
  if (!t || t.length > 2_000) return "";
  const m = t.match(URL_IN_TEXT);
  if (!m) return "";
  const rest = t
    .replace(m[0], " ")
    .replace(/[\s"'<>()[\]{}:|,;.\-–—]+/g, " ")
    .trim();
  if (rest.length > 40) return "";
  const url = m[0].replace(/[).,;:'"]+$/, "");
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
