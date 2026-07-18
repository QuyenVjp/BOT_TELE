# Data Model: AI Support Assistant

## AIProviderConfig (configuration, not domain table)

`provider`, `base_url`, `wire_api`, `model`, `api_key_env`, `reasoning_effort`, `verbosity`,
`request_timeout_ms`, `max_output_tokens`, `per_customer_rate_limit`, `global_budget_bucket`.

Secret value is loaded from an environment/secret-manager reference and never persisted or logged.

## AISupportSession

`id`, `customer_id`, `channel_identity_id`, `status`, `locale`, `context_message_count`,
`last_intent`, `retention_expires_at`, `created_at`, `updated_at`, `version`.

State: `ACTIVE -> EXPIRED | DELETED | HANDOFF`.

Unique active session per Customer + channel. Context is bounded to the configured window.

## AISupportMessage

`id`, `session_id`, `direction`, `redacted_text`, `intent`, `source_reference_ids`, `safety_result`,
`provider_request_id?`, `created_at`.

Raw inbound text may be discarded or encrypted only under approved retention policy. Never store raw
credential, provider key, hidden prompt, full bank payload, or another customer's data.

## AIActionProposal

`id`, `session_id`, `kind`, `payload_redacted`, `requires_confirmation`, `status`, `expires_at`,
`confirmed_at?`, `command_id?`, `created_at`.

Kinds are read-only lookup, existing navigation, or customer-confirmed support ticket draft. No
proposal can directly mutate payment, ledger, inventory, supplier, delivery, refund, or admin state.

## AIUsageRecord

`id`, `session_id`, `provider`, `model`, `intent`, `status`, `latency_ms`, `input_tokens?`,
`output_tokens?`, `budget_bucket`, `safe_error_code?`, `correlation_id`, `created_at`.

No raw request/response or key. Unique provider request ID when supplied for dedupe/observability.

## SupportKnowledgeEntry

`id`, `kind`, `locale`, `title`, `safe_body`, `source_uri_or_doc_id`, `version`, `owner`,
`active_from`, `active_until?`, `is_active`, `created_at`, `updated_at`.

Kinds: `FAQ | USAGE | PAYMENT_POLICY | WARRANTY | SUPPORT_POLICY`. Only active approved entries
can ground an answer.
