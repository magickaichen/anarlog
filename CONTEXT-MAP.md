# Context Map

## Contexts

- **Transcription**: turns captured meeting audio into provisional and final
  transcripts with speaker attribution.
  - Domain language: [plugins/transcription/CONTEXT.md](./plugins/transcription/CONTEXT.md)
  - Decisions: [Two-stage AssemblyAI transcription](./plugins/transcription/docs/adr/0001-assemblyai-two-stage-transcription.md)
  - Owning paths:
    - `apps/desktop/src/stt/`
    - `apps/desktop/src/session/components/note-input/transcript/`
    - `crates/owhisper-client/src/adapter/`
    - `crates/owhisper-interface/`
    - `crates/transcript/`
    - `plugins/transcription/`
