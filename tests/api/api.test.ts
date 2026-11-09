import test from 'node:test';
import assert from 'node:assert/strict';
import { PrintBridgeApi } from '../../apps/api/dist/index.js';
import { PrintSettings } from '../../packages/shared/dist/index.js';

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

test('PrintBridgeApi lists office printers including HP LaserJet M1136', () => {
  const api = new PrintBridgeApi('test-key');
  const printers = api.getPrinters();
  assert.equal(printers.length >= 2, true);
  const hp = printers.find(p => p.id === 'hp-laserjet-m1136');
  assert.ok(hp);
  assert.equal(hp?.supportsColor, false);
});

test('PrintBridgeApi creates print job and validates format and printer settings', async () => {
  const api = new PrintBridgeApi('test-key');
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  const res = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'employee-1',
    userEmail: 'employee@dtc.local',
    printerId: 'hp-laserjet-m1136',
    filename: 'quarterly_report.pdf',
    fileBytes: pdfBytes,
    settings: defaultSettings
  });

  assert.equal(res.success, true);
  assert.ok(res.job);
  assert.equal(res.job?.fileFormat, 'pdf');
  assert.equal(res.job?.status, 'pending');
});

test('PrintBridgeApi rejects job with invalid printer options (e.g. color on M1136)', async () => {
  const api = new PrintBridgeApi('test-key');
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  const res = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'employee-1',
    userEmail: 'employee@dtc.local',
    printerId: 'hp-laserjet-m1136',
    filename: 'report.pdf',
    fileBytes: pdfBytes,
    settings: { ...defaultSettings, colorMode: 'color' }
  });

  assert.equal(res.success, false);
  assert.match(res.error || '', /does not support color/i);
});

test('PrintBridgeApi claims job with lease and validates agent authentication', async () => {
  const apiKey = 'secret-gateway-token';
  const api = new PrintBridgeApi(apiKey);
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  const createRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'employee-1',
    userEmail: 'employee@dtc.local',
    printerId: 'hp-laserjet-m1136',
    filename: 'doc.pdf',
    fileBytes: pdfBytes,
    settings: defaultSettings
  });

  assert.ok(createRes.job);

  // Unauthorized agent claim
  await assert.rejects(
    async () => {
      await api.claimJob({
        agentId: 'gateway-win10',
        agentVersion: '1.0.0',
        supportedPrinters: ['hp-laserjet-m1136']
      }, 'wrong-key');
    },
    /Unauthorized agent gateway key/
  );

  // Authorized claim
  const claimRes = await api.claimJob({
    agentId: 'gateway-win10',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, apiKey);

  assert.ok(claimRes.job);
  assert.equal(claimRes.job?.id, createRes.job?.id);
  assert.equal(claimRes.job?.status, 'claimed');
  assert.ok(claimRes.leaseToken);

  // Second claim when job is already claimed and lease active -> returns null
  const secondClaim = await api.claimJob({
    agentId: 'gateway-win10-2',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, apiKey);
  assert.equal(secondClaim.job, null);

  // Status update to completed cleans up R2 storage payload
  const updateRes = await api.updateJobStatus({
    jobId: claimRes.job!.id,
    agentId: 'gateway-win10',
    leaseToken: claimRes.leaseToken!,
    status: 'completed',
    statusMessage: 'Spooler confirmed handoff to HP LaserJet M1136'
  }, apiKey);

  assert.equal(updateRes.success, true);
  const finalJob = api.getJob(claimRes.job!.id);
  assert.equal(finalJob?.status, 'completed');
  assert.equal(api.getFileBytes(finalJob!.r2StorageKey), undefined); // Auto deleted from storage
});
