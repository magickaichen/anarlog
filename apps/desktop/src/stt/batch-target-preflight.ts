import { t } from "@lingui/core/macro";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const ASSEMBLYAI_BATCH_MODELS = new Set([
  "universal-2",
  "universal-3-pro",
  "u3-rt-pro",
  "universal-3-5-pro",
  "universal-3-5-pro-realtime",
]);

export function isKnownBatchTargetModel(provider: string, model: string) {
  return provider !== "assemblyai" || ASSEMBLYAI_BATCH_MODELS.has(model);
}

export async function preflightBatchTargetConnection({
  provider,
  model,
  baseUrl,
  apiKey,
}: {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}) {
  if (provider !== "assemblyai") {
    return;
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(
      t`${provider} ${model} connectivity preflight failed because the saved endpoint is invalid.`,
    );
  }

  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/transcript")
    ? path
    : path.endsWith("/v2")
      ? `${path}/transcript`
      : path
        ? `${path}/v2/transcript`
        : "/v2/transcript";
  url.search = "";
  url.searchParams.set("limit", "1");

  let response: Response;
  try {
    response = await tauriFetch(url.toString(), {
      method: "GET",
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error(
      t`${provider} ${model} connectivity preflight could not reach the saved endpoint.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      t`${provider} ${model} authentication preflight failed. Check the saved API key.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      t`${provider} ${model} connectivity preflight failed with HTTP ${response.status}.`,
    );
  }
}
