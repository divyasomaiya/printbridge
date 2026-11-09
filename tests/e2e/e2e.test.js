"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const index_js_1 = require("../../apps/api/dist/index.js");
const index_js_2 = require("../../packages/renderers/dist/index.js");
(0, node_test_1.default)('End-to-End Workflow: Upload -> API Queue -> Lease Claim -> Render -> Spool Handoff -> Cleanup', async () => {
    const apiKey = 'dtc-secure-gateway-token-e2e';
    const employeeSecret = 'dtc-employee-secret-e2e';
    const api = new index_js_1.PrintBridgeApi({ apiKey, employeeSecret });
    const registry = new index_js_2.RendererRegistry();
    const tempDir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'pb-e2e-'));
    try {
        // 1. Authenticated user submits a print job with 3-page text document
        const textContent = Array.from({ length: 150 }, (_, i) => `E2E Test Invoice Line ${i + 1}`).join('\n');
        const textBytes = new TextEncoder().encode(textContent);
        const settings = {
            copies: 1,
            orientation: 'portrait',
            paperSize: 'a4',
            pageRangeType: 'odd', // Print odd pages (Pages 1 and 3)
            duplex: 'simplex',
            colorMode: 'grayscale',
            scaling: 'fit',
            collate: true
        };
        const auth = api.authenticateEmployee(`Bearer ${employeeSecret}`);
        strict_1.default.equal(auth.tenantId, 'dtc-office');
        const createRes = await api.createJob({
            tenantId: auth.tenantId,
            userId: auth.userId,
            userEmail: auth.userEmail,
            printerId: 'hp-laserjet-m1136',
            filename: 'invoice.txt',
            fileBytes: textBytes,
            settings
        });
        strict_1.default.equal(createRes.success, true);
        const jobId = createRes.job.id;
        strict_1.default.equal(createRes.job?.status, 'pending');
        // 2. Gateway agent polls and claims job atomically
        const claimRes = await api.claimJob({
            agentId: 'win10-gateway-office',
            agentVersion: '1.0.0',
            supportedPrinters: ['hp-laserjet-m1136']
        }, apiKey);
        strict_1.default.ok(claimRes.job);
        strict_1.default.equal(claimRes.job?.id, jobId);
        strict_1.default.equal(claimRes.job?.status, 'claimed');
        strict_1.default.ok(claimRes.leaseToken);
        // 3. Agent writes file to isolated sandbox
        const jobDir = node_path_1.default.join(tempDir, jobId);
        node_fs_1.default.mkdirSync(jobDir, { recursive: true });
        const localFilePath = node_path_1.default.join(jobDir, 'invoice.txt');
        node_fs_1.default.writeFileSync(localFilePath, textBytes);
        // 4. Renderer processes file with requested odd pages
        const renderer = registry.findRenderer(claimRes.job.fileFormat);
        strict_1.default.ok(renderer);
        const renderRes = await renderer.render({
            jobId,
            sourceFilePath: localFilePath,
            workingDir: jobDir,
            settings: claimRes.job.settings
        });
        strict_1.default.equal(renderRes.success, true);
        strict_1.default.equal(renderRes.totalPages, 3);
        strict_1.default.deepEqual(renderRes.printedPages, [1, 3]); // Verified odd pages
        strict_1.default.equal(renderRes.pages.length, 2);
        // 5. Agent submits to spooler and updates API status to completed
        const updateRes = await api.updateJobStatus({
            jobId,
            agentId: 'win10-gateway-office',
            leaseToken: claimRes.leaseToken,
            status: 'completed',
            statusMessage: 'Spooler confirmed output of 2 pages on office printer'
        }, apiKey);
        strict_1.default.equal(updateRes.success, true);
        // 6. Verify data safety: storage payload deleted from Cloudflare R2
        strict_1.default.equal(api.getFileBytes(claimRes.job.r2StorageKey), undefined);
        // 7. Gateway securely deletes local job directory
        node_fs_1.default.rmSync(jobDir, { recursive: true, force: true });
        strict_1.default.equal(node_fs_1.default.existsSync(jobDir), false);
        const finalJob = await api.getJob(jobId);
        strict_1.default.equal(finalJob?.status, 'completed');
        strict_1.default.ok(finalJob?.completedAt);
    }
    finally {
        node_fs_1.default.rmSync(tempDir, { recursive: true, force: true });
    }
});
