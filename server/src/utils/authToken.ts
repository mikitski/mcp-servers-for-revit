import fs from "fs";
import path from "path";
import { resolveWindowsLocalAppData } from "./windowsEnv.js";

// Must match plugin/Utils/PathManager.cs GetAuthTokenFilePath(): a fixed,
// version-independent location so the server can find it regardless of which
// Revit install's plugin instance generated it.
const TOKEN_SUBPATH = ["revit-mcp-plugin", "session.token"];

// Resolves the token file's path. On native Windows, process.env.LOCALAPPDATA
// already works. Under WSL (see windowsEnv.ts), it's resolved via cmd.exe and
// translated to the /mnt/<drive> path this process can actually read.
function tokenFilePath(): string | null {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, ...TOKEN_SUBPATH);
  }

  const winLocalAppData = resolveWindowsLocalAppData();
  if (!winLocalAppData) return null;
  return path.join(winLocalAppData.wslPath, ...TOKEN_SUBPATH);
}

/**
 * Reads the current session's auth token written by the Revit plugin.
 * Read fresh on every call (not cached) so a Revit restart, which rotates the
 * token, is picked up immediately without restarting the MCP server. The
 * resolved LOCALAPPDATA directory itself *is* cached (in windowsEnv.ts), since
 * it can't change within a process's lifetime.
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
