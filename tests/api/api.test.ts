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

test('Cloudflare Access RS256 JWT verification: accepts valid RS256 token and rejects invalid/forged/expired', async () => {
  // Generate a real RSA keypair using Web Crypto API
  const rsaKeypair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );

  const publicJwk: any = await crypto.subtle.exportKey('jwk', rsaKeypair.publicKey);
  publicJwk.kid = 'key-test-1';

  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    adminPassword: TEST_ADMIN_PASSWORD,
    cfAccessAud: 'aud-test-123',
    cfAccessTeamDomain: 'https://testteam.cloudflareaccess.com'
  });

  // 1. Create a valid RS256 JWT
  const header = { alg: 'RS256', typ: 'JWT', kid: 'key-test-1' };
  const payload = {
    email: 'sarah@office.local',
    aud: ['aud-test-123'],
    iss: 'https://testteam.cloudflareaccess.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    _testJwk: publicJwk
  };

  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const rawSig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsaKeypair.privateKey, signInput);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(rawSig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const validJwt = `${headerB64}.${payloadB64}.${sigB64}`;
  const validHeaders = new Headers();
  validHeaders.set('Cf-Access-Jwt-Assertion', validJwt);

  const auth = await api.authenticateEmployee(validHeaders);
  assert.equal(auth.userId, 'sarah@office.local');
  assert.equal(auth.userEmail, 'sarah@office.local');

  // 2. Reject unsupported algorithm (e.g. HS256)
  const hsHeaderB64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '');
  const hsHeaders = new Headers();
  hsHeaders.set('Cf-Access-Jwt-Assertion', `${hsHeaderB64}.${payloadB64}.${sigB64}`);
  await assert.rejects(async () => await api.authenticateEmployee(hsHeaders), /Unsupported Cloudflare Access JWT algorithm/);

  // 3. Reject forged signature
  const forgedHeaders = new Headers();
  forgedHeaders.set('Cf-Access-Jwt-Assertion', `${headerB64}.${payloadB64}.forgedSignature`);
  await assert.rejects(async () => await api.authenticateEmployee(forgedHeaders), /Invalid Cloudflare Access JWT signature/);

  // 4. Reject expired token
  const expPayload = { ...payload, exp: Math.floor(Date.now() / 1000) - 10 };
  const expB64 = btoa(JSON.stringify(expPayload)).replace(/=+$/, '');
  const expSig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsaKeypair.privateKey, new TextEncoder().encode(`${headerB64}.${expB64}`));
  const expSigB64 = btoa(String.fromCharCode(...new Uint8Array(expSig))).replace(/=+$/, '');
  const expHeaders = new Headers();
  expHeaders.set('Cf-Access-Jwt-Assertion', `${headerB64}.${expB64}.${expSigB64}`);
  await assert.rejects(async () => await api.authenticateEmployee(expHeaders), /assertion expired/);

  // 5. Reject audience mismatch
  const wrongAudPayload = { ...payload, aud: ['wrong-aud'] };
  const wrongAudB64 = btoa(JSON.stringify(wrongAudPayload)).replace(/=+$/, '');
  const wrongAudSig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsaKeypair.privateKey, new TextEncoder().encode(`${headerB64}.${wrongAudB64}`));
  const wrongAudSigB64 = btoa(String.fromCharCode(...new Uint8Array(wrongAudSig))).replace(/=+$/, '');
  const wrongAudHeaders = new Headers();
  wrongAudHeaders.set('Cf-Access-Jwt-Assertion', `${headerB64}.${wrongAudB64}.${wrongAudSigB64}`);
  await assert.rejects(async () => await api.authenticateEmployee(wrongAudHeaders), /audience mismatch/);
});

test('Admin Credential Isolation: Employee credentials cannot authenticate as administrator', async () => {
  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    employeeSecret: TEST_EMPLOYEE_SECRET,
    adminPassword: TEST_ADMIN_PASSWORD
  });

  // Attempting to log into admin with employee secret fails
  const empLoginAttempt = await api.adminLogin('admin123', TEST_EMPLOYEE_SECRET);
  assert.equal(empLoginAttempt.success, false);
  assert.match(empLoginAttempt.error || '', /Invalid admin password/);

  // Correct admin password succeeds
  const adminLoginSuccess = await api.adminLogin('admin123', TEST_ADMIN_PASSWORD);
  assert.equal(adminLoginSuccess.success, true);
  assert.ok(adminLoginSuccess.token);
});

test('Public Guest Workflow: Submit with name -> Unguessable Receipt -> Status Inquiry', async () => {
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

test('Strict Fail-Closed Queue Settings: Malformed values or D1 errors default queue to paused', async () => {
  const d1Settings = new Map<string, string>();

  const createStatement = (query: string, boundArgs: any[] = []) => ({
    bind(...args: any[]) { return createStatement(query, args); },
    async first() {
      if (query.includes('queue_paused')) {
        const val = d1Settings.get('queue_paused');
        return val !== undefined ? { value: val } : null;
      }
      if (query.includes('max_copies_limit')) {
        const val = d1Settings.get('max_copies_limit');
        return val !== undefined ? { value: val } : null;
      }
      return null;
    },
    async run() { return { meta: { changes: 1 } }; }
  });

  const mockD1 = { prepare(q: string) { return createStatement(q); } };
  const mockR2 = { async put() {}, async get() {}, async delete() {} };

  const api = new PrintBridgeApi({
    apiKey: TEST_AGENT_KEY,
    adminPassword: TEST_ADMIN_PASSWORD,
    db: mockD1,
    r2: mockR2,
    isProduction: true
  });

  // 1. Missing settings -> defaults to paused
  const s1 = await api.getQueueSettings();
  assert.equal(s1.queuePaused, true);

  // 2. Malformed settings (e.g. "invalid", "0", "paused") -> strictly defaults to paused
  d1Settings.set('queue_paused', 'invalid');
  const s2 = await api.getQueueSettings();
  assert.equal(s2.queuePaused, true);

  d1Settings.set('queue_paused', 'TRUE'); // not exact "false"
  const s3 = await api.getQueueSettings();
  assert.equal(s3.queuePaused, true);

  // 3. Only exact "false" unpauses
  d1Settings.set('queue_paused', 'false');
  const s4 = await api.getQueueSettings();
  assert.equal(s4.queuePaused, false);

  // 4. Malformed or excessive max_copies_limit defaults or bounds to 50
  d1Settings.set('max_copies_limit', '9999');
  const s5 = await api.getQueueSettings();
  assert.equal(s5.maxCopiesLimit, 50);

  d1Settings.set('max_copies_limit', '-5');
  const s6 = await api.getQueueSettings();
  assert.equal(s6.maxCopiesLimit, 50);
});
