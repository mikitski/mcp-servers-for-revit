# Security review: mcp-servers-for-revit

Reviewed 2026-09-21.

| Ref | Commit |
|---|---|
| `v1.0.0` tag (the only release; npm `mcp-server-for-revit@1.0.0`) | `1a52de93d9f4565f94d0d1541186c9cf18f3648f` (2026-02-26) |
| `main` | `86cf7057785f2423fc0d0892c9a5d9c93deb1aa3` (2026-04-05) |
| `RevitMCPSDK` (third-party NuGet dep, source reviewed) | github.com/DTDucas/RevitMCPSDK `66c35eb3` |

`main` differs from `v1.0.0` by 9 files: a `transactionMode: "none"` option on the code-execution tool, three zod schemas tightened from `z.any()` to `z.string()`, a stale `.addin` removed, and a `better-sqlite3` bump. Nothing on `main` changes any finding's severity; one finding (F2) gets slightly worse. Line numbers below are from `main`.

## 1. Executive summary

**Recommendation: no-go as shipped. Go only as a fork with three code changes plus a host firewall rule.**

The plugin is not a WebSocket server. It is a raw TCP listener on `0.0.0.0:8080` with no authentication of any kind, and one of its commands compiles and runs arbitrary C# inside Revit with every loaded assembly referenced. Anyone on the office network who can reach the workstation, and any process on the workstation, gets code execution as the logged-in user once that command is enabled. A prompt-injected agent gets the same through the MCP tool. The three fixes are small (bind to loopback, add a shared secret, remove or gate the code tool), but they are not in upstream and the project has effectively one maintainer.

Top three issues:
1. Unauthenticated command channel bound to all interfaces on a fixed port (F1).
2. Arbitrary C# execution with no sandbox, allowlist, or confirmation (F2). Off by default, one checkbox to enable.
3. The MCP server trusts whatever answers on `localhost:8080`, so any local process can impersonate Revit and inject content into the agent (F3).

Also worth knowing before spending more time: the repo has no Revit 2027 build configuration, and Formwork targets 2027 (ADR-0001).

## 2. Trust boundaries

```
 LLM (untrusted)
   │  tool call (zod-validated shape only)
   ▼
 MCP client ──stdio──► mcp-server-for-revit (Node, per-call)
                          │  new TCP connection to localhost:8080 per call
                          │  NO auth, NO peer verification, NO framing
                          ▼
   ┌──── any LAN host / any local process can also write here ────┐
   │   Revit plugin  TcpListener(IPAddress.Any, 8080)             │
   │     JSON-RPC parse → exact-match dictionary dispatch          │
   │     NO auth, NO origin, NO size/rate limit, 1 thread/conn     │
   └───────────────────────────────────────────────────────────────┘
                          │  ExternalEvent.Raise → Revit UI thread
                          ▼
   Command set (C#)  ── Transaction ── Revit API ── model file
     send_code_to_revit: Roslyn compile + Assembly.Load(bytes)
       → full .NET: Process.Start, System.IO, System.Net, Revit Save/Sync
                          │
   Model content (Comments, Mark, Name…) ──► JSON.stringify ──► LLM, unlabelled
   store_*_data ──► revit-data.db in the npx cache (plaintext, persistent)
```

What is authenticated at each hop: nothing. What is validated: the MCP server validates argument *shape* with zod; the plugin validates that `jsonrpc == "2.0"` and `method` is non-empty, then dispatches. Data that crosses boundaries from an untrusted origin: LLM-authored code and parameters (hops 1-3), model-file strings (bottom edge, back to the LLM), and anything a LAN peer or local process writes to port 8080.

## 3. Findings table

