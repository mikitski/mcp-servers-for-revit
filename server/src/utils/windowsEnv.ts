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

let cached: WindowsLocalAppData | null | undefined;

/**
 * Resolves the Windows user's LOCALAPPDATA directory from within WSL by
 * asking cmd.exe (process.env.LOCALAPPDATA isn't set for a WSL/Linux
 * process, and os.homedir() would return the Linux home). Requires WSL's
 * Windows interop (cmd.exe reachable from the Linux side), which is the
 * default.
 */
export function resolveWindowsLocalAppData(): WindowsLocalAppData | null {
  if (cached !== undefined) return cached;

  if (!isWsl()) {
    cached = null;
    return cached;
  }

  try {
    const output = execFileSync("cmd.exe", ["/c", "echo", "%LOCALAPPDATA%"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const windowsPath = output.trim();
    const match = windowsPath.match(/^([A-Za-z]):\\(.*)$/);
    if (!match) {
      cached = null;
      return cached;
    }
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    cached = { windowsPath, wslPath: `/mnt/${drive}/${rest}` };
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}
