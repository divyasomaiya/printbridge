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
  ADMIN_PASSWORD?: string; // Private admin password for /admin
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  DEFAULT_TENANT_ID?: string;
}

export interface AuthContext {
  userId: string;
  userEmail: string;
  tenantId: string;
  isAdmin?: boolean;
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

/**
 * Helper to compute HMAC-SHA256 signature in Base64Url.
 */
async function signHmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function verifyHmacSha256(secret: string, data: string, signatureBase64Url: string): Promise<boolean> {
  const expectedSig = await signHmacSha256(secret, data);
  return expectedSig === signatureBase64Url;
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
  private receiptTokens: Map<string, string> = new Map(); // jobId -> unguessable receiptToken
  private leaseHashes: Map<string, string> = new Map();   // jobId -> sha256(leaseToken)
  private storage: Map<string, Uint8Array> = new Map();
  private printers: Map<string, PrinterCapability> = new Map();
  private gatewayApiKey?: string;
  private employeeAuthSecret?: string;
  private adminPassword?: string;
  private cfAccessAud?: string;
  private cfAccessTeamDomain?: string;
  private defaultTenantId: string = 'dtc-office';
  private db?: any;
  private r2?: any;
  private isProduction: boolean = false;
  private queuePaused: boolean = false;
  private maxCopiesLimit: number = 99;

  constructor(options?: {
    apiKey?: string;
    employeeSecret?: string;
    adminPassword?: string;
    cfAccessAud?: string;
    cfAccessTeamDomain?: string;
    tenantId?: string;
    db?: any;
    r2?: any;
    isProduction?: boolean;
  }) {
    if (options?.apiKey) this.gatewayApiKey = options.apiKey;
    if (options?.employeeSecret) this.employeeAuthSecret = options.employeeSecret;
    if (options?.adminPassword) this.adminPassword = options.adminPassword;
    if (options?.cfAccessAud) this.cfAccessAud = options.cfAccessAud;
    if (options?.cfAccessTeamDomain) this.cfAccessTeamDomain = options.cfAccessTeamDomain;
    if (options?.tenantId) this.defaultTenantId = options.tenantId;
    if (options?.db) this.db = options.db;
    if (options?.r2) this.r2 = options.r2;
    this.isProduction = options?.isProduction ?? false;

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

  async getQueueSettings(): Promise<{ queuePaused: boolean; maxCopiesLimit: number }> {
    if (this.db) {
      try {
        const pausedRow = await this.db.prepare('SELECT value FROM system_settings WHERE key = "queue_paused"').first();
        const copiesRow = await this.db.prepare('SELECT value FROM system_settings WHERE key = "max_copies_limit"').first();

        // FAIL-CLOSED SAFETY:
        // If settings record is missing from D1 in production, default queue to PAUSED.
        const isPaused = pausedRow ? pausedRow.value === 'true' : true;
        const maxCopies = copiesRow ? parseInt(copiesRow.value, 10) : 50;
        return { queuePaused: isPaused, maxCopiesLimit: isNaN(maxCopies) ? 50 : maxCopies };
      } catch (dbErr) {
        // FAIL-CLOSED SAFETY:
        // Any database read failure must strictly fail closed (paused queue)
        console.error('Failed to read system_settings from D1, failing closed:', dbErr);
        return { queuePaused: true, maxCopiesLimit: 50 };
      }
    }
    return { queuePaused: this.queuePaused, maxCopiesLimit: this.maxCopiesLimit };
  }

  async setQueueSettings(settings: { queuePaused?: boolean; maxCopiesLimit?: number }): Promise<void> {
    if (typeof settings.queuePaused === 'boolean') {
      this.queuePaused = settings.queuePaused;
      if (this.db) {
        await this.db.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES ("queue_paused", ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
          .bind(settings.queuePaused ? 'true' : 'false', Date.now()).run();
      }
    }
    if (typeof settings.maxCopiesLimit === 'number') {
      this.maxCopiesLimit = settings.maxCopiesLimit;
      if (this.db) {
        await this.db.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES ("max_copies_limit", ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
          .bind(settings.maxCopiesLimit.toString(), Date.now()).run();
      }
    }
  }

  /**
   * Generates a signed, short-lived session token (valid for 8 hours).
   */
  async createSessionToken(userId: string, email: string, isAdmin = false): Promise<string> {
    const signingKey = this.adminPassword || this.employeeAuthSecret;
    if (!signingKey) {
      throw new Error('Server authentication configuration missing: ADMIN_PASSWORD or EMPLOYEE_AUTH_SECRET must be configured.');
    }
    const expiry = Date.now() + 8 * 3600 * 1000;
    const payload = `${userId}:${email}:${expiry}:${this.defaultTenantId}:${isAdmin ? 'admin' : 'emp'}`;
    const sig = await signHmacSha256(signingKey, payload);
    const tokenPayload = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `sess.${tokenPayload}.${sig}`;
  }

  /**
   * Verifies short-lived session token.
   */
  async verifySessionToken(token: string): Promise<AuthContext> {
    const signingKey = this.adminPassword || this.employeeAuthSecret;
    if (!signingKey) {
      throw new Error('Server authentication configuration missing: ADMIN_PASSWORD or EMPLOYEE_AUTH_SECRET must be configured.');
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'sess') {
      throw new Error('Invalid session token format.');
    }
    const tokenPayload = parts[1];
    const signature = parts[2];

    let decodedPayload: string;
    try {
      decodedPayload = atob(tokenPayload.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      throw new Error('Malformed session token encoding.');
    }

    const isValidSig = await verifyHmacSha256(signingKey, decodedPayload, signature);
    if (!isValidSig) {
      throw new Error('Invalid session token signature.');
    }

    const [userId, email, expiryStr, tenantId, role] = decodedPayload.split(':');
    const expiry = parseInt(expiryStr, 10);
    if (Date.now() > expiry) {
      throw new Error('Session token has expired.');
    }

    return {
      userId,
      userEmail: email,
      tenantId: tenantId || this.defaultTenantId,
      isAdmin: role === 'admin'
    };
  }

  /**
   * Admin Login: Verifies username 'admin123' and configured admin password.
   */
  async adminLogin(username: string, password: string): Promise<{ success: boolean; token?: string; error?: string }> {
    if (username !== 'admin123') {
      return { success: false, error: 'Invalid admin username.' };
    }
    const configuredAdminPw = this.adminPassword || this.employeeAuthSecret;
    if (!configuredAdminPw) {
      return { success: false, error: 'Admin password not configured on server.' };
    }
    if (password !== configuredAdminPw) {
      return { success: false, error: 'Invalid admin password.' };
    }

    const token = await this.createSessionToken('admin123', 'admin@office.local', true);
    return { success: true, token };
  }

  async authenticateEmployee(headers: Headers): Promise<AuthContext> {
    const accessJwt = headers.get('Cf-Access-Jwt-Assertion');

    if (accessJwt) {
      // Secure Cloudflare Access verification requires a configured AUD and signing secret/certs.
      // If CF_ACCESS_AUD is not configured, or if verification fails, fail closed.
      if (!this.cfAccessAud) {
        throw new Error('Cloudflare Access authentication path is disabled: CF_ACCESS_AUD is not configured on server.');
      }

      const jwtParts = accessJwt.split('.');
      if (jwtParts.length !== 3) {
        throw new Error('Malformed Cf-Access-Jwt-Assertion.');
      }

      const [headerB64, payloadB64, signatureB64] = jwtParts;
      let payload: any;
      try {
        const payloadJson = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
        payload = JSON.parse(payloadJson);
      } catch {
        throw new Error('Failed to parse Cf-Access-Jwt-Assertion payload.');
      }

      // Check expiration
      const nowSec = Math.floor(Date.now() / 1000);
      if (!payload.exp || payload.exp < nowSec) {
        throw new Error('Cloudflare Access JWT assertion expired.');
      }

      // Validate Audience Tag
      const audClaim = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audClaim.includes(this.cfAccessAud)) {
        throw new Error('Cloudflare Access JWT audience mismatch.');
      }

      // Cryptographic signature check:
      // When a shared secret or team verification secret is configured, verify HMAC signature.
      // Otherwise, reject unverified signature to prevent forgery.
      const verificationSecret = this.employeeAuthSecret || this.adminPassword;
      if (!verificationSecret) {
        throw new Error('Cloudflare Access JWT cryptographic verification key not configured.');
      }

      const signedData = `${headerB64}.${payloadB64}`;
      const isValidSig = await verifyHmacSha256(verificationSecret, signedData, signatureB64);
      if (!isValidSig) {
        throw new Error('Invalid Cloudflare Access JWT signature.');
      }

      const email = payload.email;
      if (!email) {
        throw new Error('Cloudflare Access JWT contains no user email identity.');
      }

      return {
        userId: email,
        userEmail: email,
        tenantId: this.defaultTenantId
      };
    }

    const authHeader = headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized: Missing valid session or Cloudflare Access assertion.');
    }

    const token = authHeader.substring(7).trim();
    return await this.verifySessionToken(token);
  }

  async exchangeSession(passkey: string): Promise<{ success: boolean; token?: string; error?: string }> {
    const secret = this.employeeAuthSecret || this.adminPassword;
    if (!secret) {
      return { success: false, error: 'Server authentication secret not configured.' };
    }
    if (passkey !== secret) {
      return { success: false, error: 'Invalid office passkey.' };
    }

    const sessionToken = await this.createSessionToken('emp_office_user', 'employee@office.local', false);
    return { success: true, token: sessionToken };
  }

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

  async getAdminQueue(tenantId?: string): Promise<PrintJob[]> {
    if (this.db) {
      let query = 'SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 50';
      const rows = await this.db.prepare(query).all();
      return (rows.results || []).map((row: any) => ({
        id: row.id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        userEmail: row.user_email,
        employeeName: row.employee_name || row.guest_name,
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
      }));
    }
    const all = Array.from(this.jobs.values());
    return tenantId ? all.filter(j => j.tenantId === tenantId) : all;
  }

  async cancelJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    const job = await this.getJob(jobId);
    if (!job) return { success: false, error: 'Job not found.' };
    if (job.status === 'completed' || job.status === 'cancelled') {
      return { success: false, error: `Cannot cancel job in '${job.status}' state.` };
    }

    if (this.db) {
      await this.db.prepare('UPDATE print_jobs SET status = "cancelled", status_message = "Cancelled by administrator", updated_at = ? WHERE id = ?')
        .bind(Date.now(), jobId).run();
    } else {
      job.status = 'cancelled';
      job.statusMessage = 'Cancelled by administrator';
      job.updatedAt = Date.now();
    }

    if (this.r2) {
      await this.r2.delete(job.r2StorageKey);
    } else {
      this.storage.delete(job.r2StorageKey);
    }

    return { success: true };
  }

  /**
   * Creates a print job. Supports public guest submission (if guestName is supplied)
   * or authenticated employee submission.
   */
  async createJob(params: {
    tenantId: string;
    userId: string;
    userEmail: string;
    employeeName?: string;
    guestName?: string;
    printerId: string;
    filename: string;
    fileBytes: Uint8Array;
    settings: PrintSettings;
  }): Promise<{ success: boolean; job?: PrintJob; receiptToken?: string; error?: string }> {
    const queueSettings = await this.getQueueSettings();
    if (queueSettings.queuePaused) {
      return { success: false, error: 'Print queue is currently paused by the administrator.' };
    }

    if (params.settings.copies > queueSettings.maxCopiesLimit) {
      return { success: false, error: `Requested copies (${params.settings.copies}) exceeds administrator limit (${queueSettings.maxCopiesLimit}).` };
    }

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
    const receiptToken = generateSecureToken('rcpt');
    const storageKey = `uploads/${params.tenantId}/${jobId}/${params.filename}`;

    const displayName = params.guestName || params.employeeName || 'Anonymous';

    const newJob: PrintJob = {
      id: jobId,
      tenantId: params.tenantId,
      userId: params.userId,
      userEmail: params.userEmail,
      employeeName: displayName,
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
          id, tenant_id, user_id, user_email, employee_name, receipt_token, printer_id, printer_name,
          original_filename, file_size_bytes, file_format, mime_type,
          r2_storage_key, settings_json, status, status_message, lease_token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        newJob.id, newJob.tenantId, newJob.userId, newJob.userEmail, displayName, receiptToken,
        newJob.printerId, newJob.printerName, newJob.originalFileName,
        newJob.fileSizeBytes, newJob.fileFormat, newJob.mimeType,
        newJob.r2StorageKey, JSON.stringify(newJob.settings),
        newJob.status, newJob.statusMessage, null, newJob.createdAt, newJob.updatedAt
      ).run();
    } else {
      this.jobs.set(jobId, newJob);
      this.receiptTokens.set(jobId, receiptToken);
    }

    return { success: true, job: newJob, receiptToken };
  }

  async getJob(jobId: string, tenantId?: string, receiptToken?: string): Promise<PrintJob | undefined> {
    if (this.db) {
      let query = 'SELECT * FROM print_jobs WHERE id = ?';
      const params = [jobId];
      if (tenantId) {
        query += ' AND tenant_id = ?';
        params.push(tenantId);
      }
      const row = await this.db.prepare(query).bind(...params).first();
      if (!row) return undefined;

      // If receipt token is provided for guest tracking, verify match against receipt_token column
      if (receiptToken && row.receipt_token !== receiptToken) {
        return undefined;
      }

      return {
        id: row.id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        userEmail: row.user_email,
        employeeName: row.employee_name,
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

    if (receiptToken) {
      const storedReceipt = this.receiptTokens.get(jobId);
      if (storedReceipt !== receiptToken) return undefined;
    }

    return job;
  }

  async claimJob(req: ClaimJobRequest, agentAuthToken?: string | null): Promise<ClaimJobResponse> {
    this.assertAgentAuthenticated(agentAuthToken);

    const settings = await this.getQueueSettings();
    if (settings.queuePaused) {
      console.log('claimJob rejected: print queue is paused by administrator.');
      return { job: null };
    }

    const now = Date.now();
    const leaseDuration = (req.leaseDurationSeconds || LEASE_DURATION_SECONDS) * 1000;
    const leaseExpiresAt = now + leaseDuration;

    if (this.db) {
      const printersList = req.supportedPrinters && req.supportedPrinters.length > 0
        ? req.supportedPrinters
        : ['hp-laserjet-m1136', 'mock-printer-test'];
      const printerPlaceholders = printersList.map(() => '?').join(',');
      const candidate = await this.db.prepare(`
        SELECT id FROM print_jobs
        WHERE (status = 'pending' OR (status = 'claimed' AND lease_expires_at < ?))
        AND printer_id IN (${printerPlaceholders})
        ORDER BY created_at ASC LIMIT 1
      `).bind(now, ...printersList).first();

      if (!candidate) {
        return { job: null };
      }

      const leaseToken = generateSecureToken('lease');
      const leaseHash = await sha256Hex(leaseToken);

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
        return { job: null };
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

    if (job.claimedByAgentId && job.claimedByAgentId !== req.agentId) {
      return { success: false, error: 'Agent ownership mismatch: job was claimed by a different agent.', statusCode: 403 };
    }

    const validNextStates = ALLOWED_STATUS_TRANSITIONS[job.status] || [];
    if (!validNextStates.includes(req.status)) {
      return { success: false, error: `Invalid state transition from '${job.status}' to '${req.status}'.`, statusCode: 400 };
    }

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

    if (req.status === 'completed' || req.status === 'failed') {
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
      if (job.createdAt < cutoff || job.status === 'completed' || job.status === 'failed') {
        this.storage.delete(job.r2StorageKey);
        this.leaseHashes.delete(id);
        this.receiptTokens.delete(id);
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
let cachedDevApi: PrintBridgeApi | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve /admin route to admin.html if ASSETS binding exists
    if (url.pathname === '/admin' && env.ASSETS) {
      return await env.ASSETS.fetch(new Request(new URL('/admin.html', request.url), request));
    }

    if (!url.pathname.startsWith('/api') && env.ASSETS) {
      return await env.ASSETS.fetch(request);
    }

    const isProd = env.ENVIRONMENT === 'production';
    let api: PrintBridgeApi;
    if (isProd || env.DB) {
      api = new PrintBridgeApi({
        apiKey: env.GATEWAY_API_KEY,
        employeeSecret: env.EMPLOYEE_AUTH_SECRET,
        adminPassword: env.ADMIN_PASSWORD,
        cfAccessAud: env.CF_ACCESS_AUD,
        cfAccessTeamDomain: env.CF_ACCESS_TEAM_DOMAIN,
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
          adminPassword: env.ADMIN_PASSWORD,
          cfAccessAud: env.CF_ACCESS_AUD,
          cfAccessTeamDomain: env.CF_ACCESS_TEAM_DOMAIN,
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Key, Cf-Access-Jwt-Assertion, Cf-Access-Authenticated-User-Email'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    try {
      // Admin Login: Username 'admin123' + password
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        const body: any = await request.json();
        const res = await api.adminLogin(body.username, body.password);
        return new Response(JSON.stringify(res), {
          status: res.success ? 200 : 401,
          headers
        });
      }

      // Legacy/Employee session exchange with PIN
      if (url.pathname === '/api/auth/session' && request.method === 'POST') {
        const body: any = await request.json();
        const res = await api.exchangeSession(body.passkey);
        return new Response(JSON.stringify(res), {
          status: res.success ? 200 : 401,
          headers
        });
      }

      if (url.pathname === '/api/printers' && request.method === 'GET') {
        return new Response(JSON.stringify(api.getPrinters()), { headers });
      }

      // Submit print job:
      // Supports Public Guest Submission (requires only guestName) OR authenticated employee
      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        const body: any = await request.json();
        const fileBytes = Uint8Array.from(atob(body.fileBase64), c => c.charCodeAt(0));

        let tenantId = 'dtc-office';
        let userId = 'guest_user';
        let userEmail = 'guest@office.local';
        let guestName = body.guestName?.trim();

        // Check if caller provided employee session / Access token
        try {
          const auth = await api.authenticateEmployee(request.headers);
          userId = auth.userId;
          userEmail = auth.userEmail;
          tenantId = auth.tenantId;
          if (!guestName) guestName = auth.userId;
        } catch {
          // Public Guest Printing: name is required to identify print job
          if (!guestName) {
            return new Response(JSON.stringify({ error: 'Name is required to submit a print job.' }), {
              status: 400,
              headers
            });
          }
        }

        const res = await api.createJob({
          tenantId,
          userId,
          userEmail,
          guestName,
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

      // Administrative Queue Management endpoints (Protected strictly with Admin Role check)
      if (url.pathname === '/api/admin/queue' && request.method === 'GET') {
        let authContext: AuthContext;
        try {
          authContext = await api.authenticateEmployee(request.headers);
          if (!authContext.isAdmin) {
            return new Response(JSON.stringify({ error: 'Forbidden: Administrator privileges required.' }), { status: 403, headers });
          }
        } catch (authErr: any) {
          return new Response(JSON.stringify({ error: authErr.message }), { status: 401, headers });
        }
        const queue = await api.getAdminQueue(authContext.tenantId);
        return new Response(JSON.stringify(queue), { headers });
      }

      if (url.pathname.startsWith('/api/admin/queue/') && url.pathname.endsWith('/cancel') && request.method === 'POST') {
        try {
          const authContext = await api.authenticateEmployee(request.headers);
          if (!authContext.isAdmin) {
            return new Response(JSON.stringify({ error: 'Forbidden: Administrator privileges required.' }), { status: 403, headers });
          }
        } catch (authErr: any) {
          return new Response(JSON.stringify({ error: authErr.message }), { status: 401, headers });
        }
        const jobId = url.pathname.replace('/api/admin/queue/', '').replace('/cancel', '');
        const res = await api.cancelJob(jobId);
        return new Response(JSON.stringify(res), { status: res.success ? 200 : 400, headers });
      }

      if (url.pathname === '/api/admin/settings' && request.method === 'GET') {
        try {
          const authContext = await api.authenticateEmployee(request.headers);
          if (!authContext.isAdmin) {
            return new Response(JSON.stringify({ error: 'Forbidden: Administrator privileges required.' }), { status: 403, headers });
          }
        } catch (authErr: any) {
          return new Response(JSON.stringify({ error: authErr.message }), { status: 401, headers });
        }
        const settings = await api.getQueueSettings();
        return new Response(JSON.stringify(settings), { headers });
      }

      if (url.pathname === '/api/admin/settings' && request.method === 'POST') {
        try {
          const authContext = await api.authenticateEmployee(request.headers);
          if (!authContext.isAdmin) {
            return new Response(JSON.stringify({ error: 'Forbidden: Administrator privileges required.' }), { status: 403, headers });
          }
        } catch (authErr: any) {
          return new Response(JSON.stringify({ error: authErr.message }), { status: 401, headers });
        }
        const body: any = await request.json();
        await api.setQueueSettings(body);
        const settings = await api.getQueueSettings();
        return new Response(JSON.stringify({ success: true, settings }), { headers });
      }

      // Query job status:
      // Authorized via either unguessable receiptToken query param (guest receipt) OR employee auth header
      if (url.pathname.startsWith('/api/jobs/') && request.method === 'GET') {
        const jobId = url.pathname.replace('/api/jobs/', '');
        const receiptToken = url.searchParams.get('receiptToken');

        let isAuth = false;
        let tenantId = 'dtc-office';

        if (receiptToken) {
          isAuth = true;
        } else {
          try {
            const auth = await api.authenticateEmployee(request.headers);
            tenantId = auth.tenantId;
            isAuth = true;
          } catch {
            isAuth = false;
          }
        }

        if (!isAuth) {
          return new Response(JSON.stringify({ error: 'Unauthorized: Missing valid receipt token or session.' }), {
            status: 401,
            headers
          });
        }

        const job = await api.getJob(jobId, tenantId, receiptToken || undefined);
        if (!job) {
          return new Response(JSON.stringify({ error: 'Job not found or invalid receipt token.' }), {
            status: 404,
            headers
          });
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
