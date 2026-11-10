# Cloudflare Deployment & Operations Manual — Print Bridge by DTC

A complete, beginner-friendly manual for configuring and operating Print Bridge on Cloudflare.

---

## 1. Verified Production Environment

- **Cloudflare Workers Plan**: Free
- **Worker Name**: `print-bridge-api`
- **D1 Database**: `print-bridge-d1`
- **D1 Database ID**: `3aa0a5f9-6087-46ea-ba88-e57727f6073b` (configured in `apps/api/wrangler.toml`)
- **R2 Bucket**: `print-bridge-documents`
- **R2 Public Dev URL**: Disabled (private access only)
- **R2 Object Expiration**: 1 day (`delete-temp-documents`)
- **Default System Settings**: `queue_paused=true`, `max_copies_limit=50`

---

## 2. Setting Production Secrets via Wrangler

Secrets must **never** be placed in the git repository. Set them using Wrangler:

```bash
cd apps/api

# Gateway authentication key for Windows Agent polling
npx wrangler secret put GATEWAY_API_KEY
# Enter a high-entropy secret string

# Administrator password for /admin dashboard (username: admin123)
npx wrangler secret put ADMIN_PASSWORD
# Enter your private administrator password (strictly isolated from employee credentials)
```

---

## 3. Database Schema & Tables

The SQLite database migration (`apps/api/migrations/0001_init.sql`) initializes:
- `tenants`: Multi-tenant organization boundaries.
- `printers`: Configured office printer capabilities (pointing to `\\SILVERTOUCH-PC\HP LaserJet Professional M1136 MFP`).
- `print_jobs`: Queue containing `employee_name`, `receipt_token` (guest tracking), `lease_token` (agent lease), and settings.
- `system_settings`: Persists `queue_paused` and `max_copies_limit`.
- `agents`: Gateway agent enrollment metadata.
- `audit_logs`: Audit trail for queue operations.

### Executing Migrations:

```bash
# Local development:
npx wrangler d1 execute print-bridge-d1 --local --file=./migrations/0001_init.sql

# Production deployment:
npx wrangler d1 execute print-bridge-d1 --remote --file=./migrations/0001_init.sql
```

---

## 4. Cloudflare Access (Zero Trust) RS256 Verification

To authenticate employees using Cloudflare Access Zero Trust:
1. Configure `CF_ACCESS_AUD` (Audience tag from Access application overview) in `wrangler.toml` or via environment variable.
2. Configure `CF_ACCESS_TEAM_DOMAIN` (e.g. `https://yourteam.cloudflareaccess.com`) in `wrangler.toml`.
3. The API cryptographically fetches public RSA certificates from `https://yourteam.cloudflareaccess.com/cdn-cgi/access/certs` and verifies RS256 signatures, issuer, audience, and expiration.
4. If `CF_ACCESS_AUD` or `CF_ACCESS_TEAM_DOMAIN` are unset, the Access JWT route fails closed.

---

## 5. Deploying the Application

From `apps/api`:

```bash
npx wrangler deploy
```

This command publishes:
1. API routing (`/api/*`).
2. Public guest web UI (`/`) and private admin dashboard (`/admin`) via Workers Static Assets.
3. Retention cleanup cron trigger (`*/15 * * * *`).

---

## 6. Deployment Verification Checklist

1. **Safety Checkpoint**: Verify queue remains paused (`queue_paused=true`) until ready.
2. **Admin Dashboard**:
   - Access `https://<worker-domain>/admin`.
   - Log in using `admin123` and the configured `ADMIN_PASSWORD`.
   - Confirm queue is reported as **Queue Paused**.
3. **Gateway Agent**:
   - Run diagnostics on the Windows 10 gateway machine:
     ```cmd
     set PB_API_URL=https://<worker-domain>
     set PB_AGENT_KEY=<your-agent-key>
     PrintBridgeAgent.exe --diagnose
     ```
   - Verify network printer reachability to `\\SILVERTOUCH-PC\HP LaserJet Professional M1136 MFP`.
   - Test polling in safe dry-run mode:
     ```cmd
     PrintBridgeAgent.exe --single-poll --dry-run
     ```
4. **Queue Unpause**:
   - When verified, click **Resume Queue** on the `/admin` dashboard.
