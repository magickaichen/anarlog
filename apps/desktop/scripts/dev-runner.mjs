#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const appIdentifier = "com.hyprnote.dev";
const appName = "Anarlog Dev";
const executableName = "anarlog-dev";
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}

export function getMacOSAppBundlePath(
  cacheDirectory = join(homedir(), "Library", "Caches"),
) {
  return join(cacheDirectory, appIdentifier, `${appName}.app`);
}

export function getMacOSOpenArgs(appBundle, args, output) {
  return [
    "-n",
    "-W",
    "--stdout",
    output.stdout,
    "--stderr",
    output.stderr,
    appBundle,
    "--args",
    ...args,
  ];
}

export function createInfoPlist(baseInfoPlist) {
  const bundleMetadata = `
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleDisplayName</key>
    <string>${appName}</string>
    <key>CFBundleExecutable</key>
    <string>${executableName}</string>
    <key>CFBundleIdentifier</key>
    <string>${appIdentifier}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${appName}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.0.0</string>
    <key>CFBundleVersion</key>
    <string>0.0.0</string>
    <key>CSResourcesFileMapped</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>15.0</string>
    <key>LSRequiresCarbon</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>`;

  return baseInfoPlist.replace("  <dict>", `  <dict>${bundleMetadata}`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    console.error("Expected a Cargo command or Tauri application binary path.");
    process.exit(1);
  }

  if (command === "__guard_macos_app__") {
    guardMacOSApp(Number(args[0]), args[1], args[2]);
    return;
  }

  if (command === "run" || command === "build") {
    const cargoArgs = [];
    if (command === "run" && process.platform === "darwin") {
      cargoArgs.push(
        "--config",
        `target.'cfg(target_os = "macos")'.runner = [${JSON.stringify(scriptPath)}]`,
      );
    }
    cargoArgs.push(command, ...args);
    runChild("cargo", cargoArgs, {
      onSignal:
        process.platform === "darwin"
          ? () => terminateMacOSApp(getMacOSAppBundlePath())
          : undefined,
    });
    return;
  }

  if (process.platform === "darwin") {
    const appBundle = prepareMacOSAppBundle(command);
    const output = followMacOSAppOutput();
    startMacOSAppGuard(appBundle, output.directory);
    runChild("/usr/bin/open", getMacOSOpenArgs(appBundle, args, output.paths), {
      onExit: output.stop,
      onSignal: () => {
        output.stop();
        terminateMacOSApp(appBundle);
      },
    });
    return;
  }

  runChild(command, args);
}

function prepareMacOSAppBundle(binary) {
  const appBundle = getMacOSAppBundlePath();
  const contentsDirectory = join(appBundle, "Contents");
  const executableDirectory = join(contentsDirectory, "MacOS");
  const resourcesDirectory = join(contentsDirectory, "Resources");
  const targetDirectory = dirname(binary);
  const sourceDirectory = resolve(scriptDirectory, "../src-tauri");

  mkdirSync(executableDirectory, { recursive: true });
  mkdirSync(resourcesDirectory, { recursive: true });

  copyFile(binary, join(executableDirectory, executableName));
  copyFile(
    join(targetDirectory, "check-permissions"),
    join(executableDirectory, "check-permissions"),
  );

  for (const resource of ["CabinSketch-OFL.txt", "CabinSketch-Regular.ttf"]) {
    copyFile(
      join(targetDirectory, resource),
      join(resourcesDirectory, resource),
    );
  }

  copyDirectory(
    join(targetDirectory, "icons"),
    join(resourcesDirectory, "icons"),
  );
  copyDirectory(
    join(targetDirectory, "notification-icons"),
    join(resourcesDirectory, "notification-icons"),
  );
  copyFile(
    join(targetDirectory, "mlx.metallib"),
    join(resourcesDirectory, "mlx-swift_Cmlx.bundle", "default.metallib"),
  );
  copyFile(
    join(sourceDirectory, "resources/dev/AppIcon.icns"),
    join(resourcesDirectory, "AppIcon.icns"),
  );
  copyFile(
    join(sourceDirectory, "icons/dev/icon.icns"),
    join(resourcesDirectory, "icon.icns"),
  );

  const baseInfoPlist = readFileSync(
    join(sourceDirectory, "Info.plist"),
    "utf8",
  );
  writeFileSync(
    join(contentsDirectory, "Info.plist"),
    createInfoPlist(baseInfoPlist),
  );

  signAppBundle(appBundle);
  return appBundle;
}

function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      copyFile(sourcePath, destinationPath);
    }
  }
}

function copyFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, constants.COPYFILE_FICLONE);
}

function signAppBundle(appBundle) {
  const entitlements = resolve(
    scriptDirectory,
    "../src-tauri/Entitlements.plist",
  );
  const sidecar = join(appBundle, "Contents", "MacOS", "check-permissions");
  const sidecarSigning = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--identifier", "check-permissions", sidecar],
    { stdio: "inherit" },
  );

  if (sidecarSigning.status !== 0) {
    process.exit(sidecarSigning.status ?? 1);
  }

  const signing = spawnSync(
    "codesign",
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      appIdentifier,
      "--requirements",
      `=designated => identifier "${appIdentifier}"`,
      "--entitlements",
      entitlements,
      appBundle,
    ],
    { stdio: "inherit" },
  );

  if (signing.status !== 0) {
    process.exit(signing.status ?? 1);
  }
}

function terminateMacOSApp(appBundle) {
  const executable = join(appBundle, "Contents", "MacOS", executableName);
  const escapedExecutable = executable.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  spawnSync("/usr/bin/pkill", ["-TERM", "-f", `^${escapedExecutable}( |$)`]);
}

function startMacOSAppGuard(appBundle, outputDirectory) {
  const guard = spawn(
    process.execPath,
    [
      scriptPath,
      "__guard_macos_app__",
      String(process.pid),
      appBundle,
      outputDirectory,
    ],
    { detached: true, stdio: "ignore" },
  );
  guard.unref();
}

function guardMacOSApp(parentPid, appBundle, outputDirectory) {
  const interval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(interval);
      terminateMacOSApp(appBundle);
      rmSync(outputDirectory, { force: true, recursive: true });
      process.exit(0);
    }
  }, 250);
}

function followMacOSAppOutput() {
  const outputDirectory = mkdtempSync(join(tmpdir(), "anarlog-dev-"));
  const paths = {
    stderr: join(outputDirectory, "dev-runner.stderr.log"),
    stdout: join(outputDirectory, "dev-runner.stdout.log"),
  };

  writeFileSync(paths.stdout, "");
  writeFileSync(paths.stderr, "");

  const followers = [
    spawn("/usr/bin/tail", ["-n", "0", "-F", paths.stdout], {
      stdio: ["ignore", "inherit", "inherit"],
    }),
    spawn("/usr/bin/tail", ["-n", "0", "-F", paths.stderr], {
      stdio: ["ignore", "inherit", "inherit"],
    }),
  ];

  return {
    directory: outputDirectory,
    paths,
    stop: () => {
      for (const follower of followers) {
        follower.kill();
      }
      rmSync(outputDirectory, { force: true, recursive: true });
    },
  };
}

function runChild(executable, childArgs, { onExit, onSignal } = {}) {
  const child = spawn(executable, childArgs, { stdio: "inherit" });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      onSignal?.();
      child.kill(signal);
    });
  }

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    onExit?.();
    if (signal) {
      process.exit(signalExitCodes[signal] ?? 1);
      return;
    }

    process.exit(code ?? 1);
  });
}
