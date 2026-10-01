# Progress log

Running, dated notes on work sessions in this fork — what happened and why,
for context that doesn't belong in `CLAUDE.md` (instructions), `CHANGELOG.md`
(shipped changes), or `BACKLOG.md`/`TODO.md` (open work). Newest entries at
the top.

## 2026-09-30 (later)

- Live-tested the WSL relay (PR #6) against real Revit 2027 from Claude Code itself: `analyze_model_statistics` succeeded on the first call after reconnecting (real project data, 20709 elements). Revit was then restarted independently (PID changed); after the user clicked Start again and the socket was confirmed listening, the *same* long-running MCP server process started failing every subsequent call with an opaque `execFileSync` "Command failed" error and no stderr.
- Spent real effort isolating this: confirmed the relay script file on disk was intact, confirmed a fresh manual invocation of the exact same command (same host/port/payload/script) succeeded reliably every time from a plain bash shell, and ruled out several hypotheses by direct reproduction - missing PATH (produces a distinct `ENOENT`, not this), `execFileSync`'s own timeout killing the child (produces `ETIMEDOUT`+`SIGTERM`, not this), the relay script throwing (produces visible stderr, not this), and WSL's UNC-path CWD fallback when launched from outside `/mnt/c` (reproduced the UNC fallback itself, but the relay still succeeded despite it).
- Net result: fresh processes work every time; the one long-running server process that was already alive before Revit restarted started failing consistently after. Root cause not identified - something accumulating in *that process's* state across repeated calls is the leading theory, not a problem with the relay mechanism itself (which keeps working from every fresh invocation). Recommended the user reconnect (`/mcp`) to respawn the server process fresh, rather than keep debugging the live process further.
- Improved `windowsRelay.ts`'s error reporting either way (it was uselessly opaque - just "Command failed: powershell.exe ..." with no exit code/stdout/stderr), so a recurrence will actually be diagnosable next time instead of starting from zero again.

## 2026-09-30

- Merged PR #4 (Revit 2027 support) and PR #5 (WSL token-path fix) into `main`.
- User downloaded a `build.yml` artifact, extracted the `Revit2027/` bundle, and I installed it into `%AppData%\Autodesk\Revit\Addins\2027\` (no conflicts with the existing `Formwork` install there) and registered `mcp-server-for-revit` in Claude Code's user-scope config (`node <path-to-server/build/index.js>`, same pattern as `formwork`).
- First live tool call failed with "connect to revit client failed" even after PR #5's token-path fix. Diagnosed from first principles: `netstat` via `cmd.exe` showed the plugin correctly listening on `127.0.0.1:8080` (PID matched `Revit.exe`), but a raw WSL `bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080'` also got refused — proving WSL2's loopback forwarding doesn't work WSL→Windows in this setup (formwork's own port 8765 was equally unreachable directly from WSL). User confirmed their other (working) sessions use "a PowerShell relay" for this instead.
- Implemented that: `server/src/utils/windowsRelay.ts` shells out to `powershell.exe -ExecutionPolicy Bypass` per command, relaying the JSON-RPC payload over stdin/stdout. Factored the shared WSL/LOCALAPPDATA detection out of `authToken.ts` into `server/src/utils/windowsEnv.ts` so both modules use it. Hit and fixed one real snag along the way: PowerShell's default execution policy blocked the unsigned relay script outright.
- Verified for real against the live Revit 2027 instance (which was mid-way through an unrelated user test — did not restart Revit or touch any documents): `get_current_view_info` returned actual view data end-to-end. Accidentally used `say_hello` (a modal-dialog command) for an earlier test attempt before switching to read-only commands - its `ExternalEvent` may still be queued and could pop a dialog later; flagged to the user rather than hidden.
- This is the deepest real-environment verification this whole effort has had: loopback bind, token auth, and now cross-WSL-boundary connectivity all confirmed working against actual running Revit 2027, not just Docker cross-compiles.

## 2026-09-29

