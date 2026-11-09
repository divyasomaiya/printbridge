# Print Bridge by DTC — Universal Cloud Printing Platform

Print Bridge allows authorized users to print documents directly from phones, tablets, and laptops to existing office printers without needing to email or message files between machines.

## Architecture Overview

```
 [ Mobile / Laptop Web Client ]
              │ (HTTPS)
              ▼
   [ Cloudflare Workers & R2 ]  <──  Outbound Polling (HTTPS)  ───┐
      - Job queue & validation                                     │
      - Temporary document storage                                 │
      - 24-hr TTL cleanup                                          │
                                                                   ▼
                                                     [ Windows 10 Gateway Agent ]
                                                      (Dedicated safe sandbox)
                                                                   │
                                                                   │ Windows Spooler API
                                                                   │ (UNC: \\SILVERTOUCH-PC\HP...)
                                                                   ▼
                                                     [ SILVERTOUCH-PC (Win 7) ]
                                                      HP LaserJet M1136 MFP
```

### Critical Security Guarantees
- **SILVERTOUCH-PC is untouched**: No software or drivers are modified or installed on `SILVERTOUCH-PC`.
- **Restricted Filesystem Sandbox**: The agent only reads and writes within its configured temporary directory (`C:\PrintBridge\temp` or OS temp).
- **Symlink & Junction Rejection**: Protects company files from unauthorized access or path traversal.
- **Immediate Secure Deletion**: Documents are cleaned up from Cloudflare R2 and gateway storage immediately following spool handoff.
- **Isolated Renderers**: Renderers enforce timeouts, macro denial, and memory bounds.

## Monorepo Layout

- `apps/web`: Responsive web application with print dialog and mobile support.
- `apps/api`: Cloudflare Workers backend with D1 metadata and R2 storage handling.
- `apps/windows-agent`: Lightweight portable C# Windows agent (`PrintBridgeAgent.exe`).
- `packages/shared`: Shared data contracts, HP LaserJet M1136 profile, settings validator, and page range parser.
- `packages/renderers`: Modular rendering pipeline (PDF, Images, Text, Office, HTML).
- `tests/`: Automated unit and end-to-end test suites.
- `docs/`: In-depth documentation and Google Antigravity development handoff.

## Running Tests

```bash
# Run all TypeScript & .NET unit and integration tests
npm test
```

## Documentation
See [`docs/ANTIGRAVITY_HANDOFF.md`](docs/ANTIGRAVITY_HANDOFF.md) for full architecture specs, Windows 7 vs 10 compatibility matrix, and instructions for Google Antigravity development.
