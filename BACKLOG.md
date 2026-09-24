# Backlog

Known issues and improvements that are not yet scheduled. Not a substitute for
GitHub Issues — this is for tracking items that came out of internal review
work (security review, architecture notes) before they're turned into issues.
When picking one up, open a GitHub issue/PR and remove it from here.

## Security (from `docs/security-reviews/2026-09-21-security-review.md`)

F1 (unauthenticated socket) and F2 (arbitrary code execution) are fixed — see
`CHANGELOG.md`. Remaining findings, most severe first:

- **F3 — High.** MCP server trusts whatever answers on `localhost:8080` with no peer verification. A local process that binds the port first (accidental or malicious) can impersonate the plugin and inject fake results into the agent. Fix: the auth token (now required) mitigates the "arbitrary local process" case since an impostor won't know the token, but bind-failure is still silent (`SocketService.Start()` swallows the exception) and the ribbon reports success anyway — surface bind failures to the user.
- **F4 — High.** Destructive operations (`delete_element`, `operate_element` delete) have no confirmation, dry-run, or undo hint. Room creation/tagging paths auto-delete Revit warnings by substring-matching localized text. Needs a real confirmation/dry-run layer, not a patch.
- **F5 — High.** Modal `TaskDialog`s on socket-reachable error paths cause a remote UI hang (one dialog stalls every queued `ExternalEvent`). One thread per connection with no cap. No message framing or size limit — requests over ~8KB fragment and silently hang for the full 2-minute timeout.
- **F6 — Medium.** Singleton command handler state races across overlapping requests to the same command (`RevitMCPSDK/API/Base/ExternalEventCommandBase.cs`); a per-request handler or a set-raise-wait lock is needed. Partly upstream-SDK owned.
- **F7 — Medium.** `store_project_data`/`store_room_data` persist client/project data in plaintext SQLite inside the npx cache, outside any document-management control. Consider deleting these three tools or moving the DB to a documented per-user data directory with a retention rule.
- **F8 — Medium.** Supply chain: unpinned `npx -y mcp-server-for-revit` launch, floating NuGet versions (`$(RevitVersion).*`), unsigned/unstrong-named release DLLs, `npm audit` advisories (transitive, low reachability in stdio mode).
- **F9 — Low.** `CommandManager.cs` loads any `assemblyPath` from `commandRegistry.json` via `Assembly.LoadFrom`, including absolute paths. Same trust level as the add-in itself; not remotely reachable.
- **F10 — Low.** Model strings (Comments, Mark, room Department/Occupancy, etc.) are returned to the LLM unlabelled as data, so a third-party RVT could carry a prompt injection. Wrap tool results in a labelled data block.
- **F11 — Info.** Reflection type lookup from caller string in `AIElementFilterEventHandler.cs`; bounded by `ElementClassFilter`, not exploitable.
- **F12 — Info.** Misleading docs (README/server README said "WebSocket"; fixed as part of CLAUDE.md — actual transport is raw TCP), unused `ws` npm dependency, dead code (`CommandExecutor.cs`, `ExternalEventManager.cs`, three zero-byte tool files), full request tracing to `OutputDebugString` including any code payloads.
- **H1 — Hypothesis, unverified.** Possible browser drive-by POST reaching the plugin's parser from an intranet page; not testable without a running Revit instance.

## Other

- No Revit 2027 build configuration or CI job exists yet; Formwork (a related project) targets 2027. A port is possible since the SDK publishes a `2027.0.0.5` package, but nothing here has been built/tested against it.