| ID | Sev | Title | Location | Impact |
|---|---|---|---|---|
| F1 | Critical | Command channel bound to all interfaces, no auth, fixed port | `plugin/Core/SocketService.cs:87,105` | Any LAN host or local process drives Revit |
| F2 | Critical | Arbitrary C# compiled and run in-process, no sandbox | `commandset/Commands/ExecuteDynamicCode/ExecuteCodeEventHandler.cs:96-156` | With F1: network RCE as the Revit user |
| F3 | High | MCP server trusts whatever is on `localhost:8080` | `server/src/utils/ConnectionManager.ts:23`, `SocketService.cs:114-117` | Local impostor injects results into the agent, captures commands |
| F4 | High | Destructive ops with no confirmation or dry-run; warnings auto-deleted | `DeleteElementEventHandler.cs:62-71`, `OperateElementEventHandler.cs:248-255`, `CreateRoomEventHandler.cs:16-37` | Confused agent deletes model content silently |
| F5 | High | Remote UI hang and resource exhaustion | `SayHelloEventHandler.cs:22`, `SocketService.cs:148-154,174-200` | Modal dialogs from the network stall Revit; unbounded threads; >8 KB request breaks |
| F6 | Medium | Singleton handler state races across connections | `RevitMCPSDK/API/Base/ExternalEventCommandBase.cs:35-50`, `ExecuteCodeEventHandler.cs:33-40` | One caller's code runs under another's request |
| F7 | Medium | Client/project data persisted in plaintext in the npm cache | `server/src/database/db.ts:10`, `service.ts:66-83` | Client names, addresses, paths leave the model's document controls |
| F8 | Medium | Supply chain: unpinned npx, floating NuGet, unsigned DLLs, single maintainer | `README.md:73`, `RevitMCPPlugin.csproj:61`, `release.yml:3-6,109-133` | Silent auto-upgrade; no tamper detection on releases |
| F9 | Low | Config-driven `Assembly.LoadFrom` of any path | `plugin/Core/CommandManager.cs:107-124` | Same trust level as the add-in itself |
| F10 | Low | Model strings returned to the LLM unlabelled | `GetCurrentViewElementsEventHandler.cs:203-210`, 21 server tools | Third-party RVT can carry instructions to the agent; with F2, RVT→RCE |
| F11 | Info | Reflection type lookup from caller string | `AIElementFilterEventHandler.cs:213-224` | Bounded by `ElementClassFilter`; not exploitable |
| F12 | Info | Misleading docs and dead code | README, `ws` dep, `CommandExecutor`, 3 zero-byte tools, `SocketService.cs:201` | Signals maturity; full requests traced to debuggers |
| H1 | Hypothesis | Browser drive-by POST reaches the parser | `SocketService.cs:184` | Unverified; see §4 |

## 4. Detailed findings

### F1. Unauthenticated command channel on all interfaces (Critical, design)

```csharp
// plugin/Core/SocketService.cs
 87: _port = 8080; // 固定端口号 - Hard-wired port number.
105: _listener = new TcpListener(IPAddress.Any, _port);
```

There is no authentication anywhere in `plugin/`. `ProcessJsonRPCRequest` (lines 221-283) goes from `JsonConvert.DeserializeObject<JsonRPCRequest>` straight to `_commandRegistry.TryGetCommand(request.Method)` and `command.Execute(...)`. I grepped `plugin/` and the SDK for `token`, `auth`, `secret`, `Origin`, `Handshake`, `RemoteEndPoint`: no hits. The port-from-config code at lines 81-86 is commented out, so the port is not configurable either. The transport is raw TCP, not WebSocket as the README and the server README both claim; the `ws` npm dependency is declared but never imported.

Attack scenario: from any machine on the firm's LAN or VPN, `nc <workstation> 8080` and paste `{"jsonrpc":"2.0","id":"1","method":"delete_element","params":{"elementIds":["<id>"]}}`. Every enabled command is reachable this way. Windows Firewall may prompt on first bind for a private network profile, but on a domain profile the default inbound policy is what applies.

Remediation: bind `IPAddress.Loopback`, generate a per-session token written to a user-only file that the MCP server reads and sends in every request, and reject requests without it. Consumer-fixable by fork (three lines for the bind, ~30 for the token).

### F2. Arbitrary C# execution in-process (Critical, design; main adds a mode that widens it)

```csharp
// commandset/Commands/ExecuteDynamicCode/ExecuteCodeEventHandler.cs
121: var references = AppDomain.CurrentDomain.GetAssemblies()
122:     .Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
123:     .Select(a => MetadataReference.CreateFromFile(a.Location))
...
150: var assembly = Assembly.Load(ms.ToArray());
154: return executeMethod.Invoke(null, new object[] { doc, parameters });
```

