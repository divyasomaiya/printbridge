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
const TEST_ADMIN_PASSWORD = 'super-secret-admin-pw';

test('PrintBridgeApi lists office printers including HP LaserJet M1136', () => {
  const api = new PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
  const printers = api.getPrinters();
  assert.equal(printers.length >= 2, true);
  const hp = printers.find(p => p.id === 'hp-laserjet-m1136');
  assert.ok(hp);
  assert.equal(hp?.supportsColor, false);
});

test('Public Guest Workflow: Submit with name (no PIN/login) -> Unguessable Receipt -> Status Inquiry', async () => {
  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    adminPassword: TEST_ADMIN_PASSWORD
  });

  // 1. Submit guest print job with only name and document
  const guestJobRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'guest_user',
    userEmail: 'guest@office.local',
    guestName: 'Visiting Client John',
    printerId: 'hp-laserjet-m1136',
    filename: 'contract.pdf',
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
    settings: defaultSettings
  });

  assert.equal(guestJobRes.success, true);
  assert.ok(guestJobRes.job);
  assert.ok(guestJobRes.receiptToken);
  assert.equal(guestJobRes.job.employeeName, 'Visiting Client John');
  const jobId = guestJobRes.job.id;
  const receiptToken = guestJobRes.receiptToken!;

  // 2. Guest checks status with valid unguessable receipt token -> Succeeds
  const validStatus = await api.getJob(jobId, 'dtc-office', receiptToken);
  assert.ok(validStatus);
  assert.equal(validStatus.id, jobId);

  // 3. Guest checks status with WRONG receipt token -> Denied (prevents cross-guest snooping)
  const invalidStatus = await api.getJob(jobId, 'dtc-office', 'wrong-receipt-token');
  assert.equal(invalidStatus, undefined);
});

test('Admin Workflow: Login with admin123 -> Inspect Queue -> Pause Queue -> Cancel Job', async () => {
  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    adminPassword: TEST_ADMIN_PASSWORD
  });

  // 1. Admin login with bad credentials
  const badLogin = await api.adminLogin('wronguser', TEST_ADMIN_PASSWORD);
  assert.equal(badLogin.success, false);

  const badPw = await api.adminLogin('admin123', 'wrongpassword');
  assert.equal(badPw.success, false);

  // 2. Admin login with admin123 and correct password -> issues signed session token
  const goodLogin = await api.adminLogin('admin123', TEST_ADMIN_PASSWORD);
  assert.equal(goodLogin.success, true);
  assert.ok(goodLogin.token);
  assert.match(goodLogin.token!, /^sess\./);

  // 3. Create a guest job to inspect in queue
  const jobRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'guest_1',
    userEmail: 'guest@office.local',
    guestName: 'Alex Smith',
    printerId: 'hp-laserjet-m1136',
    filename: 'invoice.pdf',
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    settings: defaultSettings
  });
  assert.ok(jobRes.job);

  // 4. Admin inspects queue
  const queue = await api.getAdminQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].employeeName, 'Alex Smith');

  // 5. Admin pauses queue
  api.setQueueSettings({ queuePaused: true });
  assert.equal(api.getQueueSettings().queuePaused, true);

  // 6. Submitting a new job while paused fails
  const pausedRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'guest_2',
    userEmail: 'guest2@office.local',
    guestName: 'Bob',
    printerId: 'hp-laserjet-m1136',
    filename: 'test.pdf',
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    settings: defaultSettings
  });
  assert.equal(pausedRes.success, false);
  assert.match(pausedRes.error || '', /paused/);

  // 7. Resume queue and cancel job
  api.setQueueSettings({ queuePaused: false });
  const cancelRes = await api.cancelJob(jobRes.job.id);
  assert.equal(cancelRes.success, true);
  const cancelledJob = await api.getJob(jobRes.job.id);
  assert.equal(cancelledJob?.status, 'cancelled');
});

test('Worker fetch handler routes public guest printing and admin login', async () => {
  const env = {
    GATEWAY_API_KEY: TEST_AGENT_KEY,
    EMPLOYEE_AUTH_SECRET: TEST_EMPLOYEE_SECRET,
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ENVIRONMENT: 'development'
  };

  // 1. Guest submits print job without any auth header
  const guestUploadReq = new Request('http://worker.local/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      guestName: 'Guest Mary',
      printerId: 'hp-laserjet-m1136',
      filename: 'flyer.pdf',
      fileBase64: 'JVBERi0xLjQ=',
      settings: defaultSettings
    })
  });
  const uploadRes = await workerHandler.fetch(guestUploadReq, env);
  assert.equal(uploadRes.status, 201);
  const uploadData: any = await uploadRes.json();
  assert.ok(uploadData.job?.id);
  assert.ok(uploadData.receiptToken);
  assert.equal(uploadData.job.employeeName, 'Guest Mary');

  const jobId = uploadData.job.id;
  const receiptToken = uploadData.receiptToken;

  // 2. Guest checks status with receipt token
  const statusReq = new Request(`http://worker.local/api/jobs/${jobId}?receiptToken=${receiptToken}`);
  const statusRes = await workerHandler.fetch(statusReq, env);
  assert.equal(statusRes.status, 200);
  const statusData: any = await statusRes.json();
  assert.equal(statusData.id, jobId);

  // 3. Unauthenticated access without receipt token is rejected (401)
  const snoopingReq = new Request(`http://worker.local/api/jobs/${jobId}`);
  const snoopingRes = await workerHandler.fetch(snoopingReq, env);
  assert.equal(snoopingRes.status, 401);

  // 4. Admin login via /api/admin/login
  const adminLoginReq = new Request('http://worker.local/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin123', password: TEST_ADMIN_PASSWORD })
  });
  const adminLoginRes = await workerHandler.fetch(adminLoginReq, env);
  assert.equal(adminLoginRes.status, 200);
  const adminData: any = await adminLoginRes.json();
  assert.ok(adminData.token);

  // 5. Admin queue inspection
  const queueReq = new Request('http://worker.local/api/admin/queue', {
    headers: { 'Authorization': `Bearer ${adminData.token}` }
  });
  const queueRes = await workerHandler.fetch(queueReq, env);
  assert.equal(queueRes.status, 200);
  const queueData: any = await queueRes.json();
  assert.ok(Array.isArray(queueData));
});
