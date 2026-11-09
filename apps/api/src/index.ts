import {
  PrintJob,
  PrinterCapability,
  PrintSettings,
  ClaimJobRequest,
  ClaimJobResponse,
  UpdateJobStatusRequest,
  HP_LASERJET_M1136_CAPABILITY,
  MOCK_PRINTER_CAPABILITY,
  validatePrintSettings,
  validateUploadedFile,
  LEASE_DURATION_SECONDS
} from '@print-bridge/shared';

export interface Env {
  DB?: any;
  STORAGE?: any;
  ENVIRONMENT?: string;
  GATEWAY_API_KEY?: string;
}

export class PrintBridgeApi {
  // In-memory fallback datastore for testing or edge environments without D1/R2 bindings
  private jobs: Map<string, PrintJob> = new Map();
  private storage: Map<string, Uint8Array> = new Map();
  private printers: Map<string, PrinterCapability> = new Map();
  private gatewayApiKey: string = 'dtc-secure-gateway-token-2025';

  constructor(apiKey?: string) {
    if (apiKey) this.gatewayApiKey = apiKey;
    this.printers.set(HP_LASERJET_M1136_CAPABILITY.id, HP_LASERJET_M1136_CAPABILITY);
    this.printers.set(MOCK_PRINTER_CAPABILITY.id, MOCK_PRINTER_CAPABILITY);
  }

  getPrinters(): PrinterCapability[] {
    return Array.from(this.printers.values());
  }

  getPrinter(id: string): PrinterCapability | undefined {
    return this.printers.get(id);
  }

