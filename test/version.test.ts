import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { type AddressInfo } from "node:net";
import { buildHeaders } from "../src/kiro/handler.ts";
import {
  DEFAULT_KIRO_VERSION,
  effectiveKiroVersion,
  refreshKiroVersion,
  USAGE_API_KIRO_VERSION,
} from "../src/kiro/version.ts";

test("Kiro version refresh updates streaming headers without changing usage headers", async (t) => {
  assert.equal(effectiveKiroVersion(), DEFAULT_KIRO_VERSION);
  assert.match(
    buildHeaders("token")["user-agent"],
    /aws-sdk-js\/1\.0\.34 .*KiroIDE-2\.3\.0-/,
  );

  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        currentRelease: request.url === "/invalid" ? "" : " 2.4.1 ",
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.equal(await refreshKiroVersion(baseUrl), "2.4.1");
  assert.equal(effectiveKiroVersion(), "2.4.1");
  const streaming = buildHeaders("token");
  assert.match(
    streaming["x-amz-user-agent"],
    /^aws-sdk-js\/1\.0\.34 KiroIDE-2\.4\.1-/,
  );
  assert.match(
    streaming["user-agent"],
    /api\/codewhispererstreaming#1\.0\.34 m\/E KiroIDE-2\.4\.1-/,
  );

  const usage = buildHeaders("token", null, "usageLimits");
  assert.match(
    usage["x-amz-user-agent"],
    new RegExp(`^aws-sdk-js/1\\.0\\.0 KiroIDE-${USAGE_API_KIRO_VERSION}-`),
  );
  assert.match(
    usage["user-agent"],
    new RegExp(
      `api/codewhispererruntime#1\\.0\\.0 m/N,E KiroIDE-${USAGE_API_KIRO_VERSION}-`,
    ),
  );

  await assert.rejects(
    refreshKiroVersion(`${baseUrl}/invalid`),
    /missing currentRelease/,
  );
  assert.equal(effectiveKiroVersion(), "2.4.1");
});
