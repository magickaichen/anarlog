import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createInfoPlist,
  followMacOSAppOutput,
  getMacOSAppBundlePath,
  getMacOSOpenArgs,
} from "./dev-runner.mjs";

const runnerPath = resolve(process.cwd(), "scripts/dev-runner.mjs");

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

  it("removes temporary output after log forwarding stops", () => {
    const output = followMacOSAppOutput();

    expect(existsSync(output.paths.stdout)).toBe(true);
    expect(existsSync(output.paths.stderr)).toBe(true);

    output.stop();

    expect(existsSync(output.directory)).toBe(false);
  });

  it("cleans up when the guarded runner process is gone", async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "anarlog-guard-test-"));
    const guard = spawn(
      process.execPath,
      [
        runnerPath,
        "__guard_macos_app__",
        "2147483647",
        "/tmp/nonexistent/Anarlog Dev.app",
        outputDirectory,
      ],
      { stdio: "ignore" },
    );

    const [code] = await once(guard, "exit");

    expect(code).toBe(0);
    expect(existsSync(outputDirectory)).toBe(false);
  });
});
