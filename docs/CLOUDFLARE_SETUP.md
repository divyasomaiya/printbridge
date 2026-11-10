# Cloudflare Deployment & Operations Manual — Print Bridge by DTC

A complete, beginner-friendly manual for configuring and operating Print Bridge on Cloudflare.

---

## 1. Cloudflare Dashboard Overview & Login

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Select your target account from the home dashboard.

---

## 2. Creating the D1 Database (Metadata & Queue)

1. Navigate to **Storage & Databases** > **D1 SQL Database** in the left sidebar.
2. Click **Create database**.
3. Set the database name:
   ```
   print-bridge-d1
   ```
4. Click **Create**.
5. Once created, note the **Database ID** (a UUID like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

---

## 3. Creating the Private R2 Storage Bucket (Temporary Documents)

1. Navigate to **Storage & Databases** > **R2 Object Storage** in the left sidebar.
2. Click **Create bucket**.
3. Set the bucket name:
   ```
   print-bridge-documents
   ```
4. Leave bucket access as **Private** (do NOT enable Public Access or custom public domains; all access must flow through authenticated Worker endpoints).
5. (Optional) In bucket settings, add an **Object Lifecycle Rule** to auto-expire objects after 1 day as an extra defense-in-depth safety net.

---

## 4. Configuring `apps/api/wrangler.toml`

Open `apps/api/wrangler.toml` on your deployment machine and configure:

```toml
name = "print-bridge-api"
main = "src/index.ts"
compatibility_date = "2024-05-01"

[assets]
directory = "../web/public"
binding = "ASSETS"

[vars]
ENVIRONMENT = "production"
DEFAULT_TENANT_ID = "dtc-office"
CF_ACCESS_AUD = "<PASTE-YOUR-CLOUDFLARE-ACCESS-AUDIENCE-TAG-HERE>" # Optional: If using Cloudflare Access Zero Trust
CF_ACCESS_TEAM_DOMAIN = "https://<your-team-name>.cloudflareaccess.com"

[[d1_databases]]
binding = "DB"
database_name = "print-bridge-d1"
database_id = "<PASTE-YOUR-D1-DATABASE-ID-HERE>"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "print-bridge-documents"

[triggers]
crons = ["*/15 * * * *"] # Executes cleanup every 15 minutes
```

---

## 5. Setting Production Secrets via Wrangler

Do **NOT** put secrets in git repositories. Run these commands from your local terminal in `apps/api`:

```bash
# Set the gateway authentication key for the Windows Agent
npx wrangler secret put GATEWAY_API_KEY
# Enter a high-entropy secret (e.g., 32 random characters)

# Set the private admin password for the /admin dashboard (username: admin123)
npx wrangler secret put ADMIN_PASSWORD
# Enter your private administrator password
```

---

## 6. Two Separate Interfaces

1. **Public/Guest Printing (`/`)**:
   - For employees, clients, and guests.
   - Flow: **Open Website → Enter Name → Select Document → Choose Print Settings → Print**.
   - No login, registration, or password required.
   - Status tracking is secured via unguessable receipt tokens.
2. **Private Administrator Dashboard (`/admin`)**:
   - For the owner/staff.
   - Login username: `admin123`.
   - Live queue table with guest names, timestamps, printer status, pause/resume queue button, and job cancellation.

---

## 7. Applying Database Migrations

From the `apps/api` directory:

```bash
# Local testing migration:
npx wrangler d1 execute print-bridge-d1 --local --file=./migrations/0001_init.sql

# Production deployment migration:
npx wrangler d1 execute print-bridge-d1 --remote --file=./migrations/0001_init.sql
```

---

## 8. Deploying the Application

From `apps/api`:

```bash
npx wrangler deploy
```

This single command deploys:
1. The API endpoints (`/api/*`).
2. The public guest UI (`/`) and admin dashboard (`/admin`) via Workers Static Assets.
3. The scheduled retention cron worker.

---

## 9. Usage, Free-Tier Budgets & Billing Monitoring

Monitor consumption at **Compute (Workers)** and **R2** in the Cloudflare dashboard:
- **Workers Requests**: Free tier provides 100,000 requests/day (3,000,000/month). Typical office usage (40 jobs/day with polling) is ~250,000 requests/month (<10% of free limit).
- **R2 Storage**: Free tier provides 10 GB-months. Active queue storage rarely exceeds 500 MB.
- **D1 Reads & Writes**: Free tier provides 5 million reads/day and 100,000 writes/day.
