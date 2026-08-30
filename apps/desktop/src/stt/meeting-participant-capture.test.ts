import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureMeetingParticipants: vi.fn(),
  persistObservedParticipants: vi.fn(() => Promise.resolve()),
}));

vi.mock("@anlg/plugin-detect", () => ({
  commands: {
    captureMeetingParticipants: mocks.captureMeetingParticipants,
  },
}));

vi.mock("~/session/queries", () => ({
  persistObservedParticipants: mocks.persistObservedParticipants,
}));

import { startMeetingParticipantCapture } from "./meeting-participant-capture";

describe("meeting participant capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.captureMeetingParticipants.mockResolvedValue({
      status: "ok",
      data: {
        app: { id: "us.zoom.xos", name: "Zoom" },
        platform: "zoom",
        surface: "native",
        participants: [
          { displayName: "Ada Lovelace" },
          { displayName: "Grace Hopper" },
        ],
        warnings: [],
      },
    });
  });

  it("persists only observed display names for the active session", async () => {
    const stop = startMeetingParticipantCapture({ sessionId: "session-1" });

    await vi.waitFor(() => {
      expect(mocks.persistObservedParticipants).toHaveBeenCalledWith(
        "session-1",
        ["Ada Lovelace", "Grace Hopper"],
      );
    });

    await stop();
  });

  it("degrades without touching persisted candidates when observation fails", async () => {
    mocks.captureMeetingParticipants.mockResolvedValueOnce({
      status: "error",
      error: "accessibility unavailable",
    });
    const stop = startMeetingParticipantCapture({ sessionId: "session-1" });

    await vi.waitFor(() => {
      expect(mocks.captureMeetingParticipants).toHaveBeenCalledOnce();
    });
    expect(mocks.persistObservedParticipants).not.toHaveBeenCalled();

    await stop();
  });
});
