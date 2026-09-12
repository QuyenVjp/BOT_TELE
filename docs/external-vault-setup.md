# External Vault setup

BOT_TELE's `external` Vault driver is a repository-specific HTTPS JSON secret-store protocol. It is **not** a HashiCorp Vault client and does not use HashiCorp paths, mounts, policies, AppRole, or KV APIs.

## Required environment

Configure the service environment locally. Do not paste token values into chat, tickets, logs, or committed files.

```dotenv
VAULT_DRIVER=external
VAULT_ENDPOINT=https://vault.example.invalid
VAULT_TOKEN=<secret>
VAULT_NAMESPACE=telegram-shop
VAULT_TIMEOUT_MS=5000
VAULT_MAX_ATTEMPTS=3
VAULT_EGRESS_HOST_ALLOWLIST=vault.example.invalid
VAULT_EGRESS_PORT_ALLOWLIST=443
VAULT_EGRESS_CIDR_ALLOWLIST=<approved-vault-network-cidr>
```

`VAULT_ENDPOINT` may include a base path, for example `https://vault.example.invalid/bot-tele`. It must not include username/password credentials, a query string, or a fragment. Production transport must be HTTPS.

`VAULT_NAMESPACE` must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. The default is `telegram-shop`.

`VAULT_TIMEOUT_MS` is the deadline for each individual request attempt, including DNS resolution, socket I/O, and the response body. Valid range: `10..30000`; default: `5000`. A full Vault operation may take longer when transient failures are retried, because each retry receives a fresh per-attempt deadline plus bounded backoff.

`VAULT_MAX_ATTEMPTS` is the maximum request attempt count. Valid range: `1..5`; default: `3`. The adapter retries only transient failures/statuses (`408`, `425`, `429`, `500`, `502`, `503`, `504`) with bounded exponential backoff. Strict non-transient failures, validation failures, and not-found reads are not retried.

All three egress allowlists are required in production external mode:

- `VAULT_EGRESS_HOST_ALLOWLIST`: comma-separated endpoint hostnames. The configured endpoint hostname must be present.
- `VAULT_EGRESS_PORT_ALLOWLIST`: comma-separated numeric ports. The effective endpoint port must be present (`443` for HTTPS unless an explicit port is used).
- `VAULT_EGRESS_CIDR_ALLOWLIST`: comma-separated IPv4/IPv6 CIDRs. Every DNS result for the endpoint must be inside an allowed CIDR.

The adapter resolves DNS for every request, rejects mixed allowed/disallowed results, and pins the approved address set into the actual request lookup to prevent DNS-rebinding escape.

## Provider protocol

Every request sends:

```text
Authorization: Bearer <VAULT_TOKEN>
Accept: application/json
```

Requests with JSON bodies also send `Content-Type: application/json`.

Health check:

```text
GET <base-path>/healthz
200 application/json
{"status":"ok"}
```

Secret path:

```text
<base-path>/v1/secrets/{VAULT_NAMESPACE}/{kind}/{key}
```

`kind` is exactly `asset` or `capability`. `key` must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Returned references use:

```text
vault:{VAULT_NAMESPACE}:{kind}:{key}
```

Write:

```text
PUT /v1/secrets/{namespace}/{kind}/{key}
{"material":"<secret-material>"}
```

Success must be `200` or `201` with strict JSON containing only:

```json
{ "ref": "vault:{namespace}:{kind}:{key}" }
```

Read:

```text
GET /v1/secrets/{namespace}/{kind}/{key}
```

Success must be `200` with strict JSON containing only:

```json
{ "material": "<secret-material>" }
```

Delete:

```text
DELETE /v1/secrets/{namespace}/{kind}/{key}
```

`204` with an empty body is success. `404` is treated as an idempotent delete only when the provider returns the strict JSON error envelope described below.

Provider errors must be JSON with `Content-Type: application/json` and exactly one field:

```json
{ "error": "<non-empty provider error>" }
```

Provider error details are not propagated to callers.

## TLS and secret handling

There are no repository-specific Vault TLS/CA environment variables. The adapter uses Node's normal `https.request` TLS verification and the process/system CA trust store. There is no `tls_skip_verify` option and no code path setting `rejectUnauthorized: false`.

Production must use a certificate trusted by the Node runtime on the BOT_TELE host. If a private CA is required, configure trust at the Node/service-runtime level according to the deployment platform; BOT_TELE does not define a `VAULT_*` custom-CA variable.

