import { commands as detectCommands } from "@anlg/plugin-detect";

import { persistObservedParticipants } from "~/session/queries";

const MEETING_PARTICIPANT_CAPTURE_INTERVAL_MS = 5_000;

export function startMeetingParticipantCapture({
  sessionId,
}: {
  sessionId: string;
}) {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastWarning = "";

  const captureOnce = async () => {
    const result = await detectCommands.captureMeetingParticipants();
    if (stopped) {
      return;
    }
    if (result.status === "error") {
      console.warn(
        "[listener] failed to capture meeting participants",
        result.error,
      );
      return;
    }

    const warning = result.data.warnings.join("\n");
    if (warning && warning !== lastWarning) {
      console.warn("[listener] meeting participant capture warning", warning);
    }
    lastWarning = warning;

    const displayNames = result.data.participants
      .map((participant) => participant.displayName.trim())
      .filter(Boolean);
    if (displayNames.length > 0) {
      await persistObservedParticipants(sessionId, displayNames);
    }
  };

  const scheduleCapture = () => {
    if (stopped || timeout) {
      return;
    }
    timeout = setTimeout(() => {
      timeout = null;
      void capture();
    }, MEETING_PARTICIPANT_CAPTURE_INTERVAL_MS);
  };

  const capture = () => {
    if (stopped || inFlight) {
      return inFlight ?? Promise.resolve();
    }
    const pendingCapture = captureOnce()
      .catch((error) => {
        console.warn(
          "[listener] failed to capture meeting participants",
          error,
        );
      })
      .finally(() => {
        if (inFlight === pendingCapture) {
          inFlight = null;
          scheduleCapture();
        }
      });
    inFlight = pendingCapture;
    return pendingCapture;
  };

  void capture();

  return async () => {
    stopped = true;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    await inFlight;
  };
}
