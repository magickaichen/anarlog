import { describe, expect, it } from "vitest";

import { getMeetingLanguageOptions } from "./meeting-language-options";

describe("getMeetingLanguageOptions", () => {
  it("offers explicit single-language choices and one multilingual choice", () => {
    expect(
      getMeetingLanguageOptions(["en-US", "es", "en"], ["fr", "es"]),
    ).toEqual([
      { languages: ["en-US"], multilingual: false },
      { languages: ["es"], multilingual: false },
      { languages: ["fr"], multilingual: false },
    ]);
  });

  it("defaults a meeting to English", () => {
    expect(getMeetingLanguageOptions([], [])).toEqual([
      { languages: ["en"], multilingual: false },
    ]);
  });
});
