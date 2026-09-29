# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

mcp-servers-for-revit connects AI clients (Claude, Cline, etc.) to Autodesk Revit via the Model Context Protocol. It is a fork of the original `revit-mcp` project with additional tools and fixes. Three components, each built independently:

- **`server/`** — TypeScript MCP server. Exposes MCP tools over stdio to the AI client, forwards each call as a JSON-RPC request over a raw TCP socket (`localhost:8080`) to the Revit plugin, and returns the result.
- **`plugin/`** — C# Revit add-in (`revit_mcp_plugin`). Runs inside Revit, hosts a `TcpListener` on port 8080 (`plugin/Core/SocketService.cs`), receives JSON-RPC requests, and dispatches them by method name to registered commands.
- **`commandset/`** — C# command implementations (`RevitMCPCommandSet.dll`), loaded dynamically by the plugin at runtime. Each command executes the actual Revit API calls.

Despite the README's "WebSocket" label in its architecture diagram, the wire protocol is plain JSON-RPC 2.0 over a raw TCP socket, not the WebSocket protocol.

## Development workflow

- **Never push or merge directly to `main`.** `main` is branch-protected and only accepts changes through a pull request — do not attempt `git push origin main` or a local merge into `main`.
- **Do all work in a dedicated worktree on its own branch**, not in the primary checkout:
  ```bash
  git worktree add ../<worktree-dir> -b <branch-name>
  ```
  Make the change, then in that worktree:
  ```bash
  git commit -m "..."
  git push -u origin <branch-name>
  ```
- **Open a pull request into `main`** once the branch is pushed (e.g. `gh pr create`) and let the merge happen through the PR — never merge the branch into `main` locally.

## Request flow (end to end)

1. AI client calls an MCP tool → handled in `server/src/tools/<tool>.ts`.
2. The tool handler calls `withRevitConnection(...)` (`server/src/utils/ConnectionManager.ts`), which serializes access via a module-level mutex (only one in-flight Revit connection at a time) and opens a `RevitClientConnection` (`server/src/utils/SocketClient.ts`).
3. `RevitClientConnection.sendCommand(method, params)` sends a JSON-RPC request to `localhost:8080`, including the per-session auth token (`server/src/utils/authToken.ts`, read fresh from disk each call), and resolves/rejects based on the JSON-RPC response (2-minute timeout).
4. In the plugin, `SocketService` accepts the connection, parses the request, and rejects it if the token doesn't match the one it generated at startup. Requests that pass validate are dispatched directly by `SocketService.ProcessJsonRPCRequest`, which looks up the method name in `RevitCommandRegistry` (note: `CommandExecutor.cs`/`ExecuteCommand` is a parallel, unused dispatch path — dead code, not the live one).
5. The matched command (in `commandset/Commands/`) is an `ExternalEventCommandBase` subclass pairing a `Command` (implements `IRevitCommand`, parses JSON params) with an `EventHandler` (`commandset/Services/`, implements `IExternalEventHandler`) — Revit API calls must run on Revit's main thread via `ExternalEvent`, so the command raises the event and blocks (`RaiseAndWaitForCompletion`) until the handler signals completion via a `ManualResetEvent`.
6. The handler's result is serialized back through `CommandExecutor` → `SocketService` → TCP → the TS server → the MCP client.

Units convention: values crossing the server/plugin boundary are millimeters; Revit's internal API uses feet, so command handlers convert (`/ 304.8`) as needed.

## Adding a new tool/command (three-sided change)

A new capability typically requires changes in all three projects:

1. **`server/src/tools/<name>.ts`** — define a zod schema and call `server.tool(name, description, schema, handler)`; the handler calls `withRevitConnection` and `revitClient.sendCommand("<command_name>", params)`. No manual registration needed: `server/src/tools/register.ts` scans the `tools/` directory at startup and auto-invokes any exported function whose name starts with `register`.
2. **`commandset/Commands/<Name>Command.cs`** + **`commandset/Services/<Name>EventHandler.cs`** — the command's `CommandName` string must match the method name sent from the TS tool. Follow the existing `ExternalEventCommandBase` + `IExternalEventHandler`/`IWaitableExternalEventHandler` pairing pattern.
3. **`command.json`** (repo root) — add an entry `{ "commandName": ..., "description": ..., "assemblyPath": "RevitMCPCommandSet.dll" }`; the plugin's `CommandManager` reads this file to know which commands to load and enable.

## Security

The Revit↔MCP socket (`plugin/Core/SocketService.cs`) binds loopback only and requires a per-session auth token on every request:

- The plugin generates a random token in `Initialize()` and writes it to `PathManager.GetAuthTokenFilePath()` — a fixed, Revit-version-independent path under the user's local app data (not the per-version Addins folder), so the server can find it regardless of which Revit install produced it.
- Every request must echo that token back in a top-level `token` field. `ProcessJsonRPCRequest` rejects a missing/mismatched token before it ever touches the command registry.
- `server/src/utils/authToken.ts` reads the same file; `SocketClient.ts` sends the token on every outgoing command.
- Changing this protocol is a breaking change: the plugin and server must always be updated together (they already ship together in each release).

