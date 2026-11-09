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
(0, node_test_1.default)('Employee authentication fails closed with invalid/missing token', () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
    const dummyHeaders = new Headers();
    strict_1.default.throws(() => api.authenticateEmployee(dummyHeaders), /Missing or invalid Authorization header/);
    dummyHeaders.set('Authorization', 'Bearer wrong-token');
    strict_1.default.throws(() => api.authenticateEmployee(dummyHeaders), /Invalid employee authentication token/);
    dummyHeaders.set('Authorization', `Bearer ${TEST_EMPLOYEE_SECRET}`);
    const auth = api.authenticateEmployee(dummyHeaders);
    strict_1.default.equal(auth.userId, 'emp_authorized');
    strict_1.default.equal(auth.tenantId, 'dtc-office');
});
(0, node_test_1.default)('Cloudflare Access header automatically authenticates employee', () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
    const headers = new Headers();
    headers.set('Cf-Access-Authenticated-User-Email', 'sarah@office.local');
    const auth = api.authenticateEmployee(headers);
    strict_1.default.equal(auth.userId, 'sarah@office.local');
    strict_1.default.equal(auth.userEmail, 'sarah@office.local');
});
(0, node_test_1.default)('Worker fetch handler executes real HTTP routing, auth check, and session exchange', async () => {
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
    const sessRes = await index_js_1.default.fetch(sessReq, env);
    strict_1.default.equal(sessRes.status, 200);
    const sessData = await sessRes.json();
    strict_1.default.equal(sessData.success, true);
    strict_1.default.equal(sessData.token, TEST_EMPLOYEE_SECRET);
    // 2. Reject job creation with missing auth
    const unauthReq = new Request('http://worker.local/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerId: 'hp-laserjet-m1136', filename: 'test.pdf', fileBase64: 'JVBERi0xLjQ=', settings: defaultSettings })
    });
    const unauthRes = await index_js_1.default.fetch(unauthReq, env);
    strict_1.default.equal(unauthRes.status, 401);
    // 3. Authenticated job creation
    const authReq = new Request('http://worker.local/api/jobs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TEST_EMPLOYEE_SECRET}`
        },
        body: JSON.stringify({ printerId: 'hp-laserjet-m1136', filename: 'test.pdf', fileBase64: 'JVBERi0xLjQ=', settings: defaultSettings })
    });
    const authRes = await index_js_1.default.fetch(authReq, env);
    strict_1.default.equal(authRes.status, 201);
    const authData = await authRes.json();
    strict_1.default.ok(authData.job?.id);
    const jobId = authData.job.id;
    // 4. Secure job status inquiry
    const statusReq = new Request(`http://worker.local/api/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${TEST_EMPLOYEE_SECRET}` }
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
(0, node_test_1.default)('State machine rejects invalid transitions (e.g. completed -> pending)', async () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
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
        jobId: claimRes.job.id,
        agentId: 'gw-1',
        leaseToken: claimRes.leaseToken,
        status: 'completed'
    }, TEST_AGENT_KEY);
    // Attempt invalid transition back to pending
    const invalidRes = await api.updateJobStatus({
        jobId: claimRes.job.id,
        agentId: 'gw-1',
        leaseToken: claimRes.leaseToken,
        status: 'pending'
    }, TEST_AGENT_KEY);
    strict_1.default.equal(invalidRes.success, false);
    strict_1.default.equal(invalidRes.statusCode, 400);
    strict_1.default.match(invalidRes.error || '', /Invalid state transition/);
});
