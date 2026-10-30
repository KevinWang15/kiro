import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export interface ProxyBinding {
  type?: string;
  url?: string;
  basicAuthUsername?: string | null;
  basicAuthPassword?: string | null;
}

export function normalizeProxyUrl(binding?: ProxyBinding): string | undefined {
  if (!binding?.url) return undefined;
  const rawUrl = binding.url.trim();
  if (!rawUrl) return undefined;
  const isSocks =
    binding.type?.toUpperCase() === "SOCKS5" || rawUrl.startsWith("socks5://");
  const withScheme = /^[a-zA-Z]+:\/\//.test(rawUrl)
    ? rawUrl
    : `${isSocks ? "socks5" : "http"}://${rawUrl.replace(/^\/+/, "")}`;
  try {
    const url = new URL(withScheme);
    if (binding.basicAuthUsername) url.username = binding.basicAuthUsername;
    if (binding.basicAuthPassword) url.password = binding.basicAuthPassword;
    return url.toString();
  } catch {
    return withScheme;
  }
}

export function buildAgentFromProxy(
  binding?: ProxyBinding,
): HttpsProxyAgent<string> | SocksProxyAgent | null {
  const url = normalizeProxyUrl(binding);
  if (!url) return null;
  try {
    const isSocks =
      binding?.type?.toUpperCase() === "SOCKS5" || url.startsWith("socks5://");
    return isSocks ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
  } catch {
    return null;
  }
}

export interface ProxyConnectivityResult {
  success: boolean;
  statusCode?: number;
  message?: string;
}

export async function testProxyConnectivity(
  binding?: ProxyBinding,
): Promise<ProxyConnectivityResult> {
  const agent = buildAgentFromProxy(binding);
  if (!agent) return { success: false, message: "Failed to build proxy agent" };

  return new Promise<ProxyConnectivityResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (result: ProxyConnectivityResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = https.request(
      "https://www.google.com/generate_204",
      { method: "GET", agent, timeout: 2000 },
      (response) => {
        response.resume();
        finish({
          success: response.statusCode === 204,
          statusCode: response.statusCode,
          message:
            response.statusCode === 204
              ? "Proxy is working correctly"
              : `Unexpected status code: ${response.statusCode}`,
        });
      },
    );
    timer = setTimeout(() => {
      request.destroy();
      finish({
        success: false,
        message: "Proxy test timed out after 2 seconds",
      });
    }, 2000);
    request.on("error", (error) =>
      finish({
        success: false,
        message: `Proxy test failed: ${error.message}`,
      }),
    );
    request.on("timeout", () => {
      request.destroy();
      finish({
        success: false,
        message: "Proxy test timed out after 2 seconds",
      });
    });
    request.end();
  });
}
