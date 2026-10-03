/**
 * Renders a RoundPlan into one print-ready PDF packet.
 *
 * Page 1 is an internal mailing checklist (marked "do not mail"); each
 * letter then starts on its own page, plain paper, Times New Roman 11pt,
 * 1" margins, block paragraphs. No firm letterhead: letters are in the
 * consumer's own voice.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Letter, RoundPlan, RoundTimeline } from "./types";

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 72;

/** "2026-10-05" → "10/05/2026" */
function us(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}
const SIZE = 11;
const LEADING = 14;

/** Replace characters the standard Times font can't encode. */
function safe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—•€]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont) {}
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  lines(text: string, opts: { font?: PDFFont; size?: number } = {}) {
    const font = opts.font ?? this.font;
    const size = opts.size ?? SIZE;
    for (const l of wrap(safe(text), font, size, PAGE_W - 2 * MARGIN)) {
      if (this.y < MARGIN + LEADING) this.newPage();
      if (l) this.page.drawText(l, { x: MARGIN, y: this.y, size, font, color: rgb(0, 0, 0) });
      this.y -= l ? LEADING : LEADING * 0.8;
    }
  }
}

export interface PacketMeta {
  clientName: string;
  timeline: RoundTimeline;
}

export async function renderPacketPdf(plan: RoundPlan, meta: PacketMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Round ${plan.round} dispute packet - ${meta.clientName}`);
  doc.setCreator("FUNDED UP");
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const w = new Writer(doc, font);

  // Internal checklist page.
  w.newPage();
  w.lines("INTERNAL MAILING CHECKLIST - DO NOT MAIL THIS PAGE", { font: bold, size: 12 });
  w.lines("");
  w.lines(`Client: ${meta.clientName}`);
  w.lines(`Round ${plan.round} - mail by ${us(meta.timeline.mailedOn)}`);
  w.lines(`Bureau response due: ${us(meta.timeline.responseDueOn)} (extended: ${us(meta.timeline.extendedDueOn)})`);
  w.lines(`Next round eligible: ${us(meta.timeline.nextRoundEligibleOn)}`);
  w.lines("");
  plan.letters.forEach((l: Letter, i) => {
    const addr = l.recipient.addressLines.length ? l.recipient.addressLines.join(", ") : "ADDRESS NEEDED - look up the furnisher's dispute address before mailing";
    w.lines(`${i + 1}. ${l.recipient.name} (${l.recipient.kind}) - ${l.itemIds.length} item(s)`, { font: bold });
    w.lines(`   ${addr}`);
    w.lines(`   Send certified mail, return receipt. Enclose: ${l.enclosures.replace(/^Enclosures?: /, "")}`);
    w.lines("");
  });
  if (plan.skipped.length) {
    w.lines("Not included this round:", { font: bold });
    for (const s of plan.skipped) w.lines(`${s.itemId}: ${s.reason}`);
  }
  w.lines("");
  w.lines("Before mailing: client signs each letter; confirm every item was confirmed by the client as inaccurate; attach the listed enclosures only if actually in hand.");

  for (const l of plan.letters) {
    w.newPage();
    w.lines(l.body);
  }
  return doc.save();
}
