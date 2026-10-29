import path from "node:path";
import express, { type Request, type Response } from "express";
import { AppDatabase } from "./db.ts";
import { AccountRepository } from "./accounts/repository.ts";
import { ProxyRepository } from "./accounts/proxies.ts";
import { TokenManager } from "./accounts/token-manager.ts";
import { UsageService } from "./accounts/usage-service.ts";
import { AccountImportService } from "./accounts/import-service.ts";
import { KiroAccountPool } from "./accounts/pool.ts";
import { UsageRepository } from "./usage/repository.ts";
import { parseCredentialInput } from "./accounts/credential-input.ts";
import { handleCountTokensRequest } from "./kiro/token.ts";
import type { MessagesRequest } from "./kiro/types.ts";
import { parseCredentials, parseStatusInfo } from "./accounts/types.ts";
import type { KiroCredentials } from "./accounts/types.ts";
import { LoginFlowService, PORTAL_CALLBACK_PATHS } from "./accounts/login-flows.ts";

export interface ServerContext {
  app: express.Express;
  database: AppDatabase;
  accounts: AccountRepository;
  proxies: ProxyRepository;
  tokens: TokenManager;
  usageService: UsageService;
  pool: KiroAccountPool;
  logins: LoginFlowService;
}

const SIGN_IN_LABELS: Record<string, string> = {
  BuilderId: "AWS Builder ID",
  Enterprise: "IAM Identity Center",
  Google: "Google",
  Github: "GitHub",
  ExternalIdp: "Organization sign-in",
};

// What the edit dialog shows instead of raw tokens.
function credentialSummary(credentials: KiroCredentials) {
  const authMethod = (credentials.authMethod || "").toLowerCase();
  const apiKey = authMethod === "api_key" || authMethod === "apikey";
  const tail = (value?: string) => (value ? `…${value.slice(-4)}` : null);
  return {
    method: apiKey ? "api_key" : authMethod || "unknown",
    signIn: apiKey
      ? "API key"
      : SIGN_IN_LABELS[credentials.provider || ""] || credentials.provider || "OAuth",
    email: credentials.email || null,
    region: credentials.region || "us-east-1",
    runtimeRegion: credentials.runtimeRegion || null,
    expiresAt: apiKey ? null : credentials.expiresAt || null,
    hasRefreshToken: Boolean(credentials.refreshToken),
    accessTokenHint: tail(credentials.accessToken),
    refreshTokenHint: tail(credentials.refreshToken),
    startUrl: credentials.startUrl || null,
    profileArn: credentials.profileArn || null,
  };
}

