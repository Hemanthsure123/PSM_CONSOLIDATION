import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  type IBorderOptions,
  LevelFormat,
  Packer,
  Paragraph,
  type ParagraphChild,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import type { FeedbackContent, TextRun as Run } from "@/lib/feedback-docs/model";

/**
 * The candidate feedback document as a .docx, in the look the team approved for these documents
 * (the "Resume Rejection Analysis" sample): A4, Calibri, black only, one or two pages, numbered
 * sections, plain bordered tables, the "What to Improve" points in a box. Uploaded as a Google Doc
 * (the conversion keeps fonts, tables and borders), reviewed there, sent as a PDF. Pure.
 *
 * A long period (many jobs or resumes) is set a little tighter — narrower margins, less space between
 * points, a 10 pt results table — so it still fits on two pages.
 */

const FONT = "Calibri";
const BLACK = "000000";
const PAGE_WIDTH = 11906; // A4 (twips)
const line: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: BLACK };
const thick: IBorderOptions = { style: BorderStyle.SINGLE, size: 12, color: BLACK };
const none: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };

interface Layout {
  /** Text width (twips). */
  width: number;
  margins: { top: number; bottom: number; side: number };
  bullet: { after: number; line: number };
  heading: { before: number; after: number };
  jobs: { size: number; line: number; margins: [number, number, number, number] };
  resumeMargins: [number, number, number, number];
}

const NORMAL: Layout = {
  width: PAGE_WIDTH - 2 * 1440,
  margins: { top: 1080, bottom: 1080, side: 1440 },
  bullet: { after: 80, line: 288 },
  heading: { before: 300, after: 120 },
  jobs: { size: 21, line: 264, margins: [40, 120, 40, 120] },
  resumeMargins: [40, 60, 40, 60],
};

const COMPACT: Layout = {
  width: PAGE_WIDTH - 2 * 1080,
  margins: { top: 900, bottom: 900, side: 1080 },
  bullet: { after: 40, line: 264 },
  heading: { before: 200, after: 80 },
  jobs: { size: 20, line: 240, margins: [25, 100, 25, 100] },
  resumeMargins: [20, 60, 20, 60],
};

/** The tighter layout, for a long period. */
export const isCompact = (c: Pick<FeedbackContent, "jobs" | "resumes" | "summary" | "interviews" | "assignments">) =>
  c.jobs.length > 12 || c.resumes.length > 9 || c.summary.length + c.interviews.length + c.assignments.length > 10;

const t = (text: string, o: { bold?: boolean; size?: number } = {}) => new TextRun({ text, font: FONT, size: o.size ?? 22, bold: Boolean(o.bold), color: BLACK });
const runs = (rs: Run[], size?: number) => rs.map((r) => t(r.text, { bold: r.bold, size }));

const bulletIn = (L: Layout) => (children: ParagraphChild[]) =>
  new Paragraph({ numbering: { reference: "dots", level: 0 }, spacing: { before: 0, after: L.bullet.after, line: L.bullet.line }, children });

const heading = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [t(text, { bold: true, size: 28 })] });

function cell(children: Paragraph[], width: number, o: { borders?: IBorderOptions; margins?: [number, number, number, number]; top?: boolean } = {}) {
  const b = o.borders ?? line;
  const [top, right, bottom, left] = o.margins ?? [70, 120, 70, 120];
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: o.top ? VerticalAlign.TOP : VerticalAlign.CENTER,
    margins: { top, right, bottom, left },
    borders: { top: b, bottom: b, left: b, right: b },
    children,
  });
}

const cellText = (text: string, o: { bold?: boolean; size?: number; center?: boolean; keepNext?: boolean; line?: number } = {}) =>
  new Paragraph({
    spacing: { after: 0, line: o.line ?? 264 },
    keepNext: Boolean(o.keepNext),
    alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [t(text, { bold: o.bold, size: o.size })],
  });

/** A bordered table; [together]: kept on one page (small tables). */
function grid(widths: number[], rows: string[][], o: { center?: number[]; size?: number; line?: number; margins?: [number, number, number, number]; top?: boolean; together?: boolean } = {}) {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: rows.map(
      (r, ri) =>
        new TableRow({
          tableHeader: ri === 0,
          cantSplit: true,
          children: r.map((c, ci) =>
            cell([cellText(c, { bold: ri === 0, size: o.size, line: o.line, center: ri > 0 && (o.center ?? []).includes(ci), keepNext: Boolean(o.together) && ri < rows.length - 1 })], widths[ci], { margins: o.margins, top: o.top }),
          ),
        }),
    ),
  });
}

