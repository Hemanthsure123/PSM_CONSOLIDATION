/**
 * A small, dependency-free .xlsx writer (Office Open XML in a stored ZIP) for
 * the Academy bucketing workbook: several sheets, a bold frozen header row, an
 * auto-filter, column widths, numbers as numbers. Pure — runs in the browser and
 * in the self-test.
 */

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
  name: string;
  header: string[];
  rows: XlsxCell[][];
  /** Character widths per column (defaults from the content). */
  widths?: number[];
}

const MAX_CELL = 32_767;

/** Excel's rules for a tab name: ≤ 31 chars, none of []:*?/\ , unique. */
export function safeSheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim() || "Sheet").slice(0, 31);
  let out = base;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(out.toLowerCase());
  return out;
}

const xmlEscape = (s: string) =>
  s
    // Characters XML 1.0 forbids (control codes other than tab / newline / return).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function columnRef(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(ref: string, v: XlsxCell, style: number): string {
  const s = style ? ` s="${style}"` : "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  const text = v === null || v === undefined ? "" : String(v);
  if (!text) return "";
  const clipped = text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 20)} … [truncated]` : text;
  const space = /^\s|\s$/.test(clipped) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${s}><is><t${space}>${xmlEscape(clipped)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const width = Math.max(sheet.header.length, ...sheet.rows.map((r) => r.length), 1);
  const widths = Array.from({ length: width }, (_, i) => {
    if (sheet.widths?.[i]) return sheet.widths[i];
    const longest = Math.max(
      String(sheet.header[i] ?? "").length,
      ...sheet.rows.slice(0, 200).map((r) => String(r[i] ?? "").length),
    );
    return Math.max(8, Math.min(60, Math.ceil(longest * 1.05) + 2));
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows: string[] = [];
  rows.push(`<row r="1">${sheet.header.map((h, i) => cellXml(`${columnRef(i)}1`, h, 1)).join("")}</row>`);
  sheet.rows.forEach((r, k) => {
    const n = k + 2;
    rows.push(`<row r="${n}">${r.map((v, i) => cellXml(`${columnRef(i)}${n}`, v, 2)).join("")}</row>`);
  });
  const last = `${columnRef(width - 1)}${sheet.rows.length + 1}`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${last}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join("")}</sheetData>` +
    (sheet.header.length ? `<autoFilter ref="A1:${last}"/>` : "") +
    `</worksheet>`
  );
}

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF1F2A44"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF8"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFB8C4D9"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** The workbook as .xlsx bytes. */
export function buildXlsx(input: XlsxSheet[]): Uint8Array {
  const used = new Set<string>();
  const sheets = (input.length ? input : [{ name: "Sheet1", header: [], rows: [] }]).map((s) => ({ ...s, name: safeSheetName(s.name, used) }));
  const files: { path: string; data: string }[] = [];
  files.push({
    path: "[Content_Types].xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `</Types>`,
  });
  files.push({
    path: "_rels/.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  });
  const filters = sheets
    .map((s, i) => {
      if (!s.header.length) return "";
      const width = Math.max(s.header.length, ...s.rows.map((r) => r.length), 1);
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEscape(s.name.replace(/'/g, "''"))}'!$A$1:$${columnRef(width - 1)}$${s.rows.length + 1}</definedName>`;
    })
    .join("");
  files.push({
    path: "xl/workbook.xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<bookViews><workbookView activeTab="0"/></bookViews>` +
      `<sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
      (filters ? `<definedNames>${filters}</definedNames>` : "") +
      `</workbook>`,
  });
  files.push({
    path: "xl/_rels/workbook.xml.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  });
  files.push({ path: "xl/styles.xml", data: STYLES });
  sheets.forEach((s, i) => files.push({ path: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zipStore(files.map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.data) })));
}

// ── ZIP (stored, no compression) ─────────────────────────────────────────────

let CRC_TABLE: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: { path: string; bytes: Uint8Array }[]): Uint8Array {
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.bytes.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, f.bytes);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + f.bytes.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
