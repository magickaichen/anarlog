import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: null as null | {
    enabled?: boolean;
    mapRows?: (rows: Array<Record<string, unknown>>) => unknown;
    params?: unknown[];
    sql: string;
  },
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("~/db", () => ({
  executeTransaction: vi.fn(),
  liveQueryClient: { execute: vi.fn() },
  useLiveQuery: (options: {
    enabled?: boolean;
    mapRows?: (rows: Array<Record<string, unknown>>) => unknown;
    params?: unknown[];
    sql: string;
  }) => {
    mocks.options = options;
    return {
      data:
        options.enabled === false
          ? undefined
          : (options.mapRows?.(mocks.rows) ?? mocks.rows),
    };
  },
}));

import { useSessionSpeakerCandidates } from "./participants";

describe("session speaker candidates", () => {
  beforeEach(() => {
    mocks.options = null;
    mocks.rows = [];
  });

  it("keeps calendar and manual candidates when no participant was observed", () => {
    mocks.rows = [
      {
        id: "calendar",
        human_id: "human-1",
        source: "auto",
        name: "Grace Hopper",
      },
      {
        id: "manual",
        human_id: "human-2",
        source: "manual",
        name: "Linus Torvalds",
      },
    ];

    const { result } = renderHook(() =>
      useSessionSpeakerCandidates("session-1"),
    );

    expect(result.current).toEqual([
      { humanId: "human-1", name: "Grace Hopper", source: "calendar" },
      { humanId: "human-2", name: "Linus Torvalds", source: "manual" },
    ]);
  });

  it("prefers observed candidates and exposes no unrelated metadata", () => {
    mocks.rows = [
      {
        id: "observed",
        human_id: "human-1",
        source: "observed",
        name: "Ada Lovelace",
      },
      {
        id: "calendar",
        human_id: "human-1",
        source: "auto",
        name: "Ada Lovelace",
      },
      {
        id: "email-only",
        human_id: "human-2",
        source: "auto",
        name: "private@example.com",
      },
      { id: "empty", human_id: "", source: "manual", name: "" },
    ];

    const { result } = renderHook(() =>
      useSessionSpeakerCandidates("session-1"),
    );

    expect(result.current).toEqual([
      { humanId: "human-1", name: "Ada Lovelace", source: "observed" },
    ]);
    expect(Object.keys(result.current[0] ?? {}).sort()).toEqual([
      "humanId",
      "name",
      "source",
    ]);
    expect(mocks.options?.sql).not.toContain("email");
    expect(mocks.options?.sql).not.toContain("metadata_json");
  });

  it("keeps a known identity when an anonymous observation has the same name", () => {
    mocks.rows = [
      {
        id: "observed",
        human_id: "",
        source: "observed",
        name: "Ada Lovelace",
      },
      {
        id: "calendar",
        human_id: "human-1",
        source: "auto",
        name: "Ada Lovelace",
      },
    ];

    const { result } = renderHook(() =>
      useSessionSpeakerCandidates("session-1"),
    );

    expect(result.current).toEqual([
      { humanId: "human-1", name: "Ada Lovelace", source: "observed" },
    ]);
  });
});
