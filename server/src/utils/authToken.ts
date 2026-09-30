import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// Must match plugin/Utils/PathManager.cs GetAuthTokenFilePath(): a fixed,
// version-independent location so the server can find it regardless of which
// Revit install's plugin instance generated it.
const TOKEN_SUBPATH = ["revit-mcp-plugin", "session.token"];

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

// Converts a Windows path (as reported by cmd.exe) to its WSL mount
// equivalent, e.g. "C:\Users\foo\AppData\Local" -> "/mnt/c/Users/foo/AppData/Local".
function windowsPathToWslPath(windowsPath: string): string | null {
  const match = windowsPath.trim().match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

let cachedLocalAppData: string | null | undefined;

// Resolves the user's LOCALAPPDATA directory as a path this process can read.
// On native Windows, process.env.LOCALAPPDATA already works. Under WSL, the
// server is commonly run as a Linux process (see README's WSL setup note),
// where LOCALAPPDATA isn't set and the Linux home directory isn't the
// Windows one - so ask cmd.exe for the real value and translate it to the
// /mnt/<drive> path this process can actually read.
function resolveLocalAppDataDir(): string | null {
  if (cachedLocalAppData !== undefined) return cachedLocalAppData;

  if (process.env.LOCALAPPDATA) {
    cachedLocalAppData = process.env.LOCALAPPDATA;
    return cachedLocalAppData;
  }

  if (isWsl()) {
    try {
      const output = execFileSync(
        "cmd.exe",
        ["/c", "echo", "%LOCALAPPDATA%"],
        { encoding: "utf8", timeout: 5000 }
      );
      cachedLocalAppData = windowsPathToWslPath(output);
      return cachedLocalAppData;
    } catch {
      // cmd.exe not reachable (e.g. WSL without interop) - fall through.
    }
  }

  cachedLocalAppData = null;
  return cachedLocalAppData;
}

function tokenFilePath(): string | null {
  const localAppData = resolveLocalAppDataDir();
  if (!localAppData) return null;
  return path.join(localAppData, ...TOKEN_SUBPATH);
}

/**
 * Reads the current session's auth token written by the Revit plugin.
 * Read fresh on every call (not cached) so a Revit restart, which rotates the
 * token, is picked up immediately without restarting the MCP server. The
 * resolved LOCALAPPDATA directory itself *is* cached, since it can't change
 * within a process's lifetime.
 */
export function readSessionToken(): string | null {
  const filePath = tokenFilePath();
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}
