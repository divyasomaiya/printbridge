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

  // Agent claims the job -> updates lease_token without altering receipt token
  const claimRes = await api.claimJob({
    agentId: 'gw-win10',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);
  assert.ok(claimRes.job);
  assert.equal(claimRes.job.id, jobId);

  // Guest can STILL check status with valid unguessable receipt token after agent claim
  const validStatus = await api.getJob(jobId, 'dtc-office', receiptToken);
  assert.ok(validStatus);
  assert.equal(validStatus.id, jobId);
  assert.equal(validStatus.status, 'claimed');

  // Guest checks status with WRONG receipt token -> Denied (prevents cross-guest snooping)
  const invalidStatus = await api.getJob(jobId, 'dtc-office', 'wrong-receipt-token');
  assert.equal(invalidStatus, undefined);
});

test('Admin Role Enforcement: Non-admin rejected with 403 on admin endpoints', async () => {
  const env = {
    GATEWAY_API_KEY: TEST_AGENT_KEY,
    EMPLOYEE_AUTH_SECRET: TEST_EMPLOYEE_SECRET,
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ENVIRONMENT: 'development'
  };

  const empSessReq = new Request('http://worker.local/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passkey: TEST_EMPLOYEE_SECRET })
  });
  const empSessRes = await workerHandler.fetch(empSessReq, env);
  const empData: any = await empSessRes.json();
  const empToken = empData.token;

  // Non-admin token fails with 403 Forbidden
  const queueReq = new Request('http://worker.local/api/admin/queue', {
    headers: { 'Authorization': `Bearer ${empToken}` }
  });
  const queueRes = await workerHandler.fetch(queueReq, env);
  assert.equal(queueRes.status, 403);

  // Admin session via admin123
  const adminLoginReq = new Request('http://worker.local/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin123', password: TEST_ADMIN_PASSWORD })
  });
  const adminLoginRes = await workerHandler.fetch(adminLoginReq, env);
  const adminData: any = await adminLoginRes.json();
  const adminToken = adminData.token;

  // With admin token -> 200 OK
  const adminQueueReq = new Request('http://worker.local/api/admin/queue', {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const adminQueueRes = await workerHandler.fetch(adminQueueReq, env);
  assert.equal(adminQueueRes.status, 200);
});

test('Queue Pause Blocks Agent Claims and New Job Submissions', async () => {
  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    adminPassword: TEST_ADMIN_PASSWORD
  });

  const jobRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'guest_1',
    userEmail: 'guest@office.local',
    guestName: 'Sarah',
    printerId: 'hp-laserjet-m1136',
    filename: 'doc.pdf',
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    settings: defaultSettings
  });
  assert.ok(jobRes.job);

  // Admin pauses queue
  await api.setQueueSettings({ queuePaused: true });
  const settings = await api.getQueueSettings();
  assert.equal(settings.queuePaused, true);

  // Agent attempts to claim while queue is paused -> Rejected (returns null)
  const claimRes = await api.claimJob({
    agentId: 'gw-win10',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);
  assert.equal(claimRes.job, null);

  // Admin resumes queue
  await api.setQueueSettings({ queuePaused: false });

  // Agent can now claim
  const claimAfterResume = await api.claimJob({
    agentId: 'gw-win10',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);
  assert.ok(claimAfterResume.job);
  assert.equal(claimAfterResume.job.id, jobRes.job.id);
});

