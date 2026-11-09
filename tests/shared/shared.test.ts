import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePrintSettings,
  resolvePageNumbers,
  validateUploadedFile,
  HP_LASERJET_M1136_CAPABILITY,
  MOCK_PRINTER_CAPABILITY,
  PrintSettings
} from '../../packages/shared/dist/index.js';

test('HP LaserJet M1136 capability profile validation', () => {
  assert.equal(HP_LASERJET_M1136_CAPABILITY.supportsColor, false);
  assert.equal(HP_LASERJET_M1136_CAPABILITY.supportsAutoDuplex, false);
  assert.equal(HP_LASERJET_M1136_CAPABILITY.supportsManualDuplex, true);
  assert.equal(HP_LASERJET_M1136_CAPABILITY.host, 'SILVERTOUCH-PC');
});

test('validatePrintSettings rejects color on monochrome printer', () => {
  const settings: PrintSettings = {
    copies: 1,
    orientation: 'portrait',
    paperSize: 'a4',
    pageRangeType: 'all',
    duplex: 'simplex',
    colorMode: 'color',
    scaling: 'fit',
    collate: true
  };

  const res = validatePrintSettings(settings, HP_LASERJET_M1136_CAPABILITY);
  assert.equal(res.isValid, false);
  assert.match(res.error || '', /does not support color/i);
});

test('validatePrintSettings rejects automatic duplex on HP LaserJet M1136', () => {
  const settings: PrintSettings = {
    copies: 1,
    orientation: 'portrait',
    paperSize: 'a4',
    pageRangeType: 'all',
    duplex: 'duplex_long_edge',
    colorMode: 'grayscale',
    scaling: 'fit',
    collate: true
  };

  const res = validatePrintSettings(settings, HP_LASERJET_M1136_CAPABILITY);
  assert.equal(res.isValid, false);
  assert.match(res.error || '', /does not support automatic duplex/i);
});

test('validatePrintSettings warns on manual duplex', () => {
  const settings: PrintSettings = {
    copies: 1,
    orientation: 'portrait',
    paperSize: 'a4',
    pageRangeType: 'all',
    duplex: 'manual_duplex',
    colorMode: 'grayscale',
    scaling: 'fit',
    collate: true
  };

  const res = validatePrintSettings(settings, HP_LASERJET_M1136_CAPABILITY);
  assert.equal(res.isValid, true);
  assert.match(res.warning || '', /Manual duplex requires human intervention/i);
});

test('resolvePageNumbers handles all, odd, even', () => {
  assert.deepEqual(resolvePageNumbers('all', undefined, 5).pages, [1, 2, 3, 4, 5]);
  assert.deepEqual(resolvePageNumbers('odd', undefined, 6).pages, [1, 3, 5]);
  assert.deepEqual(resolvePageNumbers('even', undefined, 6).pages, [2, 4, 6]);
  assert.equal(resolvePageNumbers('even', undefined, 1).success, false);
});

test('resolvePageNumbers handles custom ranges and bounds checking', () => {
  const res = resolvePageNumbers('custom', '1-3, 5, 8-10', 10);
  assert.equal(res.success, true);
  assert.deepEqual(res.pages, [1, 2, 3, 5, 8, 9, 10]);

  const outOfBounds = resolvePageNumbers('custom', '1-5, 12', 10);
  assert.equal(outOfBounds.success, false);
  assert.match(outOfBounds.error || '', /bounds/i);

  const invalidSyntax = resolvePageNumbers('custom', '1-foo', 10);
  assert.equal(invalidSyntax.success, false);
});

test('validateUploadedFile validates formats and magic bytes', () => {
  // Empty file
  assert.equal(validateUploadedFile('doc.pdf', 0).isValid, false);

  // Exceeds max size (51 MB)
  assert.equal(validateUploadedFile('doc.pdf', 51 * 1024 * 1024).isValid, false);

  // Valid PDF with magic bytes %PDF
  const validPdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const pdfRes = validateUploadedFile('report.pdf', 1024, validPdfHeader);
  assert.equal(pdfRes.isValid, true);
  assert.equal(pdfRes.format, 'pdf');

  // Spoofed PDF (has .pdf ext but PNG magic bytes)
  const fakePdfHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fakeRes = validateUploadedFile('fake.pdf', 1024, fakePdfHeader);
  assert.equal(fakeRes.isValid, false);

  // Valid PNG
  const pngRes = validateUploadedFile('image.png', 2048, fakePdfHeader);
  assert.equal(pngRes.isValid, true);
  assert.equal(pngRes.format, 'png');

  // Unsupported file extension
  const exeRes = validateUploadedFile('malware.exe', 5000);
  assert.equal(exeRes.isValid, false);
  assert.match(exeRes.error || '', /Unsupported file extension/i);
});
