import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AppDatabase } from "../src/db.js";
import { createServerContext } from "../src/server.js";

test("disconnecting after SSE headers does not attempt a second JSON response", { timeout: 5000 }, async (t) => {
  const database = new AppDatabase(":memory:");
  const context = createServerContext(database);
  let cancelled: () => void;
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  context.pool.call = async (_body, options) => {
    await options.sink.onHeaders(200, { "content-type": "text/event-stream" });
    await options.sink.onChunk('event: ping\ndata: {}\n\n');
    await new Promise<void>((resolve) => options.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    cancelled();
    return { success: false, statusCode: 499, error: "Request canceled" };
  };
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(...args); };
  const server = http.createServer(context.app);
  t.after(() => {
    console.error = originalError;
    server.closeAllConnections();
    server.close();
    database.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = http.request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } });
  client.on("error", () => {});
  const received = new Promise<void>((resolve) => client.on("response", (response) => {
    assert.equal(response.statusCode, 200);
    response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
  }));
  client.end(JSON.stringify({ model: "claude-opus-5.5", stream: true, messages: [{ role: "user", content: "test" }] }));
  await received;
  await cancellation;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(logged, []);
});