The adapter never logs the bearer token or secret material. Errors are reduced to generic Vault errors. Plaintext credential material must remain behind opaque `vault:` references and must not be persisted in business tables, logs, events, audit metadata, metrics, callback payloads, or support transcripts.

Maximum secret material size is 65,536 UTF-8 bytes. Request/response JSON bodies are bounded and slow/oversized responses are aborted within the configured deadline.

## Startup and readiness

Both API and worker construct the selected Vault driver and call `vault.health()` during startup. API `/ready` calls the Vault health probe as well and fails closed with HTTP 503 when the Vault dependency is unavailable.

Production configuration rejects `VAULT_DRIVER=memory`. External mode also rejects empty egress allowlists.

Before switching an existing process from the in-memory driver, protect any in-memory canary credential. The current Vault port exposes only `write`, `reveal`, `delete`, and optional `health`; there is no cross-driver migration operation. Do not dump an in-memory secret to a file, log, shell output, database field, or chat to migrate it. If the canary is disposable, obtain explicit owner authorization to discard and re-import it before any API/worker restart.

## Local acceptance helper and single-host production profile

The repository includes a loopback-only persistent HTTPS store. It is used for
release acceptance and, in the current BOT_TELE deployment, as the single-host
production Vault behind the existing `com.bot-tele.vault` LaunchAgent. It is not
an HA or multi-host Vault service. Keep its token, AES-256-GCM master key, and TLS
private key outside the repository. The server rejects group/world-readable token,
master-key, or TLS-key files, keeps its state directory at `0700`, and persists
the encrypted store at `0600`.

The production profile binds to `127.0.0.1:8443` and uses the encrypted state at
`~/.local/state/bot-tele-external-vault/store.json`; credentials and CA remain
under `~/.config/bot-tele-external-vault`. API and worker must point to the same
endpoint and explicit host/port/CIDR egress allowlists.

The default local paths used by the helper are under `~/.config/bot-tele-external-vault`
for credentials/CA and `~/.local/state/bot-tele-external-vault` for encrypted state.

```bash
BT_VAULT_DATA_FILE="$HOME/.local/state/bot-tele-external-vault/store.json" \
BT_VAULT_TOKEN_FILE="$HOME/.config/bot-tele-external-vault/token" \
BT_VAULT_MASTER_KEY_FILE="$HOME/.config/bot-tele-external-vault/master-key" \
BT_VAULT_TLS_KEY_FILE="$HOME/.config/bot-tele-external-vault/server.key" \
BT_VAULT_TLS_CERT_FILE="$HOME/.config/bot-tele-external-vault/server.crt" \
node scripts/external-vault-acceptance-server.mjs
```

Run disposable health/write/reveal/at-rest/delete validation with:

```bash
node scripts/check-local-external-vault.mjs
```

The checker accepts only `https://127.0.0.1` or `https://localhost`, generates disposable material internally, verifies the plaintext is absent from the persistent store, deletes the entry, and prints only PASS/FAIL state.

After CRUD passes, launch BOT_TELE through the local wrapper:

```bash
node --env-file=.env --env-file=.env.staging.local scripts/run-local-external-vault.mjs api
node --env-file=.env --env-file=.env.staging.local scripts/run-local-external-vault.mjs worker
```

The wrapper reads the token from its private file and starts the real `dist/main.js` or `dist/worker.js` child with `NODE_EXTRA_CA_CERTS` set before Node initializes TLS. `BT_VAULT_CA_FILE` can override the default local CA path. The wrapper also supplies the loopback host/port/CIDR allowlists used by the acceptance environment.

## Owner checklist

- Provision an HTTPS service implementing the exact protocol above.
- Configure `VAULT_DRIVER=external` in the same service environment used to launch API and worker.
- Configure `VAULT_ENDPOINT` with no embedded credentials/query/fragment.
- Configure `VAULT_TOKEN` locally through the normal secret-injection mechanism; never send it in chat.
- Configure the real hostname, effective port, and the complete approved DNS CIDR set in the three `VAULT_EGRESS_*` allowlists.
- Confirm the endpoint certificate validates with the Node runtime trust store.
- Keep the Vault service reachable from both API and worker.
- Do not restart API/worker until disposable CRUD validation passes and the existing in-memory canary disposition is decided.

After configuration, validate only with a disposable random test secret: health, authenticated write, reveal, delete, then verify the deleted ref cannot be revealed. Never echo the test material. Clean up the disposable secret before restart-persistence acceptance.
