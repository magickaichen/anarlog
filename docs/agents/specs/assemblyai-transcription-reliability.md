# AssemblyAI transcription reliability and speaker identity

## Status

Ready for implementation. This file is the temporary specification source
while GitHub Issues are disabled for the fork.

## Outcome

An AssemblyAI-backed online meeting produces useful live text, automatically
settles into a more accurate final transcript, and reduces manual speaker
assignment without silently inventing identities or switching providers.

## Problem

The current AssemblyAI integration has three user-visible failure modes:

1. Accented English may be recognized as unrelated languages or incorrect
   words when language detection is broader than the meeting requires.
2. Streaming speaker data is incomplete. Word-level speaker labels and
   end-of-session speaker revisions are not applied, and short pending turns
   can become false speaker indices.
3. Re-transcription can select a fallback batch provider, so an AssemblyAI
   request may fail with an error from a different provider.

Diarization alone cannot produce participant names. Naming requires a separate
identity step using observed participants, calendar invitees, manual
participants, or trusted voiceprints.

## Scope

Phase 1 is AssemblyAI-first and covers:

- English-stable live and batch transcription;
- live word-level diarization and streaming speaker revisions;
- automatic post-meeting batch refinement for AssemblyAI online meetings;
- explicit, provider-consistent re-transcription;
- participant candidate collection for Zoom, Google Meet, and Microsoft Teams;
- AssemblyAI batch Speaker Identification as a source of suggestions;
- conservative identity confirmation and voiceprint training;
- preservation of manual transcript edits and speaker assignments; and
- a local private benchmark for regression testing.

Provider-neutral contracts must separate session policy, refinement state,
speaker candidates, suggested identities, and confirmed assignments from the
AssemblyAI adapter.

## Non-goals

- Guaranteeing a name when no participant or trusted voice evidence exists.
- Joining meetings with a bot or using hosted meeting-bot infrastructure.
- Sending participant email, employer, title, chat, or raw accessibility data
  to AssemblyAI.
- Bringing every transcription provider to feature parity in Phase 1.
- Uploading real meeting audio or human-corrected transcripts to Git, CI, or a
  hosted analytics service.
- Blocking final transcript availability until every suggested identity is
  reviewed.

## Required behavior

### R1. Session transcription policy

- The global default spoken language is English.
- A meeting can explicitly select another single language or multilingual
  recognition.
- The session-owned language choice is durable and is reused by live
  transcription, automatic refinement, and re-transcription.
- A single-language AssemblyAI request sends that language explicitly and does
  not enable language detection.
- A multilingual request enables detection only because the user selected it.
- Each transcript records its requested provider, model, and language. Record
  the provider-reported model when the API exposes it.
- Existing sessions without a session-owned policy fall back to the current
  global setting once, then retain the resolved choice for subsequent passes.

Storage changes, if required, must follow the repository's downgrade-safe
SQLite migration rules. Existing `sessions.language` and transcript
provider/model/language fields should be reused where they can represent the
policy without ambiguity.

### R2. Live AssemblyAI diarization

- An AssemblyAI online meeting enables `speaker_labels` even when no expected
  speaker count is supplied.
- Expected speaker count is an optional per-session advanced hint. Calendar
  invitee count and observed participant count must not become a hard limit.
- Deserialize and apply `words[].speaker` for every final streaming word.
- Use the turn-level speaker label only when a word has no speaker label.
- Treat `PENDING`, `UNKNOWN`, empty, and null labels as unassigned. They must not
  become numbered speakers.
- Process `SpeakerRevision` messages by matching `turn_order` and replacing the
  affected turn and word speaker labels before termination completes.
- Persist the corrected word-level speaker hints and render speaker changes
  that occur within one provider turn.
- Ignore malformed labels safely and keep transcript text available.

Primary implementation areas:

- `crates/owhisper-client/src/adapter/assemblyai/live.rs`
- the streaming response contract in `crates/owhisper-interface/`
- live persistence and rendering under `apps/desktop/src/stt/`

### R3. Automatic AssemblyAI refinement

- Every completed AssemblyAI live online meeting schedules a batch refinement,
  even when the participant list is empty or contains only one remote person.
- Start refinement only after the retained audio file is finalized.
- Use AssemblyAI, the session language, the session keywords, diarization, and
  the explicit compatible Universal-3.5 Pro batch model.
