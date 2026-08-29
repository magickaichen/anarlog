-- Retain the requested languages and provider-reported model for audit and
-- deterministic re-transcription.
ALTER TABLE transcripts
ADD COLUMN requested_languages_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE transcripts
ADD COLUMN provider_model TEXT NOT NULL DEFAULT '';
