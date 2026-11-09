"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const index_js_1 = require("../../packages/renderers/dist/index.js");
const tempDir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'pb-render-test-'));
const defaultSettings = {
    copies: 1,
    orientation: 'portrait',
    paperSize: 'a4',
    pageRangeType: 'all',
    duplex: 'simplex',
    colorMode: 'grayscale',
    scaling: 'fit',
    collate: true
};
(0, node_test_1.default)('RendererRegistry finds appropriate adapters for formats', () => {
    const registry = new index_js_1.RendererRegistry();
    strict_1.default.equal(registry.findRenderer('pdf')?.id, 'pdf-renderer');
    strict_1.default.equal(registry.findRenderer('png')?.id, 'image-renderer');
    strict_1.default.equal(registry.findRenderer('txt')?.id, 'text-renderer');
    strict_1.default.equal(registry.findRenderer('docx')?.id, 'office-renderer');
    strict_1.default.equal(registry.findRenderer('html')?.id, 'webpage-renderer');
});
(0, node_test_1.default)('TextRenderer renders multi-line text into pages', async () => {
    const registry = new index_js_1.RendererRegistry();
    const renderer = registry.findRenderer('txt');
    const txtPath = node_path_1.default.join(tempDir, 'test.txt');
    const lines = Array.from({ length: 120 }, (_, i) => `Line number ${i + 1}`).join('\n');
    node_fs_1.default.writeFileSync(txtPath, lines, 'utf-8');
    const res = await renderer.render({
        jobId: 'job-text-1',
        sourceFilePath: txtPath,
        workingDir: tempDir,
        settings: { ...defaultSettings, pageRangeType: 'custom', customPageRanges: '1-2' }
    });
    strict_1.default.equal(res.success, true);
    strict_1.default.equal(res.totalPages, 3); // 120 lines / 55 lines per page = 3 pages
    strict_1.default.deepEqual(res.printedPages, [1, 2]);
    strict_1.default.equal(res.pages.length, 2);
});
(0, node_test_1.default)('PdfRenderer inspects and renders mock PDF', async () => {
    const registry = new index_js_1.RendererRegistry();
    const renderer = registry.findRenderer('pdf');
    const pdfPath = node_path_1.default.join(tempDir, 'sample.pdf');
    // Minimal valid PDF structure with 2 pages
    const dummyPdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page >> endobj
4 0 obj << /Type /Page >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
    node_fs_1.default.writeFileSync(pdfPath, dummyPdf, 'utf-8');
    const inspectRes = await renderer.inspect(pdfPath);
    strict_1.default.equal(inspectRes.totalPages, 2);
    const renderRes = await renderer.render({
        jobId: 'job-pdf-1',
        sourceFilePath: pdfPath,
        workingDir: tempDir,
        settings: { ...defaultSettings, pageRangeType: 'even' } // even pages = page 2
    });
    strict_1.default.equal(renderRes.success, true);
    strict_1.default.deepEqual(renderRes.printedPages, [2]);
});
(0, node_test_1.default)('OfficeRenderer clearly reports missing engine without dry-run, succeeds with dry-run', async () => {
    const registry = new index_js_1.RendererRegistry();
    const renderer = registry.findRenderer('docx');
    const docxPath = node_path_1.default.join(tempDir, 'memo.docx');
    node_fs_1.default.writeFileSync(docxPath, 'fake-docx-content');
    // Without dryRun and without engine: reports clearly missing engine
    const liveRes = await renderer.render({
        jobId: 'job-doc-1',
        sourceFilePath: docxPath,
        workingDir: tempDir,
        settings: defaultSettings,
        dryRun: false
    });
    strict_1.default.equal(liveRes.success, false);
    strict_1.default.match(liveRes.error || '', /is not installed on this gateway/i);
    // In dryRun mode: succeeds with emulated spool
    const dryRes = await renderer.render({
        jobId: 'job-doc-2',
        sourceFilePath: docxPath,
        workingDir: tempDir,
        settings: defaultSettings,
        dryRun: true
    });
    strict_1.default.equal(dryRes.success, true);
    strict_1.default.equal(dryRes.pages.length, 1);
});
(0, node_test_1.default)('WebpageRenderer sanitizes script tags from HTML', async () => {
    const registry = new index_js_1.RendererRegistry();
    const renderer = registry.findRenderer('html');
    const htmlPath = node_path_1.default.join(tempDir, 'print.html');
    const rawHtml = '<html><body><h1>Invoice</h1><script>alert("hacked")</script><div>Content</div></body></html>';
    node_fs_1.default.writeFileSync(htmlPath, rawHtml, 'utf-8');
    const res = await renderer.render({
        jobId: 'job-html-1',
        sourceFilePath: htmlPath,
        workingDir: tempDir,
        settings: defaultSettings
    });
    strict_1.default.equal(res.success, true);
    const renderedContent = new TextDecoder().decode(res.pages[0].rawBytes);
    strict_1.default.doesNotMatch(renderedContent, /alert\("hacked"\)/);
    strict_1.default.match(renderedContent, /script removed for print security/);
});
