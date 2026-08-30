import { t } from "@lingui/core/macro";
import { useCallback } from "react";

import { commands as fsSyncCommands } from "@anlg/plugin-fs-sync";
import { sonnerToast } from "@anlg/ui/components/ui/toast";

import { withCloudsyncActivity } from "~/db/cloudsync-activity";
import { getEnhancerService } from "~/services/enhancer";
import { useSession } from "~/session/queries";
import { useListener } from "~/stt/contexts";
import { useLatestSessionTranscriptTarget } from "~/stt/queries";
import { formatTranscriptionTarget } from "~/stt/transcription-policy";
import { isStoppedTranscriptionError, useRunBatch } from "~/stt/useRunBatch";

export function useRegenerateTranscript(sessionId: string) {
  const session = useSession(sessionId);
  const latestTranscriptTarget = useLatestSessionTranscriptTarget(sessionId);
  const target = latestTranscriptTarget ?? session?.transcription;
  const runBatch = useRunBatch(sessionId, target);
  const handleBatchFailed = useListener((state) => state.handleBatchFailed);

  return useCallback(async () => {
    if (!target) {
      sonnerToast.error(t`Re-transcription failed`, {
        id: `transcript-regenerate-failed-${sessionId}`,
        description: t`The original transcription target was not recorded for this meeting.`,
      });
      return;
    }
    const result = await fsSyncCommands.audioPath(sessionId);
    if (result.status === "error") {
      sonnerToast.error(t`Recording not found. It may have been deleted.`, {
        id: `transcript-regenerate-audio-missing-${sessionId}`,
      });
      return;
    }

    const audioPath = result.data;

    try {
      sonnerToast.info(t`Re-transcription started`, {
        description: formatTranscriptionTarget(target),
      });
      await withCloudsyncActivity(
        "transcription",
        `${sessionId}:retranscription:${crypto.randomUUID()}`,
        async () => {
          await runBatch(audioPath, {
            promotion: { scope: "whole_session" },
          });
          await getEnhancerService()?.queueAutoEnhanceIfSummaryEmpty(sessionId);
        },
      );
    } catch (error) {
      if (isStoppedTranscriptionError(error)) {
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      handleBatchFailed(sessionId, msg);
      sonnerToast.error(t`Re-transcription failed`, {
        id: `transcript-regenerate-failed-${sessionId}`,
        description: msg,
      });
    }
  }, [handleBatchFailed, runBatch, sessionId, target]);
}