- Merged PR #3 (build.yml, manual-verification.md, Node 22 fix) into `main` (`f274538`).
- User's only Revit install is 2027, which this repo didn't support at all (no `R27` config anywhere). Confirmed via NuGet that `RevitMCPSDK` (`2027.0.0.5`) and the `Nice3point.Revit.Api.*`/`Toolkit`/`Extensions` packages (`2027.x`) are published, so did the port: added `R27` configs to both `.csproj` files and the `.sln` (`net10.0-windows10.0.19041.0` — Revit 2027 moved from .NET 8 to .NET 10), and R27 build steps to `build.yml`/`release.yml` (which also needed `actions/setup-dotnet` to install .NET 10 SDK alongside 8, since they're different major versions).
- Docker-verifying R27 caught a real API break: `GeometryUtils.FindIntersection` used `Curve.Intersect(Curve, out IntersectionResultArray)`, which Revit 2027 actually removed (2026 had already flagged it obsolete, pointing at a replacement). It had zero callers, so deleted it rather than porting to the new API blind.
- Learned the hard way: switching Docker SDK major-version images (8.0 → 10.0 → 8.0 again) against the same uncommitted `obj/`/`bin/` output corrupts the NuGet lock file cross-version (`Cannot compare the value of a token type 'Number' to text`) — not a real code bug, just don't reuse `obj/` across SDK versions. Documented in `CLAUDE.md`.
- Port only verified by cross-compiling in Docker (`EnableWindowsTargeting=true`) — nothing has run inside actual Revit 2027 yet. That's still the open item in `TODO.md`.

## 2026-09-24

- Merged PR #2 (F1/F2 security fixes, security review, tracking docs) into `main` (`4addbb6`).
- User has real Revit access but needs to coordinate getting builds onto that machine manually — no local `dotnet`/Visual Studio there either. Added `.github/workflows/build.yml`: a `workflow_dispatch` + PR-triggered build that produces a real Windows-built package (all 7 Revit-version AddIn layouts) as a downloadable Actions artifact, no local toolchain needed at all. This also closes the "no CI on PRs" backlog item.
- Added `docs/manual-verification.md`: step-by-step install + smoke-test instructions for verifying a build on real Revit, including the F1 auth-fix checks (loopback-only bind, token file, unauthorized-request rejection).
- `build.yml`'s first-ever live run (triggered by its own PR) failed at "Build MCP Server": Node 18 can't install `better-sqlite3` (no prebuild for Node 18, native compile needs VS build tools absent on the runner). This is a pre-existing bug in `release.yml` too (same Node 18 setup, copied from there), just never exercised since no real release has run since the GHA migration. Fixed both workflows to use Node 22 (matches `server/package.json`'s `engines.node: >=20.0.0`).

## 2026-09-23

- Enabled branch protection on `main` (PR required, no direct pushes).
- Added `CLAUDE.md`. Migrated the release process fully into GitHub Actions (`prepare-release.yml` + reworked `release.yml`), removed `scripts/release.ps1` and npm publishing (PR #1, merged as `fcc6b92`).
- Read the 2026-09-21 internal security review. Triaged findings; F1 (unauthenticated socket) and F2 (arbitrary code execution) are Critical and were implemented first (PR #2): loopback bind + per-session auth token for F1, full removal of `send_code_to_revit` for F2.
- Discovered `dotnet` is not installed in this WSL/host environment. Found that `docker run mcr.microsoft.com/dotnet/sdk:8.0 dotnet build -p:EnableWindowsTargeting=true` successfully builds both `plugin/RevitMCPPlugin.csproj` and `commandset/RevitMCPCommandSet.csproj` (both set `UseWPF`) for compile-only verification, despite the default `NETSDK1100` refusal on Linux. Verified both projects build with 0 errors for `net48` (R20) and `net8.0-windows10.0.19041.0` (R26). Documented this in `CLAUDE.md`.
- Added the security review itself to the repo (`docs/security-reviews/2026-09-21-security-review.md`) and split tracker-style content out of `CLAUDE.md` into this file, `BACKLOG.md`, `TODO.md`, and `CHANGELOG.md`.
- PR #2 is still open pending manual verification against a real Revit instance (see `TODO.md`) — this environment has no Revit install.
