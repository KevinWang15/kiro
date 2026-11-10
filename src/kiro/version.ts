import axios from "axios";

export const DEFAULT_KIRO_VERSION = "2.3.0";
export const USAGE_API_KIRO_VERSION = "0.9.2";

const METADATA_URL =
  "https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json";
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

let latestVersion: string | null = null;

export function effectiveKiroVersion(
  fallback = DEFAULT_KIRO_VERSION,
): string {
  return latestVersion || fallback;
}

export async function refreshKiroVersion(
  metadataUrl = METADATA_URL,
): Promise<string> {
  const response = await axios.get(metadataUrl, { timeout: 15_000 });
  const currentRelease = response.data?.currentRelease;
  if (typeof currentRelease !== "string" || !currentRelease.trim()) {
    throw new Error("Kiro version metadata is missing currentRelease");
  }
  latestVersion = currentRelease.trim();
  return latestVersion;
}

export function startKiroVersionRefresher(): NodeJS.Timeout {
  const refresh = async () => {
    const previous = latestVersion;
    try {
      const version = await refreshKiroVersion();
      if (version !== previous) {
        console.log(`Detected Kiro IDE version ${version}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Failed to fetch the latest Kiro IDE version; using ${effectiveKiroVersion()}: ${message}`,
      );
    }
  };

  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  timer.unref();
  return timer;
}
