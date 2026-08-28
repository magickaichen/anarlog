# ADR 0001: Use two-stage AssemblyAI transcription with conservative speaker identity

## Status

Accepted

## Context

AssemblyAI Universal-3.5 Pro Realtime provides low-latency text, but the live
result is not a reliable final record for accented English or multi-speaker
meetings. Anarlog currently exposes the live turn's speaker label on every word,
does not process streaming speaker revisions, and only schedules settled batch
diarization for selected cloud and local providers.

AssemblyAI streaming diarization produces anonymous speaker labels. Its batch
Speaker Identification feature can map those labels to supplied names, but the
response does not provide a confidence score for each identity mapping. A
successful provider response therefore cannot safely establish a person's
identity by itself.

The existing batch path may replace an unavailable selected target with
Anarlog Cloud or local Soniqo. That behavior is useful as a general fallback,
but it makes re-transcription surprising when the user expects AssemblyAI.

## Decision

Use a two-stage transcription pipeline for AssemblyAI online meetings:

1. Show a provisional live transcript during capture.
2. After audio capture finishes, automatically run an AssemblyAI batch pass and
   promote it to the final transcript.

The pipeline has these boundaries:

- English is the default spoken language. Multilingual recognition requires an
  explicit per-session choice, and the same choice governs live transcription,
  automatic refinement, and re-transcription.
- Online meetings enable speaker diarization by default. An expected speaker
  count is optional and never inferred as a hard limit from invitees.
- Re-transcription uses an explicit provider, model, and language target. It
  never silently substitutes another provider or model.
- Observed meeting-platform participants are preferred speaker candidates,
  followed by calendar invitees and manually added participants.
- Only candidate names are sent to AssemblyAI Speaker Identification.
- A provider identity mapping is a suggested identity. Only user confirmation
  or an already trusted local voiceprint creates a speaker assignment.
- Unconfirmed suggestions never train voiceprints.
- Automatic refinement preserves manual speaker assignments. It replaces
  untouched machine text automatically and requests confirmation before
  replacing manually edited text.
- Refinement retries remain bounded and use the same target. Failure preserves
  the live transcript and remains visible and retryable.

Keep provider-neutral transcription, identity-suggestion, and refinement-state
contracts around the AssemblyAI-first implementation so another provider can
implement the same behavior later.

## Consequences

- Users see live text immediately and receive a more accurate post-meeting
  transcript without starting re-transcription manually.
- Every AssemblyAI online meeting incurs an additional batch request and a
  delay before finalization.
- The interface must distinguish provisional text, final text, suggested
  identities, confirmed assignments, and refinement failures.
- Participant observation and identity suggestions require durable minimal
  metadata, but raw accessibility trees are not retained.
- Re-transcription failures become more explicit because provider fallback no
  longer masks unsupported or unavailable targets.
- Speaker names may remain anonymous when available evidence is insufficient.

## Alternatives considered

**Live transcription only** was rejected because it preserves low latency but
does not address final transcript accuracy or settled diarization.

**Batch transcription only** was rejected because it removes useful live
meeting feedback.

**Automatically trust provider name mappings** was rejected because the
provider does not return per-identity confidence and a wrong name is more
damaging than an anonymous label.

**Continue silent batch fallback** was rejected because the resulting provider
and error behavior do not match the user's explicit transcription choice.

## References

- [Implementation specification](../specs/assemblyai-transcription-reliability.md)
- [Transcription domain language](../../../plugins/transcription/CONTEXT.md)
- [AssemblyAI streaming diarization](https://www.assemblyai.com/docs/streaming/label-speakers-and-separate-channels)
- [AssemblyAI Speaker Identification](https://www.assemblyai.com/docs/speech-understanding/speaker-identification)
- [AssemblyAI pre-recorded model selection](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model)
