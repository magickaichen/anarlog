import { render, waitFor } from "@testing-library/react";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { DatabaseSync } = process.getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");
const database = vi.hoisted(() => ({
  current: null as DatabaseSyncType | null,
  failPromotion: false,
}));
const provider = vi.hoisted(() => ({ ready: false, transcribe: vi.fn() }));
let directory: string;

vi.mock("~/db", () => ({
  useLiveQuery: ({ sql, params = [], mapRows }: any) => ({
    data: mapRows(database.current!.prepare(sql).all(...params)),
  }),
  liveQueryClient: {
    execute: async (sql: string, params: any[] = []) =>
      database.current!.prepare(sql).all(...params),
  },
  executeTransaction: async (
    statements: Array<{
      sql: string;
      params: any[];
      expectedRowsAffected?: number;
    }>,
  ) => {
    const db = database.current!;
    if (
      database.failPromotion &&
      statements.some((statement) =>
        statement.sql.includes("INSERT INTO transcripts"),
      )
    )
      throw new Error("disk full");
    db.exec("BEGIN");
    try {
      const result = statements.map(({ sql, params, expectedRowsAffected }) => {
        const changes = Number(db.prepare(sql).run(...params).changes);
        if (
          expectedRowsAffected !== undefined &&
          changes !== expectedRowsAffected
        ) {
          throw new Error("Unexpected rows affected");
        }
        return changes;
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
}));

vi.mock("./useRunBatch", () => ({ useRunBatch: () => provider.transcribe }));
vi.mock("./contexts", () => ({ useListener: () => "inactive" }));
vi.mock("~/settings/providers", () => ({
  useAiProvidersState: () => ({ isReady: provider.ready }),
}));
vi.mock("~/shared/config", () => ({ useConfigValue: () => false }));
vi.mock("~/session/attachments", () => ({
  markSessionAudioTranscriptionComplete: vi.fn(),
}));
vi.mock("~/services/audio-retention", () => ({
  normalizeAudioRetention: () => "forever",
  deleteProcessedAudioForRetention: vi.fn(),
}));
vi.mock("~/services/voiceprint", () => ({
  maybeExtractVoiceprintCandidates: vi.fn(),
}));
vi.mock("~/services/enhancer", () => ({ getEnhancerService: () => null }));

import {
  createTranscript,
  getTranscriptRecord,
  updateTranscriptSegmentText,
} from "./queries";
import {
  getTranscriptRefinement,
  scheduleTranscriptRefinement,
  runTranscriptRefinement,
  retryTranscriptRefinement,
  getTranscriptRefinementReview,
  confirmTranscriptRefinement,
  finishTranscriptRefinement,
} from "./refinement";
import { TranscriptRefinementLifecycle } from "./refinement-lifecycle";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anarlog-refinement-test-"));
  database.current = new DatabaseSync(join(directory, "app.db"));
  database.failPromotion = false;
  provider.ready = false;
  provider.transcribe.mockReset();
  for (const name of [
    "20260710223922_canonical_data_model",
    "20260815100000_transcript_content_revision",
    "20260815100100_transcript_live_deltas",
    "20260829100100_transcript_transcription_target",
    "20260903100000_transcript_refinement_jobs",
  ]) {
    database.current.exec(
      readFileSync(`../../crates/db-app/migrations/${name}.sql`, "utf8"),
    );
  }
  database.current.exec("INSERT INTO sessions (id) VALUES ('meeting-1')");
});

afterEach(() => {
  database.current?.close();
  rmSync(directory, { recursive: true });
});

function reopenDatabase() {
  database.current!.close();
  database.current = new DatabaseSync(join(directory, "app.db"));
}

test("a finalized AssemblyAI recording creates a durable pending refinement with its original language and keywords", async () => {
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/meeting-1.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["es"],
    keywords: ["Anarlog"],
  });

  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    id: "live-1",
    sessionId: "meeting-1",
    status: "pending",
    attempts: 0,
    input: {
      audioPath: "/recordings/meeting-1.wav",
      target: {
        provider: "assemblyai",
        model: "universal-3-5-pro",
        languages: ["es"],
      },
      keywords: ["Anarlog"],
    },
  });
});

test("three transient failures exhaust the durable budget even when each attempt reloads the job", async () => {
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["en"],
    keywords: [],
  });
  const transcribe = vi.fn(async () => {
    throw new Error("503 Service unavailable");
  });
  await runTranscriptRefinement("live-1", transcribe);
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "pending",
    attempts: 1,
  });
  reopenDatabase();
  await runTranscriptRefinement("live-1", transcribe);
  reopenDatabase();
  await runTranscriptRefinement("live-1", transcribe);
  await runTranscriptRefinement("live-1", transcribe);
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "failed",
    attempts: 3,
    error: "503 Service unavailable",
  });
  expect(transcribe).toHaveBeenCalledTimes(3);
});