The snippet is spliced into a method body (line 113) with `System`, `System.Linq`, and the Revit namespaces imported, and compiled against every assembly Revit has loaded, which includes `System.Diagnostics.Process`, `System.IO`, and `System.Net`. There is no allowlist, no AppDomain or `AssemblyLoadContext` isolation, no reference restriction, no confirmation prompt in Revit, and no audit log (the only trace is `Trace.WriteLine` of the whole request at `SocketService.cs:201`, which goes to `OutputDebugString`, not a file). On `main`, `transactionMode: "none"` (lines 57-64) runs the snippet outside any transaction, which is exactly what `Document.Save`, `SaveAs`, `SynchronizeWithCentral`, and `Application.OpenDocumentFile` require, so a snippet can save over the model, sync to central, or open a malicious RVT from a UNC path.

Stated plainly, as the prompt asked: **combined with F1, any process on the workstation and any host that can reach port 8080 gets code execution inside Revit as the logged-in user, with access to the open model, the file shares that user can reach, and the network.** The one real mitigation is that commands are disabled by default in the settings UI (`CommandSetSettingsPage.xaml.cs` sets `Enabled = false` on load and the user ticks each one), so `send_code_to_revit` is reachable only after someone has enabled it and saved.

Attack scenario (LLM path): a prompt-injected agent calls the tool with `System.Diagnostics.Process.Start("powershell", "-enc ..."); return null;`. The server's tool description tells it exactly how the template works.

Remediation: remove the command from `command.json` in your fork, or keep it behind a per-session opt-in that shows a `TaskDialog` with the code and requires a click. If kept, compile against an explicit reference set (RevitAPI, mscorlib/System.Runtime, System.Linq only), reject `System.Diagnostics`, `System.IO`, `System.Net`, `System.Reflection` at the syntax-tree level, run with a timeout, and log every snippet. Consumer-fixable by fork.

### F3. Localhost peer is trusted blindly; the plugin fails silently if the port is taken (High, bug + design)

```ts
// server/src/utils/ConnectionManager.ts
23: const revitClient = new RevitClientConnection("localhost", 8080);
```

```csharp
// plugin/Core/SocketService.cs
114: catch (Exception)
115: {
116:     _isRunning = false;
117: }
```

```csharp
// plugin/Core/MCPServiceConnection.cs
26: service.Initialize(commandData.Application);
27: service.Start();
28: TaskDialog.Show("revitMCP", "Open Server");   // shown even when Start() failed
```

Any unprivileged local process can bind 8080 first. The plugin's `Start()` swallows the bind failure, and the ribbon reports success anyway. The MCP server then connects to the impostor, sends every command (including the code the agent intends to run and the data it queries), and returns whatever the impostor answers as a tool result, straight into the agent's context. Port 8080 is also the most commonly used development port, so accidental collision is likely on a developer's machine.

Remediation: random ephemeral port plus token as in F1; surface bind failure to the user. Consumer-fixable by fork.

### F4. Destructive operations with no confirmation, dry-run, or undo hint (High, design)

Two independent delete paths: `delete_element` (`DeleteElementEventHandler.cs:62-71`, `doc.Delete(elementIdsToDelete)`) and `operate_element` with `action: "Delete"` (`OperateElementEventHandler.cs:248-255`). Neither reports Revit's cascade-deletion list, asks for confirmation, or supports a dry run. The room-creation and room-tagging paths install failure preprocessors that delete warnings by substring-matching localized description text:

```csharp
// commandset/Services/Architecture/CreateRoomEventHandler.cs
27: if (description.Contains("Number") || description.Contains("number") ||
28:     description.Contains("duplicate") || description.Contains("Duplicate"))
29:     failuresAccessor.DeleteWarning(failure);
```

`Utils/DeleteWarningSuperUtils.cs` goes further (resolves every Error and deletes every Warning, returns `ProceedWithCommit`) but is currently unused in the command set.

Remediation: this is the same gate Formwork already has as a design item (ADR-0011 write guardrails). A consumer cannot add it without forking the server and plugin.

### F5. Remote UI hang and resource exhaustion (High, mixed)