/** Columns in these proportions that add up to [width] exactly. */
function split(width: number, parts: number[]): number[] {
  const total = parts.reduce((a, b) => a + b, 0);
  const out = parts.map((p) => Math.floor((width * p) / total));
  out[out.length - 1] += width - out.reduce((a, b) => a + b, 0);
  return out;
}

export async function renderFeedbackDocx(c: FeedbackContent): Promise<Buffer> {
  const L = isCompact(c) ? COMPACT : NORMAL;
  const WIDTH = L.width;
  const cols = (parts: number[]) => split(WIDTH, parts);
  const bullet = bulletIn(L);
  const children: (Paragraph | Table)[] = [];
  let n = 0;
  const section = (title: string) => children.push(heading(`${++n}. ${title}`));

  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [t(c.title, { bold: true, size: 36 })] }));
  children.push(new Paragraph({ spacing: { after: 200 }, children: [t(`Period: ${c.period.line}`)] }));

  section("Summary");
  for (const s of c.summary) children.push(bullet(runs(s)));

  section("Your Numbers");
  children.push(grid(cols(c.numbers.headers.map(() => 1)), [c.numbers.headers, c.numbers.values], { center: c.numbers.headers.map((_, i) => i), together: true }));

  if (c.reasons.length) {
    section("Why Applications Did Not Move Forward");
    children.push(grid(cols([5826, 1600, 1600]), [["Reason", "Count", "%"], ...c.reasons.map((r) => [r.text, String(r.count), `${r.pct}%`])], { center: [1, 2], together: true }));
    if (c.tags.length) {
      children.push(new Paragraph({ spacing: { before: 120, after: 60 }, children: [t("Also noticed in your resumes:", { bold: true })] }));
      const items = c.tags.map((tag, i) => `${tag.text} (${i === 0 ? `${tag.count} of ${c.tagBase}` : tag.count})`);
      const half = Math.ceil(items.length / 2);
      const col = (list: string[]) => list.map((x) => bullet([t(x)]));
      const left = col(items.slice(0, half));
      const right = col(items.slice(half));
      const halves = cols([1, 1]);
      children.push(
        new Table({
          width: { size: WIDTH, type: WidthType.DXA },
          columnWidths: halves,
          layout: TableLayoutType.FIXED,
          rows: [
            new TableRow({
              children: [
                cell(left.length ? left : [new Paragraph({ children: [] })], halves[0], { borders: none, margins: [0, 60, 0, 0], top: true }),
                cell(right.length ? right : [new Paragraph({ children: [] })], halves[1], { borders: none, margins: [0, 60, 0, 0], top: true }),
              ],
            }),
          ],
        }),
      );
    }
  }

  section("Interviews and Assignments");
  for (const x of c.interviews) children.push(bullet([t(x)]));
  for (const x of c.assignments) children.push(bullet([t(x)]));
  if (!c.interviews.length && !c.assignments.length) children.push(bullet([t("No interviews or assignments in this period.")]));
  else {
    if (!c.interviews.length) children.push(bullet([t("No interviews in this period.")]));
    if (!c.assignments.length) children.push(bullet([t("No assignments in this period.")]));
  }

  if (c.resumes.length) {
    section(`Resumes Used (${c.resumes.length})`);
    const per = 3;
    const width = cols([1, 1, 1]);
    const rows: TableRow[] = [];
    for (let i = 0; i < c.resumes.length; i += per) {
      const slice = c.resumes.slice(i, i + per);
      rows.push(
        new TableRow({
          cantSplit: true,
          children: width.map((w, j) => {
            const r = slice[j];
            const p = r
              ? new Paragraph({
                  spacing: { after: 0, line: L.bullet.line },
                  keepNext: i + per < c.resumes.length,
                  children: [
                    t(`${i + j + 1}. `),
                    new ExternalHyperlink({ link: r.url, children: [new TextRun({ text: r.label, font: FONT, size: 22, color: BLACK, underline: {} })] }),
                    t(` (${r.jobs} ${r.jobs === 1 ? "job" : "jobs"})`),
                  ],
                })
              : new Paragraph({ children: [] });
            return cell([p], w, { borders: none, margins: L.resumeMargins, top: true });
          }),
        }),
      );
    }
    children.push(new Table({ width: { size: WIDTH, type: WidthType.DXA }, columnWidths: width, layout: TableLayoutType.FIXED, rows }));
  }

  section("Result for Each Job");
  children.push(
    grid(cols([2900, 2400, 3726]), [["Company – Role", "Result", "Reason"], ...c.jobs.map((j) => [`${j.company} – ${j.role}`, j.result, j.reason])], {
      size: L.jobs.size,
      line: L.jobs.line,
      margins: L.jobs.margins,
      top: true,
    }),
  );

  section("What to Improve");
  const box: Paragraph[] = [
    new Paragraph({ spacing: { after: 120 }, children: [t("Take this feedback as a chance to improve, and start working on these areas now.", { bold: true })] }),
    ...c.improve.map((x) => bullet([t(`${x.label}: `, { bold: true }), t(x.text)])),
  ];
  children.push(
    new Table({
      width: { size: WIDTH, type: WidthType.DXA },
      columnWidths: [WIDTH],
      layout: TableLayoutType.FIXED,
      rows: [new TableRow({ children: [cell(box, WIDTH, { borders: thick, margins: [120, 180, 60, 180] })] })],
    }),
  );
  children.push(new Paragraph({ spacing: { after: 0 }, children: [] }));

  const doc = new Document({
    title: c.title,
    creator: "NxtWave Placements",
    styles: {
      default: { document: { run: { font: FONT, size: 22, color: BLACK } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: FONT, size: 36, bold: true, color: BLACK }, paragraph: { keepNext: true, spacing: { before: 0, after: 80 } } },
        {
          id: "Heading1",
          name: "heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: 28, bold: true, color: BLACK },
          paragraph: { keepNext: true, spacing: { before: L.heading.before, after: L.heading.after }, border: { bottom: { color: BLACK, space: 2, style: BorderStyle.SINGLE, size: 4 } } },
        },
      ],
    },
    numbering: {
      config: [{ reference: "dots", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }],
    },
    sections: [{ properties: { page: { size: { width: PAGE_WIDTH, height: 16838 }, margin: { top: L.margins.top, bottom: L.margins.bottom, left: L.margins.side, right: L.margins.side } } }, children }],
  });
  return Packer.toBuffer(doc);
}

