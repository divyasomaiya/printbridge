-- Print Bridge Database Schema for Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_key_hash TEXT NOT NULL,
    hostname TEXT NOT NULL,
    os_version TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    share_name TEXT NOT NULL,
    full_unc_path TEXT NOT NULL,
    is_online INTEGER NOT NULL DEFAULT 1,
    supports_color INTEGER NOT NULL DEFAULT 0,
    supports_auto_duplex INTEGER NOT NULL DEFAULT 0,
    supports_manual_duplex INTEGER NOT NULL DEFAULT 1,
    max_copies INTEGER NOT NULL DEFAULT 99,
    description TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    employee_name TEXT,
    receipt_token TEXT,
    printer_id TEXT NOT NULL,
    printer_name TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    file_format TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    r2_storage_key TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    status TEXT NOT NULL,
    status_message TEXT,
    claimed_by_agent_id TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(printer_id) REFERENCES printers(id)
);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    job_id TEXT,
    actor TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL
);

-- Seed default office tenant, printer, and system settings
INSERT OR IGNORE INTO tenants (id, name, created_at)
VALUES ('dtc-office', 'DTC Main Office', 1715000000);

INSERT OR IGNORE INTO printers (
    id, tenant_id, name, host, share_name, full_unc_path,
    is_online, supports_color, supports_auto_duplex, supports_manual_duplex,
    max_copies, description, updated_at
) VALUES (
    'hp-laserjet-m1136',
    'dtc-office',
    'HP LaserJet Professional M1136 MFP',
    'SILVERTOUCH-PC',
    'HP LaserJet Professional M1136 MFP',
    '\\\\SILVERTOUCH-PC\\HP LaserJet Professional M1136 MFP',
    1,
    0,
    0,
    1,
    99,
    'Shared monochrome office laser printer on SILVERTOUCH-PC',
    1715000000
);

INSERT OR IGNORE INTO system_settings (key, value, updated_at)
VALUES ('queue_paused', 'true', 1715000000);

INSERT OR IGNORE INTO system_settings (key, value, updated_at)
VALUES ('max_copies_limit', '50', 1715000000);
