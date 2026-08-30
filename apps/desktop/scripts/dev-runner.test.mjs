import { describe, expect, it } from "vitest";

import {
  createInfoPlist,
  getMacOSAppBundlePath,
  getMacOSOpenArgs,
} from "./dev-runner.mjs";

describe("macOS dev runner", () => {
  it("builds a stable app bundle outside protected user folders", () => {
    expect(getMacOSAppBundlePath("/tmp/cache")).toBe(
      "/tmp/cache/com.hyprnote.dev/Anarlog Dev.app",
    );
  });

  it("launches through LaunchServices while forwarding output", () => {
    expect(
      getMacOSOpenArgs("/tmp/Anarlog Dev.app", ["--flag"], {
        stderr: "/tmp/dev.stderr.log",
        stdout: "/tmp/dev.stdout.log",
      }),
    ).toEqual([
      "-n",
      "-W",
      "--stdout",
      "/tmp/dev.stdout.log",
      "--stderr",
      "/tmp/dev.stderr.log",
      "/tmp/Anarlog Dev.app",
      "--args",
      "--flag",
    ]);
  });

  it("adds the dev app identity without dropping permission descriptions", () => {
    const plist = createInfoPlist(`<?xml version="1.0"?>
<plist version="1.0">
  <dict>
    <key>NSAudioCaptureUsageDescription</key>
    <string>Capture system audio.</string>
  </dict>
</plist>`);

    expect(plist).toContain("<string>com.hyprnote.dev</string>");
    expect(plist).toContain("<string>Anarlog Dev</string>");
    expect(plist).toContain("<string>anarlog-dev</string>");
    expect(plist).toContain("<key>NSAudioCaptureUsageDescription</key>");
    expect(plist).toContain("<string>Capture system audio.</string>");
  });
});
