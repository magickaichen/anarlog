-- Persist the speech-to-text target chosen for each session so later work
-- remains independent from mutable global settings.
ALTER TABLE sessions
ADD COLUMN transcription_provider TEXT NOT NULL DEFAULT '';

ALTER TABLE sessions
ADD COLUMN transcription_model TEXT NOT NULL DEFAULT '';

ALTER TABLE sessions
ADD COLUMN transcription_languages_json TEXT NOT NULL DEFAULT '["en"]';
