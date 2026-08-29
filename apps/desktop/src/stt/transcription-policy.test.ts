import { describe, expect, it } from "vitest";

import {
  formatTranscriptionTarget,
  resolveTranscriptionPolicy,
} from "./transcription-policy";

describe("resolveTranscriptionPolicy", () => {
  it("defaults an unconfigured session to English", () => {
    expect(
      resolveTranscriptionPolicy(null, {
        provider: "assemblyai",
        model: "universal-3-5-pro",
        languages: [],
      }),
    ).toEqual({
      provider: "assemblyai",
      model: "universal-3-5-pro",
      languages: ["en"],
    });
  });

  it("keeps the session-owned policy after global settings change", () => {
    expect(
      resolveTranscriptionPolicy(
        {
          provider: "assemblyai",
          model: "universal-3-5-pro",
          languages: ["en"],
        },
        {
          provider: "deepgram",
          model: "nova-3-general",
          languages: ["ko", "ja"],
        },
      ),
    ).toEqual({
      provider: "assemblyai",
      model: "universal-3-5-pro",
      languages: ["en"],
    });
  });

  it("preserves an explicit multilingual policy", () => {
    expect(
      resolveTranscriptionPolicy(
        {
          provider: "assemblyai",
          model: "universal-3-5-pro",
          languages: ["en-US", "es", "en"],
        },
        null,
      ),
    ).toEqual({
      provider: "assemblyai",
      model: "universal-3-5-pro",
      languages: ["en-US", "es"],
    });
  });
});

describe("formatTranscriptionTarget", () => {
  it("shows provider, model, and language before re-transcription", () => {
    expect(
      formatTranscriptionTarget({
        provider: "assemblyai",
        model: "universal-3-5-pro",
        languages: ["en"],
      }),
    ).toBe("assemblyai · universal-3-5-pro · en");
  });

  it("labels an explicit multilingual target", () => {
    expect(
      formatTranscriptionTarget({
        provider: "assemblyai",
        model: "universal-3-5-pro",
        languages: ["en", "es"],
      }),
    ).toBe("assemblyai · universal-3-5-pro · en + es");
  });
});
