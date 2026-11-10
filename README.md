# Print Bridge by DTC — Universal Cloud Printing Platform

Print Bridge allows authorized users and office guests to print documents directly from phones, tablets, and laptops to existing office printers without needing to email or message files between machines.

## Architecture Overview

```
 [ Guest & Employee Web UI (/) ]            [ Admin Dashboard (/admin) ]
              │                                           │
              └─────────────────────┬─────────────────────┘
                                    │ (HTTPS)
                                    ▼
                         [ Cloudflare Workers API ]
                          - D1 Database: print-bridge-d1
                          - R2 Bucket: print-bridge-documents
                          - Scheduled cron cleanup (15 min)
                                    │
                                    │ Outbound HTTPS Polling
                                    ▼
                      [ Windows 10 Gateway Agent ]
                       - FileSandbox restricted directory
                       - winspool.drv & Windows driver bridge
                       - Diagnostics & safe dry-run mode
                                    │
                                    │ Windows Network Printer Share
                                    ▼
                      [ SILVERTOUCH-PC (Windows 7) ]
                       HP LaserJet Professional M1136 MFP
```

### Critical Security & Data Guarantees
- **SILVERTOUCH-PC is untouched**: Contains ~5 TB of historical company data. **NEVER** install software or modify anything on `SILVERTOUCH-PC`.
- **Restricted Filesystem Sandbox**: The agent only reads and writes within its designated temporary folder (`PrintBridgeTemp`).
- **Immediate Data Scrubbing**: Uploaded documents in Cloudflare R2 are deleted immediately after spooler handoff.
- **Fail-Closed Security**: The agent and administrative endpoints fail closed if secrets or credentials are unset.
- **Hardware Reality**: Network printer reachability is confirmed, but physical paper output remains untested until an attended in-person hardware test is performed.

## Monorepo Layout

- `apps/web`: Public guest printing interface (`/`) and private admin dashboard (`/admin`).
- `apps/api`: Cloudflare Workers backend with D1 database and R2 storage bindings.
- `apps/windows-agent`: Portable C# .NET 8 agent (`PrintBridgeAgent.exe`).
- `packages/shared`: Shared data contracts, HP LaserJet M1136 profile, settings validator, and page range parser.
- `packages/renderers`: Modular rendering adapters (PDF, Images, Text, Office, HTML).
- `tests/`: Automated unit, integration, and E2E test suites.
- `docs/`: Setup guides and Google Antigravity continuation handoff.

## Running Tests

```bash
# Run all TypeScript and .NET unit, integration, and adversarial tests
npm test
```

## Documentation
- Detailed deployment instructions: [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md)
- Complete Google Antigravity handoff: [`docs/ANTIGRAVITY_HANDOFF.md`](docs/ANTIGRAVITY_HANDOFF.md)
