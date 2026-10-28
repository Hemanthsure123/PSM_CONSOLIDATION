/**
 * Which sheet column holds what — the header guesses Domain shortlisting uses for a candidate
 * tab (the screen pre-fills its pickers with them; the sheet automation relies on them). Pure.
 */

export type DomainColumnKey =
  | "idColumn"
  | "phoneColumn"
  | "nameColumn"
  | "resumeColumn"
  | "assessmentColumn"
  | "tr1PanelColumn"
  | "tr1LinkedinColumn"
  | "tr1RecordingColumn"
  | "tr2PanelColumn"
  | "tr2LinkedinColumn"
  | "tr2RecordingColumn"
  | "placedColumn"
  | "ctcColumn";

const rx = (headers: string[], re: RegExp, not?: RegExp): string => headers.find((h) => re.test(h) && !(not?.test(h) ?? false)) ?? "";

/** A name column, exact titles first ("Name", "Full Name", "Your Name") so "Institute Name" never wins. */
function nameColumn(headers: string[]): string {
  const exact = headers.find((h) => /^\s*(full\s*|your\s*|candidate(?:'s)?\s*|student\s*)?name\s*$/i.test(h));
  return exact ?? rx(headers, /name/i, /company|panel|college|project|user|institut|universit|course|department|degree|school|father|mother|parent|guardian|mentor/i);
}

/** Every column a candidate tab can map, by its header ("" = not found). */
export function detectDomainColumns(headers: string[]): Record<DomainColumnKey, string> {
  return {
    idColumn: rx(headers, /uuid|user\s*[_-]?\s*id|\buid\b|\bid\b/i),
    phoneColumn: rx(headers, /phone|mobile|contact\s*(no|num)|whatsapp|^\s*number\s*$/i, /alternate|\balt\b|parent|father|mother|guardian|emergency|secondary/i),
    nameColumn: nameColumn(headers),
    resumeColumn: rx(headers, /resume|\bcv\b|biodata/i, /scanned|probability|remarks/i),
    assessmentColumn: rx(headers, /assess?ment/i),
    tr1PanelColumn: rx(headers, /(tr[\s._-]*1|round[\s._-]*1).*(panel|interviewer)/i, /linked|recording|link|video/i),
    tr1LinkedinColumn: rx(headers, /(tr[\s._-]*1|round[\s._-]*1).*linked/i),
    tr1RecordingColumn: rx(headers, /(tr[\s._-]*1|round[\s._-]*1).*(record|video|link)/i, /linked|panel/i),
    tr2PanelColumn: rx(headers, /(tr[\s._-]*2|round[\s._-]*2).*(panel|interviewer)/i, /linked|recording|link|video/i),
    tr2LinkedinColumn: rx(headers, /(tr[\s._-]*2|round[\s._-]*2).*linked/i),
    tr2RecordingColumn: rx(headers, /(tr[\s._-]*2|round[\s._-]*2).*(record|video|link)/i, /linked|panel/i),
    placedColumn: rx(headers, /placed|placement|offer|company/i, /ctc|package|panel/i),
    ctcColumn: rx(headers, /ctc|package|salary|lpa|\bpay\b|stipend/i),
  };
}
