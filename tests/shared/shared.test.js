"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/shared/dist/index.js");
(0, node_test_1.default)('HP LaserJet M1136 capability profile validation and UNC path escaping', () => {
    strict_1.default.equal(index_js_1.HP_LASERJET_M1136_CAPABILITY.supportsColor, false);
    strict_1.default.equal(index_js_1.HP_LASERJET_M1136_CAPABILITY.supportsAutoDuplex, false);
    strict_1.default.equal(index_js_1.HP_LASERJET_M1136_CAPABILITY.supportsManualDuplex, true);
    strict_1.default.equal(index_js_1.HP_LASERJET_M1136_CAPABILITY.host, 'SILVERTOUCH-PC');
    // Verify runtime UNC path has exactly 2 leading backslashes and 1 separator backslash
    strict_1.default.equal(index_js_1.HP_LASERJET_M1136_CAPABILITY.fullUncPath, '\\\\SILVERTOUCH-PC\\HP LaserJet Professional M1136 MFP');
    strict_1.default.equal(index_js_1.HP_LASERJET_M1136_CAPABILITY.fullUncPath.startsWith('\\\\'), true);
    strict_1.default.equal(index_js_1.HP_LASERJET_M1136_CAPABILITY.fullUncPath.startsWith('\\\\\\'), false);
});
(0, node_test_1.default)('validatePrintSettings rejects color on monochrome printer', () => {
    const settings = {
        copies: 1,
        orientation: 'portrait',
        paperSize: 'a4',
        pageRangeType: 'all',
        duplex: 'simplex',
        colorMode: 'color',
        scaling: 'fit',
        collate: true
    };
    const res = (0, index_js_1.validatePrintSettings)(settings, index_js_1.HP_LASERJET_M1136_CAPABILITY);
    strict_1.default.equal(res.isValid, false);
    strict_1.default.match(res.error || '', /does not support color/i);
});
(0, node_test_1.default)('validatePrintSettings rejects automatic duplex on HP LaserJet M1136', () => {
    const settings = {
        copies: 1,
        orientation: 'portrait',
        paperSize: 'a4',
        pageRangeType: 'all',
        duplex: 'duplex_long_edge',
        colorMode: 'grayscale',
        scaling: 'fit',
        collate: true
    };
    const res = (0, index_js_1.validatePrintSettings)(settings, index_js_1.HP_LASERJET_M1136_CAPABILITY);
    strict_1.default.equal(res.isValid, false);
    strict_1.default.match(res.error || '', /does not support automatic duplex/i);
});
(0, node_test_1.default)('validatePrintSettings warns on manual duplex', () => {
    const settings = {
        copies: 1,
        orientation: 'portrait',
        paperSize: 'a4',
        pageRangeType: 'all',
        duplex: 'manual_duplex',
        colorMode: 'grayscale',
        scaling: 'fit',
        collate: true
    };
    const res = (0, index_js_1.validatePrintSettings)(settings, index_js_1.HP_LASERJET_M1136_CAPABILITY);
    strict_1.default.equal(res.isValid, true);
    strict_1.default.match(res.warning || '', /Manual duplex requires human intervention/i);
});
(0, node_test_1.default)('resolvePageNumbers handles all, odd, even', () => {
    strict_1.default.deepEqual((0, index_js_1.resolvePageNumbers)('all', undefined, 5).pages, [1, 2, 3, 4, 5]);
    strict_1.default.deepEqual((0, index_js_1.resolvePageNumbers)('odd', undefined, 6).pages, [1, 3, 5]);
    strict_1.default.deepEqual((0, index_js_1.resolvePageNumbers)('even', undefined, 6).pages, [2, 4, 6]);
    strict_1.default.equal((0, index_js_1.resolvePageNumbers)('even', undefined, 1).success, false);
});
(0, node_test_1.default)('resolvePageNumbers handles custom ranges and bounds checking', () => {
    const res = (0, index_js_1.resolvePageNumbers)('custom', '1-3, 5, 8-10', 10);
    strict_1.default.equal(res.success, true);
    strict_1.default.deepEqual(res.pages, [1, 2, 3, 5, 8, 9, 10]);
    const outOfBounds = (0, index_js_1.resolvePageNumbers)('custom', '1-5, 12', 10);
    strict_1.default.equal(outOfBounds.success, false);
    strict_1.default.match(outOfBounds.error || '', /bounds/i);
    const invalidSyntax = (0, index_js_1.resolvePageNumbers)('custom', '1-foo', 10);
    strict_1.default.equal(invalidSyntax.success, false);
});
(0, node_test_1.default)('validateUploadedFile validates formats and magic bytes', () => {
    // Empty file
    strict_1.default.equal((0, index_js_1.validateUploadedFile)('doc.pdf', 0).isValid, false);
    // Exceeds max size (51 MB)
    strict_1.default.equal((0, index_js_1.validateUploadedFile)('doc.pdf', 51 * 1024 * 1024).isValid, false);
    // Valid PDF with magic bytes %PDF
    const validPdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const pdfRes = (0, index_js_1.validateUploadedFile)('report.pdf', 1024, validPdfHeader);
    strict_1.default.equal(pdfRes.isValid, true);
    strict_1.default.equal(pdfRes.format, 'pdf');
    // Spoofed PDF (has .pdf ext but PNG magic bytes)
    const fakePdfHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fakeRes = (0, index_js_1.validateUploadedFile)('fake.pdf', 1024, fakePdfHeader);
    strict_1.default.equal(fakeRes.isValid, false);
    // Valid PNG
    const pngRes = (0, index_js_1.validateUploadedFile)('image.png', 2048, fakePdfHeader);
    strict_1.default.equal(pngRes.isValid, true);
    strict_1.default.equal(pngRes.format, 'png');
    // Unsupported file extension
    const exeRes = (0, index_js_1.validateUploadedFile)('malware.exe', 5000);
    strict_1.default.equal(exeRes.isValid, false);
    strict_1.default.match(exeRes.error || '', /Unsupported file extension/i);
});
