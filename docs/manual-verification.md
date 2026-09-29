# Manual verification on a real Revit instance

This repo's automated environment can build the C# projects (see `CLAUDE.md`)
but cannot run Revit. Use this guide whenever a change needs to be verified
against a real, running Revit instance before merging or releasing — most
importantly after any change to `plugin/` or `commandset/`.

## 1. Get a build

You do **not** need `dotnet`, Visual Studio, or anything else installed on
your dev machine to produce a build — GitHub Actions builds it on a real
Windows runner. You only need Revit itself on the machine you'll test with.

1. Go to the repo's **Actions** tab → **Build** workflow (`.github/workflows/build.yml`).
2. Click **Run workflow** → select your branch → **Run workflow**.
   (A build also runs automatically on every PR that touches `plugin/`, `commandset/`, or `server/` — if you're verifying a PR, you can use that run's artifact instead of starting a new one.)
3. Wait for the run to finish (a few minutes), then open it and download the artifact named `revit-mcp-plugin-build-<run id>` from the **Artifacts** section at the bottom of the run summary page.
4. Unzip it. You'll get one subfolder per supported Revit version: `Revit2020/`, `Revit2021/`, ... `Revit2026/`. Each one is a complete, self-contained AddIn layout — the same thing a release ZIP contains.

## 2. Install on the Revit machine

Pick the subfolder matching your installed Revit version, e.g. `Revit2026/`. Inside it you'll find:

```
Revit2026/
├── mcp-servers-for-revit.addin
└── revit_mcp_plugin/
    ├── RevitMCPPlugin.dll
    ├── ...
    └── Commands/
        └── RevitMCPCommandSet/
            ├── command.json
            └── 2026/
                ├── RevitMCPCommandSet.dll
                └── ...
```

1. Close Revit if it's running.
2. **Back up anything already there** if you have a previous install you care about — copy your existing `%AppData%\Autodesk\Revit\Addins\2026\` elsewhere first. This lets you roll back by just restoring the folder (see §5).
3. Copy `mcp-servers-for-revit.addin` and the `revit_mcp_plugin/` folder into:
   ```
   %AppData%\Autodesk\Revit\Addins\2026\
   ```
   (adjust `2026` to match the subfolder/Revit version you picked).
4. Start Revit.

## 3. First launch

- If Revit shows an "unsigned add-in" / "publisher could not be verified" prompt, choose **Always Load** (these builds aren't code-signed — see `BACKLOG.md`, F8).
- Look for the **mcp-servers-for-revit** ribbon tab. If it's missing, check `%AppData%\Autodesk\Revit\Addins\<year>\revit_mcp_plugin\Logs\` for load errors.

## 4. Enable commands

1. On the ribbon, click **Settings**.
2. Select the command set, check the commands you want to test (or **Select All**), and click **Save**.
3. Confirm `send_code_to_revit` does **not** appear in the list — it was removed for security reasons (see `CLAUDE.md#security`, `docs/security-reviews/`). If you see it, you're testing a stale/pre-fix build.
4. Click **Start** (or the equivalent ribbon button) to start the socket listener.

## 5. Security smoke tests (F1 fix)

Run these from a terminal **on the same machine as Revit** (the socket now binds loopback-only, so this cannot be tested remotely — that's the point of the fix):

**Confirm the socket is loopback-only, not network-reachable:**
```powershell
netstat -ano | findstr :8080
```
Expect `127.0.0.1:8080`. If you see `0.0.0.0:8080`, the fix isn't active — you're likely running a stale build.

**Confirm the session token file exists and is fresh** (rewritten each time the plugin initializes):
```powershell
type "$env:LOCALAPPDATA\revit-mcp-plugin\session.token"
```

**Confirm a request without a token is rejected** (run in PowerShell):
```powershell
$client = New-Object System.Net.Sockets.TcpClient("localhost", 8080)
$stream = $client.GetStream()
$payload = [System.Text.Encoding]::UTF8.GetBytes('{"jsonrpc":"2.0","method":"say_hello","params":{},"id":"1"}')
$stream.Write($payload, 0, $payload.Length)
Start-Sleep -Milliseconds 500
$buffer = New-Object byte[] 4096
$read = $stream.Read($buffer, 0, $buffer.Length)
[System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
$client.Close()
```
Expect a JSON-RPC error response with `"message": "Unauthorized: missing or invalid token"`. If `say_hello` actually runs (a dialog pops up in Revit), the auth check isn't active.

## 6. End-to-end test via the MCP server

Because the plugin now binds loopback only, **the MCP server must run on the same machine as Revit** — it can no longer be reached from a different machine.

1. Set up the MCP server per the README's [MCP Server Setup](../README.md#mcp-server-setup) section, on the Revit machine itself.
2. From your AI client, call a simple tool (e.g. `say_hello` or `get_current_view_info`). You don't need to do anything with the token yourself — the server reads it automatically from the same file the plugin wrote.
3. Confirm the call succeeds end-to-end (dialog appears / data comes back).

## 7. Roll back

To remove a test build: close Revit, delete `%AppData%\Autodesk\Revit\Addins\<year>\mcp-servers-for-revit.addin` and the `revit_mcp_plugin\` folder, and restore your backup from step 2 if you made one.
