import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";

const START_TIMEOUT_MS = 90_000;
const desktopDir = process.cwd();
const rootDir = path.resolve(desktopDir, "../..");
const require = createRequire(path.join(desktopDir, "package.json"));
const electronPath = require("electron") as string;
const execFileAsync = promisify(execFile);

export interface RealElectronRenderer {
  page: Page;
  stop(): Promise<void>;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to reserve a local port"));
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForPort(port: number, child: ChildProcess, logPath: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron exited before CDP became ready; see ${logPath}`);
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for Electron CDP on port ${port}; see ${logPath}`);
}

async function waitForAppPage(browser: Browser, expoPort: number): Promise<Page> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes(`:${expoPort}`)) return page;
      }
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the real Electron renderer");
}

async function waitForAppTarget(
  cdpPort: number,
  expoPort: number,
  child: ChildProcess,
  logPath: string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron exited before its renderer became ready; see ${logPath}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      const targets = (await response.json()) as Array<{ url?: string }>;
      if (targets.some((target) => target.url?.includes(`:${expoPort}`))) return;
    } catch {
      // CDP can accept connections before the first renderer target exists.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for the Electron renderer target; see ${logPath}`);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isProcessTreeRunning(child: ChildProcess): boolean {
  if (!child.pid) return !hasExited(child);
  if (process.platform === "win32") return !hasExited(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function signalProcessTree(child: ChildProcess, force: boolean): Promise<void> {
  if (!isProcessTreeRunning(child)) return;
  if (!child.pid) throw new Error("Cannot stop a child process without a pid");
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])]);
    } else {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // The process may exit between the liveness check and signal delivery.
  }
}

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeRunning(child)) return true;
    await delay(100);
  }
  return !isProcessTreeRunning(child);
}

async function stopProcessTree(child: ChildProcess, label: string): Promise<void> {
  if (!isProcessTreeRunning(child)) return;
  await signalProcessTree(child, false);
  if (await waitForProcessTreeExit(child, 5_000)) return;
  await signalProcessTree(child, true);
  if (await waitForProcessTreeExit(child, 5_000)) return;
  throw new Error(`${label} did not exit after forced termination`);
}

export async function startRealElectronRenderer(input: {
  daemonPort: number;
  metroPort: number;
  paseoHome: string;
  artifactDir: string;
}): Promise<RealElectronRenderer> {
  mkdirSync(input.artifactDir, { recursive: true });
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "paseo-operations-electron-"));
  const cdpPort = await reservePort();
  const origin = `http://localhost:${input.metroPort}`;
  const logPath = path.join(input.artifactDir, "real-electron.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const listen = `127.0.0.1:${input.daemonPort}`;
  const commonEnv = {
    ...process.env,
    PASEO_HOME: input.paseoHome,
    PASEO_LISTEN: listen,
    PASEO_DAEMON_ENDPOINT: `localhost:${input.daemonPort}`,
    PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    PASEO_NODE_ENV: "development",
    EXPO_PORT: String(input.metroPort),
    EXPO_DEV_URL: origin,
    PASEO_ELECTRON_REMOTE_DEBUGGING_PORT: String(cdpPort),
    PASEO_ELECTRON_USER_DATA_DIR: path.join(runtimeDir, "user-data"),
    PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const cleanupRuntime = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const processes = [{ child, label: "Electron" }].filter(
        (entry): entry is { child: ChildProcess; label: string } => entry.child !== null,
      );
      const results = await Promise.allSettled(
        processes.map((entry) => stopProcessTree(entry.child, entry.label)),
      );
      for (const entry of processes) {
        entry.child.stdout?.unpipe(log);
        entry.child.stderr?.unpipe(log);
      }
      log.end();
      await finished(log).catch(() => undefined);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Failed to stop real Electron test processes; see ${logPath}`,
        );
      }
      rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })();
    return cleanupPromise;
  };
  try {
    const electronArgs = [...(process.platform === "linux" ? ["--no-sandbox"] : []), desktopDir];
    const command = process.platform === "linux" ? "xvfb-run" : electronPath;
    const args =
      process.platform === "linux"
        ? ["-a", "--server-args=-screen 0 1280x900x24", electronPath, ...electronArgs]
        : electronArgs;
    child = spawn(command, args, {
      cwd: rootDir,
      detached: process.platform !== "win32",
      env: commonEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    await waitForPort(cdpPort, child, logPath);
    await waitForAppTarget(cdpPort, input.metroPort, child, logPath);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
      timeout: START_TIMEOUT_MS,
    });
    const page = await waitForAppPage(browser, input.metroPort);
    await page.waitForFunction(() => typeof window.paseoDesktop?.invoke === "function", undefined, {
      timeout: START_TIMEOUT_MS,
    });
    return {
      page,
      stop: async () => {
        await browser?.close().catch(() => undefined);
        await cleanupRuntime();
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    try {
      await cleanupRuntime();
    } catch (cleanupError) {
      const startupMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Real Electron failed to start (${startupMessage}) and clean up`, {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
