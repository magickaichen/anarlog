# AssemblyAI transcription reliability and speaker identity

## Status

Published to GitHub Issues. The linked issues are the specification sources.

## Implementation order

1. [#1: Fix AssemblyAI live diarization events and word-level speakers](https://github.com/magickaichen/anarlog/issues/1)
2. [#2: Persist transcription targets and prevent re-transcription fallback](https://github.com/magickaichen/anarlog/issues/2)
3. [#3: Capture observed meeting participants as speaker candidates](https://github.com/magickaichen/anarlog/issues/3)
4. [#4: Automatically refine AssemblyAI live transcripts after meetings](https://github.com/magickaichen/anarlog/issues/4)
5. [#5: Add conservative AssemblyAI speaker identity suggestions](https://github.com/magickaichen/anarlog/issues/5)
6. [#6: Benchmark and QA the AssemblyAI transcription workflow](https://github.com/magickaichen/anarlog/issues/6)

Issues #1, #2, and #3 may proceed independently. Issue #4 depends on #1 and
#2. Issue #5 depends on #3 and #4. Issue #6 is the final gate after #1–#5.

The durable design decision remains in
[ADR 0001](../../../plugins/transcription/docs/adr/0001-assemblyai-two-stage-transcription.md).
