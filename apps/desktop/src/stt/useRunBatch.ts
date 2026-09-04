import { t } from "@lingui/core/macro";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useCallback } from "react";

import type { TranscriptionParams } from "@anlg/plugin-transcription";

import { BatchResponseProcessingError } from "./batch-response-processing-error";
import {
  isKnownBatchTargetModel,
  preflightBatchTargetConnection,
} from "./batch-target-preflight";
import { useListener } from "./contexts";
import { persistTranscriptWrite } from "./persist-retry";
import { reconcileRefinedSpeakerClusters } from "./refinement-speakers";
import {
  EMPTY_CURRENT_CAPTURE_TRANSCRIPT_ERROR_MESSAGE,
  isTranscriptionAuthenticationError,
} from "./transcription-errors";
import { useSTTConnection } from "./useSTTConnection";
export {
  STOPPED_TRANSCRIPTION_ERROR_MESSAGE,
  EMPTY_CURRENT_CAPTURE_TRANSCRIPT_ERROR_MESSAGE,
  isStoppedTranscriptionError,
  isTerminalTranscriptionError,
  isTranscriptionAuthenticationError,
} from "./transcription-errors";

import { useAuth } from "~/auth";
import { withCloudsyncActivity } from "~/db/cloudsync-activity";
import {
  deleteProcessedAudioForRetention,
  normalizeAudioRetention,
} from "~/services/audio-retention";
import { maybeExtractVoiceprintCandidates } from "~/services/voiceprint";
import { markSessionAudioTranscriptionComplete } from "~/session/attachments";
import {
  useSession,
  useSessionParticipants,
  useSessionSpeakerCandidates,
} from "~/session/queries";
import { useConfigValue } from "~/shared/config";
import { id } from "~/shared/utils";
import type { BatchPersistCallback } from "~/store/zustand/listener/transcript";
import {
  getTranscriptionLanguages,
  isDesktopLocalSttAvailable,
  isLocalFileSttModel,
  isOnDeviceSttModel,
  isSupportedLanguagesBatch,
} from "~/stt/capabilities";
import {
  createTranscript,
  getTranscriptRecord,
  type TranscriptRecord,
  type TranscriptInsert,
} from "~/stt/queries";
import {
  normalizeTranscriptionLanguages,
  type TranscriptionPolicy,
} from "~/stt/transcription-policy";
import type { SpeakerHintWithId, WordWithId } from "~/stt/types";

type RunOptions = {
  deferPromotion?: boolean;
  deferAudioFinalization?: boolean;
  handlePersist?: BatchPersistCallback;
  notifyOnCompletion?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  keywords?: string[];
  languages?: string[];
  numSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
  promotion?:
    | { scope: "preserve_existing" }
    | { scope: "whole_session" }
    | {
        scope: "current_capture";
        audioOffsetMs: number;
        audioEndMs?: number;
        replaceTranscriptId?: string;
        startedAt: number;
      };
};

const DIRECT_BATCH_PROVIDERS: Set<TranscriptionParams["provider"]> = new Set([
  "deepgram",
  "cartesia",
  "soniox",
  "assemblyai",
  "openai",
  "openrouter",
  "siliconflow",
  "zai",
  "gladia",
  "elevenlabs",
  "mistral",
  "fireworks",
  "pyannote",
  "aquavoice",
  "cohere",
  "aws_transcribe",
  "azure_speech",
  "google_cloud",
  "google_generative_ai",
  "groq",
  "revai",
  "speechmatics",
  "together",
  "xai",
]);

export function getBatchProvider(
  provider: string,
  model: string,
): TranscriptionParams["provider"] | null {
  if (provider === "cloudflare_workers_ai") {
    return "deepgram";
  }

  if (isLocalFileSttModel(provider, model)) {
    return "whispercpp";
  }

  if (provider === "anarlog") {
    if (model.startsWith("soniqo-")) return "soniqo";
    if (model === "apple-speech") return "applespeech";
    if (model.startsWith("am-")) return "am";
    return "anarlog";
  }
  if (provider === "soniqo") return "soniqo";
  if (provider === "apple_speech" || provider === "apple-speech") {
    return "applespeech";
  }
  if (DIRECT_BATCH_PROVIDERS.has(provider as TranscriptionParams["provider"])) {
    return provider as TranscriptionParams["provider"];
  }
  return null;
}

export function canRunBatchTranscription(
  _conn: { provider: string; model: string } | null,
  _modelOverride?: string,
) {
  return true;
}

async function canUseBatchTarget(
  provider: TranscriptionParams["provider"],
  model: string,
  languages: readonly string[],
) {
  return isSupportedLanguagesBatch(provider, model, languages);
}

