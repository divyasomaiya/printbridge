import {
  PrintJob,
  PrinterCapability,
  PrintSettings,
  ClaimJobRequest,
  ClaimJobResponse,
  UpdateJobStatusRequest,
  JobStatus,
  HP_LASERJET_M1136_CAPABILITY,
  MOCK_PRINTER_CAPABILITY,
  validatePrintSettings,
  validateUploadedFile,
  LEASE_DURATION_SECONDS
} from '@print-bridge/shared';

export interface Env {
  DB?: any;      // Cloudflare D1 database binding
  STORAGE?: any; // Cloudflare R2 bucket binding
  ASSETS?: any;  // Workers Static Assets binding
  ENVIRONMENT?: string;
  GATEWAY_API_KEY?: string;
  EMPLOYEE_AUTH_SECRET?: string;
  DEFAULT_TENANT_ID?: string;
}

export interface AuthContext {
  userId: string;
  userEmail: string;
  tenantId: string;
}

/**
 * Computes SHA-256 hash using Web Crypto API.
 */
export async function sha256Hex(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates a cryptographically secure random token.
 */
export function generateSecureToken(prefix = 'tok'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const randomHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${randomHex}`;
}

const ALLOWED_STATUS_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['rendering', 'spooling', 'completed', 'failed', 'cancelled'],
  rendering: ['spooling', 'completed', 'failed', 'cancelled'],
  spooling: ['completed', 'failed', 'cancelled'],
  completed: [], // Terminal
  failed: [],    // Terminal
  cancelled: [], // Terminal
  expired: []    // Terminal
};

export class PrintBridgeApi {
  private jobs: Map<string, PrintJob> = new Map();
  private leaseHashes: Map<string, string> = new Map(); // jobId -> sha256(leaseToken)
  private storage: Map<string, Uint8Array> = new Map();
  private printers: Map<string, PrinterCapability> = new Map();
  private gatewayApiKey?: string;
  private employeeAuthSecret?: string;
  private defaultTenantId: string = 'dtc-office';
  private db?: any;
  private r2?: any;
  private isProduction: boolean = false;

  constructor(options?: {
    apiKey?: string;
    employeeSecret?: string;
    tenantId?: string;
    db?: any;
    r2?: any;
    isProduction?: boolean;
  }) {
    if (options?.apiKey) this.gatewayApiKey = options.apiKey;
    if (options?.employeeSecret) this.employeeAuthSecret = options.employeeSecret;
    if (options?.tenantId) this.defaultTenantId = options.tenantId;
    if (options?.db) this.db = options.db;
    if (options?.r2) this.r2 = options.r2;
    this.isProduction = options?.isProduction ?? false;

    // In production mode, require real D1 and R2 bindings
    if (this.isProduction) {
      if (!this.db) {
        throw new Error('PRODUCTION MISCONFIGURATION: Cloudflare D1 database binding "DB" is required.');
      }
      if (!this.r2) {
        throw new Error('PRODUCTION MISCONFIGURATION: Cloudflare R2 bucket binding "STORAGE" is required.');
      }
    }

    this.printers.set(HP_LASERJET_M1136_CAPABILITY.id, HP_LASERJET_M1136_CAPABILITY);
    this.printers.set(MOCK_PRINTER_CAPABILITY.id, MOCK_PRINTER_CAPABILITY);
  }

  /**
   * Validates employee authorization for document submission.
   * Supports Cloudflare Access identity header (Cf-Access-Authenticated-User-Email)
   * or Bearer token matching EMPLOYEE_AUTH_SECRET.
   */
  authenticateEmployee(headers: Headers): AuthContext {
    // 1. Check for Cloudflare Access authenticated header
    const cfEmail = headers.get('Cf-Access-Authenticated-User-Email');
    if (cfEmail) {
      return {
        userId: cfEmail,
        userEmail: cfEmail,
        tenantId: this.defaultTenantId
      };
    }

    // 2. Check for office passkey/secret Bearer token
    if (!this.employeeAuthSecret) {
      throw new Error('Server authentication configuration missing: EMPLOYEE_AUTH_SECRET not set.');
    }

    const authHeader = headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized: Missing or invalid Authorization header.');
    }

    const token = authHeader.substring(7).trim();
    if (token !== this.employeeAuthSecret) {
      throw new Error('Unauthorized: Invalid employee authentication token.');
    }

    return {
      userId: 'emp_authorized',
      userEmail: 'employee@office.local',
      tenantId: this.defaultTenantId
    };
  }

  /**
   * Session authentication endpoint: Exchanges valid employee PIN with session token
   */
  exchangeSession(passkey: string): { success: boolean; token?: string; error?: string } {
    if (!this.employeeAuthSecret) {
      return { success: false, error: 'Server authentication secret not configured.' };
    }
    if (passkey !== this.employeeAuthSecret) {
      return { success: false, error: 'Invalid office passkey.' };
    }
    return { success: true, token: this.employeeAuthSecret };
  }

  /**
   * Validates gateway agent authentication key.
   */
  assertAgentAuthenticated(agentKey?: string | null): void {
    if (!this.gatewayApiKey) {
      throw new Error('Server authentication configuration missing: GATEWAY_API_KEY not set.');
    }
    if (!agentKey || agentKey !== this.gatewayApiKey) {
      throw new Error('Unauthorized: Invalid or missing gateway agent key.');
    }
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

    const jobId = generateSecureToken('job');
    const storageKey = `uploads/${params.tenantId}/${jobId}/${params.filename}`;

    const newJob: PrintJob = {
      id: jobId,
      tenantId: params.tenantId,
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

    if (this.r2) {
      await this.r2.put(storageKey, params.fileBytes);
    } else {
      this.storage.set(storageKey, params.fileBytes);
    }

    if (this.db) {
      await this.db.prepare(`
        INSERT INTO print_jobs (
          id, tenant_id, user_id, user_email, printer_id, printer_name,
          original_filename, file_size_bytes, file_format, mime_type,
          r2_storage_key, settings_json, status, status_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        newJob.id, newJob.tenantId, newJob.userId, newJob.userEmail,
        newJob.printerId, newJob.printerName, newJob.originalFileName,
        newJob.fileSizeBytes, newJob.fileFormat, newJob.mimeType,
        newJob.r2StorageKey, JSON.stringify(newJob.settings),
        newJob.status, newJob.statusMessage, newJob.createdAt, newJob.updatedAt
      ).run();
    } else {
      this.jobs.set(jobId, newJob);
    }

    return { success: true, job: newJob };
  }

  async getJob(jobId: string, tenantId?: string): Promise<PrintJob | undefined> {
    if (this.db) {
      let query = 'SELECT * FROM print_jobs WHERE id = ?';
      const params = [jobId];
      if (tenantId) {
        query += ' AND tenant_id = ?';
        params.push(tenantId);
      }
      const row = await this.db.prepare(query).bind(...params).first();
      if (!row) return undefined;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        userEmail: row.user_email,
        printerId: row.printer_id,
        printerName: row.printer_name,
        originalFileName: row.original_filename,
        fileSizeBytes: row.file_size_bytes,
        fileFormat: row.file_format,
        mimeType: row.mime_type,
        r2StorageKey: row.r2_storage_key,
        settings: JSON.parse(row.settings_json),
        status: row.status,
        statusMessage: row.status_message,
        claimedByAgentId: row.claimed_by_agent_id,
        leaseExpiresAt: row.lease_expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at
      };
    }

    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (tenantId && job.tenantId !== tenantId) return undefined;
    return job;
  }

  /**
   * Atomic lease claim with cryptographically secure lease token generation and SHA-256 persistence.
   */
  async claimJob(req: ClaimJobRequest, agentAuthToken?: string | null): Promise<ClaimJobResponse> {
    this.assertAgentAuthenticated(agentAuthToken);

    const now = Date.now();
    const leaseDuration = (req.leaseDurationSeconds || LEASE_DURATION_SECONDS) * 1000;
    const leaseExpiresAt = now + leaseDuration;

    if (this.db) {
      const printerPlaceholders = req.supportedPrinters.map(() => '?').join(',');
      const candidate = await this.db.prepare(`
        SELECT id FROM print_jobs
        WHERE (status = 'pending' OR (status = 'claimed' AND lease_expires_at < ?))
        AND printer_id IN (${printerPlaceholders})
        ORDER BY created_at ASC LIMIT 1
      `).bind(now, ...req.supportedPrinters).first();

      if (!candidate) {
        return { job: null };
      }

      const leaseToken = generateSecureToken('lease');
      const leaseHash = await sha256Hex(leaseToken);

      // In Cloudflare D1, affected rows count is available under meta.changes
      const updateRes = await this.db.prepare(`
        UPDATE print_jobs
        SET status = 'claimed',
            claimed_by_agent_id = ?,
            lease_token = ?,
            lease_expires_at = ?,
            updated_at = ?,
            status_message = ?
        WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < ?))
      `).bind(
        req.agentId, leaseHash, leaseExpiresAt, now,
        `Job claimed by agent ${req.agentId}`, candidate.id, now
      ).run();

      const affected = updateRes?.meta?.changes ?? updateRes?.changes ?? 0;
      if (affected === 0) {
        return { job: null }; // Raced by another gateway worker
      }

      const job = await this.getJob(candidate.id);
      return {
        job: job ?? null,
        downloadUrl: `/api/agent/jobs/${candidate.id}/download?leaseToken=${leaseToken}`,
        leaseToken
      };
    }

    for (const job of this.jobs.values()) {
      if (req.supportedPrinters.length > 0 && !req.supportedPrinters.includes(job.printerId)) {
        continue;
      }

      const isPending = job.status === 'pending';
      const isExpiredLease = job.status === 'claimed' && job.leaseExpiresAt && job.leaseExpiresAt < now;

      if (isPending || isExpiredLease) {
        const leaseToken = generateSecureToken('lease');
        const leaseHash = await sha256Hex(leaseToken);

        job.status = 'claimed';
        job.claimedByAgentId = req.agentId;
        job.leaseExpiresAt = leaseExpiresAt;
        job.updatedAt = now;
        job.statusMessage = `Job claimed by Windows gateway agent ${req.agentId}`;

        this.leaseHashes.set(job.id, leaseHash);

        return {
          job,
          downloadUrl: `/api/agent/jobs/${job.id}/download?leaseToken=${leaseToken}`,
          leaseToken
        };
      }
    }

    return { job: null };
  }

  /**
   * Authenticated document download endpoint for gateway agents.
   * Validates agent authentication and lease token SHA-256 hash.
   */
  async getDocumentPayload(jobId: string, leaseToken: string, agentAuthToken?: string | null): Promise<{
    fileBytes?: Uint8Array;
    filename?: string;
    mimeType?: string;
    error?: string;
    statusCode?: number;
  }> {
    try {
      this.assertAgentAuthenticated(agentAuthToken);
    } catch (e: any) {
      return { error: e.message, statusCode: 401 };
    }

    const job = await this.getJob(jobId);
    if (!job) {
      return { error: 'Job not found.', statusCode: 404 };
    }

    if (job.status !== 'claimed' && job.status !== 'rendering' && job.status !== 'spooling') {
      return { error: `Job is in status '${job.status}', not in a downloadable state.`, statusCode: 403 };
    }

    const now = Date.now();
    if (job.leaseExpiresAt && job.leaseExpiresAt < now) {
      return { error: 'Job lease has expired.', statusCode: 403 };
    }

    const candidateHash = await sha256Hex(leaseToken);

    if (this.db) {
      const row = await this.db.prepare('SELECT lease_token FROM print_jobs WHERE id = ?').bind(jobId).first();
      if (!row || row.lease_token !== candidateHash) {
        return { error: 'Invalid lease token.', statusCode: 403 };
      }
    } else {
      const storedHash = this.leaseHashes.get(jobId);
      if (!storedHash || storedHash !== candidateHash) {
        return { error: 'Invalid lease token.', statusCode: 403 };
      }
    }

    let fileBytes: Uint8Array | undefined;
    if (this.r2) {
      const r2Obj = await this.r2.get(job.r2StorageKey);
      if (!r2Obj) return { error: 'Storage object not found in R2.', statusCode: 404 };
      fileBytes = new Uint8Array(await r2Obj.arrayBuffer());
    } else {
      fileBytes = this.storage.get(job.r2StorageKey);
    }

    if (!fileBytes) {
      return { error: 'Storage payload missing.', statusCode: 404 };
    }

    return {
      fileBytes,
      filename: job.originalFileName,
      mimeType: job.mimeType
    };
  }

  async updateJobStatus(req: UpdateJobStatusRequest, agentAuthToken?: string | null): Promise<{ success: boolean; error?: string; statusCode?: number }> {
    try {
      this.assertAgentAuthenticated(agentAuthToken);
    } catch (e: any) {
      return { success: false, error: e.message, statusCode: 401 };
    }

    const job = await this.getJob(req.jobId);
    if (!job) {
      return { success: false, error: 'Job not found.', statusCode: 404 };
    }

    // Agent ownership check: ensure this agent claimed the job
    if (job.claimedByAgentId && job.claimedByAgentId !== req.agentId) {
      return { success: false, error: 'Agent ownership mismatch: job was claimed by a different agent.', statusCode: 403 };
    }

    // Allowed status transitions
    const validNextStates = ALLOWED_STATUS_TRANSITIONS[job.status] || [];
    if (!validNextStates.includes(req.status)) {
      return { success: false, error: `Invalid state transition from '${job.status}' to '${req.status}'.`, statusCode: 400 };
    }

    // Verify lease token hash
    const candidateHash = await sha256Hex(req.leaseToken);
    if (this.db) {
      const row = await this.db.prepare('SELECT lease_token, lease_expires_at FROM print_jobs WHERE id = ?').bind(req.jobId).first();
      if (!row || row.lease_token !== candidateHash) {
        return { success: false, error: 'Invalid lease token.', statusCode: 403 };
      }
    } else {
      const storedHash = this.leaseHashes.get(req.jobId);
      if (!storedHash || storedHash !== candidateHash) {
        return { success: false, error: 'Invalid lease token.', statusCode: 403 };
      }
    }

    const now = Date.now();
    const completedAt = req.status === 'completed' ? now : null;

    if (this.db) {
      await this.db.prepare(`
        UPDATE print_jobs
        SET status = ?, status_message = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).bind(req.status, req.statusMessage ?? null, now, completedAt, req.jobId).run();
    } else {
      job.status = req.status;
      job.statusMessage = req.statusMessage;
      job.updatedAt = now;
      if (completedAt) job.completedAt = completedAt;
    }

    // If completed or failed, securely scrub payload from storage
    if (req.status === 'completed') {
      try {
        if (this.r2) {
          await this.r2.delete(job.r2StorageKey);
        } else {
          this.storage.delete(job.r2StorageKey);
        }
      } catch (delErr) {
        console.error('Storage deletion error:', delErr);
      }
    }

    return { success: true };
  }

  /**
   * Periodic retention cleanup for expired R2 objects and orphaned jobs
   */
  async cleanupExpired(maxAgeMs = 24 * 3600 * 1000): Promise<{ cleanedJobsCount: number }> {
    const cutoff = Date.now() - maxAgeMs;
    let count = 0;

    if (this.db) {
      const expiredJobs = await this.db.prepare(`
        SELECT id, r2_storage_key FROM print_jobs
        WHERE created_at < ? OR status IN ('completed', 'failed', 'cancelled')
      `).bind(cutoff).all();

      for (const row of expiredJobs.results ?? []) {
        if (this.r2 && row.r2_storage_key) {
          try {
            await this.r2.delete(row.r2_storage_key);
          } catch (e) {
            console.error('R2 cleanup error:', e);
          }
        }
        await this.db.prepare('DELETE FROM print_jobs WHERE id = ?').bind(row.id).run();
        count++;
      }
      return { cleanedJobsCount: count };
    }

    for (const [id, job] of this.jobs.entries()) {
      if (job.createdAt < cutoff || job.status === 'completed') {
        this.storage.delete(job.r2StorageKey);
        this.leaseHashes.delete(id);
        this.jobs.delete(id);
        count++;
      }
    }
    return { cleanedJobsCount: count };
  }

  getFileBytes(storageKey: string): Uint8Array | undefined {
    return this.storage.get(storageKey);
  }
}

/**
 * Cloudflare Worker fetch & scheduled entrypoint
 */
// Singleton or persistent API instance cache per environment in dev/test
let cachedDevApi: PrintBridgeApi | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // If request is not an API call, serve static frontend assets if ASSETS binding exists
    if (!url.pathname.startsWith('/api') && env.ASSETS) {
      return await env.ASSETS.fetch(request);
    }

    const isProd = env.ENVIRONMENT === 'production';
    let api: PrintBridgeApi;
    if (isProd || env.DB) {
      api = new PrintBridgeApi({
        apiKey: env.GATEWAY_API_KEY,
        employeeSecret: env.EMPLOYEE_AUTH_SECRET,
        tenantId: env.DEFAULT_TENANT_ID,
        db: env.DB,
        r2: env.STORAGE,
        isProduction: isProd
      });
    } else {
      if (!cachedDevApi) {
        cachedDevApi = new PrintBridgeApi({
          apiKey: env.GATEWAY_API_KEY,
          employeeSecret: env.EMPLOYEE_AUTH_SECRET,
          tenantId: env.DEFAULT_TENANT_ID,
          isProduction: false
        });
      }
      api = cachedDevApi;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Key, Cf-Access-Authenticated-User-Email'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    try {
      // Exchange session token with employee passkey
      if (url.pathname === '/api/auth/session' && request.method === 'POST') {
        const body: any = await request.json();
        const res = api.exchangeSession(body.passkey);
        return new Response(JSON.stringify(res), {
          status: res.success ? 200 : 401,
          headers
        });
      }

      if (url.pathname === '/api/printers' && request.method === 'GET') {
        return new Response(JSON.stringify(api.getPrinters()), { headers });
      }

      // Submit print job (requires employee authentication)
      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        let authContext: AuthContext;
        try {
          authContext = api.authenticateEmployee(request.headers);
        } catch (authErr: any) {
          return new Response(JSON.stringify({ error: authErr.message }), { status: 401, headers });
        }

        const body: any = await request.json();
        const fileBytes = Uint8Array.from(atob(body.fileBase64), c => c.charCodeAt(0));
        const res = await api.createJob({
          tenantId: authContext.tenantId,
          userId: authContext.userId,
          userEmail: authContext.userEmail,
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

      // Query job status (requires employee authentication and tenant isolation)
      if (url.pathname.startsWith('/api/jobs/') && request.method === 'GET') {
        let authContext: AuthContext;
        try {
          authContext = api.authenticateEmployee(request.headers);
        } catch (authErr: any) {
          return new Response(JSON.stringify({ error: authErr.message }), { status: 401, headers });
        }

        const jobId = url.pathname.replace('/api/jobs/', '');
        const job = await api.getJob(jobId, authContext.tenantId);
        if (!job) {
          return new Response(JSON.stringify({ error: 'Job not found.' }), { status: 404, headers });
        }
        return new Response(JSON.stringify(job), { headers });
      }

      // Agent claim endpoint
      if (url.pathname === '/api/agent/claim' && request.method === 'POST') {
        const agentKey = request.headers.get('X-Agent-Key');
        const body = (await request.json()) as ClaimJobRequest;
        const res = await api.claimJob(body, agentKey);
        return new Response(JSON.stringify(res), { headers });
      }

      // Agent authenticated document download endpoint
      if (url.pathname.startsWith('/api/agent/jobs/') && url.pathname.endsWith('/download') && request.method === 'GET') {
        const parts = url.pathname.split('/');
        const jobId = parts[parts.length - 2];
        const leaseToken = url.searchParams.get('leaseToken') || '';
        const agentKey = request.headers.get('X-Agent-Key');

        const dlRes = await api.getDocumentPayload(jobId, leaseToken, agentKey);
        if (dlRes.error || !dlRes.fileBytes) {
          return new Response(JSON.stringify({ error: dlRes.error }), {
            status: dlRes.statusCode || 400,
            headers
          });
        }

        return new Response(dlRes.fileBytes.buffer as ArrayBuffer, {
          status: 200,
          headers: {
            'Content-Type': dlRes.mimeType || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${dlRes.filename || 'document'}"`
          }
        });
      }

      // Agent update status endpoint
      if (url.pathname === '/api/agent/status' && request.method === 'POST') {
        const agentKey = request.headers.get('X-Agent-Key');
        const body = (await request.json()) as UpdateJobStatusRequest;
        const res = await api.updateJobStatus(body, agentKey);
        return new Response(JSON.stringify(res), {
          status: res.success ? 200 : (res.statusCode || 400),
          headers
        });
      }

      return new Response(JSON.stringify({ error: 'Endpoint not found.' }), { status: 404, headers });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  },

  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    const isProd = env.ENVIRONMENT === 'production';
    const api = new PrintBridgeApi({
      apiKey: env.GATEWAY_API_KEY,
      db: env.DB,
      r2: env.STORAGE,
      isProduction: isProd
    });
    const res = await api.cleanupExpired();
    console.log(`[RETENTION_CRON] Cleaned up ${res.cleanedJobsCount} expired print jobs and temporary R2 documents.`);
  }
};
