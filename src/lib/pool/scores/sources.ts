/**
 * The assessment tabs the service account can read (read-only), so their scores can be refetched
 * without downloading a CSV. Every other export (the offline exam results, the Bucket A / B
 * interview sheets) is imported as a CSV. Override a spreadsheet with SCORES_INTERVIEWS_SHEET /
 * SCORES_OLD_OFFLINE_SHEET (id or URL) if it moves.
 */
export interface ScoreSheet {
  id: string;
  label: string;
  spreadsheetId: string;
  tab: string;
}

const idFrom = (v: string) => v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? v.trim();
const sheet = (env: string, fallback: string) => {
  const v = process.env[env]?.trim();
  return v ? idFrom(v) : fallback;
};

/** "Post Offline Competency Interview Evaluation" — one tab per competency (the interview after the offline exam). */
const INTERVIEWS = "1tsRHDkqQFusgvVyuT0-Wli53jHBvvMICQQfzkVbpwa4";
/** "Post Assessment eligible students for Placement Pool" — the old process offline assessment roster. */
const OLD_OFFLINE = "1LJOr3p3MsANVPsmJjj4S0IwfJvuzrrEVliE68h2sniE";

export function scoreSheets(): ScoreSheet[] {
  const interviews = sheet("SCORES_INTERVIEWS_SHEET", INTERVIEWS);
  const old = sheet("SCORES_OLD_OFFLINE_SHEET", OLD_OFFLINE);
  return [
    { id: "old-offline", label: "Old offline assessment", spreadsheetId: old, tab: "Offline Attended - Old Process" },
    { id: "interview-dsa-v2", label: "DSA competency interview (DSA 2.0)", spreadsheetId: interviews, tab: "DSA 2.0 (current)" },
    { id: "interview-dsa-v1", label: "DSA competency interview (discontinued format)", spreadsheetId: interviews, tab: "DSA (discontinued)" },
    { id: "interview-frontend", label: "Frontend competency interview", spreadsheetId: interviews, tab: "Frontend Development" },
    { id: "interview-backend", label: "Backend competency interview", spreadsheetId: interviews, tab: "Backend Development" },
    { id: "interview-software", label: "Software Engineering competency interview", spreadsheetId: interviews, tab: "SE Fundamentals" },
  ];
}

export const scoreSheetUrl = (s: ScoreSheet) => `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`;