function prepareTranscriptPromotion(
  words: WordWithId[],
  hints: SpeakerHintWithId[],
  promotion: NonNullable<RunOptions["promotion"]>,
) {
  if (promotion.scope !== "current_capture") {
    return {
      words,
      hints,
      replaceSession: promotion.scope === "whole_session",
      replaceTranscriptId: undefined,
      startedAt: undefined,
    };
  }

  const offsetMs = Number.isFinite(promotion.audioOffsetMs)
    ? Math.max(0, promotion.audioOffsetMs)
    : 0;
  const endBoundMs = promotion.audioEndMs ?? Infinity;
  const currentWords = words.flatMap((word) => {
    const startMs = word.start_ms ?? 0;
    const endMs = word.end_ms ?? startMs;
    if (endMs <= offsetMs || startMs >= endBoundMs) {
      return [];
    }
    return [
      {
        ...word,
        start_ms: Math.max(0, startMs - offsetMs),
        end_ms: Math.max(0, Math.min(endMs, endBoundMs) - offsetMs),
      },
    ];
  });
  const currentWordIds = new Set(currentWords.map((word) => word.id));

  return {
    words: currentWords,
    hints: hints.filter(
      (hint) =>
        typeof hint.word_id === "string" && currentWordIds.has(hint.word_id),
    ),
    replaceSession: false,
    replaceTranscriptId: promotion.replaceTranscriptId,
    startedAt: promotion.startedAt,
  };
}

export { reconcileRefinedSpeakerClusters } from "./refinement-speakers";

export function getSessionSpeakerCount(
  participantHumanIds: Iterable<string>,
  selfHumanId?: string | null,
): number | undefined {
  const humanIds = new Set(
    Array.from(participantHumanIds).filter((humanId) => Boolean(humanId)),
  );

  if (typeof selfHumanId === "string" && selfHumanId) {
    humanIds.add(selfHumanId);
  }

  return humanIds.size > 1 ? humanIds.size : undefined;
}

