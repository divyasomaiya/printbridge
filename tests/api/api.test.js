"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = __importStar(require("../../apps/api/dist/index.js"));
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
const TEST_AGENT_KEY = 'test-agent-key-secret-999';
const TEST_EMPLOYEE_SECRET = 'employee-bearer-token-123';
(0, node_test_1.default)('PrintBridgeApi lists office printers including HP LaserJet M1136', () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
    const printers = api.getPrinters();
    strict_1.default.equal(printers.length >= 2, true);
    const hp = printers.find(p => p.id === 'hp-laserjet-m1136');
    strict_1.default.ok(hp);
    strict_1.default.equal(hp?.supportsColor, false);
});
(0, node_test_1.default)('Employee authentication fails closed with invalid/missing token', async () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
    const dummyHeaders = new Headers();
    await strict_1.default.rejects(async () => await api.authenticateEmployee(dummyHeaders), /Missing valid session or Cloudflare Access assertion/);
    dummyHeaders.set('Authorization', 'Bearer wrong-token');
    await strict_1.default.rejects(async () => await api.authenticateEmployee(dummyHeaders), /Invalid session token format/);
});
(0, node_test_1.default)('Cloudflare Access assertion with valid claims authenticates employee', async () => {
    const api = new index_js_1.PrintBridgeApi({
        apiKey: TEST_AGENT_KEY,
        employeeSecret: TEST_EMPLOYEE_SECRET,
        cfAccessAud: 'test-aud-tag'
    });
    // Valid JWT payload with aud and exp in future
    const payload = {
        email: 'sarah@office.local',
        aud: ['test-aud-tag'],
        exp: Math.floor(Date.now() / 1000) + 3600
    };
    const jwtPayloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const validJwt = `header.${jwtPayloadB64}.signature`;
    const headers = new Headers();
    headers.set('Cf-Access-Jwt-Assertion', validJwt);
    const auth = await api.authenticateEmployee(headers);
    strict_1.default.equal(auth.userId, 'sarah@office.local');
    strict_1.default.equal(auth.userEmail, 'sarah@office.local');
});
(0, node_test_1.default)('Cloudflare Access assertion rejects expired JWT or audience mismatch', async () => {
    const api = new index_js_1.PrintBridgeApi({
        apiKey: TEST_AGENT_KEY,
        employeeSecret: TEST_EMPLOYEE_SECRET,
        cfAccessAud: 'required-aud-tag'
    });
    // Expired JWT
    const expiredPayload = {
        email: 'sarah@office.local',
        aud: ['required-aud-tag'],
        exp: Math.floor(Date.now() / 1000) - 300 // expired 5 minutes ago
    };
    const expB64 = btoa(JSON.stringify(expiredPayload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const expJwt = `header.${expB64}.signature`;
    const headersExp = new Headers();
    headersExp.set('Cf-Access-Jwt-Assertion', expJwt);
    await strict_1.default.rejects(async () => await api.authenticateEmployee(headersExp), /assertion expired/);
    // Audience mismatch
    const wrongAudPayload = {
        email: 'sarah@office.local',
        aud: ['wrong-aud-tag'],
        exp: Math.floor(Date.now() / 1000) + 3600
    };
    const wrongAudB64 = btoa(JSON.stringify(wrongAudPayload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const wrongAudJwt = `header.${wrongAudB64}.signature`;
    const headersWrongAud = new Headers();
    headersWrongAud.set('Cf-Access-Jwt-Assertion', wrongAudJwt);
    await strict_1.default.rejects(async () => await api.authenticateEmployee(headersWrongAud), /audience mismatch/);
});
(0, node_test_1.default)('Worker fetch handler executes real HTTP routing, session exchange, and lease download', async () => {
    const env = {
        GATEWAY_API_KEY: TEST_AGENT_KEY,
        EMPLOYEE_AUTH_SECRET: TEST_EMPLOYEE_SECRET,
        ENVIRONMENT: 'development'
    };
    // 1. Session exchange with valid passkey returns signed session token (not the raw secret)
    const sessReq = new Request('http://worker.local/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passkey: TEST_EMPLOYEE_SECRET })
    });
    const sessRes = await index_js_1.default.fetch(sessReq, env);
    strict_1.default.equal(sessRes.status, 200);
    const sessData = await sessRes.json();
    strict_1.default.equal(sessData.success, true);
    strict_1.default.ok(sessData.token);
    strict_1.default.notEqual(sessData.token, TEST_EMPLOYEE_SECRET); // Raw secret is NEVER returned
    strict_1.default.match(sessData.token, /^sess\./);
    const sessionToken = sessData.token;
    // 2. Reject job creation with missing auth
    const unauthReq = new Request('http://worker.local/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerId: 'hp-laserjet-m1136', filename: 'test.pdf', fileBase64: 'JVBERi0xLjQ=', settings: defaultSettings })
    });
    const unauthRes = await index_js_1.default.fetch(unauthReq, env);
    strict_1.default.equal(unauthRes.status, 401);
    // 3. Authenticated job creation using signed session token
    const authReq = new Request('http://worker.local/api/jobs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ printerId: 'hp-laserjet-m1136', filename: 'test.pdf', fileBase64: 'JVBERi0xLjQ=', settings: defaultSettings })
    });
    const authRes = await index_js_1.default.fetch(authReq, env);
    strict_1.default.equal(authRes.status, 201);
    const authData = await authRes.json();
    strict_1.default.ok(authData.job?.id);
    const jobId = authData.job.id;
    // 4. Secure job status inquiry with session token
    const statusReq = new Request(`http://worker.local/api/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
    });
    const statusRes = await index_js_1.default.fetch(statusReq, env);
    strict_1.default.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    strict_1.default.equal(statusData.id, jobId);
    strict_1.default.equal(statusData.status, 'pending');
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
    const claimRes = await index_js_1.default.fetch(claimReq, env);
    strict_1.default.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    strict_1.default.equal(claimData.job?.id, jobId);
    strict_1.default.ok(claimData.leaseToken);
    // 6. Authenticated document download
    const dlReq = new Request(`http://worker.local${claimData.downloadUrl}`, {
        headers: { 'X-Agent-Key': TEST_AGENT_KEY }
    });
    const dlRes = await index_js_1.default.fetch(dlReq, env);
    strict_1.default.equal(dlRes.status, 200);
    strict_1.default.equal(dlRes.headers.get('Content-Disposition'), 'attachment; filename="test.pdf"');
    const dlBytes = new Uint8Array(await dlRes.arrayBuffer());
    strict_1.default.equal(dlBytes[0], 0x25); // '%PDF'
});
(0, node_test_1.default)('Simulated D1 & R2 persistence handles atomic updates and storage cleanup', async () => {
    // Create mock D1 database and R2 bucket simulation
    const d1Rows = new Map();
    const mockD1 = {
        prepare(query) {
            return {
                bind(...args) {
                    return {
                        async first() {
                            if (query.includes('SELECT id FROM print_jobs')) {
                                for (const row of d1Rows.values()) {
                                    if (row.status === 'pending')
                                        return { id: row.id };
                                }
                                return null;
                            }
                            if (query.includes('SELECT * FROM print_jobs WHERE id = ?')) {
                                return d1Rows.get(args[0]) || null;
                            }
                            if (query.includes('SELECT lease_token')) {
                                const r = d1Rows.get(args[0]);
                                return r ? { lease_token: r.lease_token, lease_expires_at: r.lease_expires_at } : null;
                            }
                            return null;
                        },
                        async run() {
                            if (query.includes('INSERT INTO print_jobs')) {
                                d1Rows.set(args[0], {
                                    id: args[0],
                                    tenant_id: args[1],
                                    user_id: args[2],
                                    user_email: args[3],
                                    printer_id: args[4],
                                    printer_name: args[5],
                                    original_filename: args[6],
                                    file_size_bytes: args[7],
                                    file_format: args[8],
                                    mime_type: args[9],
                                    r2_storage_key: args[10],
                                    settings_json: args[11],
                                    status: args[12],
                                    status_message: args[13],
                                    created_at: args[14],
                                    updated_at: args[15]
                                });
                                return { meta: { changes: 1 } };
                            }
                            if (query.includes('UPDATE print_jobs')) {
                                if (query.includes('SET status = \'claimed\'')) {
                                    const id = args[5]; // args: agentId, leaseHash, leaseExpiresAt, now, msg, candidate.id, now
                                    const existing = d1Rows.get(id);
                                    if (existing && (existing.status === 'pending' || (existing.status === 'claimed' && existing.lease_expires_at < args[6]))) {
                                        existing.status = 'claimed';
                                        existing.claimed_by_agent_id = args[0];
                                        existing.lease_token = args[1];
                                        existing.lease_expires_at = args[2];
                                        return { meta: { changes: 1 } };
                                    }
                                    return { meta: { changes: 0 } };
                                }
                                if (query.includes('SET status = ?')) {
                                    const id = args[4];
                                    const existing = d1Rows.get(id);
                                    if (existing) {
                                        existing.status = args[0];
                                        existing.status_message = args[1];
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
    const r2Storage = new Map();
    const mockR2 = {
        async put(key, data) {
            r2Storage.set(key, data);
        },
        async get(key) {
            const bytes = r2Storage.get(key);
            if (!bytes)
                return null;
            return {
                async arrayBuffer() {
                    return bytes.buffer;
                }
            };
        },
        async delete(key) {
            r2Storage.delete(key);
        }
    };
    const api = new index_js_1.PrintBridgeApi({
        apiKey: TEST_AGENT_KEY,
        employeeSecret: TEST_EMPLOYEE_SECRET,
        db: mockD1,
        r2: mockR2,
        isProduction: true
    });
    // 1. Create job in simulated D1 and R2
    const createRes = await api.createJob({
        tenantId: 'dtc-office',
        userId: 'emp_1',
        userEmail: 'emp@dtc.local',
        printerId: 'hp-laserjet-m1136',
        filename: 'd1_test.pdf',
        fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        settings: defaultSettings
    });
    strict_1.default.ok(createRes.job);
    strict_1.default.equal(d1Rows.size, 1);
    strict_1.default.equal(r2Storage.size, 1);
    // 2. Atomic claim via D1
    const claimRes = await api.claimJob({
        agentId: 'gw-d1',
        agentVersion: '1.0.0',
        supportedPrinters: ['hp-laserjet-m1136']
    }, TEST_AGENT_KEY);
    strict_1.default.ok(claimRes.job);
    strict_1.default.equal(claimRes.job?.status, 'claimed');
    // 3. Document payload download from R2
    const dlRes = await api.getDocumentPayload(claimRes.job.id, claimRes.leaseToken, TEST_AGENT_KEY);
    strict_1.default.ok(dlRes.fileBytes);
    strict_1.default.equal(dlRes.fileBytes.length, 4);
    // 4. Update status to completed -> R2 payload deleted
    const statusRes = await api.updateJobStatus({
        jobId: claimRes.job.id,
        agentId: 'gw-d1',
        leaseToken: claimRes.leaseToken,
        status: 'completed'
    }, TEST_AGENT_KEY);
    strict_1.default.equal(statusRes.success, true);
    strict_1.default.equal(r2Storage.size, 0); // Verified wiped from R2
});
