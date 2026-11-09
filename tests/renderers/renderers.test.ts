import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RendererRegistry } from '../../packages/renderers/dist/index.js';
import { PrintSettings } from '../../packages/shared/dist/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-render-test-'));

const defaultSettings: PrintSettings = {
  copies: 1,
  orientation: 'portrait',
  paperSize: 'a4',
  pageRangeType: 'all',
  duplex: 'simplex',
  colorMode: 'grayscale',
  scaling: 'fit',
  collate: true
};

test('RendererRegistry finds appropriate adapters for formats', () => {
  const registry = new RendererRegistry();
  assert.equal(registry.findRenderer('pdf')?.id, 'pdf-renderer');
  assert.equal(registry.findRenderer('png')?.id, 'image-renderer');
  assert.equal(registry.findRenderer('txt')?.id, 'text-renderer');
  assert.equal(registry.findRenderer('docx')?.id, 'office-renderer');
  assert.equal(registry.findRenderer('html')?.id, 'webpage-renderer');
});

test('TextRenderer renders multi-line text into pages', async () => {
  const registry = new RendererRegistry();
  const renderer = registry.findRenderer('txt')!;

  const txtPath = path.join(tempDir, 'test.txt');
  const lines = Array.from({ length: 120 }, (_, i) => `Line number ${i + 1}`).join('\n');
  fs.writeFileSync(txtPath, lines, 'utf-8');

  const res = await renderer.render({
    jobId: 'job-text-1',
    sourceFilePath: txtPath,
    workingDir: tempDir,
    settings: { ...defaultSettings, pageRangeType: 'custom', customPageRanges: '1-2' }
  });

  assert.equal(res.success, true);
  assert.equal(res.totalPages, 3); // 120 lines / 55 lines per page = 3 pages
  assert.deepEqual(res.printedPages, [1, 2]);
  assert.equal(res.pages.length, 2);
});

test('PdfRenderer inspects and renders mock PDF', async () => {
  const registry = new RendererRegistry();
  const renderer = registry.findRenderer('pdf')!;

  const pdfPath = path.join(tempDir, 'sample.pdf');
  // Minimal valid PDF structure with 2 pages
  const dummyPdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page >> endobj
4 0 obj << /Type /Page >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
  fs.writeFileSync(pdfPath, dummyPdf, 'utf-8');

  const inspectRes = await renderer.inspect(pdfPath);
  assert.equal(inspectRes.totalPages, 2);

  const renderRes = await renderer.render({
    jobId: 'job-pdf-1',
    sourceFilePath: pdfPath,
    workingDir: tempDir,
    settings: { ...defaultSettings, pageRangeType: 'even' } // even pages = page 2
  });

  assert.equal(renderRes.success, true);
  assert.deepEqual(renderRes.printedPages, [2]);
});

test('OfficeRenderer clearly reports missing engine without dry-run, succeeds with dry-run', async () => {
  const registry = new RendererRegistry();
  const renderer = registry.findRenderer('docx')!;

  const docxPath = path.join(tempDir, 'memo.docx');
  fs.writeFileSync(docxPath, 'fake-docx-content');

  // Without dryRun and without engine: reports clearly missing engine
  const liveRes = await renderer.render({
    jobId: 'job-doc-1',
    sourceFilePath: docxPath,
    workingDir: tempDir,
    settings: defaultSettings,
    dryRun: false
  });
  assert.equal(liveRes.success, false);
  assert.match(liveRes.error || '', /is not installed on this gateway/i);

  // In dryRun mode: succeeds with emulated spool
  const dryRes = await renderer.render({
    jobId: 'job-doc-2',
    sourceFilePath: docxPath,
    workingDir: tempDir,
    settings: defaultSettings,
    dryRun: true
  });
  assert.equal(dryRes.success, true);
  assert.equal(dryRes.pages.length, 1);
});

test('WebpageRenderer sanitizes script tags from HTML', async () => {
  const registry = new RendererRegistry();
  const renderer = registry.findRenderer('html')!;

  const htmlPath = path.join(tempDir, 'print.html');
  const rawHtml = '<html><body><h1>Invoice</h1><script>alert("hacked")</script><div>Content</div></body></html>';
  fs.writeFileSync(htmlPath, rawHtml, 'utf-8');

  const res = await renderer.render({
    jobId: 'job-html-1',
    sourceFilePath: htmlPath,
    workingDir: tempDir,
    settings: defaultSettings
  });

  assert.equal(res.success, true);
  const renderedContent = new TextDecoder().decode(res.pages[0].rawBytes);
  assert.doesNotMatch(renderedContent, /alert\("hacked"\)/);
  assert.match(renderedContent, /script removed for print security/);
});