- `say_hello` exists to pop a `TaskDialog` (`SayHelloEventHandler.cs:22`), and most handlers' error paths do the same (`DeleteElementEventHandler.cs:57,76,82`, `TagWallsEventHandler.cs:185`, `CreateLineElementEventHandler.cs:256`, and eleven more). A `TaskDialog` on the Revit UI thread is modal; every queued `ExternalEvent` behind it stalls until the architect dismisses it. From the network this is a one-line denial of service.
- One thread per accepted connection with no cap (`SocketService.cs:148-154`), each blocking up to 60-120 s on the UI thread (`ExecuteCodeCommand.cs:41`, `SocketClient.ts:141`). No request size limit, no rate limit.
- The read loop does a single `stream.Read` into an 8192-byte buffer (`SocketService.cs:174,184`) and parses that as a complete message. There is no length prefix or delimiter on either side (`SocketClient.ts:133` writes the JSON with no terminator). A request over 8 KB, which a real C# snippet or a long element-ID list easily is, arrives as fragments that each fail to parse; the plugin answers each with `id: null`, the server maps a null id to `"default"` and finds no callback (`SocketClient.ts:81-86`), and the tool call hangs for the full 2 minutes. Partial reads can happen on smaller messages too.

Remediation: length-prefixed framing, a bounded worker pool, a hard message size cap, and no dialogs on any path reachable from the socket. Consumer-fixable by fork; the framing change touches both sides.

### F6. Shared singleton handler state races across connections (Medium, bug)

```csharp
// RevitMCPSDK/API/Base/ExternalEventCommandBase.cs
35: protected ExternalEvent Event { get; } = ExternalEvent.Create(handler);
46: protected bool RaiseAndWaitForCompletion(int timeoutMs = 10000)
47: { Event.Raise(); return Handler.WaitForCompletion(timeoutMs); }
```

Each command is registered once (`RevitCommandRegistry.cs:12`) with one handler and one `ExternalEvent`. `SetExecutionParameters` (`ExecuteCodeEventHandler.cs:33-40`) writes `_generatedCode` into that shared instance. The MCP server serializes its own calls with a promise mutex (`ConnectionManager.ts:5-21`), but nothing serializes a second client. Two overlapping requests to the same command: the second overwrites the first's code before Revit's idle loop runs the handler, so the first caller's request executes the second caller's payload, and both wait on the same `ManualResetEvent`. Also `WaitForCompletion` calls `_resetEvent.Reset()` after `Raise()`, which is a lost-wakeup race on its own.

Remediation: a per-request handler or a lock around set-raise-wait. Upstream SDK change ideally; consumer can wrap in the plugin.

### F7. Client and project data persisted in plaintext outside the model (Medium, design)

```ts
// server/src/database/db.ts
10: const DB_PATH = join(__dirname, '..', '..', 'revit-data.db');
```

With the documented `npx -y mcp-server-for-revit` launch, that resolves to the package root inside the npx cache (`%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\mcp-server-for-revit\revit-data.db`). `store_project_data` writes `client_name`, `project_address`, `project_path`, `author`; `store_room_data` writes room comments. It persists across sessions and projects, sits outside any document-management or retention control the firm has, and an npx cache prune deletes it without notice. No encryption, no access control beyond the user profile.

Remediation: don't enable or use the three `store_*`/`query_stored_data` tools; in a fork, delete them or move the DB to a documented per-user data directory with a retention rule. Consumer-fixable.

### F8. Supply chain (Medium, design)

