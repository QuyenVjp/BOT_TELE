# Contract: AI Provider Port (OpenAI-Compatible Responses)

## Request

```text
AiProviderRequest {
  model: allowlisted model,
  input: redacted bounded messages,
  instructions: versioned safety/grounding instruction,
  max_output_tokens: bounded integer,
  reasoning_effort?: allowlisted value,
  metadata: correlation + feature version only
}
```

The adapter builds the provider request and owns HTTP details. Domain modules never receive the API key.

## Response

```text
AiProviderResponse {
  providerRequestId?: string,
  outputText: string,
  finishReason?: allowlisted value,
  usage?: { inputTokens?: number, outputTokens?: number },
  latencyMs: number
}
```

The response is untrusted and must be parsed into the AI answer schema before display.

## Errors and retry

`TIMEOUT`, `UNAUTHORIZED`, `RATE_LIMITED`, `SERVER_ERROR`, `MALFORMED_RESPONSE`, `CONTENT_BLOCKED`,
and `BUDGET_EXCEEDED` are stable categories. Retry only bounded transient classes; never retry
unauthorized, malformed, content-blocked, or budget errors. All failures route to fallback.

## Secret and endpoint rules

- `AI_API_KEY` is read from a secret environment/manager reference and redacted everywhere.
- Base URL and model must be allowlisted configuration; no customer-provided URL/model.
- No raw provider request/response is logged or stored.
- Opt-in staging smoke may call qrouter; CI uses a fake adapter.
