import { AppDatabase } from "./db.ts";
import { config } from "./config.ts";
import { createServerContext } from "./server.ts";

const TRANSIENT_NETWORK_ERRORS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);
process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
  if (error.code && TRANSIENT_NETWORK_ERRORS.has(error.code)) {
    console.error(`[NETWORK] ${error.code}: ${error.message}`);
    return;
  }
  console.error(error);
  process.exit(1);
});

const context = createServerContext(new AppDatabase(config.dbPath));
const server = context.app.listen(config.port, config.host, () => {
  console.log(`Kiro adapter listening at http://${config.host}:${config.port}`);
});

void context.tokens
  .refreshExpiring()
  .catch((error) => console.warn(error.message));
const refreshTimer = setInterval(() => {
  void context.tokens
    .refreshExpiring()
    .catch((error) => console.warn(error.message));
}, config.refreshIntervalMs);
refreshTimer.unref();

const initialUsageTimer = setTimeout(() => {
  void context.usageService
    .refreshAll()
    .catch((error) => console.warn(error.message));
}, 10_000);
initialUsageTimer.unref();
const usageTimer = setInterval(() => {
  void context.usageService
    .refreshAll()
    .catch((error) => console.warn(error.message));
}, config.usageIntervalMs);
usageTimer.unref();

function shutdown(): void {
  clearInterval(refreshTimer);
  clearInterval(usageTimer);
  clearTimeout(initialUsageTimer);
  server.close(() => {
    context.database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
