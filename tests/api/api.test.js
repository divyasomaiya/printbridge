"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../apps/api/dist/index.js");
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
    strict_1.default.throws(() => api.authenticateEmployee(undefined), /Missing or invalid Authorization header/);
    strict_1.default.throws(() => api.authenticateEmployee('Bearer wrong-token'), /Invalid employee authentication token/);
    const auth = api.authenticateEmployee(`Bearer ${TEST_EMPLOYEE_SECRET}`);
    strict_1.default.equal(auth.userId, 'emp_authorized');
    strict_1.default.equal(auth.tenantId, 'dtc-office');
});
(0, node_test_1.default)('PrintBridgeApi creates print job and validates format and printer settings', async () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
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
    strict_1.default.equal(res.success, true);
    strict_1.default.ok(res.job);
    strict_1.default.equal(res.job?.fileFormat, 'pdf');
    strict_1.default.equal(res.job?.status, 'pending');
});
(0, node_test_1.default)('PrintBridgeApi claims job with secure lease token and validates download endpoint', async () => {
    const api = new index_js_1.PrintBridgeApi({ apiKey: TEST_AGENT_KEY, employeeSecret: TEST_EMPLOYEE_SECRET });
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
    strict_1.default.ok(createRes.job);
    // Unauthorized agent claim fails closed
    await strict_1.default.rejects(async () => {
        await api.claimJob({
            agentId: 'gateway-win10',
            agentVersion: '1.0.0',
            supportedPrinters: ['hp-laserjet-m1136']
        }, 'wrong-agent-key');
    }, /Unauthorized/);
    // Authorized claim
    const claimRes = await api.claimJob({
        agentId: 'gateway-win10',
        agentVersion: '1.0.0',
        supportedPrinters: ['hp-laserjet-m1136']
    }, TEST_AGENT_KEY);
    strict_1.default.ok(claimRes.job);
    strict_1.default.equal(claimRes.job?.id, createRes.job?.id);
    strict_1.default.equal(claimRes.job?.status, 'claimed');
    strict_1.default.ok(claimRes.leaseToken);
    // Test authenticated document download with invalid lease token
    const badDl = await api.getDocumentPayload(claimRes.job.id, 'invalid-lease-token', TEST_AGENT_KEY);
    strict_1.default.equal(badDl.statusCode, 403);
    strict_1.default.match(badDl.error || '', /Invalid lease token/);
    // Test authenticated document download with valid lease token
    const goodDl = await api.getDocumentPayload(claimRes.job.id, claimRes.leaseToken, TEST_AGENT_KEY);
    strict_1.default.ok(goodDl.fileBytes);
    strict_1.default.equal(goodDl.filename, 'doc.pdf');
    strict_1.default.deepEqual(goodDl.fileBytes, pdfBytes);
    // Status update to completed cleans up storage payload
    const updateRes = await api.updateJobStatus({
        jobId: claimRes.job.id,
        agentId: 'gateway-win10',
        leaseToken: claimRes.leaseToken,
        status: 'completed',
        statusMessage: 'Spooler confirmed handoff to office printer'
    }, TEST_AGENT_KEY);
    strict_1.default.equal(updateRes.success, true);
    const finalJob = await api.getJob(claimRes.job.id);
    strict_1.default.equal(finalJob?.status, 'completed');
    strict_1.default.equal(api.getFileBytes(finalJob.r2StorageKey), undefined); // Scrubbed from storage
});
