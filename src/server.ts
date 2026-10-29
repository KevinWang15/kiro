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

export interface ServerContext {
  app: express.Express;
  database: AppDatabase;
  accounts: AccountRepository;
  proxies: ProxyRepository;
  tokens: TokenManager;
  usageService: UsageService;
  pool: KiroAccountPool;
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
      res.json({
        count: options.length,
        accounts: options.map(({ index, label }) => ({ index, label })),
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
    for (const id of result.accountIds) {
      setImmediate(
        () => void usageService.refreshAccountUsage(id).catch(() => undefined),
      );
    }
    res.json({ success: true, ...result });
  });
  app.post("/api/accounts/import", importHandler);
  app.post("/api/accounts", importHandler);

  app.get("/api/accounts/:id", (req, res) => {
    const account = accounts.get(Number(req.params.id));
    if (!account)
      return void res.status(404).json({ error: "Account not found" });
    res.json({
      id: account.id,
      credentials: parseCredentials(account),
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

  return { app, database, accounts, proxies, tokens, usageService, pool };
}