test("an authentication failure waits for an explicit retry and keeps the recorded target", async () => {
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["es"],
    keywords: ["Anarlog"],
  });
  const transcribe = vi.fn(async () => {
    throw new Error("401 Unauthorized");
  });
  await runTranscriptRefinement("live-1", transcribe);
  await runTranscriptRefinement("live-1", transcribe);
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "failed",
    attempts: 1,
  });
  reopenDatabase();
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "failed",
    attempts: 1,
  });
  expect(transcribe).toHaveBeenCalledTimes(1);
  await retryTranscriptRefinement("live-1");
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "pending",
    attempts: 0,
    input: {
      target: {
        provider: "assemblyai",
        model: "universal-3-5-pro",
        languages: ["es"],
      },
    },
  });
});

test("untouched live text is atomically promoted to the completed refinement", async () => {
  await createTranscript({
    id: "live-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [{ id: "w1", text: "helo", start_ms: 0, end_ms: 400, channel: 1 }],
  });
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["en"],
    keywords: [],
  });
  await runTranscriptRefinement("live-1", async () => ({
    id: "batch-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [{ id: "b1", text: "Hello.", start_ms: 0, end_ms: 400, channel: 1 }],
    speakerHints: [],
  }));
  expect(await getTranscriptRecord("batch-1")).toMatchObject({
    words: [{ text: "Hello." }],
  });
  expect(await getTranscriptRecord("live-1")).toBeNull();
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "succeeded",
  });
});

test("text edited during refinement stays readable until the displayed difference is confirmed", async () => {
  await createTranscript({
    id: "live-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [{ id: "w1", text: "helo", start_ms: 0, end_ms: 400, channel: 1 }],
  });
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["en"],
    keywords: [],
  });
  await runTranscriptRefinement("live-1", async () => {
    await updateTranscriptSegmentText({
      transcriptId: "live-1",
      wordIds: ["w1"],
      text: "Hi Mike",
    });
    return {
      id: "batch-1",
      sessionId: "meeting-1",
      ownerUserId: "",
      createdAt: "2026-09-03",
      startedAt: 1000,
      words: [
        { id: "b1", text: "Hello.", start_ms: 0, end_ms: 400, channel: 1 },
      ],
      speakerHints: [],
    };
  });
  expect(await getTranscriptRecord("live-1")).toMatchObject({
    words: [{ text: "Hi Mike" }],
  });
  expect(await getTranscriptRecord("batch-1")).toBeNull();
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "awaiting_confirmation",
  });
  const review = await getTranscriptRefinementReview("live-1");
  expect(review).toMatchObject({ before: "Hi Mike", after: "Hello." });
  const current = await getTranscriptRecord("live-1");
  await updateTranscriptSegmentText({
    transcriptId: "live-1",
    wordIds: current!.words.map((word) => word.id),
    text: "My latest correction",
  });
  await expect(
    confirmTranscriptRefinement("live-1", review!.revision),
  ).rejects.toThrow("The transcript changed");
  expect(await getTranscriptRecord("batch-1")).toBeNull();
  const updatedReview = await getTranscriptRefinementReview("live-1");
  await confirmTranscriptRefinement("live-1", updatedReview!.revision);
  expect(await getTranscriptRecord("batch-1")).toMatchObject({
    words: [{ text: "Hello." }],
  });
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "succeeded",
  });
});

test.each(["user_speaker_assignment", "automatic_speaker_assignment"] as const)(
  "confirmed %s identities survive changed batch cluster labels without confirming inferred identities",
  async (assignmentType) => {
    const provenance =
      assignmentType === "automatic_speaker_assignment"
        ? { source: "voiceprint" }
        : {};
    await createTranscript({
      id: "live-1",
      sessionId: "meeting-1",
      ownerUserId: "",
      createdAt: "2026-09-03",
      startedAt: 1000,
      words: [
        { id: "w1", text: "Hello", start_ms: 0, end_ms: 400, channel: 1 },
      ],
      speakerHints: [
        {
          id: "p1",
          word_id: "w1",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 4 }),
        },
        {
          id: "u1",
          word_id: "w1",
          type: assignmentType,
          value: JSON.stringify({
            human_id: "alice",
            scope: "speaker",
            channel: 1,
            speaker_index: 4,
            ...provenance,
          }),
        },
        {
          id: "a1",
          word_id: "w1",
          type: "automatic_speaker_assignment",
          value: JSON.stringify({ human_id: "bob" }),
        },
      ],
    });
    await scheduleTranscriptRefinement({
      sessionId: "meeting-1",
      transcriptId: "live-1",
      audioPath: "/recordings/a.wav",
      audioOffsetMs: 0,
      startedAt: 1000,
      languages: ["en"],
      keywords: [],
    });
    await runTranscriptRefinement("live-1", async () => ({
      id: "batch-1",
      sessionId: "meeting-1",
      ownerUserId: "",
      createdAt: "2026-09-03",
      startedAt: 1000,
      words: [
        { id: "b1", text: "Hello.", start_ms: 0, end_ms: 400, channel: 1 },
      ],
      speakerHints: [
        {
          id: "bp1",
          word_id: "b1",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 0 }),
        },
      ],
    }));
    const transcript = await getTranscriptRecord("batch-1");
    expect(
      transcript?.speakerHints
        .filter((hint) => hint.type === assignmentType)
        .map((hint) => JSON.parse(hint.value)),
    ).toEqual([
      {
        human_id: "alice",
        scope: "speaker",
        channel: 1,
        speaker_index: 4,
        ...provenance,
      },
    ]);
  },
);

