import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { normalizeProxyUrl, testProxyConnectivity } from "../src/proxy.js";

test("proxy connectivity returns an explicit timeout within two seconds", async (t) => {
  const server = http.createServer((req) => {
    req.socket.setTimeout(0);
  });
  const sockets = new Set<Duplex>();
  server.on("connect", (_req, socket) => {
    sockets.add(socket);
    (socket as Socket).setTimeout(0);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const startedAt = Date.now();
  const result = await testProxyConnectivity({
    type: "HTTPS_CONNECT",
    url: `http://127.0.0.1:${port}`,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.success, false);
  assert.equal(result.message, "Proxy test timed out after 2 seconds");
  assert.ok(elapsed >= 1800, `returned too early: ${elapsed}ms`);
  assert.ok(elapsed < 3500, `returned too late: ${elapsed}ms`);
});

test("HTTP and HTTPS proxy URLs are supported with a useful schemeless default", () => {
  assert.equal(
    normalizeProxyUrl({ type: "HTTPS_CONNECT", url: "127.0.0.1:6152" }),
    "http://127.0.0.1:6152/",
  );
  assert.equal(
    normalizeProxyUrl({ type: "HTTPS_CONNECT", url: "http://127.0.0.1:6152" }),
    "http://127.0.0.1:6152/",
  );
  assert.equal(
    normalizeProxyUrl({
      type: "HTTPS_CONNECT",
      url: "https://proxy.example:8443",
    }),
    "https://proxy.example:8443/",
  );
});
