import {
  createTranscript,
  type TranscriptInsert,
  type TranscriptRecord,
} from "./queries";
import { preserveConfirmedSpeakerAssignments } from "./refinement-speakers";
import { isTerminalTranscriptionError } from "./transcription-errors";
import type { WordWithId } from "./types";

import { executeTransaction, liveQueryClient } from "~/db";
import { enqueueDatabaseWrite } from "~/db/write-queue";
import {
  normalizeTranscriptionLanguages,
  type TranscriptionPolicy,
} from "~/stt/transcription-policy";

export type TranscriptRefinement = {
  id: string;
  sessionId: string;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "awaiting_confirmation";
  attempts: number;
  error: string | null;
  nextAttemptAt: number;
  finalized: boolean;
  candidate: TranscriptInsert | null;
  input: {
    audioPath: string;
    audioOffsetMs: number;
    audioEndMs?: number;
    startedAt: number;
    target: TranscriptionPolicy;
    keywords: string[];
    sourceWords: WordWithId[] | null;
    sourceWasEdited: boolean;
  };
};

export async function scheduleTranscriptRefinement(input: {
  sessionId: string;
  transcriptId: string;
  audioPath: string;
  audioOffsetMs: number;
  audioEndMs?: number;
  startedAt: number;
  languages: string[];
  keywords: string[];
}): Promise<void> {
  const source = await readRefinementSource(input.transcriptId);
  await enqueueDatabaseWrite(`refinement:${input.transcriptId}`, () =>
    executeTransaction([
      {
        sql: `INSERT OR IGNORE INTO transcript_refinement_jobs
        (id, session_id, input_json, updated_at) VALUES (?, ?, ?, ?)`,
        params: [
          input.transcriptId,
          input.sessionId,
          JSON.stringify({
            audioPath: input.audioPath,
            audioOffsetMs: input.audioOffsetMs,
            audioEndMs: input.audioEndMs,
            startedAt: input.startedAt,
            target: {
              provider: "assemblyai",
              model: "universal-3-5-pro",
              languages: normalizeTranscriptionLanguages(input.languages),
            },
            keywords: input.keywords,
            sourceWords: source?.words ?? null,
            sourceWasEdited: source?.manuallyEdited ?? false,
          }),
          new Date().toISOString(),
        ],
      },
    ]),
  );
}

export async function getTranscriptRefinement(
  id: string,
): Promise<TranscriptRefinement | null> {
  const rows = await liveQueryClient.execute<{
    id: string;
    session_id: string;
    status: TranscriptRefinement["status"];
    attempts: number;
    input_json: string;
    candidate_json: string | null;
    error: string | null;
    next_attempt_at: number;
    finalized: number;
  }>("SELECT * FROM transcript_refinement_jobs WHERE id = ?", [id]);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        sessionId: row.session_id,
        status: row.status,
        attempts: row.attempts,
        error: row.error,
        nextAttemptAt: row.next_attempt_at,
        finalized: row.finalized === 1,
        input: JSON.parse(row.input_json),
        candidate: row.candidate_json ? JSON.parse(row.candidate_json) : null,
      }
    : null;
}

const activeRuns = new Map<string, Promise<void>>();
const activeCompletions = new Map<string, Promise<void>>();

export function finishTranscriptRefinement(
  id: string,
  finalize: (job: TranscriptRefinement) => Promise<void>,
): Promise<void> {
  const active = activeCompletions.get(id);
  if (active) return active;
  const run = (async () => {
    const job = await getTranscriptRefinement(id);
    if (!job || job.status !== "succeeded" || job.finalized) return;
    try {
      await finalize(job);
      await executeTransaction([
        {
          sql: `UPDATE transcript_refinement_jobs SET finalized = 1, error = NULL, next_attempt_at = 0 WHERE id = ? AND status = 'succeeded'`,
          params: [id],
          expectedRowsAffected: 1,
        },
      ]);
    } catch (error) {
      await executeTransaction([
        {
          sql: `UPDATE transcript_refinement_jobs SET next_attempt_at = ?, error = ? WHERE id = ? AND status = 'succeeded'`,
          params: [
            Date.now() + 5000,
            error instanceof Error ? error.message : String(error),
            id,
          ],
        },
      ]);
      throw error;
    }
  })().finally(() => activeCompletions.delete(id));
  activeCompletions.set(id, run);
  return run;
}

