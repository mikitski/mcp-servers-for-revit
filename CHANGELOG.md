# Changelog

Notable changes to this fork. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
For the full commit history, use `git log`.

## Unreleased

### Security
- Fixed F1 (from the 2026-09-21 security review, `docs/security-reviews/`): the plugin's TCP socket now binds `127.0.0.1` only (was `0.0.0.0`) and requires a per-session auth token on every request.
- Fixed F2: removed `send_code_to_revit` (arbitrary C# execution in Revit) entirely — the TS tool, the C# command/handler, its `command.json` entry, and the unused Roslyn package reference.

### Changed
- `main` is now branch-protected: no direct pushes, all changes go through a PR.
- Release process moved fully into GitHub Actions: `prepare-release.yml` bumps versions on a `release/vX.Y.Z` branch and opens a PR; merging it triggers `release.yml`, which tags the merge commit and builds/publishes the GitHub release. Replaces the old local `scripts/release.ps1` + manual `git push origin main --tags` flow.
- Removed npm publishing — this fork doesn't own the `mcp-server-for-revit` package name on npm.

### Fixed
- `release.yml`'s build job used Node 18 to build `server/`, which fails outright (`better-sqlite3` has no Node 18 prebuild and its native compile needs Visual Studio build tools the runner doesn't have). This was never hit because no real release had run since the GHA migration — caught when `build.yml`'s first live run failed the same way. Bumped both workflows to Node 22, matching `server/package.json`'s `engines.node` requirement.
- `server/src/utils/authToken.ts` couldn't find the session token file when the server runs as a WSL/Linux process (e.g. `node <path>` in Claude Code's config, rather than the README's `cmd /c npx ...`) — `LOCALAPPDATA` isn't set and `os.homedir()` returns the Linux home. Now detects WSL and asks `cmd.exe` for the real Windows path, translating it to `/mnt/<drive>/...` (factored into `server/src/utils/windowsEnv.ts`).
- Even with the token fix above, a WSL-hosted server still couldn't reach the plugin at all: WSL2's loopback forwarding is commonly Windows→WSL only, so a WSL process connecting out to `127.0.0.1:8080` gets refused even when a native Windows process reaches it fine (confirmed: `netstat` showed the plugin correctly listening on `127.0.0.1:8080`, but a raw connection attempt from WSL was refused). `SocketClient.ts` now relays each command through a native `powershell.exe` process (`server/src/utils/windowsRelay.ts`) when running under WSL, rather than connecting directly. Verified end-to-end against a live Revit 2027 instance.

### Added
- `CLAUDE.md` documenting architecture, dev commands, and the development workflow.
- `docs/security-reviews/` with the internal security review this fork is responding to.
- `BACKLOG.md`, `TODO.md`, `PROGRESS.md` for tracking work outside of `CLAUDE.md`.
- `.github/workflows/build.yml`: build-only workflow (manual dispatch, plus automatic runs on PRs touching `plugin/`/`commandset/`/`server/`) that uploads a real Windows-built package as a workflow artifact — no local `dotnet` install needed to get a testable build, and PRs are now actually build-checked before merge.
- `docs/manual-verification.md`: step-by-step instructions for installing a build on a real Revit machine and smoke-testing the F1 auth fix.
- **Revit 2027 support**: new `R27` build configuration (`net10.0-windows10.0.19041.0`) in both `.csproj` files, the `.sln`, and `build.yml`/`release.yml`. Fixed one real API break this surfaced: `GeometryUtils.FindIntersection` used the now-removed `Curve.Intersect(Curve, out IntersectionResultArray)` overload; deleted it (it had no callers). Both build workflows now install .NET 10 SDK alongside .NET 8 to build the new config. `tests/commandset/`'s TUnit harness still doesn't cover 2027 (see `BACKLOG.md`).