`send_code_to_revit` (arbitrary C# execution in Revit) has been removed from this fork and has no in-repo replacement. If it's ever reintroduced, it needs an explicit compilation reference allowlist, syntax-level rejection of `System.Diagnostics`/`System.IO`/`System.Net`/`System.Reflection`, a timeout, `AssemblyLoadContext` isolation, and an audit log — see `docs/security-reviews/2026-09-21-security-review.md` (finding F2) for the full threat model.

Known gaps not yet addressed in this fork are tracked in `BACKLOG.md`, not here.

## Project tracking documents

This file is for durable, current-state instructions only. Status and planning live elsewhere:

- **`CHANGELOG.md`** — notable shipped changes.
- **`BACKLOG.md`** — known issues/improvements not yet scheduled.
- **`TODO.md`** — near-term concrete action items.
- **`PROGRESS.md`** — dated running log of work sessions.
- **`docs/security-reviews/`** — point-in-time security review reports.

## Common commands

### MCP server (`server/`)

```bash
cd server
npm install
npm run build          # tsc -> server/build/
npx tsx src/index.ts   # run directly during development (no build step)
```

There is no lint or test script for the server package.

### Revit plugin + command set (Windows only)

Open `mcp-servers-for-revit.sln` in Visual Studio or build via `dotnet build`/`msbuild` with one of the per-version configurations, e.g. `Release R26`, `Debug R25`, `Release R20` (covers Revit 2020–2026: 2020–2024 target `net48`, 2025–2026 target `net8.0-windows`). Building the solution assembles the full deployable add-in layout under `plugin/bin/AddIn <year> <config>/`, copying the command set DLLs into the plugin's `Commands/RevitMCPCommandSet/<year>/` folder automatically (see the `DeployCommandSet` target in `commandset/RevitMCPCommandSet.csproj`). Debug builds also copy straight into `%AppData%\Autodesk\Revit\Addins\<version>\` for local iteration.

### Building C# locally without a Windows box

`dotnet`/`msbuild` are not installed in this repo's WSL distro or the Windows host — only Docker is available. Both `plugin/RevitMCPPlugin.csproj` (`UseWPF`+`UseWindowsForms`) and `commandset/RevitMCPCommandSet.csproj` (`UseWPF`) normally refuse to build on Linux (`NETSDK1100: To build a project targeting Windows on this operating system, set the EnableWindowsTargeting property to true.`). Passing `-p:EnableWindowsTargeting=true` works around this for a **compile-only sanity check** — restore + build succeed and produce real DLLs, but they can't be run or tested here (confirmed working for both projects, for both `net48` (`R20`) and `net8.0-windows10.0.19041.0` (`R26`) target frameworks):

```bash
docker run --rm -v "$(pwd)":/repo -w /repo mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet build plugin/RevitMCPPlugin.csproj -c "Debug R26" -p:EnableWindowsTargeting=true

docker run --rm -v "$(pwd)":/repo -w /repo mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet build commandset/RevitMCPCommandSet.csproj -c "Debug R26" -p:EnableWindowsTargeting=true
```

This is a useful pre-PR sanity check for C# syntax/type errors, but it is not a substitute for a real build+run against Revit (see Testing below), and it's a fallback for local iteration — `.github/workflows/build.yml` (below) is the authoritative build.

If `docker pull`/`docker run` fails with a credential-helper error (`error getting credentials`, not an actual auth failure), the `credsStore` configured in `~/.docker/config.json` is broken in this environment; work around it per-invocation with an isolated `DOCKER_CONFIG` pointed at a directory holding just `{}`, rather than editing the real Docker config:

```bash
mkdir -p /tmp/docker-config-anon && echo '{}' > /tmp/docker-config-anon/config.json
export DOCKER_CONFIG=/tmp/docker-config-anon
```

### Getting a real Windows-built package (no local build needed)

`.github/workflows/build.yml` builds the MCP server and every supported Revit version on a real Windows GitHub Actions runner and uploads the result as a downloadable artifact — this is how to get a build to manually install and test on an actual Revit machine, with nothing installed locally at all. It runs automatically on PRs touching `plugin/`/`commandset/`/`server/`, and can also be triggered manually (Actions tab → "Build" → Run workflow, or `gh workflow run build.yml`). See `docs/manual-verification.md` for the full install-and-smoke-test procedure.

### Integration tests (`tests/commandset/`, Windows only, requires a running Revit)

Uses [Nice3point.TUnit.Revit](https://github.com/Nice3point/RevitUnit) to inject into a live Revit process — no separate add-in install needed. Requires .NET 10 SDK and a licensed Revit 2025 or 2026 install; Revit must already be open before running tests.

```bash
dotnet test -c Debug.R26 -r win-x64 tests/commandset   # Revit 2026
dotnet test -c Debug.R25 -r win-x64 tests/commandset   # Revit 2025
```

`-r win-x64` is required on ARM64 machines (Revit API assemblies are x64-only). Test classes inherit from `RevitApiTest`, use `[Before(HookType.Class)]`/`[After(HookType.Class)]` with `[HookExecutor<RevitThreadExecutor>]` for setup/teardown that must run on Revit's thread, and use TUnit's async `Assert.That(...)` API.

### Releasing

Releasing is fully GitHub Actions-driven — no local script or manual tagging is needed (and none of it requires breaking out of WSL to run a `.ps1` on the host):

1. Trigger `.github/workflows/prepare-release.yml` (Actions tab → "Prepare Release" → Run workflow, or `gh workflow run prepare-release.yml -f version=X.Y.Z`). It bumps `server/package.json`, `server/package-lock.json`, and `plugin/Properties/AssemblyInfo.cs` on a new `release/vX.Y.Z` branch and opens a PR into `main`.
2. Review and merge that PR like any other (`main` is protected — no direct pushes).
3. The merge triggers `.github/workflows/release.yml`, which tags the merge commit `vX.Y.Z`, builds the plugin/command set for every supported Revit version, and publishes a GitHub release with the per-version zips.

This fork does not publish to npm — the original `mcp-server-for-revit` npm package is owned by the upstream project, so the npm-publish job has been removed rather than risk publishing under/against that name.
