# Supply-Chain Evidence (T103)

**Date**: 2026-07-16
**Scope**: SR-001 / SC-007 / SR-008 — dependency audit, secret scan, SBOM, container image posture.

## Dependency audit

Command:

```bash
npm run audit   # npm audit --omit=dev --audit-level=high
```

Result:

```
found 0 vulnerabilities
```

No High or Critical advisory affects the production dependency closure. The audit is enforced in CI (`.github/workflows/ci.yml` → "Dependency audit").

## Secret scan

Command:

```bash
npm run secret-scan   # scripts/secret-scan.mjs
```

Result:

```
secret-scan OK (no high-confidence secrets found)
```

The scanner walks tracked source for high-confidence patterns (private keys, AWS keys, GitHub PATs,
Telegram bot tokens, generic `secret/token/password = "…"` assignments). Intentionally-fake secrets
that exist only to prove redaction (SR-001 / SC-007) are allowlisted and are confined to `tests/`,
`fixtures/`, and `.env.example`. The credential-leak lane (`tests/security/credential-leak.test.ts`)
independently asserts no vault ref or raw secret reaches DB rows, logs, traces, outbox payloads,
tickets, or error envelopes.

## SBOM

Generated `evidence/sbom.json` (CycloneDX 1.5) for the production dependency set:

| Component | Version |
|---|---|
| @opentelemetry/api | 1.9.1 |
| dotenv | 17.4.2 |
| fastify | 5.10.0 |
| grammy | 1.44.0 |
| kysely | 0.29.3 |
| pg | 8.22.0 |
| pino | 10.3.1 |
| ulid | 3.0.2 |
| zod | 4.4.3 |

Runtime is Node 24 (ESM). All production dependencies are pinned via `package-lock.json`; CI installs
with `npm ci` (locked, reproducible).

## Container image scan

**Status: launch gate (SR-008).** The pilot runs from source with `npm ci` + `npm run build`; no
production container image is published from this repository yet. Before production:

- build the deployment image from a pinned minimal base (e.g. `node:24-bookworm-slim` or distroless);
- run an image scanner (Trivy/Grype) in CI and fail on High/Critical OS + library findings;
- sign the image and record the digest in the deployment runbook.

This item is intentionally deferred to the launch gate rather than marked complete, so the container
posture is not silently claimed. See `launch-gates.md`.

## Residual supply-chain risk

- **SEC-014 (upstream account provenance)**: mitigated in-app by supplier authorization evidence,
  asset validation, and quarantine, but the human authorization per active SKU remains a launch gate.
- **Transitive drift**: `npm audit` + lockfile pinning bound the risk; a scheduled re-audit belongs in
  the deployment cadence.
