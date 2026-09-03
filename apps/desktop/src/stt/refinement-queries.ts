import type { TranscriptRefinement } from "./refinement";

import { useLiveQuery } from "~/db";

export type RefinementStatus = Pick<
  TranscriptRefinement,
  "id" | "status" | "attempts" | "error" | "nextAttemptAt"
>;

const EMPTY: RefinementStatus[] = [];

export function useSessionRefinementStatus(sessionId: string) {
  const { data = EMPTY } = useLiveQuery<
    {
      id: string;
      status: TranscriptRefinement["status"];
      attempts: number;
      error: string | null;
      next_attempt_at: number;
    },
    RefinementStatus[]
  >({
    sql: `SELECT id, status, attempts, error, next_attempt_at FROM transcript_refinement_jobs WHERE session_id = ? ORDER BY updated_at, id`,
    params: [sessionId],
    mapRows: (rows) =>
      rows.map((row) => ({
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        error: row.error,
        nextAttemptAt: row.next_attempt_at,
      })),
  });
  return data;
}
