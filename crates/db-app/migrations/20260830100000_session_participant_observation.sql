-- Additive observation timestamps keep older builds compatible with newer databases.
ALTER TABLE session_participants ADD COLUMN first_observed_at TEXT;
ALTER TABLE session_participants ADD COLUMN last_observed_at TEXT;
