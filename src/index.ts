import { AppDatabase } from "./db.ts";
import { config } from "./config.ts";
import { startKiroVersionRefresher } from "./kiro/version.ts";
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
const versionTimer = startKiroVersionRefresher();
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

// Streaming replies can run for minutes, so in-flight requests get a short
// grace period. Closing their connections also aborts the upstream Kiro call
// (see the response "close" handler in server.ts).
const SHUTDOWN_GRACE_MS = 5_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    console.log(`${signal} received again, exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(
    `${signal} received, waiting up to ${SHUTDOWN_GRACE_MS / 1000}s for in-flight requests (press Ctrl+C again to exit now)`,
  );
  clearInterval(versionTimer);
  clearInterval(refreshTimer);
  clearInterval(usageTimer);
  clearTimeout(initialUsageTimer);
  context.logins.close();
  server.close(() => {
    context.database.close();
    process.exit(0);
  });
  setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
