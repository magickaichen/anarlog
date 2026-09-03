-- Device-local work: only this device owns the retained recording and retry budget.
CREATE TABLE IF NOT EXISTS transcript_refinement_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL DEFAULT '{}',
  candidate_json TEXT,
  error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  finalized INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_refinement_jobs_session
ON transcript_refinement_jobs(session_id);