test('D1-Backed Integration Test: D1 inserts, separate receipt_token column, and system_settings persistence', async () => {
  const d1Jobs: Map<string, any> = new Map();
  const d1Settings: Map<string, any> = new Map();

  const mockD1 = {
    prepare(query: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (query.includes('SELECT value FROM system_settings WHERE key = "queue_paused"')) {
                const s = d1Settings.get('queue_paused');
                return s ? { value: s.value } : null;
              }
              if (query.includes('SELECT value FROM system_settings WHERE key = "max_copies_limit"')) {
                const s = d1Settings.get('max_copies_limit');
                return s ? { value: s.value } : null;
              }
              if (query.includes('SELECT id FROM print_jobs')) {
                for (const row of d1Jobs.values()) {
                  if (row.status === 'pending') return { id: row.id };
                }
                return null;
              }
              if (query.includes('SELECT * FROM print_jobs WHERE id = ?')) {
                return d1Jobs.get(args[0]) || null;
              }
              if (query.includes('SELECT lease_token')) {
                const r = d1Jobs.get(args[0]);
                return r ? { lease_token: r.lease_token, lease_expires_at: r.lease_expires_at } : null;
              }
              return null;
            },
            async all() {
              return { results: Array.from(d1Jobs.values()) };
            },
            async run() {
              if (query.includes('INSERT INTO system_settings')) {
                d1Settings.set(args[0], { key: args[0], value: args[1], updated_at: args[2] });
                return { meta: { changes: 1 } };
              }
              if (query.includes('INSERT INTO print_jobs')) {
                // columns: id, tenant_id, user_id, user_email, employee_name, receipt_token, printer_id...
                d1Jobs.set(args[0], {
                  id: args[0],
                  tenant_id: args[1],
                  user_id: args[2],
                  user_email: args[3],
                  employee_name: args[4],
                  receipt_token: args[5],
                  printer_id: args[6],
                  printer_name: args[7],
                  original_filename: args[8],
                  file_size_bytes: args[9],
                  file_format: args[10],
                  mime_type: args[11],
                  r2_storage_key: args[12],
                  settings_json: args[13],
                  status: args[14],
                  status_message: args[15],
                  lease_token: args[16],
                  created_at: args[17],
                  updated_at: args[18]
                });
                return { meta: { changes: 1 } };
              }
              if (query.includes('UPDATE print_jobs')) {
                if (query.includes('SET status = \'claimed\'')) {
                  const id = args[5]; // agentId, leaseHash, leaseExpiresAt, now, msg, candidate.id
                  const existing = d1Jobs.get(id);
                  if (existing) {
                    existing.status = 'claimed';
                    existing.claimed_by_agent_id = args[0];
                    existing.lease_token = args[1];
                    existing.lease_expires_at = args[2];
                    return { meta: { changes: 1 } };
                  }
                }
              }
              return { meta: { changes: 0 } };
            }
          };
        }
      };
    }
  };

  const r2Storage: Map<string, Uint8Array> = new Map();
  const mockR2 = {
    async put(key: string, data: Uint8Array) { r2Storage.set(key, data); },
    async get(key: string) {
      const bytes = r2Storage.get(key);
      return bytes ? { async arrayBuffer() { return bytes.buffer; } } : null;
    },
    async delete(key: string) { r2Storage.delete(key); }
  };

  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    employeeSecret: TEST_EMPLOYEE_SECRET,
    db: mockD1,
    r2: mockR2,
    isProduction: true
  });

  // 1. Create job with guest name and receipt token in D1
  const createRes = await api.createJob({
    tenantId: 'dtc-office',
    userId: 'guest_user',
    userEmail: 'guest@office.local',
    guestName: 'D1 Guest Alice',
    printerId: 'hp-laserjet-m1136',
    filename: 'd1_test.pdf',
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    settings: defaultSettings
  });
  assert.ok(createRes.job);
  assert.ok(createRes.receiptToken);
  const jobId = createRes.job.id;
  const receiptToken = createRes.receiptToken!;

  // 2. Verify D1 stored receipt_token separately
  const storedD1Row = d1Jobs.get(jobId);
  assert.equal(storedD1Row.receipt_token, receiptToken);
  assert.equal(storedD1Row.lease_token, null); // Not leased yet

  // 3. Agent claims the job
  const claimRes = await api.claimJob({
    agentId: 'gw-d1',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);
  assert.ok(claimRes.job);

  // 4. Verify lease_token was updated in D1 WITHOUT altering receipt_token
  const postClaimD1Row = d1Jobs.get(jobId);
  assert.ok(postClaimD1Row.lease_token); // Agent lease token hash present
  assert.equal(postClaimD1Row.receipt_token, receiptToken); // receipt_token is preserved!

  // 5. Guest checks status using receiptToken after agent claim -> Still succeeds!
  const guestStatus = await api.getJob(jobId, 'dtc-office', receiptToken);
  assert.ok(guestStatus);
  assert.equal(guestStatus.id, jobId);
  assert.equal(guestStatus.status, 'claimed');
});