- Do not fall back to Anarlog Cloud, Soniqo, or another provider or model.
- Attempt at most two automatic retries after the initial request. Retry only
  errors classified as transient, and retain the same target.
- Persist a refinement state that survives restart: pending, running,
  succeeded, or failed with a user-safe reason.
- When refinement fails, keep the live transcript visible and provide an
  explicit retry action.
- Promote refined words automatically only when their source machine text has
  not been manually edited.
- Preserve confirmed speaker assignments by reconciling old and refined
  clusters. Never promote an unconfirmed suggested identity into an
  assignment.
- If affected transcript text was manually edited, show the replacement
  difference and require confirmation before replacing it.

Primary implementation areas:

- `apps/desktop/src/stt/capture-lifecycle.ts`
- `apps/desktop/src/stt/useRunBatch.ts`
- transcript persistence and promotion helpers under `apps/desktop/src/stt/`

### R4. Explicit re-transcription

- Re-transcription opens a confirmation surface showing provider, model, and
  language before the request starts.
- Default the target from the current final transcript, not the current global
  provider selection.
- Validate batch capability before submission.
- If the target is unavailable, show the exact unsupported language, model,
  platform, authentication, or connectivity reason and do not start another
  provider.
- Reuse the manual-edit and confirmed-speaker protections from automatic
  refinement.
- A successful re-transcription records the target that actually produced it.

Primary implementation areas:

- `apps/desktop/src/session/components/note-input/transcript/actions.ts`
- `apps/desktop/src/stt/useRunBatch.ts`
- transcript action and batch screen components and tests

### R5. Speaker candidates

- Candidate precedence is:
  1. participants observed in the active meeting surface;
  2. participants attached from the calendar event;
  3. participants added manually.
- Deduplicate candidates by existing human identity when available, then by a
  normalized display name scoped to the session.
- Persist only the normalized display name, source, and first/last observed
  timestamps required by the identity workflow.
- Do not retain raw accessibility trees for speaker identification.
- Verify observed participant extraction on Zoom, Google Meet, and Microsoft
  Teams. Unsupported or inaccessible platforms fall back to calendar and
  manual candidates without failing transcription.
- Send only non-empty candidate names to AssemblyAI.

Primary implementation areas:

- accessibility analysis under `crates/detect/src/meeting_ax/`
- Tauri bindings under `plugins/detect/`
- participant persistence under `apps/desktop/src/session/queries/`
- calendar participant synchronization under
  `apps/desktop/src/services/calendar/`

### R6. Suggested and confirmed identities

- Run AssemblyAI Speaker Identification only on a completed diarized batch
  transcript and only when at least two distinct candidate names exist.
- Submit `speaker_type: "name"` and candidate names. Do not submit email,
  company, title, role descriptions, chat, or other metadata.
- Store the returned anonymous-label-to-name mapping as provider-neutral
  suggested identities separate from confirmed speaker assignments.
- Display suggestions as uncertain, such as `Alice?`, and provide one
  post-meeting identity review for confirming or correcting all suggestions.
- Identity review does not block final transcript availability.
- User confirmation or an already trusted local voiceprint may create a
  confirmed assignment.
- Only confirmed identities may create voiceprint exemplars. Provider
  suggestions alone never create or reinforce a voiceprint.
- A rejected or corrected suggestion must not reappear as confirmed through
  stale cached state.

Primary implementation areas:

- `crates/owhisper-client/src/adapter/assemblyai/batch.rs`
- `plugins/transcription/src/voiceprint.rs`
- transcript speaker hints and rendering under `apps/desktop/src/stt/` and
  `apps/desktop/src/session/components/note-input/transcript/`

### R7. Settings and status UI

- Keep English as the visible global default and expose a per-meeting language
  override near transcription controls.
- Keep diarization enabled by default for online meetings.
- Put expected speaker count in advanced per-meeting controls and allow it to
  remain unset.
- Distinguish provisional, refining, final, and refinement-failed states.
- Distinguish anonymous labels, suggested identities, and confirmed names.
- Status text must name the requested provider when reporting errors.

## Acceptance scenarios

1. **English constraint:** an English session sends `en` for live and batch
   requests without language detection. Re-transcription uses the same stored
   choice after the global language setting changes.
2. **Mid-turn speaker change:** a streaming fixture containing words from
   speakers A and B in one turn persists and renders both speakers.
