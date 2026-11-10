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
const TEST_ADMIN_PASSWORD = 'super-secret-admin-pw';
(0, node_test_1.default)('PrintBridgeApi lists office printers including HP LaserJet M1136', () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
    const printers = api.getPrinters();
    strict_1.default.equal(printers.length >= 2, true);
    const hp = printers.find(p => p.id === 'hp-laserjet-m1136');
    strict_1.default.ok(hp);
    strict_1.default.equal(hp?.supportsColor, false);
});
(0, node_test_1.default)('Public Guest Workflow: Submit with name (no PIN/login) -> Unguessable Receipt -> Status Inquiry', async () => {
    const api = new index_js_1.PrintBridgeApi({
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
    strict_1.default.equal(guestJobRes.success, true);
    strict_1.default.ok(guestJobRes.job);
    strict_1.default.ok(guestJobRes.receiptToken);
    strict_1.default.equal(guestJobRes.job.employeeName, 'Visiting Client John');
    const jobId = guestJobRes.job.id;
    const receiptToken = guestJobRes.receiptToken;
    // 2. Guest checks status with valid unguessable receipt token -> Succeeds
    const validStatus = await api.getJob(jobId, 'dtc-office', receiptToken);
    strict_1.default.ok(validStatus);
    strict_1.default.equal(validStatus.id, jobId);
    // 3. Guest checks status with WRONG receipt token -> Denied (prevents cross-guest snooping)
    const invalidStatus = await api.getJob(jobId, 'dtc-office', 'wrong-receipt-token');
    strict_1.default.equal(invalidStatus, undefined);
});
(0, node_test_1.default)('Admin Workflow: Login with admin123 -> Inspect Queue -> Pause Queue -> Cancel Job', async () => {
    const api = new index_js_1.PrintBridgeApi({
        apiKey: TEST_AGENT_KEY,
        adminPassword: TEST_ADMIN_PASSWORD
    });
    // 1. Admin login with bad credentials
    const badLogin = await api.adminLogin('wronguser', TEST_ADMIN_PASSWORD);
    strict_1.default.equal(badLogin.success, false);
    const badPw = await api.adminLogin('admin123', 'wrongpassword');
    strict_1.default.equal(badPw.success, false);
    // 2. Admin login with admin123 and correct password -> issues signed session token
    const goodLogin = await api.adminLogin('admin123', TEST_ADMIN_PASSWORD);
    strict_1.default.equal(goodLogin.success, true);
    strict_1.default.ok(goodLogin.token);
    strict_1.default.match(goodLogin.token, /^sess\./);
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
    strict_1.default.ok(jobRes.job);
    // 4. Admin inspects queue
    const queue = await api.getAdminQueue();
    strict_1.default.equal(queue.length, 1);
    strict_1.default.equal(queue[0].employeeName, 'Alex Smith');
    // 5. Admin pauses queue
    api.setQueueSettings({ queuePaused: true });
    strict_1.default.equal(api.getQueueSettings().queuePaused, true);
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
    strict_1.default.equal(pausedRes.success, false);
    strict_1.default.match(pausedRes.error || '', /paused/);
    // 7. Resume queue and cancel job
    api.setQueueSettings({ queuePaused: false });
    const cancelRes = await api.cancelJob(jobRes.job.id);
    strict_1.default.equal(cancelRes.success, true);
    const cancelledJob = await api.getJob(jobRes.job.id);
    strict_1.default.equal(cancelledJob?.status, 'cancelled');
});
(0, node_test_1.default)('Worker fetch handler routes public guest printing and admin login', async () => {
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
    const uploadRes = await index_js_1.default.fetch(guestUploadReq, env);
    strict_1.default.equal(uploadRes.status, 201);
    const uploadData = await uploadRes.json();
    strict_1.default.ok(uploadData.job?.id);
    strict_1.default.ok(uploadData.receiptToken);
    strict_1.default.equal(uploadData.job.employeeName, 'Guest Mary');
    const jobId = uploadData.job.id;
    const receiptToken = uploadData.receiptToken;
    // 2. Guest checks status with receipt token
    const statusReq = new Request(`http://worker.local/api/jobs/${jobId}?receiptToken=${receiptToken}`);
    const statusRes = await index_js_1.default.fetch(statusReq, env);
    strict_1.default.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    strict_1.default.equal(statusData.id, jobId);
    // 3. Unauthenticated access without receipt token is rejected (401)
    const snoopingReq = new Request(`http://worker.local/api/jobs/${jobId}`);
    const snoopingRes = await index_js_1.default.fetch(snoopingReq, env);
    strict_1.default.equal(snoopingRes.status, 401);
    // 4. Admin login via /api/admin/login
    const adminLoginReq = new Request('http://worker.local/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin123', password: TEST_ADMIN_PASSWORD })
    });
    const adminLoginRes = await index_js_1.default.fetch(adminLoginReq, env);
    strict_1.default.equal(adminLoginRes.status, 200);
    const adminData = await adminLoginRes.json();
    strict_1.default.ok(adminData.token);
    // 5. Admin queue inspection
    const queueReq = new Request('http://worker.local/api/admin/queue', {
        headers: { 'Authorization': `Bearer ${adminData.token}` }
    });
    const queueRes = await index_js_1.default.fetch(queueReq, env);
    strict_1.default.equal(queueRes.status, 200);
    const queueData = await queueRes.json();
    strict_1.default.ok(Array.isArray(queueData));
});
