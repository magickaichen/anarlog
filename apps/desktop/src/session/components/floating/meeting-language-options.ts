import { normalizeTranscriptionLanguages } from "~/stt/transcription-policy";

export function getMeetingLanguageOptions(
  languages: readonly string[],
  supportedLanguages: readonly string[],
) {
  const normalized = normalizeTranscriptionLanguages([
    ...languages,
    ...supportedLanguages,
  ]);
  return normalized.map((language) => ({
    languages: [language],
    multilingual: false,
  }));
}