export function runTranscriptRefinement(
  id: string,
  transcribe: (job: TranscriptRefinement) => Promise<TranscriptInsert>,
): Promise<void> {
  const active = activeRuns.get(id);
  if (active) return active;
  const run = (async () => {
    const job = await getTranscriptRefinement(id);
    if (!job || (job.status !== "pending" && job.status !== "running")) return;
    if (job.attempts >= 3 && !job.candidate) {
      await updateRefinement(
        id,
        "failed",
        job.attempts,
        "Refinement retry budget exhausted.",
      );
      return;
    }
    const attempts = job.attempts + (job.candidate ? 0 : 1);
    let candidateReady = Boolean(job.candidate);
    await updateRefinement(id, "running", attempts);
    try {
      const candidate = job.candidate ?? (await transcribe(job));
      await executeTransaction([
        {
          sql: `UPDATE transcript_refinement_jobs SET candidate_json = ? WHERE id = ?`,
          params: [JSON.stringify(candidate), id],
          expectedRowsAffected: 1,
        },
      ]);
      candidateReady = true;
      await promoteRefinement(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal =
        isTerminalTranscriptionError(error) ||
        /not (?:connected|available)|target is missing|credentials are unavailable|endpoint is unavailable/i.test(
          message,
        );
      await updateRefinement(
        id,
        !candidateReady && attempts < 3 && !terminal ? "pending" : "failed",
        attempts,
        message,
      );
    }
  })().finally(() => activeRuns.delete(id));
  activeRuns.set(id, run);
  return run;
}

async function readRefinementSource(
  id: string,
): Promise<
  (TranscriptRecord & { revision: number; manuallyEdited: boolean }) | null
> {
  const rows = await liveQueryClient.execute<{
    id: string;
    session_id: string;
    owner_user_id: string;
    started_at_ms: number;
    words_json: string;
    speaker_hints_json: string;
    content_revision: number;
    metadata_json: string;
  }>(
    `SELECT id, session_id, owner_user_id, started_at_ms, words_json, speaker_hints_json, content_revision, metadata_json FROM transcripts WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    startedAt: row.started_at_ms,
    words: JSON.parse(row.words_json),
    speakerHints: JSON.parse(row.speaker_hints_json),
    revision: row.content_revision,
    manuallyEdited: Boolean(JSON.parse(row.metadata_json).manual_text_edited),
  };
}

async function promoteRefinement(
  id: string,
  confirmationRevision?: number,
): Promise<void> {
  const job = await getTranscriptRefinement(id);
  if (
    !job?.candidate ||
    (job.status !== "running" && job.status !== "awaiting_confirmation")
  )
    return;
  const source = await readRefinementSource(id);
  if (job.input.sourceWords && !source)
    throw new Error(
      "The live transcript was removed. Refinement cannot replace it.",
    );
  if (
    confirmationRevision !== undefined &&
    source?.revision !== confirmationRevision
  ) {
    throw new Error(
      "The transcript changed. Review the updated difference before confirming.",
    );
  }
  const sourceChanged =
    source &&
    (source.manuallyEdited ||
      job.input.sourceWasEdited ||
      JSON.stringify(source.words) !== JSON.stringify(job.input.sourceWords));
  if (confirmationRevision === undefined && sourceChanged) {
    await updateRefinement(id, "awaiting_confirmation", job.attempts);
    return;
  }
  await createTranscript({
    ...job.candidate,
    sessionId: job.sessionId,
    speakerHints: source
      ? preserveConfirmedSpeakerAssignments(
          source,
          job.candidate.words ?? [],
          job.candidate.speakerHints ?? [],
        )
      : job.candidate.speakerHints,
    replaceSession: false,
    replaceTranscriptId: source ? id : undefined,
    expectedSourceRevision: source?.revision,
    refinementJobId: id,
  });
}

export async function getTranscriptRefinementReview(id: string) {
  const job = await getTranscriptRefinement(id);
  const source = await readRefinementSource(id);
  if (job?.status !== "awaiting_confirmation" || !job.candidate || !source)
    return null;
  return {
    revision: source.revision,
    before: source.words
      .map((word) => word.text)
      .join(" ")
      .trim(),
    after: (job.candidate.words ?? [])
      .map((word) => word.text)
      .join(" ")
      .trim(),
  };
}

export function confirmTranscriptRefinement(
  id: string,
  revision: number,
): Promise<void> {
  return promoteRefinement(id, revision);
}

export async function retryTranscriptRefinement(id: string): Promise<void> {
  await executeTransaction([
    {
      sql: `UPDATE transcript_refinement_jobs SET status = 'pending', attempts = CASE WHEN candidate_json IS NULL THEN 0 ELSE attempts END, error = NULL, next_attempt_at = 0, updated_at = ? WHERE id = ? AND status = 'failed'`,
      params: [new Date().toISOString(), id],
    },
  ]);
}

async function updateRefinement(
  id: string,
  status: TranscriptRefinement["status"],
  attempts: number,
  error: string | null = null,
) {
  await executeTransaction([
    {
      sql: `UPDATE transcript_refinement_jobs SET status = ?, attempts = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      params: [
        status,
        attempts,
        error,
        status === "pending" ? Date.now() + 2000 * 2 ** (attempts - 1) : 0,
        new Date().toISOString(),
        id,
      ],
      expectedRowsAffected: 1,
    },
  ]);
}
