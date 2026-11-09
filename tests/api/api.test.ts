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

const TEST_AGENT_KEY = 'test-agent-key-secret-999';
const TEST_EMPLOYEE_SECRET = 'employee-bearer-token-123';

test('PrintBridgeApi lists office printers including HP LaserJet M1136', () => {
  const api = new PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
  const printers = api.getPrinters();
  assert.equal(printers.length >= 2, true);
  const hp = printers.find(p => p.id === 'hp-laserjet-m1136');
  assert.ok(hp);
  assert.equal(hp?.supportsColor, false);
});

test('Employee authentication fails closed with invalid/missing token', () => {
  const api = new PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });

  assert.throws(() => api.authenticateEmployee(undefined), /Missing or invalid Authorization header/);
  assert.throws(() => api.authenticateEmployee('Bearer wrong-token'), /Invalid employee authentication token/);

  const auth = api.authenticateEmployee(`Bearer ${TEST_EMPLOYEE_SECRET}`);
  assert.equal(auth.userId, 'emp_authorized');
  assert.equal(auth.tenantId, 'dtc-office');
});

test('PrintBridgeApi creates print job and validates format and printer settings', async () => {
  const api = new PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  const res = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'employee-1',
    userEmail: 'employee@office.local',
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

test('PrintBridgeApi claims job with secure lease token and validates download endpoint', async () => {
  const api = new PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  const createRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'employee-1',
    userEmail: 'employee@office.local',
    printerId: 'hp-laserjet-m1136',
    filename: 'doc.pdf',
    fileBytes: pdfBytes,
    settings: defaultSettings
  });

  assert.ok(createRes.job);

  // Unauthorized agent claim fails closed
  await assert.rejects(
    async () => {
      await api.claimJob({
        agentId: 'gateway-win10',
        agentVersion: '1.0.0',
        supportedPrinters: ['hp-laserjet-m1136']
      }, 'wrong-agent-key');
    },
    /Unauthorized/
  );

  // Authorized claim
  const claimRes = await api.claimJob({
    agentId: 'gateway-win10',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);

  assert.ok(claimRes.job);
  assert.equal(claimRes.job?.id, createRes.job?.id);
  assert.equal(claimRes.job?.status, 'claimed');
  assert.ok(claimRes.leaseToken);

  // Test authenticated document download with invalid lease token
  const badDl = await api.getDocumentPayload(claimRes.job!.id, 'invalid-lease-token', TEST_AGENT_KEY);
  assert.equal(badDl.statusCode, 403);
  assert.match(badDl.error || '', /Invalid lease token/);

  // Test authenticated document download with valid lease token
  const goodDl = await api.getDocumentPayload(claimRes.job!.id, claimRes.leaseToken!, TEST_AGENT_KEY);
  assert.ok(goodDl.fileBytes);
  assert.equal(goodDl.filename, 'doc.pdf');
  assert.deepEqual(goodDl.fileBytes, pdfBytes);

  // Status update to completed cleans up storage payload
  const updateRes = await api.updateJobStatus({
    jobId: claimRes.job!.id,
    agentId: 'gateway-win10',
    leaseToken: claimRes.leaseToken!,
    status: 'completed',
    statusMessage: 'Spooler confirmed handoff to office printer'
  }, TEST_AGENT_KEY);

  assert.equal(updateRes.success, true);
  const finalJob = await api.getJob(claimRes.job!.id);
  assert.equal(finalJob?.status, 'completed');
  assert.equal(api.getFileBytes(finalJob!.r2StorageKey), undefined); // Scrubbed from storage
});
