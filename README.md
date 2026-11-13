# Local Kiro Adapter

Run a local Anthropic-compatible API backed by your Kiro accounts. Manage credentials, proxies, credits, and usage through a small admin UI. Data stays in one SQLite file.

## Quick start

Requires **Node.js 24+**.

```bash
npm install
npm run build
PORT=48763 npm start
```

Open **http://127.0.0.1:48763/** and import your Kiro credential JSON. You can paste one account, a nested multi-account export, or a raw Kiro API key. OAuth credentials are automatically exchanged for fresh access tokens.

## Connect Claude Code

Use the admin page's **Copy setup script** button, or run:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:48763
export ANTHROPIC_API_KEY=sk-ant-api03-dummykey123123123123

# programmatically approve this API Key
(cat ~/.claude.json 2>/dev/null || echo 'null') | jq --arg key "${ANTHROPIC_API_KEY: -20}" '(. // {}) | .customApiKeyResponses.approved |= ([.[]?, $key] | unique)' > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json
```

Any non-empty API key is accepted. The approval snippet requires `jq`.

Available endpoints:

- `POST /v1/messages` — Anthropic JSON and streaming SSE
- `POST /v1/messages/count_tokens` — local token estimation

Signed thinking and redacted reasoning are replayed through Kiro's native
`reasoningContent` field. When thinking display is `omitted`, the adapter saves
the original text locally in SQLite and restores it by signature on later
requests, including after restarts. Keep the database when resuming or moving
conversations. Text already discarded by older adapter versions cannot be
reconstructed from an empty thinking block alone.

Trailing assistant prefills are preserved as history, followed by an empty user
turn for continuation. This retains their context; Kiro's user-turn request
format does not guarantee exact prefix completion.

API failures include Kiro's original error code, event metadata, upstream HTTP
status, request ID, and a local diagnostic ID in `error.message` and
`error.upstream`, for both JSON and SSE responses. Matching `[kiro-error]` server
log entries include replay/cache counts and the requested and upstream model IDs.
Replay diagnostics contain counts without dumping request bodies or
authorization headers.
An error with client status 403 and `upstream_http=200` is an adapter-reported
refusal in Kiro's response stream; it is distinct from an upstream HTTP 403.

## Accounts and proxies

The admin page supports bulk imports, token refresh, credit balances, account tests, editing, and pooling with failover. OAuth tokens refresh automatically in the background, and usage is checked periodically.

Inference and MCP requests preserve a non-empty configured `profileArn` (or
`profile_arn`). Otherwise, Builder ID and legacy OAuth accounts use the Builder
ID profile default, and GitHub, Google, or `social` accounts use the social
profile default. API-key accounts receive no default ARN. These defaults apply
to outgoing requests without changing stored credentials. Usage lookups omit
the Builder ID placeholder and preserve real configured profiles.

Assign an HTTP, HTTPS, or SOCKS5 proxy to route inference, token exchange, credit lookup, and MCP traffic:

```text
127.0.0.1:6152          HTTP proxy (scheme defaults to http)
http://127.0.0.1:6152   HTTP proxy
https://proxy.example   HTTPS proxy
socks5://127.0.0.1:6153 SOCKS5 proxy
```

Explicit schemes are honored; there is no protocol auto-detection. Proxy tests time out after two seconds.

## Metrics and history

Open **http://127.0.0.1:48763/metrics** for request, cost, latency, token, and per-model charts. Choose a quick or custom time range, or drag across the overview chart to select one.

Open **http://127.0.0.1:48763/history** for usage-over-time charts and expandable request details, including tokens, cost breakdown, timing, Kiro credits, and cumulative consumption.

## Local data and development

- Default database: `data/kiro.db`
- Configuration: `HOST`, `PORT`, `KIRO_DB_PATH`
- Development server: `npm run dev`
- Tests: `npm test`

Keep the service bound to localhost; it has no authentication. USD values are token-based estimates, not invoices.
