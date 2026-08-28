# Transcription

The transcription context defines the language for converting meeting audio
into text and attributing that text to speakers.

## Boundary

Transcription owns provider speech-to-text integration, transcript refinement,
speaker diarization, speaker identity evidence, and the transition from a live
transcript to a final transcript. Audio capture and meeting participant
discovery are upstream. Session transcript rendering and meeting intelligence
are downstream.

## Invariants

- A live transcript remains provisional until refinement or an explicit
  re-transcription succeeds.
- Word-level speaker evidence takes precedence over a turn-level label.
- A suggested identity is never a confirmed speaker assignment.
- Only confirmed identities may train trusted voiceprints.
- One session language and explicit transcription target govern every pass.
- A refinement failure preserves the live transcript as provisional and stays
  visible and retryable.

## Ownership

- Provider I/O adapters live under `crates/owhisper-client/src/adapter/`.
- Streaming response contracts live under `crates/owhisper-interface/`.
- Desktop orchestration and persistence live under `apps/desktop/src/stt/`.
- Speaker resolution and voiceprints live under `plugins/transcription/` and
  `crates/transcript/`.
- Transcript presentation lives under
  `apps/desktop/src/session/components/note-input/transcript/`.
- Meeting accessibility and calendar services supply participant candidates.

## Decisions

- [Use two-stage AssemblyAI transcription with conservative speaker identity](./docs/adr/0001-assemblyai-two-stage-transcription.md)

## Language

**Live transcript**:
A low-latency, provisional transcript shown while capture is active. Its words
and speaker attribution may be refined after the meeting.
_Avoid_: Final transcript, authoritative transcript

**Final transcript**:
The authoritative transcript produced after post-capture refinement or an
explicit re-transcription completes successfully. A failed refinement leaves
the live transcript provisional and does not produce a final transcript.
_Avoid_: Live transcript, raw transcript

**Transcript refinement**:
An automatic post-capture batch pass over retained meeting audio that produces
the final transcript.
_Avoid_: Re-transcription, retry

**Re-transcription**:
A user-initiated batch pass over retained meeting audio that replaces the
existing final transcript.
_Avoid_: Transcript refinement, retry

**Speaker diarization**:
The separation of spoken words into anonymous speaker clusters. It answers who
spoke when without assigning a person's name.
_Avoid_: Speaker identification, name recognition

**Word-level speaker attribution**:
A speaker label attached to each recognized word. It preserves speaker changes
inside one provider turn and takes precedence over the turn-level label.
_Avoid_: Turn-level speaker approximation, speaker identification

**Speaker revision**:
A provider correction that replaces previously received turn-level and
word-level speaker labels before the streaming session terminates.
_Avoid_: New transcript turn, speaker identification

**Speaker identification**:
The mapping of an anonymous speaker cluster to a known person. Identification
may use participant context or remembered voiceprints, but requires evidence
beyond diarization.
_Avoid_: Speaker diarization

**Speaker assignment**:
A link from a speaker cluster to a confirmed identity. Without an assignment,
the transcript retains an anonymous speaker label or shows a suggested
identity as uncertain.
_Avoid_: Speaker guess

**Speaker label**:
The stable anonymous name shown for an unassigned speaker cluster, such as
`Speaker 2`.
_Avoid_: Participant name

**Observed participant**:
A person reported as present by the meeting platform during the meeting.
Presence does not prove that the person spoke.
_Avoid_: Speaker, invited participant

**Invited participant**:
A person listed on the calendar event. An invitation does not prove attendance.
_Avoid_: Observed participant, speaker

**Speaker candidate**:
A known person eligible for speaker identification. Candidates come from
observed participants first, then invited or manually added participants, but
remain possibilities until assigned to a speaker cluster.
_Avoid_: Speaker assignment, identified speaker

**Suggested identity**:
An unconfirmed mapping from a speaker cluster to a speaker candidate. A
suggested identity is shown as uncertain and cannot train a voiceprint.
_Avoid_: Speaker assignment, confirmed identity

**Identity review**:
A post-meeting review of suggested identities where the user may confirm or
correct several speaker mappings without blocking transcript refinement.
_Avoid_: Required transcription approval, automatic assignment

**Confirmed identity**:
A speaker identity accepted by the user or supported by an already trusted
voiceprint. A confirmed identity may become a speaker assignment and may train
future voiceprints.
_Avoid_: Suggested identity, provider guess

**Trusted voiceprint**:
A locally retained voice representation learned only from confirmed speaker
identities. It may support future speaker identification without making a
provider suggestion authoritative.
_Avoid_: Unconfirmed voice sample, speaker candidate

**Expected speaker count**:
An optional per-session hint for speaker diarization. It represents expected
speakers, not the number of invited or observed participants, and is never a
required meeting-start field.
_Avoid_: Participant count, required speaker count

**Manual transcript edit**:
A user-authored change to transcript words or speaker assignments. Automated
refinement preserves manual edits or asks before replacing affected content.
_Avoid_: Machine refinement

**Spoken language**:
The language selected for speech recognition. A speaker's accent does not
change the spoken language.
_Avoid_: Speaker nationality, accent language

**Session language**:
The spoken-language choice persisted with a meeting and used consistently for
live transcription, transcript refinement, and re-transcription.
_Avoid_: Interface language, provider default

**Multilingual meeting**:
A meeting in which participants actually speak more than one language. Accented
English alone is an English-language meeting.
_Avoid_: International meeting

**Transcription target**:
The provider, model, and session language selected for a transcription pass.
Re-transcription keeps its target explicit and does not silently substitute a
different provider.
_Avoid_: Fallback provider, global default

**Refinement failure**:
A state in which automatic transcript refinement cannot produce a final
transcript after bounded retries against its transcription target. The live
transcript remains available and the failure remains visible and retryable.
_Avoid_: Empty transcript, silent fallback

**Transcription benchmark**:
A local-only set of representative meeting audio and human-corrected
transcripts used to compare transcription accuracy and speaker attribution.
Private benchmark material is not committed to the repository or uploaded to
continuous integration.
_Avoid_: Production telemetry, repository fixture
