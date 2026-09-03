import { useEffect, useRef } from "react";

import { useListener } from "./contexts";
import {
  finishTranscriptRefinement,
  runTranscriptRefinement,
  type TranscriptRefinement,
} from "./refinement";
import { useRunBatch } from "./useRunBatch";

import { useLiveQuery } from "~/db";
import {
  deleteProcessedAudioForRetention,
  normalizeAudioRetention,
} from "~/services/audio-retention";
import { getEnhancerService } from "~/services/enhancer";
import { maybeExtractVoiceprintCandidates } from "~/services/voiceprint";
import { markSessionAudioTranscriptionComplete } from "~/session/attachments";
import { useAiProvidersState } from "~/settings/providers";
import { useConfigValue } from "~/shared/config";

type RefinementWork = {
  id: string;
  session_id: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  input_json: string;
};

const EMPTY: RefinementWork[] = [];

export function TranscriptRefinementLifecycle() {
  const { isReady } = useAiProvidersState("stt");
  const { data = EMPTY } = useLiveQuery<RefinementWork, RefinementWork[]>({
    sql: `SELECT job.id, job.session_id, job.status, job.attempts, job.next_attempt_at, job.input_json
      FROM transcript_refinement_jobs AS job
      JOIN sessions AS session ON session.id = job.session_id AND session.deleted_at IS NULL
      WHERE (job.status IN ('pending', 'running') OR (job.status = 'succeeded' AND job.finalized = 0))
        AND NOT EXISTS (SELECT 1 FROM app_settings WHERE id = 'capture_lifecycle_pending:' || job.session_id)
      ORDER BY job.updated_at, job.id`,
    mapRows: (rows) => rows,
  });
  const sessions = new Set<string>();
  return data
    .filter((job) => {
      if (sessions.has(job.session_id)) return false;
      sessions.add(job.session_id);
      return true;
    })
    .map((job) => (
      <RefinementWorker key={job.id} job={job} providersReady={isReady} />
    ));
}

function RefinementWorker({
  job,
  providersReady,
}: {
  job: RefinementWork;
  providersReady: boolean;
}) {
  const input: TranscriptRefinement["input"] = JSON.parse(job.input_json);
  const runBatch = useRunBatch(job.session_id, input.target);
  const runBatchRef = useRef(runBatch);
  runBatchRef.current = runBatch;
  const mode = useListener((state) => state.getSessionMode(job.session_id));
  const audioRetention = normalizeAudioRetention(
    useConfigValue("audio_retention"),
  );
  const rememberSpeakers = useConfigValue("remember_speakers") === true;

  useEffect(() => {
    if (mode !== "inactive" || (!providersReady && job.status !== "succeeded"))
      return;
    const timer = setTimeout(
      () => {
        if (job.status === "succeeded") {
          void finishTranscriptRefinement(job.id, async (current) => {
            if (current.candidate)
              await maybeExtractVoiceprintCandidates({
                enabled: rememberSpeakers,
                sessionId: current.sessionId,
                transcriptId: current.candidate.id,
                audioPath: current.input.audioPath,
              });
            await markSessionAudioTranscriptionComplete(current.sessionId);
            await getEnhancerService()?.queueAutoEnhanceIfSummaryEmpty(
              current.sessionId,
            );
            await deleteProcessedAudioForRetention(
              audioRetention,
              current.sessionId,
            );
          }).catch((error) =>
            console.error("[refinement] completion pending", error),
          );
          return;
        }
        void runTranscriptRefinement(job.id, async (current) => {
          const candidate = await runBatchRef.current(current.input.audioPath, {
            deferPromotion: true,
            deferAudioFinalization: true,
            notifyOnCompletion: false,
            ...current.input.target,
            keywords: current.input.keywords,
            promotion: {
              scope: "current_capture",
              audioOffsetMs: current.input.audioOffsetMs,
              audioEndMs: current.input.audioEndMs,
              replaceTranscriptId: current.id,
              startedAt: current.input.startedAt,
            },
          });
          if (!candidate)
            throw new Error("No speech was detected in the audio.");
          return candidate;
        }).catch((error) =>
          console.error("[refinement] could not persist job state", error),
        );
      },
      Math.max(0, job.next_attempt_at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [
    job.id,
    job.status,
    job.attempts,
    job.next_attempt_at,
    mode,
    audioRetention,
    rememberSpeakers,
    providersReady,
  ]);

  return null;
}
