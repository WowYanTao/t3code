import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  desktopDir,
  resolveElectronLaunchCommand,
} from "../apps/desktop/scripts/electron-launcher.mjs";

const __filename = NodeURL.fileURLToPath(import.meta.url);
const repoRoot = NodePath.resolve(NodePath.dirname(__filename), "..");
const mainEntryPath = NodePath.join(desktopDir, "dist-electron", "main.cjs");
const serverEntryPath = NodePath.join(repoRoot, "apps", "server", "dist", "bin.mjs");
const liveRuntimePath = NodePath.join(NodeOS.homedir(), ".t3", "userdata", "server-runtime.json");
const logPath = NodePath.join(NodeOS.tmpdir(), "t3code-restart-desktop.log");
const WINDOWS_TASK_NAME = "T3CodeRestartDesktopOnce";
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone restart script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function appendLog(message) {
  try {
    NodeFS.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Best-effort diagnostics only.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function readLiveServerPid() {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(liveRuntimePath, "utf8"));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function resolveWindowsParentDesktopPid(serverPid) {
  if (hostPlatform !== "win32" || !serverPid) return null;
  const psScript = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${serverPid}" -ErrorAction SilentlyContinue`,
    `if ($p -and $p.ParentProcessId) {`,
    `  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -ErrorAction SilentlyContinue`,
    `  if ($parent -and ($parent.Name -match '^(electron|T3 Code)' -or $parent.CommandLine -match 'dist-electron')) {`,
    `    Write-Output $parent.ProcessId`,
    `  }`,
    `}`,
  ].join("; ");
  const result = NodeChildProcess.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { encoding: "utf8", windowsHide: true },
  );
  const parsed = Number.parseInt((result.stdout ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requestGracefulClose(pid) {
  if (!isProcessAlive(pid)) return;
  if (hostPlatform === "win32") {
    const psScript = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`;
    NodeChildProcess.spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore if already exited.
  }
}

function forceKill(pid) {
  if (!isProcessAlive(pid)) return;
  if (hostPlatform === "win32") {
    NodeChildProcess.spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore if already exited.
  }
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return true;
    await sleep(200);
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

function makeCleanLaunchEnv() {
  const env = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "VITE_DEV_SERVER_URL",
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "T3CODE_PORT",
    "T3CODE_HOME",
    "T3CODE_MODE",
    "T3CODE_NO_BROWSER",
    "T3CODE_SINGLE_ORIGIN_DEV",
    "T3CODE_DESKTOP_WS_URL",
    "T3_SERVICE_LAUNCHER_CONTEXT",
    "T3_BOOT_SERVICE_UNIT",
  ]) {
    delete env[key];
  }
  return env;
}

function readArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function cleanupWindowsTask(vbsPath) {
  if (hostPlatform !== "win32") return;
  NodeChildProcess.spawnSync("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (vbsPath) {
    try {
      NodeFS.rmSync(vbsPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function launchWindowsDetachedViaTaskScheduler() {
  const vbsPath = NodePath.join(NodeOS.tmpdir(), `t3code-restart-${process.pid}.vbs`);
  const nodeExe = process.execPath.replaceAll('"', '""');
  const scriptPath = __filename.replaceAll('"', '""');
  const vbsArg = vbsPath.replaceAll('"', '""');
  // WScript.Shell.Run with window style 0 launches Node silently outside the parent Job Object.
  const vbsContent = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${nodeExe}"" ""${scriptPath}"" --detached --cleanup-vbs ""${vbsArg}""", 0, False`,
    "",
  ].join("\r\n");
  NodeFS.writeFileSync(vbsPath, vbsContent, "utf8");

  const taskCommand = `wscript.exe //B //Nologo "${vbsPath}"`;
  const createResult = NodeChildProcess.spawnSync(
    "schtasks.exe",
    ["/Create", "/TN", WINDOWS_TASK_NAME, "/TR", taskCommand, "/SC", "ONCE", "/ST", "00:00", "/F"],
    { encoding: "utf8", windowsHide: true },
  );
  if (createResult.status !== 0) {
    throw new Error(
      `schtasks /Create failed: ${(createResult.stderr || createResult.stdout || "").trim()}`,
    );
  }
  const runResult = NodeChildProcess.spawnSync("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK_NAME], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (runResult.status !== 0) {
    cleanupWindowsTask(vbsPath);
    throw new Error(`schtasks /Run failed: ${(runResult.stderr || runResult.stdout || "").trim()}`);
  }
}

async function runDetachedWorker() {
  const vbsPath = readArgValue("--cleanup-vbs");
  try {
    appendLog("detached restart worker started");
    await sleep(300);

    const serverPid = readLiveServerPid();
    const mainPid = resolveWindowsParentDesktopPid(serverPid);
    const targetPids = [...new Set([mainPid, serverPid].filter((pid) => pid !== null))];
    appendLog(`resolved targets: mainPid=${mainPid ?? "none"} serverPid=${serverPid ?? "none"}`);

    if (mainPid !== null) {
      requestGracefulClose(mainPid);
    } else if (serverPid !== null) {
      requestGracefulClose(serverPid);
    }

    if (targetPids.length > 0) {
      const exitedGracefully = await waitForExit(targetPids, 8_000);
      if (!exitedGracefully) {
        appendLog("graceful shutdown timed out; force stopping remaining target PIDs");
        for (const pid of targetPids) {
          forceKill(pid);
        }
        await waitForExit(targetPids, 5_000);
      }
      // Brief grace period for OS release of Electron single-instance lock and SQLite handles.
      await sleep(600);
    }

    const electronCommand = resolveElectronLaunchCommand(["dist-electron/main.cjs"]);
    appendLog(`launching ${electronCommand.electronPath} ${electronCommand.args.join(" ")}`);
    const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
      cwd: desktopDir,
      env: makeCleanLaunchEnv(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    appendLog(`spawned new desktop process pid=${child.pid ?? "unknown"}`);
  } finally {
    cleanupWindowsTask(vbsPath);
  }
}

function main() {
  if (process.argv.includes("--detached")) {
    void runDetachedWorker().catch((error) => {
      appendLog(`restart worker failed: ${error instanceof Error ? error.stack : String(error)}`);
      process.exit(1);
    });
    return;
  }

  if (!NodeFS.existsSync(mainEntryPath) || !NodeFS.existsSync(serverEntryPath)) {
    console.error(
      "未找到编译产物（apps/desktop/dist-electron/main.cjs 或 apps/server/dist/bin.mjs），请先运行“编译 Electron 桌面版”（vp run build:desktop）。",
    );
    process.exit(1);
  }

  NodeFS.writeFileSync(logPath, "");
  if (hostPlatform === "win32") {
    launchWindowsDetachedViaTaskScheduler();
  } else {
    const worker = NodeChildProcess.spawn(process.execPath, [__filename, "--detached"], {
      cwd: repoRoot,
      env: makeCleanLaunchEnv(),
      detached: true,
      stdio: "ignore",
    });
    worker.unref();
  }
  console.log("已触发重启：即将关闭当前 T3 Code 主力窗口，并自动启动编译后的最新版本...");
}

main();
