import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IBorderOptions,
  type ParagraphChild,
} from "docx";

/**
 * The team's document look (prep documents and RSA documents), in docx units: sizes are
 * half-points (20 = 10pt), spacing and indents are twips, table widths DXA. Built as .docx and
 * converted into a Google Doc on upload, so fonts, table widths, borders and shading are kept.
 * Pure: no I/O.
 */

export const BFONT = "Calibri";
export const HFONT = "Cambria";

export const COLOR = {
  TAG: "9A6212",
  LINK: "1155CC",
  BORDER: "D4D9E2",
  BOXBG: "EEF3FA",
  WARNBG: "FDF6E7",
  SUBTITLE: "444444",
  SOURCE: "666666",
  H2TEXT: "333333",
} as const;

/** One deep, professional accent per company, the same in every document for that company. */
export const ACCENTS = ["1A4D8F", "3B2E7E", "0F5C4A", "7A2E2E", "2C4A5E", "5C3A6E", "1F4E5F"] as const;

export function accentFor(company: string): string {
  const key = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

/** All tables sit just inside the 9400-twip content width. */
export const TABLE_WIDTH = 9360;
const LINE = 256;

const PAGE = { size: { width: 12240, height: 15840 }, margin: { top: 780, bottom: 720, left: 1420, right: 1420 } };

const thin = (color: string = COLOR.BORDER): IBorderOptions => ({ style: BorderStyle.SINGLE, size: 2, color });

export interface Run {
  text: string;
  bold?: boolean;
  italics?: boolean;
  /** Half-points. */
  size?: number;
  color?: string;
  font?: string;
}

const run = (r: Run) => new TextRun({ text: r.text, bold: r.bold, italics: r.italics, size: r.size ?? 20, color: r.color, font: r.font ?? BFONT });

export class DocBuilder {
  readonly children: (Paragraph | Table)[] = [];

  constructor(readonly accent: string) {}

  /** Company name (uppercase), subtitle, and an italic source line: three stacked paragraphs. */
  titleBlock(title: string, subtitle: string, sourceLine: string) {
    this.children.push(new Paragraph({ spacing: { after: 40 }, children: [run({ text: title, bold: true, size: 40, color: this.accent, font: HFONT })] }));
    if (subtitle) this.children.push(new Paragraph({ spacing: { after: 40 }, children: [run({ text: subtitle, size: 23, color: COLOR.SUBTITLE, font: HFONT })] }));
    if (sourceLine) this.children.push(new Paragraph({ spacing: { after: 120 }, children: [run({ text: sourceLine, size: 17, italics: true, color: COLOR.SOURCE })] }));
  }

  /** H1 with an optional priority tag (three spaces, amber, small). */
  h1(text: string, tag?: string) {
    const children: ParagraphChild[] = [run({ text, bold: true, size: 25, color: this.accent, font: HFONT })];
    if (tag) children.push(run({ text: `   ${tag}`, bold: true, size: 15, color: COLOR.TAG }));
    this.children.push(new Paragraph({ keepNext: true, spacing: { before: 185, after: 48 }, children }));
  }

  h2(text: string) {
    this.children.push(new Paragraph({ keepNext: true, spacing: { before: 110, after: 36 }, children: [run({ text, bold: true, size: 20, color: COLOR.H2TEXT })] }));
  }

  para(runs: Run[] | string) {
    const list = typeof runs === "string" ? [{ text: runs }] : runs;
    this.children.push(new Paragraph({ spacing: { after: 60, line: LINE }, children: list.map(run) }));
  }

  /** One bullet level only (never nested). */
  bullet(runs: Run[] | string) {
    const list = typeof runs === "string" ? [{ text: runs }] : runs;
    this.children.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 24, line: LINE }, children: list.map(run) }));
  }

  /** "Topic — what to revise": bold topic, em dash, plain explanation. */
  topic(name: string, explanation: string) {
    this.bullet([{ text: name, bold: true }, { text: explanation ? ` — ${explanation}` : "" }]);
  }

  /** A numbered item with the number in the run, so the hanging indent is exact. */
  numbered(n: number, text: string) {
    this.children.push(
      new Paragraph({ indent: { left: 290, hanging: 290 }, spacing: { after: 24, line: LINE }, children: [run({ text: `${n}.  `, bold: true }), run({ text })] }),
    );
  }

  spacer(after = 100) {
    this.children.push(new Paragraph({ spacing: { after }, children: [] }));
  }

  private cell(children: Paragraph[], width: number, opts: { fill?: string } = {}) {
    return new TableCell({
      width: { size: width, type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 110, right: 110 },
      borders: { top: thin(), bottom: thin(), left: thin(), right: thin() },
      ...(opts.fill ? { shading: { fill: opts.fill, type: ShadingType.CLEAR, color: "auto" } } : {}),
      children,
    });
  }

  private cellText(text: string, o: { bold?: boolean; color?: string } = {}) {
    return new Paragraph({ spacing: { after: 0, line: 250 }, children: [run({ text, size: 18, bold: o.bold, color: o.color })] });
  }

  /** INFO table: tinted bold label on the left, one or two plain sentences on the right. */
  infoTable(rows: { label: string; value: string | ParagraphChild[] }[], labelWidth = 2180) {
    if (!rows.length) return;
    const right = TABLE_WIDTH - labelWidth;
    this.children.push(
      new Table({
        width: { size: TABLE_WIDTH, type: WidthType.DXA },
        columnWidths: [labelWidth, right],
        rows: rows.map(
          (r) =>
            new TableRow({
              cantSplit: true,
              children: [
                this.cell([this.cellText(r.label, { bold: true, color: this.accent })], labelWidth, { fill: COLOR.BOXBG }),
                this.cell(
                  [typeof r.value === "string" ? this.cellText(r.value) : new Paragraph({ spacing: { after: 0, line: 250 }, children: r.value })],
                  right,
                ),
              ],
            }),
        ),
      }),
    );
  }

  /** GRID table: up to 3 columns, a tinted header row repeated on each page. */
  gridTable(header: string[], rows: string[][], widths?: number[]) {
    if (!rows.length) return;
    const cols = Math.min(3, header.length);
    const w = widths && widths.length === cols && widths.reduce((a, b) => a + b, 0) === TABLE_WIDTH ? widths : cols === 3 ? [2700, 3400, 3260] : [3600, 5760];
    this.children.push(
      new Table({
        width: { size: TABLE_WIDTH, type: WidthType.DXA },
        columnWidths: w,
        rows: [
          new TableRow({ tableHeader: true, cantSplit: true, children: header.slice(0, cols).map((h, i) => this.cell([this.cellText(h, { bold: true, color: this.accent })], w[i], { fill: COLOR.BOXBG })) }),
          ...rows.map((r) => new TableRow({ cantSplit: true, children: Array.from({ length: cols }, (_, i) => this.cell([this.cellText(r[i] ?? "")], w[i])) })),
        ],
      }),
    );
  }

  /** A callout: a single-cell table with a thick accent rule on the left. */
  box(label: string, body: string[], tone: "info" | "warn") {
    const paras = [
      new Paragraph({ spacing: { after: 50 }, children: [run({ text: label, bold: true, size: 17, color: this.accent })] }),
      ...body.map((t, i) => new Paragraph({ spacing: { after: i === body.length - 1 ? 0 : 50, line: LINE }, children: [run({ text: t, size: 19 })] })),
    ];
    this.children.push(
      new Table({
        width: { size: TABLE_WIDTH, type: WidthType.DXA },
        columnWidths: [TABLE_WIDTH],
        rows: [
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: TABLE_WIDTH, type: WidthType.DXA },
                margins: { top: 110, bottom: 110, left: 160, right: 160 },
                borders: { left: { style: BorderStyle.SINGLE, size: 12, color: this.accent }, top: thin(), bottom: thin(), right: thin() },
                shading: { fill: tone === "info" ? COLOR.BOXBG : COLOR.WARNBG, type: ShadingType.CLEAR, color: "auto" },
                children: paras,
              }),
            ],
          }),
        ],
      }),
    );
  }

  /** Hyperlinked titles separated by " · ", in one small paragraph. */
  links(prefix: string, links: { label: string; url: string }[]) {
    if (!links.length) return;
    const children: ParagraphChild[] = [];
    if (prefix) children.push(run({ text: prefix, size: 19 }));
    links.forEach((l, i) => {
      if (i) children.push(run({ text: " · ", size: 19 }));
      children.push(new ExternalHyperlink({ link: l.url, children: [new TextRun({ text: l.label, size: 19, color: COLOR.LINK, underline: {}, font: BFONT })] }));
    });
    this.children.push(new Paragraph({ spacing: { after: 60, line: LINE }, children }));
  }

  /** A hyperlink run for an INFO cell. */
  static link(label: string, url: string): ParagraphChild {
    return new ExternalHyperlink({ link: url, children: [new TextRun({ text: label, size: 18, color: COLOR.LINK, underline: {}, font: BFONT })] });
  }

  static text(text: string): ParagraphChild {
    return new TextRun({ text, size: 18, font: BFONT });
  }

  async build(title: string): Promise<Buffer> {
    const doc = new Document({
      title,
      creator: "PSM",
      styles: { default: { document: { run: { font: BFONT, size: 20 } } } },
      numbering: {
        config: [
          {
            reference: "bullets",
            levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 290, hanging: 200 } } } }],
          },
        ],
      },
      sections: [{ properties: { page: PAGE }, children: this.children }],
    });
    return Packer.toBuffer(doc);
  }
}

/**
 * About how many pages a document takes on US Letter at these sizes: ~95 characters a line,
 * ~50 lines a page; tables and boxes count their rows. Used to keep documents in their budget
 * (the server can't render the file).
 */
export function estimatePages(blocks: { chars: number; kind: "line" | "row" | "heading" | "box" }[]): number {
  let lines = 0;
  for (const b of blocks) {
    const perLine = b.kind === "row" ? 55 : 95;
    const wrapped = Math.max(1, Math.ceil(b.chars / perLine));
    lines += b.kind === "heading" ? 2 : b.kind === "box" ? wrapped + 2 : b.kind === "row" ? wrapped + 0.5 : wrapped + 0.3;
  }
  return lines / 50;
}
