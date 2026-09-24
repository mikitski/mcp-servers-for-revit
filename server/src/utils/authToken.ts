import fs from "fs";
import os from "os";
import path from "path";

// Must match plugin/Utils/PathManager.cs GetAuthTokenFilePath(): a fixed,
// version-independent location so the server can find it regardless of which
// Revit install's plugin instance generated it.
function tokenFilePath(): string {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "revit-mcp-plugin", "session.token");
}

/**
 * Reads the current session's auth token written by the Revit plugin.
 * Read fresh on every call (not cached) so a Revit restart, which rotates the
 * token, is picked up immediately without restarting the MCP server.
 */
export function readSessionToken(): string | null {
  try {
    return fs.readFileSync(tokenFilePath(), "utf8").trim();
  } catch {
    return null;
  }
}
