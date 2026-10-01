import { execFileSync } from "child_process";
import fs from "fs";

/**
 * Whether this process is running inside WSL, talking to a Revit instance on
 * the Windows host. Both authToken.ts (reading the plugin's session token)
 * and windowsRelay.ts (reaching the plugin's loopback-only socket) need this.
 */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export interface WindowsLocalAppData {
  /** Windows-style path, e.g. "C:\\Users\\foo\\AppData\\Local" - for passing to a Windows process. */
  windowsPath: string;
  /** The same directory as a WSL mount path, e.g. "/mnt/c/Users/foo/AppData/Local" - for this process's own fs calls. */
  wslPath: string;
}

// Only a *successful* resolution is cached - it can't change within a
// process's lifetime. A failure is never cached: spawning a Windows process
// through WSL interop has been observed to fail intermittently (see
// BACKLOG.md), and caching that failure would permanently break every
// subsequent call in a long-running server process over one transient hiccup.
let cached: WindowsLocalAppData | undefined;

// Kept small: a genuine failure (Revit not listening, a real busy-Revit
// timeout) looks identical to spawn-time flakiness from here, and each
// attempt can take up to the caller's own timeout - too many retries would
// multiply a legitimate slow failure's latency instead of just absorbing a
// one-off hiccup.
const SPAWN_RETRY_ATTEMPTS = 2;

/**
 * Retries a synchronous operation that spawns a Windows process via WSL
 * interop, which has been observed to fail intermittently with no useful
 * error (see BACKLOG.md's "long-running process" entry). Retries immediately
 * (no backoff) since the failures observed so far look like spawn-time
 * flakiness, not a resource that needs time to recover.
 */
export function retrySpawn<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SPAWN_RETRY_ATTEMPTS; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Resolves the Windows user's LOCALAPPDATA directory from within WSL by
 * asking cmd.exe (process.env.LOCALAPPDATA isn't set for a WSL/Linux
 * process, and os.homedir() would return the Linux home). Requires WSL's
 * Windows interop (cmd.exe reachable from the Linux side), which is the
 * default.
 */
export function resolveWindowsLocalAppData(): WindowsLocalAppData | null {
  if (cached !== undefined) return cached;
  if (!isWsl()) return null;

  try {
    const output = retrySpawn(() =>
      execFileSync("cmd.exe", ["/c", "echo", "%LOCALAPPDATA%"], {
        encoding: "utf8",
        timeout: 5000,
      })
    );
    const windowsPath = output.trim();
    const match = windowsPath.match(/^([A-Za-z]):\\(.*)$/);
    if (!match) return null;

    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    cached = { windowsPath, wslPath: `/mnt/${drive}/${rest}` };
    return cached;
  } catch {
    return null;
  }
}
