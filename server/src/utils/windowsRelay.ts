import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { resolveWindowsLocalAppData, retrySpawn } from "./windowsEnv.js";

// WSL2's loopback forwarding is commonly one-directional in practice
// (Windows -> WSL works; a WSL process connecting out to 127.0.0.1 on the
// Windows host is often refused outright, as observed against this same
// plugin socket). So under WSL, don't try to reach the plugin's socket
// directly from this (Linux) process - relay the single request/response
// through a native Windows process (powershell.exe), which reaches Windows
// loopback the same way Revit itself does.
//
// One relay invocation per call, matching how ConnectionManager.ts already
// opens a fresh connection per command (see withRevitConnection) - there is
// no persistent connection to maintain.
const RELAY_SCRIPT = `
param([string]$TargetHost, [int]$Port, [int]$TimeoutMs)
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd()

$client = New-Object System.Net.Sockets.TcpClient
$connectTask = $client.ConnectAsync($TargetHost, $Port)
if (-not $connectTask.Wait(5000)) {
    throw "connect to revit client failed"
}

$stream = $client.GetStream()
$client.ReceiveTimeout = $TimeoutMs

$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$stream.Write($bytes, 0, $bytes.Length)
$stream.Flush()

$buffer = New-Object byte[] 65536
$read = $stream.Read($buffer, 0, $buffer.Length)
$client.Close()

[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($buffer, 0, $read))
`;

// Only a successful write is cached - same reasoning as
// windowsEnv.ts's resolveWindowsLocalAppData: don't let one transient
// failure permanently break every subsequent call in a long-running process.
let relayScriptWindowsPath: string | undefined;

// Writes the relay script (once per process) into the same directory the
// plugin uses for its session token, and returns its path in Windows syntax
// (e.g. "C:\\Users\\foo\\AppData\\Local\\revit-mcp-plugin\\relay.ps1"), since
// that's what powershell.exe -File needs - this process's own /mnt/<drive>
// view of the same directory isn't meaningful to a native Windows process.
function ensureRelayScript(): string | null {
  if (relayScriptWindowsPath !== undefined) return relayScriptWindowsPath;

  const winLocalAppData = resolveWindowsLocalAppData();
  if (!winLocalAppData) return null;

  try {
    const dirWsl = path.join(winLocalAppData.wslPath, "revit-mcp-plugin");
    fs.mkdirSync(dirWsl, { recursive: true });
    const scriptPathWsl = path.join(dirWsl, "relay.ps1");
    fs.writeFileSync(scriptPathWsl, RELAY_SCRIPT, "utf8");
    relayScriptWindowsPath = `${winLocalAppData.windowsPath}\\revit-mcp-plugin\\relay.ps1`;
    return relayScriptWindowsPath;
  } catch {
    return null;
  }
}

/**
 * Sends a single request to the plugin's socket via a native Windows process
 * and returns its raw response text. Throws on any failure (relay script
 * missing, powershell.exe unreachable, connect/read failure, timeout).
 */
export function sendViaWindowsRelay(
  targetHost: string,
  port: number,
  payload: string,
  timeoutMs: number
): string {
  const scriptPath = ensureRelayScript();
  if (!scriptPath) {
    throw new Error(
      "Could not set up the Windows relay script (failed to resolve LOCALAPPDATA via cmd.exe)"
    );
  }

  try {
    return retrySpawn(() =>
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          // Scoped to this one process invocation only - does not change the
          // system-wide execution policy, which commonly blocks unsigned .ps1
          // files by default (e.g. "Restricted" or "AllSigned").
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-TargetHost",
          targetHost,
          "-Port",
          String(port),
          "-TimeoutMs",
          String(timeoutMs),
        ],
        {
          input: payload,
          encoding: "utf8",
          timeout: timeoutMs + 10_000,
          maxBuffer: 16 * 1024 * 1024,
        }
      )
    );
  } catch (error: any) {
    // execFileSync's own error.message is just "Command failed: <cmd> <args>"
    // with no indication of *why* - surface exit code/signal/stdout/stderr
    // explicitly, since a killed-with-no-stderr process (e.g. the OS timeout
    // firing, or something else terminating it) looks identical to a clean
    // non-zero exit otherwise.
    const details = [
      error?.signal ? `signal=${error.signal}` : null,
      error?.status !== undefined && error?.status !== null
        ? `exitCode=${error.status}`
        : null,
      error?.stdout ? `stdout=${JSON.stringify(String(error.stdout))}` : null,
      error?.stderr ? `stderr=${JSON.stringify(String(error.stderr))}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(
      `Windows relay failed${details ? ` (${details})` : ""}: ${
        error?.message ?? String(error)
      }`
    );
  }
}