export const useRunBatch = (
  sessionId: string,
  targetPolicy?: TranscriptionPolicy | null,
) => {
  const session = useSession(sessionId);
  const participants = useSessionParticipants(sessionId);
  const speakerCandidates = useSessionSpeakerCandidates(sessionId);
  const persistedPolicy = targetPolicy ?? session?.transcription ?? undefined;

  const startTranscription = useListener((state) => state.startTranscription);
  const { conn, connectionIssue } = useSTTConnection(persistedPolicy);
  const auth = useAuth();
  const aiLanguage = useConfigValue("ai_language");
  const spokenLanguages = useConfigValue("spoken_languages");
  const dictionaryTerms = useConfigValue("personalization_dictionary_terms");
  const audioRetention = normalizeAudioRetention(
    useConfigValue("audio_retention"),
  );
  const rememberSpeakers = useConfigValue("remember_speakers") === true;

  return useCallback(
    async (filePath: string, options?: RunOptions) => {
      if (!startTranscription) {
        throw new Error(
          "STT connection is not available. Please configure your speech-to-text provider.",
        );
      }

      const languages = normalizeTranscriptionLanguages(
        options?.languages ??
          persistedPolicy?.languages ??
          getTranscriptionLanguages(aiLanguage, spokenLanguages),
      );
      const currentPlatform = platform();
      const currentArch = arch();
      const selectedProviderId =
        options?.provider ?? persistedPolicy?.provider ?? conn?.provider;
      const selectedModel =
        options?.model ?? persistedPolicy?.model ?? conn?.model;
      const selectedProvider =
        selectedProviderId && selectedModel
          ? getBatchProvider(selectedProviderId, selectedModel)
          : null;
      const explicitConnection =
        options?.baseUrl !== undefined && options.apiKey !== undefined
          ? { baseUrl: options.baseUrl, apiKey: options.apiKey }
          : null;
      const storedConnection =
        conn &&
        conn.provider === selectedProviderId &&
        conn.model === selectedModel
          ? conn
          : null;
      const credentials = explicitConnection ?? storedConnection;
      const selectedTarget =
        credentials && selectedProviderId && selectedModel && selectedProvider
          ? {
              provider: selectedProvider,
              requestedProvider: selectedProviderId,
              model: selectedModel,
              baseUrl: credentials.baseUrl,
              apiKey: credentials.apiKey,
            }
          : null;
      const selectedOnDeviceUnsupported = !!(
        selectedProviderId &&
        selectedModel &&
        (isOnDeviceSttModel(selectedProviderId, selectedModel) ||
          isLocalFileSttModel(selectedProviderId, selectedModel)) &&
        !isDesktopLocalSttAvailable(currentPlatform, currentArch)
      );
      if (!selectedProviderId || !selectedModel) {
        throw new Error(
          t`The recorded transcription target is missing. Choose a speech-to-text provider and model for this meeting.`,
        );
      }
      if (!selectedProvider) {
        throw new Error(
          t`${selectedModel} is not available for batch transcription with ${selectedProviderId}. The recorded target does not support batch transcription.`,
        );
      }
      if (!isKnownBatchTargetModel(selectedProviderId, selectedModel)) {
        throw new Error(
          t`${selectedModel} is not an available batch transcription model for ${selectedProviderId}.`,
        );
      }
      if (selectedOnDeviceUnsupported) {
        throw new Error(
          t`${selectedModel} is not available for batch transcription on ${currentPlatform}/${currentArch}. The recorded target requires Apple silicon macOS.`,
        );
      }
      if (!selectedTarget) {
        const reason =
          connectionIssue === "authentication"
            ? t`The saved authentication credentials are unavailable.`
            : connectionIssue === "local_service"
              ? t`The selected local transcription service is unavailable.`
              : t`The selected transcription endpoint is unavailable.`;
        throw new Error(
          t`${selectedProviderId} ${selectedModel} is not connected. ${reason}`,
        );
      }
      if (
        !(await canUseBatchTarget(
          selectedTarget.provider,
          selectedTarget.model,
          languages,
        ))
      ) {
        throw new Error(
          t`${selectedModel} is not available for batch transcription with the selected languages (${languages.join(", ")}).`,
        );
      }
      await preflightBatchTargetConnection({
        provider: selectedProviderId,
        model: selectedModel,
        baseUrl: selectedTarget.baseUrl,
        apiKey: selectedTarget.apiKey,
      });
      const target = selectedTarget;

      let refinedTranscriptSource: TranscriptRecord | null = null;
      const replaceTranscriptId =
        options?.promotion?.scope === "current_capture"
          ? options.promotion.replaceTranscriptId
          : undefined;
      if (replaceTranscriptId && !options?.deferPromotion) {
        try {
          refinedTranscriptSource =
            await getTranscriptRecord(replaceTranscriptId);
        } catch (error) {
          console.warn("[runBatch] failed to load refined transcript", error);
        }
      }

      const createdAt = new Date().toISOString();
      const startedAt = Date.now();
      const memoMd = session?.raw_md ?? "";
      let keywords = options?.keywords;
      if (keywords === undefined) {
        const { getSessionKeywords } = await import("./useKeywords");
        keywords = await getSessionKeywords({
          sessionId,
          dictionaryTerms,
        });
      }
      let transcriptId: string | null = null;
      const inferredNumSpeakers =
        !options?.deferPromotion &&
        options?.numSpeakers === undefined &&
        options?.minSpeakers === undefined &&
        options?.maxSpeakers === undefined
          ? getSessionSpeakerCount(
              participants
                .filter((participant) => participant.source !== "excluded")
                .map((participant) => participant.humanId),
              session?.user_id,
            )
          : undefined;

      const handlePersist: BatchPersistCallback | undefined =
        options?.handlePersist;
      let stagedWords: WordWithId[] = [];
      let stagedHints: SpeakerHintWithId[] = [];
      let providerModel: string | undefined;
      const resetStagedTranscript = () => {
        transcriptId = null;
        stagedWords = [];
        stagedHints = [];
      };

      const persist =
        handlePersist ??
        ((words, hints, persistOptions) => {
          if (words.length === 0) {
            return;
          }

          const newWords: WordWithId[] = [];
          const newWordIds: string[] = [];

          words.forEach((word) => {
            const wordId = id();

            newWords.push({
              id: wordId,
              text: word.text,
              start_ms: word.start_ms,
              end_ms: word.end_ms,
              channel: word.channel,
              metadata: word.metadata
                ? JSON.stringify(word.metadata)
                : undefined,
            });

            newWordIds.push(wordId);
          });

          const newHints: SpeakerHintWithId[] = [];

          hints.forEach((hint) => {
            if (hint.data.type !== "provider_speaker_index") {
              return;
            }

            const wordId = newWordIds[hint.wordIndex];
            const word = words[hint.wordIndex];

            if (!wordId || !word) {
              return;
            }

            newHints.push({
              id: id(),
              word_id: wordId,
              type: "provider_speaker_index",
              value: JSON.stringify({
                provider: hint.data.provider ?? target.provider,
                channel: hint.data.channel ?? word.channel,
                speaker_index: hint.data.speaker_index,
              }),
            });
          });

          transcriptId ??= id();
          if (persistOptions?.mode === "replace") {
            stagedWords = [];
            stagedHints = [];
          }
          providerModel = persistOptions?.providerModel ?? providerModel;
          stagedWords.push(...newWords);
          stagedHints.push(...newHints);
        });

      const cloudsyncLeaseKey = `${sessionId}:${id()}`;
      return withCloudsyncActivity(
        "transcription",
        cloudsyncLeaseKey,
        async () => {
          const params: TranscriptionParams = {
            session_id: sessionId,
            provider: target.provider,
            file_path: filePath,
            model: target.model,
            base_url: target.baseUrl,
            api_key: target.apiKey,
            keywords,
            languages,
            speaker_candidates: speakerCandidates.map(
              (candidate) => candidate.name,
            ),
            num_speakers: options?.numSpeakers ?? inferredNumSpeakers,
            min_speakers: options?.minSpeakers,
            max_speakers: options?.maxSpeakers,
          };

          try {
            await startTranscription(params, {
              handlePersist: persist,
              notifyOnCompletion: options?.notifyOnCompletion,
            });
          } catch (error) {
            if (
              target.provider !== "anarlog" ||
              target.model !== "cloud" ||
              !isTranscriptionAuthenticationError(error)
            ) {
              throw error;
            }

            const refreshedSession = await auth.refreshSession();
            if (!refreshedSession?.access_token) {
              throw error;
            }

            if (!handlePersist) {
              resetStagedTranscript();
            }
            await startTranscription(
              { ...params, api_key: refreshedSession.access_token },
              {
                handlePersist: persist,
                notifyOnCompletion: options?.notifyOnCompletion,
              },
            );
          }

          try {
            if (!handlePersist) {
              const promoted = prepareTranscriptPromotion(
                stagedWords,
                stagedHints,
                options?.promotion ?? { scope: "preserve_existing" },
              );
              if (
                options?.promotion?.scope === "current_capture" &&
                promoted.words.length === 0
              ) {
                throw new Error(EMPTY_CURRENT_CAPTURE_TRANSCRIPT_ERROR_MESSAGE);
              }
              if (transcriptId) {
                const completedTranscriptId = transcriptId;
                if (promoted.words.length > 0) {
                  const speakerHints = refinedTranscriptSource
                    ? reconcileRefinedSpeakerClusters(
                        refinedTranscriptSource,
                        promoted.words,
                        promoted.hints,
                      )
                    : promoted.hints;
                  const candidate: TranscriptInsert = {
                    id: completedTranscriptId,
                    sessionId,
                    ownerUserId: session?.user_id ?? "",
                    createdAt,
                    startedAt: promoted.startedAt ?? startedAt,
                    memo: memoMd,
                    source: "batch_transcription",
                    provider: target.requestedProvider,
                    model: target.model,
                    languages,
                    providerModel,
                    words: promoted.words,
                    speakerHints,
                    replaceSession: promoted.replaceSession,
                    replaceTranscriptId: promoted.replaceTranscriptId,
                  };
                  if (options?.deferPromotion) return candidate;
                  await persistTranscriptWrite(() =>
                    createTranscript(candidate),
                  );
                  await maybeExtractVoiceprintCandidates({
                    enabled: rememberSpeakers,
                    sessionId,
                    transcriptId: completedTranscriptId,
                    audioPath: filePath,
                  });
                }
              }
              if (options?.deferPromotion)
                throw new Error(EMPTY_CURRENT_CAPTURE_TRANSCRIPT_ERROR_MESSAGE);
              if (!options?.deferAudioFinalization) {
                try {
                  await persistTranscriptWrite(() =>
                    markSessionAudioTranscriptionComplete(sessionId),
                  );
                } catch (error) {
                  console.error(
                    "[runBatch] failed to mark session audio as processed",
                    error,
                  );
                }
              }
            }
            if (!options?.deferAudioFinalization) {
              await deleteProcessedAudioForRetention(audioRetention, sessionId);
            }
          } catch (error) {
            if (
              error instanceof BatchResponseProcessingError ||
              (error instanceof Error &&
                error.message ===
                  EMPTY_CURRENT_CAPTURE_TRANSCRIPT_ERROR_MESSAGE)
            ) {
              throw error;
            }
            throw new BatchResponseProcessingError(error);
          }
        },
      );
    },
    [
      conn,
      auth,
      auth?.session?.access_token,
      aiLanguage,
      audioRetention,
      connectionIssue,
      dictionaryTerms,
      rememberSpeakers,
      session,
      participants,
      spokenLanguages,
      persistedPolicy,
      startTranscription,
      sessionId,
    ],
  );
};
