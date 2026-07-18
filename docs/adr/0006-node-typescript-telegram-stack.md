---
status: proposed
---

# Node.js TypeScript stack with grammY channel adapter

Use Node.js LTS + TypeScript, Fastify for HTTP/webhook/API, grammY for the Telegram adapter, Zod for boundary validation, PostgreSQL + Kysely for explicit SQL/transactions, BullMQ + Redis only for worker delivery, OpenAPI for the reseller contract, Vitest + Testcontainers + fast-check for tests, and Pino/OpenTelemetry for observability. Keep grammY, Kysely and BullMQ outside the domain layer; ledger writes use explicit database constraints/transactions. NestJS remains an optional composition layer if the admin/reseller surface grows enough to justify its structure, but the initial recommendation is lean Fastify.

## Why

The stack aligns with Telegram's fast interaction model and TypeScript's shared contract types while preserving a durable relational source of truth. Kysely keeps payment/ledger SQL visible for review and locking. BullMQ is a delivery mechanism, not the ledger or event source of truth; transactional outbox remains mandatory.