// Escape text for the small HTML page shown after a browser sign-in.
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function callbackPage(ok: boolean, message: string): string {
  const color = ok ? "#4ade80" : "#f87171";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Kiro sign-in</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="color-scheme" content="dark">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e11;color:#e8e8ec;font:15px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:28px 30px;border:1px solid #26262d;border-radius:12px;background:#18181d;text-align:center}
h1{font-size:18px;margin:0 0 8px;color:${color}}p{margin:0;color:#b4b4bd}</style></head>
<body><main><h1>${ok ? "Signed in" : "Sign-in failed"}</h1><p>${escapeHtml(message)}</p></main>
${ok ? "<script>setTimeout(() => window.close(), 1500)</script>" : ""}</body></html>`;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent)
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
    });
  };
}

function metricsRange(req: Request, res: Response): [number, number] | null {
  if (!req.query.startTime || !req.query.endTime) {
    res.status(400).json({ error: "startTime and endTime are required" });
    return null;
  }
  const start = new Date(String(req.query.startTime)).getTime();
  const end = new Date(String(req.query.endTime)).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    res.status(400).json({ error: "Invalid date format or range" });
    return null;
  }
  return [start, end];
}

function optionalTimeRange(
  req: Request,
  res: Response,
): [number | undefined, number | undefined] | null {
  if (!req.query.startTime && !req.query.endTime) return [undefined, undefined];
  return metricsRange(req, res);
}

export function createServerContext(database: AppDatabase): ServerContext {
  const accounts = new AccountRepository(database);
  const proxies = new ProxyRepository(database);
  const tokens = new TokenManager(accounts, proxies);
  const usageService = new UsageService(accounts, proxies, tokens);
  const importer = new AccountImportService(accounts, proxies, tokens);
  const usage = new UsageRepository(database);
  const pool = new KiroAccountPool(accounts, proxies, tokens, usage);
  const logins = new LoginFlowService();
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/accounts", (_req, res) =>
    res.json({ accounts: accounts.summaries() }),
  );

  app.post("/api/accounts/parse", (req, res) => {
    try {
      const options = parseCredentialInput(String(req.body?.text || ""));
      // Preview for the import dialog: what each entry is and whether it can
      // be imported. Only masked hints leave the server, never full tokens.
      // Entries in an accounts array that carry no token aren't detected by the
      // parser at all; count them so the preview can say they were skipped.
      let skipped = 0;
      try {
        const parsed = JSON.parse(String(req.body?.text || ""));
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.accounts) ? parsed.accounts : null;
        if (list) skipped = Math.max(0, list.length - options.length);
      } catch {}
      res.json({
        count: options.length,
        skipped,
        accounts: options.map(({ index, label, canonical }) => {
          const summary = credentialSummary(canonical as KiroCredentials);
          const usable = Boolean(canonical.accessToken || canonical.refreshToken);
          return {
            index,
            label,
            email: summary.email,
            signIn: summary.signIn,
            region: summary.region,
            runtimeRegion: summary.runtimeRegion,
            hasRefreshToken: summary.hasRefreshToken,
            hasAccessToken: Boolean(canonical.accessToken),
            refreshTokenHint: summary.refreshTokenHint,
            accessTokenHint: summary.accessTokenHint,
            expiresAt: summary.expiresAt,
            duplicate: usable && accounts.hasDuplicate(canonical as KiroCredentials),
            problem: usable ? null : "No access token or refresh token",
          };
        }),
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  const importHandler = asyncRoute(async (req, res) => {
    const rawAccounts =
      req.body?.accounts ||
      parseCredentialInput(String(req.body?.text || "")).map(
        (option) => option.canonical,
      );
    const result = await importer.import(
      rawAccounts,
      req.body?.proxyMode || "none",
    );
    // Fetch credits now so the table shows them right away; anything slower
    // than the cap keeps going in the background and the UI polls for it.
    await usageService.refreshNow(result.accountIds);
    res.json({ success: true, ...result });
  });
  app.post("/api/accounts/import", importHandler);
  app.post("/api/accounts", importHandler);

  // ---- New account: one credential from a sign-in session or the form ----
  const proxyFor = (value: unknown) => {
    if (value === undefined || value === null || value === "") return null;
    const proxy = proxies.get(Number(value));
    if (!proxy) throw new Error("Proxy not found");
    return proxy;
  };
  const accountOptions = (body: any, source: string) => ({
    proxyId: body?.proxyId == null || body.proxyId === "" ? null : Number(body.proxyId),
    priority: body?.priority === undefined ? undefined : Number(body.priority),
    comment: typeof body?.comment === "string" ? body.comment : undefined,
    enabled: body?.enabled === undefined ? undefined : Boolean(body.enabled),
    source,
  });
  const createdAccount = async (id: number) => {
    await usageService.refreshNow([id]);
    return { success: true, id };
  };

  app.post(
    "/api/accounts/create",
    asyncRoute(async (req, res) => {
      const body = req.body || {};
      try {
        const { id } = await importer.createOne(body.credentials, accountOptions(body, body.source || "Added manually"));
        res.status(201).json(await createdAccount(id));
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
      }
    }),
  );

  // ---- Interactive sign-in sessions ----
  const loginRoute = (start: (body: any, origin: string) => Promise<unknown> | unknown) =>
    asyncRoute(async (req, res) => {
      try {
        // The browser's own origin decides the redirect URI, so the callback
        // returns to the same host and port the dashboard is open on.
        const origin = String(req.body?.origin || `${req.protocol}://${req.get("host")}`);
        res.status(201).json(await start(req.body || {}, origin));
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
      }
    });
  app.post("/api/logins/builder-id", loginRoute((b) => logins.startBuilderId(String(b.region || "us-east-1"), proxyFor(b.proxyId))));
  app.post("/api/logins/identity-center", loginRoute((b, origin) => logins.startIdentityCenter(String(b.region || ""), String(b.startUrl || ""), origin, proxyFor(b.proxyId))));
  app.post("/api/logins/kiro", loginRoute((b, origin) => logins.startKiroPortal(String(b.region || "us-east-1"), origin, proxyFor(b.proxyId))));
  app.get("/api/logins/:id", (req, res) => {
    const view = logins.view(String(req.params.id));
    if (!view) return void res.status(404).json({ error: "Sign-in session not found or expired" });
    res.json(view);
  });
  app.delete("/api/logins/:id", (req, res) => {
    logins.cancel(String(req.params.id));
    res.json({ success: true });
  });
  app.post(
    "/api/logins/:id/account",
    asyncRoute(async (req, res) => {
      const view = logins.view(String(req.params.id));
      if (!view || view.status !== "complete")
        return void res.status(409).json({ error: "This sign-in hasn't finished yet" });
      const credentials = logins.take(String(req.params.id));
      if (!credentials) return void res.status(409).json({ error: "This sign-in was already used" });
      try {
        const { id } = await importer.createOne(credentials, accountOptions(req.body, `Signed in with ${view.label}`), true);
        res.status(201).json(await createdAccount(id));
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
      }
    }),
  );
  const loginCallback = asyncRoute(async (req, res) => {
    // Full parse so a literal "?" inside a value (e.g. issuer_url) survives.
    const params = new URL(req.originalUrl, "http://localhost").searchParams;
    const result = await logins.handleCallback(params, req.path);
    if (result.redirect) return void res.redirect(302, result.redirect);
    res.status(result.ok ? 200 : 400).type("html").send(callbackPage(result.ok, result.message));
  });
  // "/" is also the dashboard: only treat it as a sign-in return when it
  // carries the OAuth response parameters.
  app.get(PORTAL_CALLBACK_PATHS, (req, res, next) => {
    const q = req.query;
    const isReturn = typeof q.state === "string" && (q.code !== undefined || q.error !== undefined || q.login_option !== undefined);
    if (req.path !== "/" || isReturn) return loginCallback(req, res);
    next();
  });

  app.get("/api/accounts/:id", (req, res) => {
    const account = accounts.get(Number(req.params.id));
    if (!account)
      return void res.status(404).json({ error: "Account not found" });
    res.json({
      id: account.id,
      credentials: parseCredentials(account),
      credentialSummary: credentialSummary(parseCredentials(account)),
      statusInfo: parseStatusInfo(account),
      priority: account.priority,
      enabled: Boolean(account.enabled),
      autoDisabled: Boolean(account.autoDisabled),
      disabledReason: account.disabledReason,
      comment: account.comment,
      source: account.source,
      proxyId: account.proxyId,
      createdAt: account.createdAt,
      usage: accounts.usageTotals(account.id),
    });
  });

  app.patch(
    "/api/accounts/:id",
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const input = req.body || {};
      let credentials = input.credentials;
      if (typeof credentials === "string")
        credentials = JSON.parse(credentials);
      if (credentials && input.convert === true)
        credentials = await tokens.convertCredential(
          credentials,
          proxies.get(input.proxyId),
        );
      const account = accounts.update(id, {
        credentials,
        priority:
          input.priority === undefined ? undefined : Number(input.priority),
        enabled: input.enabled,
        autoDisabled: input.autoDisabled,
        disabledReason: input.disabledReason,
        comment: input.comment,
        proxyId: input.proxyId,
      });
      if (!account)
        return void res.status(404).json({ error: "Account not found" });
      res.json({ success: true });
    }),
  );

  app.delete("/api/accounts/:id", (req, res) => {
    if (!accounts.delete(Number(req.params.id)))
      return void res.status(404).json({ error: "Account not found" });
    res.json({ success: true });
  });

  app.post(
    "/api/accounts/:id/refresh",
    asyncRoute(async (req, res) => {
      await tokens.refreshAccount(Number(req.params.id));
      res.json({ success: true });
    }),
  );

  app.post(
    "/api/accounts/:id/usage",
    asyncRoute(async (req, res) => {
      const statusInfo = await usageService.refreshAccountUsage(
        Number(req.params.id),
      );
      res.json({ success: Boolean(statusInfo), statusInfo });
    }),
  );

  app.post(
    "/api/accounts/:id/test",
    asyncRoute(async (req, res) => {
      const result = await pool.testAccount(
        Number(req.params.id),
        req.body?.model,
      );
      res.status(result.success ? 200 : result.statusCode || 500).json(result);
    }),
  );

  app.get("/api/proxies", (_req, res) => res.json({ proxies: proxies.list() }));
  app.post("/api/proxies", (req, res) =>
    res.status(201).json(proxies.create(req.body || {})),
  );
  app.patch("/api/proxies/:id", (req, res) => {
    const proxy = proxies.update(Number(req.params.id), req.body || {});
    if (!proxy) return void res.status(404).json({ error: "Proxy not found" });
    res.json(proxy);
  });
  app.delete("/api/proxies/:id", (req, res) => {
    if (!proxies.delete(Number(req.params.id)))
      return void res.status(404).json({ error: "Proxy not found" });
    res.json({ success: true });
  });
  app.post(
    "/api/proxies/:id/test",
    asyncRoute(async (req, res) => {
      res.json(await proxies.test(Number(req.params.id)));
    }),
  );

  app.post("/v1/messages/count_tokens", (req, res) => {
    try {
      res.json(handleCountTokensRequest(req.body));
    } catch (error) {
      res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: (error as Error).message,
        },
      });
    }
  });

  app.post(
    "/v1/messages",
    asyncRoute(async (req, res) => {
      const body = req.body as MessagesRequest;
      if (
        !body ||
        typeof body.model !== "string" ||
        !Array.isArray(body.messages)
      ) {
        return void res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "model and messages are required",
          },
        });
      }
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const result = await pool.call(body, {
        abortSignal: abort.signal,
        requestHeaders: req.headers,
        sink: {
          onHeaders: (status, headers) => {
            res.status(status);
            for (const [name, value] of Object.entries(headers)) {
              if (
                value !== undefined &&
                !["content-length", "transfer-encoding", "connection"].includes(
                  name.toLowerCase(),
                )
              ) {
                res.setHeader(name, value as string);
              }
            }
            res.flushHeaders();
          },
          onChunk: async (chunk) => {
            if (!res.write(chunk))
              await new Promise<void>((resolve) => res.once("drain", resolve));
          },
        },
      });
      // A client may close an SSE response after headers have been flushed.
      // The pool returns cancellation metadata; there is no response left to
      // send it to, and sending JSON here would write the headers a second time.
      if (abort.signal.aborted || res.destroyed || res.writableEnded) return;
      if (result.streamed) {
        res.end();
        return;
      }
      if (body.stream && typeof result.response === "string")
        res.type("text/event-stream");
      else if (result.responseHeaders?.["content-type"])
        res.setHeader(
          "content-type",
          String(result.responseHeaders["content-type"]),
        );
      const responseBody = result.response || {
        type: "error",
        error: {
          type: "api_error",
          message: result.error || "Kiro request failed",
        },
      };
      res.status(result.statusCode || 500);
      if (typeof responseBody === "string") res.send(responseBody);
      else res.json(responseBody);
    }),
  );

  app.get("/api/history/aggregated", (req, res) => {
    const range = metricsRange(req, res);
    if (range) res.json(usage.historyAggregated(range[0], range[1]));
  });

  app.get("/api/history", (req, res) => {
    const range = optionalTimeRange(req, res);
    if (!range) return;
    const [startMs, endMs] = range;
    const limit = Math.min(
      1000,
      Math.max(1, Number.parseInt(String(req.query.limit || "100"), 10) || 100),
    );
    const offset = Math.max(
      0,
      Number.parseInt(String(req.query.offset || "0"), 10) || 0,
    );
    const entries = usage.history({ startMs, endMs, limit, offset });
    const total = usage.historyCount(startMs, endMs);
    res.json({
      entries,
      total,
      totalPages: Math.ceil(total / limit),
      currentPage: Math.floor(offset / limit) + 1,
      limit,
    });
  });

  app.get("/api/metrics/performance", (req, res) => {
    const range = metricsRange(req, res);
    if (range) res.json(usage.aggregate(...range));
  });
  app.get("/api/metrics/performance/timeseries", (req, res) => {
    const range = metricsRange(req, res);
    if (range) res.json({ timeseries: usage.timeseries(...range) });
  });
  app.get("/api/metrics/performance/models", (req, res) => {
    const range = metricsRange(req, res);
    if (range) res.json({ models: usage.models(...range) });
  });
  app.get("/api/metrics/performance/model-cost-timeseries", (req, res) => {
    const range = metricsRange(req, res);
    if (range) res.json(usage.modelCostTimeseries(...range));
  });

  const publicDir = path.resolve(process.cwd(), "public");
  app.get("/vendor/echarts.min.js", (_req, res) => {
    res.sendFile(
      path.resolve(
        process.cwd(),
        "node_modules",
        "echarts",
        "dist",
        "echarts.min.js",
      ),
    );
  });
  app.get("/vendor/lucide.min.js", (_req, res) => {
    res.sendFile(
      path.resolve(
        process.cwd(),
        "node_modules",
        "lucide",
        "dist",
        "umd",
        "lucide.min.js",
      ),
    );
  });
  app.get("/vendor/notyf.min.js", (_req, res) => {
    res.sendFile(
      path.resolve(process.cwd(), "node_modules", "notyf", "notyf.min.js"),
    );
  });
  app.get("/vendor/notyf.min.css", (_req, res) => {
    res.sendFile(
      path.resolve(process.cwd(), "node_modules", "notyf", "notyf.min.css"),
    );
  });
  // Self-hosted fonts from npm (no CDN). Each package's index.css references
  // its woff2 files relatively, so serving the package directory is enough.
  for (const [route, pkg] of [
    ["inter", "inter"],
    ["jetbrains-mono", "jetbrains-mono"],
  ]) {
    app.use(
      `/vendor/fonts/${route}`,
      express.static(
        path.resolve(process.cwd(), "node_modules", "@fontsource-variable", pkg),
        { maxAge: "30d", immutable: true },
      ),
    );
  }
  app.use(express.static(publicDir));
  app.get(["/", "/metrics", "/history", "/proxies"], (_req, res) =>
    res.sendFile(path.join(publicDir, "index.html")),
  );
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  return { app, database, accounts, proxies, tokens, usageService, pool, logins };
}