3. **Speaker revision:** a `SpeakerRevision` changes the stored speaker for the
   matching turn before termination.
4. **Pending label:** `PENDING` produces an anonymous speaker, never a large
   numbered speaker index.
5. **No participant dependency:** an AssemblyAI online meeting with no known
   participants still performs post-meeting refinement.
6. **Optional count:** diarization remains enabled with no expected count; an
   explicit per-session count is passed to live and batch requests.
7. **Provider consistency:** after the global provider changes, re-transcribing
   an AssemblyAI transcript still proposes AssemblyAI. An unavailable target
   fails without invoking cloud or local fallback.
8. **Failure recovery:** three transient failures leave the live transcript
   readable, persist a failed refinement state, and expose a retry action.
9. **Manual edit safety:** untouched machine text is promoted automatically;
   edited text requires confirmation; confirmed speaker assignments survive.
10. **Candidate privacy:** the AssemblyAI request contains candidate names and
    no other participant fields. Raw accessibility data is not persisted.
11. **Identity trust:** a successful provider mapping renders as a suggestion,
    does not train a voiceprint, and becomes confirmed only after user approval
    or a trusted voiceprint match.
12. **Platform coverage:** macOS QA verifies observed participant candidates on
    Zoom, Google Meet, and Microsoft Teams; inaccessible surfaces degrade to
    calendar or manual candidates.

## Benchmark and verification

Create a gitignored local benchmark manifest that points to user-selected,
consented recordings and human-corrected transcripts outside the repository.
The benchmark runner may emit local comparison reports, but no private audio or
transcript content may enter Git or CI.

Compare the current fork baseline with the completed implementation for:

- word error rate or an equivalent word-level difference;
- incorrect-language spans in English sessions;
- word-level speaker attribution and revision handling;
- anonymous-to-suggested identity precision; and
- confirmed wrong-name count, which must remain zero in the benchmark.

The feature is acceptable when representative English meetings show no
unrelated-language spans, word accuracy does not regress and improves on the
reported problem cases, speaker changes are retained, and no unconfirmed name
is presented as confirmed.

Run the checks required by the changed paths before every implementation
commit. At minimum, expect affected Rust tests, desktop unit tests and
typecheck, desktop lint, repository formatting checks, and macOS-native manual
QA for the three meeting platforms.

## Implementation order

Each stage must be independently tested and reviewable. Do not combine later UI
work with earlier provider correctness fixes.

1. **Live diarization correctness:** word speakers, pending labels, speaker
   revisions, persistence, and focused Rust/desktop tests.
2. **Session policy and explicit target:** durable language/target selection,
   English default, re-transcription preflight, and removal of silent fallback
   from explicit flows.
3. **Automatic refinement:** all AssemblyAI online meetings, bounded same-target
   retry, durable state, transcript promotion, and manual-edit protection.
4. **Observed participant candidates:** Zoom, Google Meet, and Teams extraction,
   minimal persistence, merging, and privacy tests.
5. **Identity suggestions:** AssemblyAI Speaker Identification, uncertain UI,
   bulk confirmation, corrections, and voiceprint trust boundaries.
6. **Benchmark and end-to-end QA:** baseline comparison, failure recovery,
   platform verification, and final code review.

## Source evidence

- The current streaming adapter assigns one turn-level speaker to every word:
  `crates/owhisper-client/src/adapter/assemblyai/live.rs`.
- The current capture lifecycle limits settled diarization refinement to
  selected Anarlog Cloud and local-model paths:
  `apps/desktop/src/stt/capture-lifecycle.ts`.
- The current batch runner can replace an unavailable selected target with Pro
  cloud or local Soniqo: `apps/desktop/src/stt/useRunBatch.ts`.
- Sessions and transcripts already carry language and transcription-target
  fields: `crates/db-app/migrations/20260710223922_canonical_data_model.sql`.
- [AssemblyAI streaming diarization](https://www.assemblyai.com/docs/streaming/label-speakers-and-separate-channels)
  documents word-level speakers, pending labels, and `SpeakerRevision`.
- [AssemblyAI Speaker Identification](https://www.assemblyai.com/docs/speech-understanding/speaker-identification)
  requires diarization and returns a speaker mapping without per-identity
  confidence.
- [ADR 0001](../decisions/0001-assemblyai-two-stage-transcription.md)
  records the durable trade-offs.