test("a persisted candidate survives restart and can be retried without a second paid provider request", async () => {
  await createTranscript({
    id: "live-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [{ id: "w1", text: "helo", start_ms: 0, end_ms: 400, channel: 1 }],
  });
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["en"],
    keywords: [],
  });
  const transcribe = vi.fn(async () => ({
    id: "batch-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [{ id: "b1", text: "Hello.", start_ms: 0, end_ms: 400, channel: 1 }],
    speakerHints: [],
  }));
  database.failPromotion = true;
  await runTranscriptRefinement("live-1", transcribe);
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "failed",
    candidate: { id: "batch-1" },
  });
  expect(await getTranscriptRecord("live-1")).toMatchObject({
    words: [{ text: "helo" }],
  });
  reopenDatabase();
  database.failPromotion = false;
  await retryTranscriptRefinement("live-1");
  await runTranscriptRefinement("live-1", transcribe);
  expect(transcribe).toHaveBeenCalledOnce();
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "succeeded",
    attempts: 1,
  });
});

test("an ambiguous batch cluster cannot inherit a confirmed identity just by reusing its numeric label", async () => {
  await createTranscript({
    id: "live-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [
      { id: "w1", text: "Alice", start_ms: 0, end_ms: 400, channel: 1 },
      { id: "w2", text: "Bob", start_ms: 400, end_ms: 800, channel: 1 },
    ],
    speakerHints: [
      {
        id: "p1",
        word_id: "w1",
        type: "provider_speaker_index",
        value: JSON.stringify({ channel: 1, speaker_index: 0 }),
      },
      {
        id: "p2",
        word_id: "w2",
        type: "provider_speaker_index",
        value: JSON.stringify({ channel: 1, speaker_index: 1 }),
      },
      {
        id: "u1",
        word_id: "w1",
        type: "user_speaker_assignment",
        value: JSON.stringify({
          human_id: "alice",
          scope: "speaker",
          channel: 1,
          speaker_index: 0,
        }),
      },
    ],
  });
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["en"],
    keywords: [],
  });
  await runTranscriptRefinement("live-1", async () => ({
    id: "batch-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [
      { id: "b1", text: "Alice.", start_ms: 0, end_ms: 400, channel: 1 },
      { id: "b2", text: "Bob.", start_ms: 400, end_ms: 800, channel: 1 },
    ],
    speakerHints: ["b1", "b2"].map((id) => ({
      id: `${id}:p`,
      word_id: id,
      type: "provider_speaker_index" as const,
      value: JSON.stringify({ channel: 1, speaker_index: 0 }),
    })),
  }));
  const transcript = await getTranscriptRecord("batch-1");
  expect(
    transcript?.speakerHints
      .filter((hint) => hint.type === "user_speaker_assignment")
      .map((hint) => JSON.parse(hint.value)),
  ).toEqual([{ human_id: "alice", scope: "segment", word_ids: ["b1"] }]);
});

test("successful refinement completion is recoverable and idempotent after restart", async () => {
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["en"],
    keywords: [],
  });
  await runTranscriptRefinement("live-1", async () => ({
    id: "batch-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [{ id: "b1", text: "Hello.", start_ms: 0, end_ms: 400, channel: 1 }],
    speakerHints: [],
  }));
  reopenDatabase();
  const finalize = vi.fn(async () => {});
  await finishTranscriptRefinement("live-1", finalize);
  reopenDatabase();
  await finishTranscriptRefinement("live-1", finalize);
  expect(finalize).toHaveBeenCalledOnce();
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "succeeded",
    finalized: true,
  });
});

test("the restart worker waits for Keychain hydration before resuming a durable pending job", async () => {
  await scheduleTranscriptRefinement({
    sessionId: "meeting-1",
    transcriptId: "live-1",
    audioPath: "/recordings/a.wav",
    audioOffsetMs: 0,
    startedAt: 1000,
    languages: ["en"],
    keywords: [],
  });
  reopenDatabase();
  provider.transcribe.mockResolvedValue({
    id: "batch-1",
    sessionId: "meeting-1",
    ownerUserId: "",
    createdAt: "2026-09-03",
    startedAt: 1000,
    words: [{ id: "b1", text: "Hello.", start_ms: 0, end_ms: 400, channel: 1 }],
    speakerHints: [],
  });
  const view = render(createElement(TranscriptRefinementLifecycle));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(provider.transcribe).not.toHaveBeenCalled();
  expect(await getTranscriptRefinement("live-1")).toMatchObject({
    status: "pending",
    attempts: 0,
  });
  provider.ready = true;
  view.rerender(createElement(TranscriptRefinementLifecycle));
  await waitFor(async () =>
    expect(await getTranscriptRefinement("live-1")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    }),
  );
  expect(provider.transcribe).toHaveBeenCalledOnce();
  view.unmount();
});