/** The document as plain text (for the selftest and the dry run). */
export function feedbackText(c: FeedbackContent): string {
  const L: string[] = [c.title, `Period: ${c.period.line}`, ""];
  let n = 0;
  const h = (s: string) => L.push("", `${++n}. ${s}`);
  h("Summary");
  for (const s of c.summary) L.push(`  • ${s.map((r) => r.text).join("")}`);
  h("Your Numbers");
  L.push(`  ${c.numbers.headers.join(" | ")}`, `  ${c.numbers.values.join(" | ")}`);
  if (c.reasons.length) {
    h("Why Applications Did Not Move Forward");
    for (const r of c.reasons) L.push(`  ${r.text} | ${r.count} | ${r.pct}%`);
    if (c.tags.length) L.push(`  Also noticed: ${c.tags.map((tag, i) => `${tag.text} (${i === 0 ? `${tag.count} of ${c.tagBase}` : tag.count})`).join("; ")}`);
  }
  h("Interviews and Assignments");
  for (const x of [...c.interviews, ...c.assignments]) L.push(`  • ${x}`);
  if (c.resumes.length) {
    h(`Resumes Used (${c.resumes.length})`);
    c.resumes.forEach((r, i) => L.push(`  ${i + 1}. ${r.label} (${r.jobs} ${r.jobs === 1 ? "job" : "jobs"})`));
  }
  h("Result for Each Job");
  for (const j of c.jobs) L.push(`  ${j.company} – ${j.role} | ${j.result} | ${j.reason}`);
  h("What to Improve");
  for (const x of c.improve) L.push(`  • ${x.label}: ${x.text}`);
  return L.join("\n");
}
