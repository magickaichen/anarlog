import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { beginCloudsyncActivity, endCloudsyncActivity } from "@anlg/plugin-db";

const mocks = vi.hoisted(() => ({
  audioPath: vi.fn(),
  handleBatchFailed: vi.fn(),
  queueAutoEnhanceIfSummaryEmpty: vi.fn(),
  runBatch: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  latestTarget: vi.fn(),
  session: vi.fn(),
  useRunBatch: vi.fn(),
}));

vi.mock("@anlg/plugin-fs-sync", () => ({
  commands: { audioPath: mocks.audioPath },
}));

vi.mock("@anlg/ui/components/ui/toast", () => ({
  sonnerToast: { error: mocks.toastError, info: mocks.toastInfo },
}));

vi.mock("~/session/queries", () => ({
  useSession: mocks.session,
}));

vi.mock("~/services/enhancer", () => ({
  getEnhancerService: () => ({
    queueAutoEnhanceIfSummaryEmpty: mocks.queueAutoEnhanceIfSummaryEmpty,
  }),
}));

vi.mock("~/stt/contexts", () => ({
  useListener: (selector: (state: unknown) => unknown) =>
    selector({ handleBatchFailed: mocks.handleBatchFailed }),
}));

vi.mock("~/stt/useRunBatch", () => ({
  isStoppedTranscriptionError: (error: unknown) =>
    error instanceof Error && error.message === "Transcription stopped.",
  useRunBatch: mocks.useRunBatch,
}));

vi.mock("~/stt/queries", () => ({
  useLatestSessionTranscriptTarget: mocks.latestTarget,
}));

import { useRegenerateTranscript } from "./actions";

describe("useRegenerateTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const target = {
      provider: "assemblyai",
      model: "universal-3-pro",
      languages: ["en"],
      providerModel: "universal-3-pro",
    };
    mocks.latestTarget.mockReturnValue(target);
    mocks.session.mockReturnValue({ transcription: null });
    mocks.useRunBatch.mockReturnValue(mocks.runBatch);
    mocks.audioPath.mockResolvedValue({
      status: "ok",
      data: "/tmp/session.wav",
    });
  });

  it("shows and reuses the current final transcript target", async () => {
    mocks.runBatch.mockResolvedValue(undefined);
    const target = mocks.latestTarget();
    const { result } = renderHook(() => useRegenerateTranscript("session-1"));

    expect(mocks.useRunBatch).toHaveBeenCalledWith("session-1", target);
    await act(async () => {
      await result.current();
    });

    expect(mocks.toastInfo).toHaveBeenCalledWith("Re-transcription started", {
      description: "assemblyai · universal-3-pro · en",
    });
    expect(mocks.toastInfo.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runBatch.mock.invocationCallOrder[0]!,
    );
  });

  it("shows batch transcription failures even when an old transcript exists", async () => {
    mocks.runBatch.mockRejectedValue(new Error("Authentication failed"));
    const { result } = renderHook(() => useRegenerateTranscript("session-1"));

    await act(async () => {
      await result.current();
    });

    expect(mocks.runBatch).toHaveBeenCalledWith("/tmp/session.wav", {
      promotion: { scope: "whole_session" },
    });
    expect(mocks.handleBatchFailed).toHaveBeenCalledWith(
      "session-1",
      "Authentication failed",
    );
    expect(mocks.toastError).toHaveBeenCalledWith("Re-transcription failed", {
      id: "transcript-regenerate-failed-session-1",
      description: "Authentication failed",
    });
  });

  it("keeps CloudSync deferred until summary scheduling settles", async () => {
    let finishSummaryScheduling: (() => void) | undefined;
    mocks.runBatch.mockResolvedValue(undefined);
    mocks.queueAutoEnhanceIfSummaryEmpty.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSummaryScheduling = resolve;
      }),
    );
    const { result } = renderHook(() => useRegenerateTranscript("session-1"));

    const regeneration = result.current();
    await waitFor(() => {
      expect(mocks.queueAutoEnhanceIfSummaryEmpty).toHaveBeenCalledWith(
        "session-1",
      );
    });

    expect(beginCloudsyncActivity).toHaveBeenCalledWith(
      "transcription",
      expect.stringMatching(/^session-1:retranscription:/),
    );
    expect(endCloudsyncActivity).not.toHaveBeenCalled();

    finishSummaryScheduling?.();
    await act(async () => {
      await regeneration;
    });
    expect(endCloudsyncActivity).toHaveBeenCalledWith(
      "transcription",
      vi.mocked(beginCloudsyncActivity).mock.calls[0]?.[1],
    );
  });
});
