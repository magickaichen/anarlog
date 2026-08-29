export type TranscriptionPolicy = {
  provider: string;
  model: string;
  languages: string[];
};

export function normalizeTranscriptionLanguages(
  languages: readonly string[] | null | undefined,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const language of languages ?? []) {
    const trimmed = language.trim();
    const baseCode = trimmed.split(/[-_]/)[0]?.toLowerCase();
    if (!baseCode || seen.has(baseCode)) continue;
    seen.add(baseCode);
    normalized.push(trimmed);
  }

  return normalized.length > 0 ? normalized : ["en"];
}

export function resolveTranscriptionPolicy(
  sessionPolicy: TranscriptionPolicy | null | undefined,
  globalPolicy: TranscriptionPolicy | null | undefined,
): TranscriptionPolicy {
  const source =
    sessionPolicy?.provider && sessionPolicy.model
      ? sessionPolicy
      : (globalPolicy ?? { provider: "", model: "", languages: ["en"] });

  return {
    provider: source.provider,
    model: source.model,
    languages: normalizeTranscriptionLanguages(source.languages),
  };
}

export function formatTranscriptionTarget(policy: TranscriptionPolicy): string {
  return [
    policy.provider,
    policy.model,
    normalizeTranscriptionLanguages(policy.languages).join(" + "),
  ].join(" · ");
}
