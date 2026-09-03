import { BatchResponseProcessingError } from "./batch-response-processing-error";

export const STOPPED_TRANSCRIPTION_ERROR_MESSAGE = "Transcription stopped.";
export const EMPTY_CURRENT_CAPTURE_TRANSCRIPT_ERROR_MESSAGE =
  "Batch transcription did not include the current recording.";

export function isStoppedTranscriptionError(error: unknown) {
  return (
    (error instanceof Error ? error.message : String(error)) ===
    STOPPED_TRANSCRIPTION_ERROR_MESSAGE
  );
}

export function isTranscriptionAuthenticationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /authentication failed|invalid_token|unauthorized|\b401\b/i.test(
    message,
  );
}

export function isTerminalTranscriptionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof BatchResponseProcessingError ||
    message === EMPTY_CURRENT_CAPTURE_TRANSCRIPT_ERROR_MESSAGE ||
    isTranscriptionAuthenticationError(error) ||
    /corrupt or unsupported|unsupported (?:audio|data)|invalid audio|no speech|empty transcript/i.test(
      message,
    ) ||
    /\b(?:400|403|404|413|415|422)\b|bad request|invalid api key/i.test(message)
  );
}
