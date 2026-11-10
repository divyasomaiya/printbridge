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

test('Cloudflare Access JWT verification: rejects unverified / forged / expired signatures', async () => {
  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    employeeSecret: TEST_EMPLOYEE_SECRET,
    cfAccessAud: 'aud-test-123'
  });

  // 1. Missing CF_ACCESS_AUD disabled path
  const noAudApi = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    employeeSecret: TEST_EMPLOYEE_SECRET
  });
  const dummyHeaders = new Headers();
  dummyHeaders.set('Cf-Access-Jwt-Assertion', 'h.p.s');
  await assert.rejects(async () => await noAudApi.authenticateEmployee(dummyHeaders), /CF_ACCESS_AUD is not configured/);

  // 2. Forged JWT with fake signature
  const headerB64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const validPayload = {
    email: 'sarah@office.local',
    aud: ['aud-test-123'],
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  const payloadB64 = btoa(JSON.stringify(validPayload)).replace(/=/g, '');
  const forgedHeaders = new Headers();
  forgedHeaders.set('Cf-Access-Jwt-Assertion', `${headerB64}.${payloadB64}.forgedSignature`);

  await assert.rejects(async () => await api.authenticateEmployee(forgedHeaders), /Invalid Cloudflare Access JWT signature/);

  // 3. Expired JWT
  const expiredPayload = {
    email: 'sarah@office.local',
    aud: ['aud-test-123'],
    exp: Math.floor(Date.now() / 1000) - 60
  };
  const expPayloadB64 = btoa(JSON.stringify(expiredPayload)).replace(/=/g, '');
  const expHeaders = new Headers();
  expHeaders.set('Cf-Access-Jwt-Assertion', `${headerB64}.${expPayloadB64}.anySig`);

  await assert.rejects(async () => await api.authenticateEmployee(expHeaders), /assertion expired/);
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

test('Database Queue Settings Fail Closed on D1 Errors / Missing Records', async () => {
  // Mock D1 that throws on settings query
  const brokenD1 = {
    prepare(query: string) {
      return {
        bind() {
          return {
            async first() {
              if (query.includes('system_settings')) {
                throw new Error('D1 storage unavailable');
              }
              return null;
            },
            async run() { return { meta: { changes: 0 } }; }
          };
        }
      };
    }
  };

  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    adminPassword: TEST_ADMIN_PASSWORD,
    db: brokenD1
  });

  // getQueueSettings fails closed to paused = true
  const settings = await api.getQueueSettings();
  assert.equal(settings.queuePaused, true);
  assert.equal(settings.maxCopiesLimit, 50);

  // createJob fails closed because queue is paused
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
  assert.equal(jobRes.success, false);
  assert.match(jobRes.error || '', /paused/);

  // claimJob fails closed because queue is paused
  const claimRes = await api.claimJob({
    agentId: 'gw-win10',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);
  assert.equal(claimRes.job, null);
});

test('D1-Backed Integration Test: D1 inserts, separate receipt_token column, and system_settings persistence', async () => {
  const d1Jobs: Map<string, any> = new Map();
  const d1Settings: Map<string, any> = new Map();

  const createStatement = (query: string, boundArgs: any[] = []) => ({
    bind(...args: any[]) {
      return createStatement(query, args);
    },
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
        return d1Jobs.get(boundArgs[0]) || null;
      }
      if (query.includes('SELECT lease_token')) {
        const r = d1Jobs.get(boundArgs[0]);
        return r ? { lease_token: r.lease_token, lease_expires_at: r.lease_expires_at } : null;
      }
      return null;
    },
    async all() {
      return { results: Array.from(d1Jobs.values()) };
    },
    async run() {
      if (query.includes('INSERT INTO system_settings')) {
        const key = query.includes('"queue_paused"') ? 'queue_paused' : 'max_copies_limit';
        d1Settings.set(key, { key, value: boundArgs[0], updated_at: boundArgs[1] });
        return { meta: { changes: 1 } };
      }
      if (query.includes('INSERT INTO print_jobs')) {
        d1Jobs.set(boundArgs[0], {
          id: boundArgs[0],
          tenant_id: boundArgs[1],
          user_id: boundArgs[2],
          user_email: boundArgs[3],
          employee_name: boundArgs[4],
          receipt_token: boundArgs[5],
          printer_id: boundArgs[6],
          printer_name: boundArgs[7],
          original_filename: boundArgs[8],
          file_size_bytes: boundArgs[9],
          file_format: boundArgs[10],
          mime_type: boundArgs[11],
          r2_storage_key: boundArgs[12],
          settings_json: boundArgs[13],
          status: boundArgs[14],
          status_message: boundArgs[15],
          lease_token: boundArgs[16],
          created_at: boundArgs[17],
          updated_at: boundArgs[18]
        });
        return { meta: { changes: 1 } };
      }
      if (query.includes('UPDATE print_jobs')) {
        if (query.includes('SET status = \'claimed\'')) {
          const id = boundArgs[5];
          const existing = d1Jobs.get(id);
          if (existing) {
            existing.status = 'claimed';
            existing.claimed_by_agent_id = boundArgs[0];
            existing.lease_token = boundArgs[1];
            existing.lease_expires_at = boundArgs[2];
            return { meta: { changes: 1 } };
          }
        }
      }
      return { meta: { changes: 0 } };
    }
  });

  const mockD1 = {
    prepare(query: string) {
      return createStatement(query);
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
    adminPassword: TEST_ADMIN_PASSWORD,
    db: mockD1,
    r2: mockR2,
    isProduction: true
  });

  // Explicitly unpause queue for test
  await api.setQueueSettings({ queuePaused: false, maxCopiesLimit: 50 });

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
  assert.equal(storedD1Row.lease_token, null);

  // 3. Agent claims the job
  const claimRes = await api.claimJob({
    agentId: 'gw-d1',
    agentVersion: '1.0.0',
    supportedPrinters: ['hp-laserjet-m1136']
  }, TEST_AGENT_KEY);
  assert.ok(claimRes.job);

  // 4. Verify lease_token was updated in D1 WITHOUT altering receipt_token
  const postClaimD1Row = d1Jobs.get(jobId);
  assert.ok(postClaimD1Row.lease_token);
  assert.equal(postClaimD1Row.receipt_token, receiptToken);

  // 5. Guest checks status using receiptToken after agent claim -> Still succeeds!
  const guestStatus = await api.getJob(jobId, 'dtc-office', receiptToken);
  assert.ok(guestStatus);
  assert.equal(guestStatus.id, jobId);
  assert.equal(guestStatus.status, 'claimed');
});