- **Unpinned launch.** The README's `npx -y mcp-server-for-revit` resolves to the latest published version on every cache miss. Publishing is triggered by any `v*` tag push (`release.yml:3-6`) by anyone with write access; the org has two contributors with 21 and 3 commits, and the repo is seven months old. Positive: npm provenance attestation is present, and I verified the published 1.0.0 tarball is byte-identical to a local `tsc` build of the tag (`BUILD IDENTICAL`, `PACKAGE.JSON IDENTICAL`).
- **Floating NuGet versions.** `RevitMCPSDK` and all `Nice3point.*` packages use `$(RevitVersion).*` (`RevitMCPPlugin.csproj:59-61`, `RevitMCPCommandSet.csproj:56-61`), so a release build picks whatever the newest patch is that day. `RevitMCPSDK` is published by an individual unrelated to this org (DTDucas). Builds are not reproducible.
- **Unsigned release binaries.** I downloaded the v1.0.0 Revit 2026 ZIP and parsed the PE headers: `RevitMCPPlugin.dll`, `RevitMCPCommandSet.dll`, and `RevitMCPSDK.dll` carry no Authenticode signature and are not strong-named (the Microsoft and Newtonsoft DLLs in the same ZIP are signed). There is no checksum on the release page. A user cannot distinguish a tampered ZIP from a real one; Revit's "Always Load" prompt is the only gate.
- **CI.** Actions are pinned by floating tag, not SHA (`actions/checkout@v4`, `softprops/action-gh-release@v2`), with `contents: write` and `id-token: write`. No `pull_request_target` misuse; publishing only runs on tags.
- **`npm audit`.** 12 advisories (9 high) on both lockfiles. All are transitive via `@modelcontextprotocol/sdk`'s HTTP stack (`hono`, `express`, `path-to-regexp`, `qs`, `body-parser`) that stdio mode never loads, plus `ws`, which this project never imports. Reachability is low. `better-sqlite3` has an `install` script that downloads a prebuilt native binary at install time (`prebuild-install`).

Remediation: pin `npx -y mcp-server-for-revit@1.0.0` or vendor the package; in a fork, pin NuGet versions and sign the DLLs. Consumer-fixable.

### F9. Config-driven assembly loading (Low, design)

