# Production environment loader

Production config is a Node dotenv file, not a shell script.

Canonical file:

`$HOME/.config/bot-tele-production/production.env`

## Load

Use Node `--env-file` only:

```bash
node --env-file="$HOME/.config/bot-tele-production/production.env" dist/main.js
node --env-file="$HOME/.config/bot-tele-production/production.env" dist/worker.js
npm run preflight:production
npm run migrate:production
```

LaunchAgents `com.bot-tele.api` and `com.bot-tele.worker` run
`run-production-service.sh`, which execs the same Node loader after stripping
parent application config. Node does not override pre-existing variables, so
the wrapper must not inherit `DATABASE_URL` / `REDIS_URL` / `TELEGRAM_*` /
`SEPAY_*` / `VAULT_*` / `VIETQR_*` / `STORE_*` / `SUPPLIER_*`.

`TELEGRAM_API_ENVIRONMENT` defaults to `prod`. Only isolated staging/test
config may set it to `test`; grammY then uses Telegram's official
`/bot<token>/test/METHOD_NAME` path. Production rejects `test`.

`SEPAY_API_BASE_URL` must be `https://userapi.sepay.vn/v2` in production.
The official Sandbox host `https://userapi-sandbox.sepay.vn/v2` is accepted
only outside production and must use a separate Sandbox token.

## Do not

```bash
source production.env
set -a; . production.env; set +a
export $(grep -v '^#' production.env)
```

Values contain spaces (`VIETQR_ACCOUNT_NAME`, `VIETQR_BANK_NAME`, and some
tokens). A shell `source` splits those lines.

Local `npm run migrate` / `npm run migrate:prod` still load repo `.env` for
development. They are not the production path.

## Preflight

```bash
npm run preflight:production
```

Prints safe metadata only: `NODE_ENV`, URLs/hosts/ports, database
`host:port/database/user`, Redis host/port, vault driver+host, SePay host,
merchant MATCH YES/NO, VietQR bank alias, store status, migration head.
Secrets are `CONFIGURED` or `MISSING`. Never values.

Empty or unparseable `REDIS_URL` fails preflight (`ok: false`). Runtime
`loadConfig` still allows an empty `REDIS_URL` because the shop process
does not consume Redis yet (Postgres is the source of truth; Redis is
reserved for rate-limit/cache). Preflight still requires it configured
so a missing production Redis cannot report PASS. Do not add Redis to
API/worker hardening until a named runtime consumer exists.

## Migrate

```bash
npm run migrate:production
```

Requires `NODE_ENV=production`, `--confirm-production`, and
`BOT_TELE_EXPECTED_DB` matching the live fingerprint (production:
`localhost:5432/shop`). Local development is `localhost:5433/shop`. Those
ports are environment evidence, not business-logic constants.

Receipt: target host/port/database/user, head before/after, applied names,
exit code. Never a password.
