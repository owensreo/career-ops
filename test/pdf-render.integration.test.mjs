import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderHtmlToPdf } from '../generate-pdf.mjs';

test('Playwright PDF fixture has a verified final ATS text layer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-pdf-fixture-'));
  const output = join(dir, 'fixture.pdf');
  const html = `<!doctype html><html><head><style>
    body { font: 12pt Arial, sans-serif; line-height: 1.4; }
    .section { margin: 0 0 18px; } .section-title { font-weight: 700; }
  </style></head><body><h1>Fixture Candidate</h1><p>fixture@example.com</p>
    <div class="section"><div class="section-title">Professional Summary</div>
    <p>Platform engineer delivering reliable automation, security improvements, and measurable operational outcomes.</p></div>
    <div class="section"><div class="section-title">Experience</div>
    <p>Built Node.js services, Playwright workflows, and cloud infrastructure with clear ownership and resilient delivery.</p></div>
    <div class="section"><div class="section-title">Skills</div>
    <p>Node.js, Playwright, cloud infrastructure, security engineering, and stakeholder communication.</p></div>
  </body></html>`;
  try {
    const result = await renderHtmlToPdf(html, output, { baseDir: dir, verifyCv: true });
    assert.equal(existsSync(output), true);
    assert.equal(result.pageCount, 1);
    assert.match(result.verification.normalizedText, /fixture@example\.com/);
    assert.equal(result.verification.layout.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared renderer still accepts a short document without CV contact data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-pdf-other-'));
  const output = join(dir, 'letter.pdf');
  try {
    const result = await renderHtmlToPdf('<html><body>A short letter.</body></html>', output, { baseDir: dir });
    assert.equal(existsSync(output), true);
    assert.equal(result.verification, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