`CommandManager.cs:107-124` loads any `assemblyPath` from `commandRegistry.json`, absolute paths allowed (line 108), via `Assembly.LoadFrom`. The registry and DLLs live under `%AppData%\Autodesk\Revit\Addins\<ver>\revit_mcp_plugin\`, which the user can write to, so this is the same trust level as the add-in itself. The settings UI additionally loads "the first DLL found" when a manifest omits the path (`CommandSetSettingsPage.xaml.cs:105-108`). Not remotely reachable; no remediation needed beyond noting it.

### F10. Model strings returned to the LLM unlabelled (Low, design)

`get_current_view_elements` returns `Comments`, `Mark`, `Level`, `Family`, `Type` verbatim (`GetCurrentViewElementsEventHandler.cs:203-210`); `export_room_data` returns room `Comments`, `Department`, `Occupancy` (`ExportRoomDataEventHandler.cs:64-74`); 21 of the server tools do `JSON.stringify(response)` with no framing that tells the agent this is data. A third-party RVT (consultant, previous firm, download) with an instruction in a Comments parameter reaches the agent as-is. On its own that is Low; combined with F2 it is a path from "open this model" to code execution. Remediation on the server side is straightforward (wrap results in a labelled data block) and consumer-fixable.

### F11. Reflection type lookup from caller string (Informational)

`AIElementFilterEventHandler.cs:213-224` calls `Type.GetType(settings.FilterElementType)` with three name patterns, then passes the result to `new ElementClassFilter(type)`, which throws for non-Element types. It cannot load new assemblies and the resolved type is only used as a filter. Not exploitable.

### F12. Misleading documentation and dead code (Informational)

The README and server README say WebSocket; the code is raw TCP. `ws` is declared but unused. `CommandExecutor.cs` and `ExternalEventManager.cs` have no callers (the only logging of method names is in the dead `CommandExecutor`, so there is no caller-controlled log injection in the live path). `modify_element.ts`, `search_modules.ts`, and `use_module.ts` are zero-byte files. `ProjectUtils.SaveToDesktop` (line 1045) writes to the Desktop but is unused. The port setting is read and ignored. The v1.0.0 ZIP ships two `.addin` files with the same ClientId (fixed on `main`, PR #19). `SocketService.cs:201` traces every full request, including C# code, to `OutputDebugString`, visible to any local debugger. No telemetry, no hardcoded secrets, no network egress beyond the local TCP connection in plugin, command set, SDK, or server.

### H1. Browser drive-by POST (hypothesis, unverified)

Because the plugin does one raw `Read` and parses the bytes as JSON, a web page doing `fetch("http://<workstation>:8080", {method:"POST", mode:"no-cors", body: jsonrpc})` would only need the HTTP body to arrive in a separate TCP segment from the headers for the body alone to parse as a valid request. Chromium sends bodies above roughly 1.4 KB in a separate write. Modern Chrome's Local Network Access policy blocks public-origin pages from reaching localhost or private addresses without a permission grant, so the realistic vector is an intranet page or a browser without that policy. Classic cross-site WebSocket hijacking does not apply: the handshake bytes never parse as JSON. I could not test this without a running Revit instance.

## 5. Mitigation plan for deployment as-is

If you ran the published release with no code changes:

1. Never enable `send_code_to_revit` in the Settings dialog, and check `Commands\commandRegistry.json` does not list it. This removes F2 but nothing else.
2. Windows Defender Firewall: an inbound rule blocking TCP 8080 for `Revit.exe` from any remote address, on all profiles. Since the bind is `0.0.0.0`, this is the only thing standing between the LAN and the plugin. Verify with `netstat -ano | findstr :8080` from another machine's perspective.
3. Before clicking the ribbon toggle, confirm nothing else owns 8080 (`netstat -ano | findstr :8080`), and turn the listener off when the session ends.
4. Drive the agent against a detached copy of the model, never the live central file, and rely on Revit's undo and versioned backups for F4.
5. Pin the server: `npx -y mcp-server-for-revit@1.0.0` in the MCP client config, and record the `dist.integrity` hash (`sha512-/ael18jd...`) so a re-resolve can be checked.
6. Do not use the three `store_*` / `query_stored_data` tools; delete `revit-data.db` from the npx cache if it appears.
7. Do not open third-party RVTs during an agent session (F10).

Residual risk after all of the above: any local process can still drive every enabled command (F3, F5, F6); a prompt-injected agent still has unconfirmed delete (F4); a modal dialog from any error path still stalls Revit (F5); and the workstation has no way to detect a tampered add-in ZIP (F8). That residual is what makes this no-go without a fork.

Fork changes that close the Critical and High findings, roughly 150 lines: loopback bind plus token (F1, F3), drop the code command from `command.json` (F2), length-prefixed framing with a size cap and a bounded worker pool (F5), replace every `TaskDialog.Show` on a socket-reachable path with an error response (F5), and pin the NuGet versions (F8). F4 needs a real confirmation and dry-run layer and is a design change, not a patch.

## 6. Comparison to a safe baseline

**Bridge.** A well-designed bridge binds loopback only, picks a random ephemeral port, writes the port and a per-session random token to a file readable only by the user, requires the token on every request, uses length-prefixed or newline-delimited framing, enforces a message size cap and a bounded worker pool, returns back-pressure instead of growing queues, and never draws UI from a request path. This project has none of those. It is the inverse of Formwork's own add-in (auth on every request, a per-op timeout class, a 64-deep queue cap answering `REVIT_BUSY`, and a failure processor that replaces dialogs).

**Code execution.** The safe baseline is not to have it. If a project keeps it, the bar is: off by default per session, a visible confirmation in Revit showing the code, an explicit reference allowlist rather than "everything loaded", syntax-level rejection of process, file, network, and reflection namespaces, a timeout with cancellation, isolation in a collectible `AssemblyLoadContext`, and an append-only log of every snippet. This project has only the off-by-default checkbox.

**File paths.** No tool here takes a path, which is the safe baseline by accident. The one file the server writes, the SQLite DB, should live in a documented per-user data directory with a retention rule, not in the npm cache. Formwork's `PathPolicy` model (per-class roots, deny when unconfigured, junction-resolving canonicalization) is the reference if any file tool is ever added.

## 7. Not reviewed, and why

- **Dynamic behaviour.** No Revit instance was available here, so the modal-dialog stall, the >8 KB fragmentation hang, the F6 race, and H1 are reasoned from code, not exercised.
- **Binary packages.** `RevitMCPSDK` was reviewed from its GitHub source at `66c35eb3`, not decompiled from the `2026.0.0.5` nupkg the build actually resolves; the `Nice3point.*` packages were not reviewed at all. The floating version ranges mean the shipped bytes may differ from any source snapshot.
- **Release ZIPs.** Only the Revit 2026 ZIP was downloaded and checked for signatures; 2020-2025 were not.
- **Revit 2027.** The repo has no 2027 build configuration or CI job, so nothing here has been built or tested against Formwork's target version. The SDK does publish a `2027.0.0.5` package, so a port is possible, but it is your work.
- **npm advisories** were assessed for reachability by import analysis, not by tracing each advisory's code path.
