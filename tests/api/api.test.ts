import test from 'node:test';
import assert from 'node:assert/strict';
import { PrintBridgeApi, default as workerHandler } from '../../apps/api/dist/index.js';
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

  const dummyHeaders = new Headers();
  assert.throws(() => api.authenticateEmployee(dummyHeaders), /Missing or invalid Authorization header/);

  dummyHeaders.set('Authorization', 'Bearer wrong-token');
  assert.throws(() => api.authenticateEmployee(dummyHeaders), /Invalid employee authentication token/);

  dummyHeaders.set('Authorization', `Bearer ${TEST_EMPLOYEE_SECRET}`);
  const auth = api.authenticateEmployee(dummyHeaders);
  assert.equal(auth.userId, 'emp_authorized');
  assert.equal(auth.tenantId, 'dtc-office');
});

test('Cloudflare Access header automatically authenticates employee', () => {
  const api = new PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
  const headers = new Headers();
  headers.set('Cf-Access-Authenticated-User-Email', 'sarah@office.local');

  const auth = api.authenticateEmployee(headers);
  assert.equal(auth.userId, 'sarah@office.local');
  assert.equal(auth.userEmail, 'sarah@office.local');
});

test('Worker fetch handler executes real HTTP routing, auth check, and session exchange', async () => {
  const env = {
    GATEWAY_API_KEY: TEST_AGENT_KEY,
    EMPLOYEE_AUTH_SECRET: TEST_EMPLOYEE_SECRET,
    ENVIRONMENT: 'development'
  };

  // 1. Session exchange with valid passkey
  const sessReq = new Request('http://worker.local/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passkey: TEST_EMPLOYEE_SECRET })
  });
  const sessRes = await workerHandler.fetch(sessReq, env);
  assert.equal(sessRes.status, 200);
  const sessData: any = await sessRes.json();
  assert.equal(sessData.success, true);
  assert.equal(sessData.token, TEST_EMPLOYEE_SECRET);

  // 2. Reject job creation with missing auth
  const unauthReq = new Request('http://worker.local/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ printerId: 'hp-laserjet-m1136', filename: 'test.pdf', fileBase64: 'JVBERi0xLjQ=', settings: defaultSettings })
  });
  const unauthRes = await workerHandler.fetch(unauthReq, env);
  assert.equal(unauthRes.status, 401);

  // 3. Authenticated job creation
  const authReq = new Request('http://worker.local/api/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_EMPLOYEE_SECRET}`
    },
    body: JSON.stringify({ printerId: 'hp-laserjet-m1136', filename: 'test.pdf', fileBase64: 'JVBERi0xLjQ=', settings: defaultSettings })
  });
  const authRes = await workerHandler.fetch(authReq, env);
  assert.equal(authRes.status, 201);
  const authData: any = await authRes.json();
  assert.ok(authData.job?.id);
  const jobId = authData.job.id;

  // 4. Secure job status inquiry
  const statusReq = new Request(`http://worker.local/api/jobs/${jobId}`, {
    headers: { 'Authorization': `Bearer ${TEST_EMPLOYEE_SECRET}` }
  });
  const statusRes = await workerHandler.fetch(statusReq, env);
  assert.equal(statusRes.status, 200);
  const statusData: any = await statusRes.json();
  assert.equal(statusData.id, jobId);
  assert.equal(statusData.status, 'pending');

  // 5. Agent atomic claim
  const claimReq = new Request('http://worker.local/api/agent/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Key': TEST_AGENT_KEY
    },
    body: JSON.stringify({
      agentId: 'gw-win10',
      agentVersion: '1.0.0',
      supportedPrinters: ['hp-laserjet-m1136']
    })
  });
  const claimRes = await workerHandler.fetch(claimReq, env);
  assert.equal(claimRes.status, 200);
  const claimData: any = await claimRes.json();
  assert.equal(claimData.job?.id, jobId);
  assert.ok(claimData.leaseToken);

  // 6. Authenticated document download
  const dlReq = new Request(`http://worker.local${claimData.downloadUrl}`, {
    headers: { 'X-Agent-Key': TEST_AGENT_KEY }
  });
  const dlRes = await workerHandler.fetch(dlReq, env);
  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.headers.get('Content-Disposition'), 'attachment; filename="test.pdf"');
  const dlBytes = new Uint8Array(await dlRes.arrayBuffer());
  assert.equal(dlBytes[0], 0x25); // '%PDF'
});

test('State machine rejects invalid transitions (e.g. completed -> pending)', async () => {
  const api = new PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
  const createRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'emp_1',
    userEmail: 'emp@dtc.local',
    printerId: 'hp-laserjet-m1136',
    filename: 'memo.txt',
    fileBytes: new TextEncoder().encode('Hello'),
    settings: defaultSettings
  });

  const claimRes = await api.claimJob({
    agentId: 'gw-1',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);

  // Complete job
  await api.updateJobStatus({
    jobId: claimRes.job!.id,
    agentId: 'gw-1',
    leaseToken: claimRes.leaseToken!,
    status: 'completed'
  }, TEST_AGENT_KEY);

  // Attempt invalid transition back to pending
  const invalidRes = await api.updateJobStatus({
    jobId: claimRes.job!.id,
    agentId: 'gw-1',
    leaseToken: claimRes.leaseToken!,
    status: 'pending'
  }, TEST_AGENT_KEY);

  assert.equal(invalidRes.success, false);
  assert.equal(invalidRes.statusCode, 400);
  assert.match(invalidRes.error || '', /Invalid state transition/);
});
