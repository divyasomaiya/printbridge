import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrintBridgeApi } from '../../apps/api/dist/index.js';
import { RendererRegistry } from '../../packages/renderers/dist/index.js';
import { PrintSettings } from '../../packages/shared/dist/index.js';

test('End-to-End Workflow: Upload -> API Queue -> Lease Claim -> Render -> Spool Handoff -> Cleanup', async () => {
  const apiKey = 'dtc-secure-gateway-token-e2e';
  const employeeSecret = 'dtc-employee-secret-e2e';
  const api = new PrintBridgeApi({ apiKey, employeeSecret });
  const registry = new RendererRegistry();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-e2e-'));

  try {
    // 1. Authenticated user submits a print job with 3-page text document
    const textContent = Array.from({ length: 150 }, (_, i) => `E2E Test Invoice Line ${i + 1}`).join('\n');
    const textBytes = new TextEncoder().encode(textContent);

    const settings: PrintSettings = {
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
    assert.equal(auth.tenantId, 'dtc-office');

    const createRes = await api.createJob({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userEmail: auth.userEmail,
      printerId: 'hp-laserjet-m1136',
      filename: 'invoice.txt',
      fileBytes: textBytes,
      settings
    });

    assert.equal(createRes.success, true);
    const jobId = createRes.job!.id;
    assert.equal(createRes.job?.status, 'pending');

    // 2. Gateway agent polls and claims job atomically
    const claimRes = await api.claimJob({
      agentId: 'win10-gateway-office',
      agentVersion: '1.0.0',
      supportedPrinters: ['hp-laserjet-m1136']
    }, apiKey);

    assert.ok(claimRes.job);
    assert.equal(claimRes.job?.id, jobId);
    assert.equal(claimRes.job?.status, 'claimed');
    assert.ok(claimRes.leaseToken);

    // 3. Agent writes file to isolated sandbox
    const jobDir = path.join(tempDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const localFilePath = path.join(jobDir, 'invoice.txt');
    fs.writeFileSync(localFilePath, textBytes);

    // 4. Renderer processes file with requested odd pages
    const renderer = registry.findRenderer(claimRes.job!.fileFormat)!;
    assert.ok(renderer);

    const renderRes = await renderer.render({
      jobId,
      sourceFilePath: localFilePath,
      workingDir: jobDir,
      settings: claimRes.job!.settings
    });

    assert.equal(renderRes.success, true);
    assert.equal(renderRes.totalPages, 3);
    assert.deepEqual(renderRes.printedPages, [1, 3]); // Verified odd pages
    assert.equal(renderRes.pages.length, 2);

    // 5. Agent submits to spooler and updates API status to completed
    const updateRes = await api.updateJobStatus({
      jobId,
      agentId: 'win10-gateway-office',
      leaseToken: claimRes.leaseToken!,
      status: 'completed',
      statusMessage: 'Spooler confirmed output of 2 pages on office printer'
    }, apiKey);

    assert.equal(updateRes.success, true);

    // 6. Verify data safety: storage payload deleted from Cloudflare R2
    assert.equal(api.getFileBytes(claimRes.job!.r2StorageKey), undefined);

    // 7. Gateway securely deletes local job directory
    fs.rmSync(jobDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(jobDir), false);

    const finalJob = await api.getJob(jobId);
    assert.equal(finalJob?.status, 'completed');
    assert.ok(finalJob?.completedAt);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
