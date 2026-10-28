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

## Accounts and proxies

The admin page supports bulk imports, token refresh, credit balances, account tests, editing, and pooling with failover. OAuth tokens refresh automatically in the background, and usage is checked periodically.

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
- Configuration: `HOST`, `PORT`, `KIRO_DB_PATH`, `PREFERENTIAL_KIRO_CACHE`, `KIRO_THINKING_TOKEN_PERCENT_RANGE`
- Development server: `npm run dev`
- Tests: `npm test`

Keep the service bound to localhost; it has no authentication. USD values are token-based estimates, not invoices.