  async createJob(params: {
    tenantId: string;
    userId: string;
    userEmail: string;
    printerId: string;
    filename: string;
    fileBytes: Uint8Array;
    settings: PrintSettings;
  }): Promise<{ success: boolean; job?: PrintJob; error?: string }> {
    const printer = this.printers.get(params.printerId);
    if (!printer) {
      return { success: false, error: `Printer '${params.printerId}' not found.` };
    }

    const valSettings = validatePrintSettings(params.settings, printer);
    if (!valSettings.isValid) {
      return { success: false, error: valSettings.error };
    }

    const fileVal = validateUploadedFile(params.filename, params.fileBytes.length, params.fileBytes.slice(0, 16));
    if (!fileVal.isValid || !fileVal.format) {
      return { success: false, error: fileVal.error };
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const storageKey = `uploads/${jobId}/${params.filename}`;

    const newJob: PrintJob = {
      id: jobId,
      tenantId: params.tenantId || 'dtc-office',
      userId: params.userId,
      userEmail: params.userEmail,
      printerId: printer.id,
      printerName: printer.name,
      originalFileName: params.filename,
      fileSizeBytes: params.fileBytes.length,
      fileFormat: fileVal.format,
      mimeType: 'application/octet-stream',
      r2StorageKey: storageKey,
      settings: params.settings,
      status: 'pending',
      statusMessage: valSettings.warning || 'Enqueued for office printer gateway',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.jobs.set(jobId, newJob);
    this.storage.set(storageKey, params.fileBytes);

    return { success: true, job: newJob };
  }

  getJob(jobId: string): PrintJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Atomic lease claim for Windows gateway agent.
   * If a job was claimed but its lease expired (e.g. agent crashed or lost network),
   * it can be safely reclaimed.
   */
  async claimJob(req: ClaimJobRequest, agentAuthToken: string): Promise<ClaimJobResponse> {
    if (agentAuthToken !== this.gatewayApiKey) {
      throw new Error('Unauthorized agent gateway key.');
    }

    const now = Date.now();
    const leaseDuration = (req.leaseDurationSeconds || LEASE_DURATION_SECONDS) * 1000;

    for (const job of this.jobs.values()) {
      if (req.supportedPrinters.length > 0 && !req.supportedPrinters.includes(job.printerId)) {
        continue;
      }

      const isPending = job.status === 'pending';
      const isExpiredLease = job.status === 'claimed' && job.leaseExpiresAt && job.leaseExpiresAt < now;

      if (isPending || isExpiredLease) {
        const leaseToken = `lease_${Math.random().toString(36).substring(2, 12)}`;
        job.status = 'claimed';
        job.claimedByAgentId = req.agentId;
        job.leaseExpiresAt = now + leaseDuration;
        job.updatedAt = now;
        job.statusMessage = `Job claimed by Windows gateway agent ${req.agentId}`;

        return {
          job,
          downloadUrl: `/api/agent/jobs/${job.id}/download?leaseToken=${leaseToken}`,
          leaseToken
        };
      }
    }

    return { job: null };
  }

  getFileBytes(storageKey: string): Uint8Array | undefined {
    return this.storage.get(storageKey);
  }

  async updateJobStatus(req: UpdateJobStatusRequest, agentAuthToken: string): Promise<{ success: boolean; error?: string }> {
    if (agentAuthToken !== this.gatewayApiKey) {
      return { success: false, error: 'Unauthorized agent gateway key.' };
    }

    const job = this.jobs.get(req.jobId);
    if (!job) {
      return { success: false, error: 'Job not found.' };
    }

    const now = Date.now();
    job.status = req.status;
    job.statusMessage = req.statusMessage;
    job.updatedAt = now;

    if (req.status === 'completed') {
      job.completedAt = now;
      // Auto-cleanup document payload in R2 upon confirmed physical spool handoff
      this.storage.delete(job.r2StorageKey);
    } else if (req.status === 'failed') {
      // Retain metadata for diagnostics, but can remove storage if needed
    }

    return { success: true };
  }

  /**
   * Periodic cron retention cleanup: removes documents older than TTL
   */
  cleanupExpired(maxAgeMs = 24 * 3600 * 1000): { cleanedJobsCount: number } {
    const cutoff = Date.now() - maxAgeMs;
    let count = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (job.createdAt < cutoff) {
        this.storage.delete(job.r2StorageKey);
        this.jobs.delete(id);
        count++;
      }
    }
    return { cleanedJobsCount: count };
  }
}

/**
 * Cloudflare Worker fetch entrypoint
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const api = new PrintBridgeApi(env.GATEWAY_API_KEY);

    // CORS Headers
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Key'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    try {
      if (url.pathname === '/api/printers' && request.method === 'GET') {
        return new Response(JSON.stringify(api.getPrinters()), { headers });
      }

      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        const body: any = await request.json();
        const fileBytes = Uint8Array.from(atob(body.fileBase64), c => c.charCodeAt(0));
        const res = await api.createJob({
          tenantId: body.tenantId || 'dtc-office',
          userId: body.userId || 'anonymous-office-user',
          userEmail: body.userEmail || 'office@dtc.local',
          printerId: body.printerId,
          filename: body.filename,
          fileBytes,
          settings: body.settings
        });
        return new Response(JSON.stringify(res), {
          status: res.success ? 201 : 400,
          headers
        });
      }

      if (url.pathname.startsWith('/api/jobs/') && request.method === 'GET') {
        const jobId = url.pathname.replace('/api/jobs/', '');
        const job = api.getJob(jobId);
        if (!job) {
          return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404, headers });
        }
        return new Response(JSON.stringify(job), { headers });
      }

      if (url.pathname === '/api/agent/claim' && request.method === 'POST') {
        const agentKey = request.headers.get('X-Agent-Key') || '';
        const body = (await request.json()) as ClaimJobRequest;
        const res = await api.claimJob(body, agentKey);
        return new Response(JSON.stringify(res), { headers });
      }

      if (url.pathname === '/api/agent/status' && request.method === 'POST') {
        const agentKey = request.headers.get('X-Agent-Key') || '';
        const body = (await request.json()) as UpdateJobStatusRequest;
        const res = await api.updateJobStatus(body, agentKey);
        return new Response(JSON.stringify(res), { headers });
      }

      return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }
};
