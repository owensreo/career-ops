#!/usr/bin/env node

/**
 * Final-PDF verification for Career-Ops CVs.
 *
 * This validates the PDF text layer an ATS receives, after Chromium has
 * rendered the HTML. It intentionally does not inspect or interpret a job
 * description: callers may provide only already-supported `--contains` terms.
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export class PdfVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfVerificationError';
  }
}

const TYPOGRAPHIC_FOLDS = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201c', '"'], ['\u201d', '"'],
  ['\u2013', '-'], ['\u2014', '-'], ['\u00a0', ' '], ['\u00ad', ''],
]);

/** Normalize only for comparisons; `text` remains the raw ATS-visible layer. */
export function normalizePdfText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u00a0\u00ad]/g, char => TYPOGRAPHIC_FOLDS.get(char) || char)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toLines(items) {
  const byY = new Map();
  for (const item of items) {
    const text = String(item.str || '');
    if (!text.trim()) continue;
    const y = Number(item.transform?.[5] || 0);
    const key = Math.round(y * 2) / 2;
    const current = byY.get(key) || { y, height: Number(item.height || 0), parts: [] };
    current.parts.push({ x: Number(item.transform?.[4] || 0), text });
    current.height = Math.max(current.height, Number(item.height || 0));
    byY.set(key, current);
  }
  return [...byY.values()]
    .map(line => {
      const parts = line.parts.sort((a, b) => a.x - b.x);
      // PDF text items commonly correspond to CSS spans.  Preserve each span
      // in visual x-order and put a word boundary between adjacent spans; this
      // is closer to an ATS reading order than blindly concatenating them.
      const text = parts.reduce((out, part) => (
        out && !/\s$/.test(out) && !/^\s/.test(part.text) ? `${out} ${part.text}` : out + part.text
      ), '');
      return { ...line, text };
    })
    .sort((a, b) => b.y - a.y);
}

export function inspectPdfLayout(pages, { sectionHeadings = [] } = {}) {
  const normalizedHeadings = new Set(sectionHeadings.map(normalizePdfText).filter(Boolean));
  const errors = [];
  const warnings = [];

  pages.forEach((page, index) => {
    const lines = page.lines;
    if (!lines.length) {
      errors.push(`page ${index + 1} has no extractable text`);
      return;
    }
    // PDF coordinates begin at the bottom. Career-Ops CVs do not put content
    // in a footer; text in the bottom 0.45in indicates an unsafe collision.
    const footerLines = lines.filter(line => line.y < 32 && /\S/.test(line.text));
    if (footerLines.length) {
      errors.push(`page ${index + 1} has text in the footer safety band: ${normalizePdfText(footerLines[0].text).slice(0, 80)}`);
    }
    if (index < pages.length - 1) {
      const last = lines.at(-1);
      if (normalizedHeadings.has(normalizePdfText(last.text))) {
        errors.push(`page ${index + 1} ends with orphaned section heading: ${normalizePdfText(last.text)}`);
      }
      for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex += 1) {
        const gap = lines[lineIndex].y - lines[lineIndex + 1].y;
        if (gap > 108) {
          errors.push(`page ${index + 1} has a ${Math.round(gap)}pt layout hole after "${normalizePdfText(lines[lineIndex].text).slice(0, 50)}"`);
          break;
        }
      }
    } else {
      const occupied = lines[0].y - lines.at(-1).y;
      if (page.height && occupied < page.height * 0.2) {
        warnings.push(`final page ${index + 1} is sparse (${Math.round(occupied)}pt of ${Math.round(page.height)}pt occupied)`);
      }
    }
  });
  return { errors, warnings };
}

export function extractContactsFromHtml(html) {
  const values = new Set();
  for (const match of String(html || '').matchAll(/mailto:([^"'\s<>?]+)/gi)) values.add(decodeURIComponent(match[1]));
  for (const match of String(html || '').matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) values.add(match[0]);
  return [...values].filter(Boolean);
}

export async function verifyPdfFile(pdfPath, {
  minChars = 1,
  contains = [],
  contacts = [],
  sectionHeadings = [],
  dumpText,
  failOnLayout = true,
  requireContact = false,
} = {}) {
  const path = resolve(pdfPath);
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new PdfVerificationError(`cannot read PDF: ${error.message}`);
  }

  let document;
  try {
    document = await getDocument({ data: bytes, disableWorker: true, useSystemFonts: true }).promise;
  } catch (error) {
    throw new PdfVerificationError(`PDF is malformed or unreadable: ${error.message}`);
  }

  const pages = [];
  const textParts = [];
  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = toLines(content.items);
      textParts.push(lines.map(line => line.text).join('\n'));
      pages.push({ height: viewport.height, lines });
    }
  } finally {
    await document.destroy();
  }

  const text = textParts.join('\n');
  const normalized = normalizePdfText(text);
  if (normalized.length < minChars) {
    throw new PdfVerificationError(`text layer has ${normalized.length} characters; expected at least ${minChars}`);
  }
  if (/[\uFFFD]/u.test(text)) {
    throw new PdfVerificationError('text layer contains replacement glyphs (garbled extraction)');
  }
  for (const required of contains) {
    if (!normalized.includes(normalizePdfText(required))) {
      throw new PdfVerificationError(`text layer is missing required text: ${JSON.stringify(required)}`);
    }
  }
  if (requireContact && contacts.length === 0) {
    throw new PdfVerificationError('no visible email address was supplied for ATS contact verification');
  }
  for (const contact of contacts) {
    if (!normalized.includes(normalizePdfText(contact))) {
      throw new PdfVerificationError(`text layer is missing visible contact information: ${JSON.stringify(contact)}`);
    }
  }
  if (dumpText) await writeFile(resolve(dumpText), text.endsWith('\n') ? text : `${text}\n`, 'utf8');

  const layout = inspectPdfLayout(pages, { sectionHeadings });
  if (failOnLayout && layout.errors.length) {
    throw new PdfVerificationError(`layout verification failed: ${layout.errors.join('; ')}`);
  }
  return { pages: pages.length, text, normalizedText: normalized, layout };
}

function parseArgs(args) {
  const options = { contains: [] };
  let pdf = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--contains') options.contains.push(args[++index] || '');
    else if (arg.startsWith('--contains=')) options.contains.push(arg.slice(11));
    else if (arg === '--min-chars') options.minChars = Number(args[++index]);
    else if (arg.startsWith('--min-chars=')) options.minChars = Number(arg.slice(12));
    else if (arg === '--dump-text') options.dumpText = args[++index];
    else if (arg.startsWith('--dump-text=')) options.dumpText = arg.slice(12);
    else if (!pdf) pdf = arg;
    else throw new PdfVerificationError(`unexpected argument: ${arg}`);
  }
  if (!pdf) throw new PdfVerificationError('Usage: node verify-pdf.mjs <file.pdf> [--min-chars N] [--contains text] [--dump-text file]');
  if (options.minChars !== undefined && (!Number.isInteger(options.minChars) || options.minChars < 1)) {
    throw new PdfVerificationError('--min-chars must be a positive integer');
  }
  return { pdf, options };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  try {
    const { pdf, options } = parseArgs(process.argv.slice(2));
    const result = await verifyPdfFile(pdf, options);
    console.log(`Verified ${pdf} (pages: ${result.pages}, ATS text: ${result.normalizedText.length} chars)`);
    for (const warning of result.layout.warnings) console.warn(`Warning: ${warning}`);
  } catch (error) {
    console.error(`PDF verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
