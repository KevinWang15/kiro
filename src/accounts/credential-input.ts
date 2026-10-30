import { parseKiroJsonText, toKiroCanonicalJson } from "./credentials.ts";
import type { KiroJsonAccountOption } from "./credentials.ts";

export function parseCredentialInput(text: string): KiroJsonAccountOption[] {
  const trimmed = text.trim();
  if (!trimmed)
    throw new Error("Paste a Kiro credential JSON object or API key");
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return [
      {
        index: 0,
        label: "Kiro API key",
        canonical: toKiroCanonicalJson({
          accessToken: trimmed,
          authMethod: "api_key",
          region: "us-east-1",
          runtimeRegion: "us-east-1",
        }),
      },
    ];
  }
  return parseKiroJsonText(trimmed);
}
