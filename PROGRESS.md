# Progress log

Running, dated notes on work sessions in this fork — what happened and why,
for context that doesn't belong in `CLAUDE.md` (instructions), `CHANGELOG.md`
(shipped changes), or `BACKLOG.md`/`TODO.md` (open work). Newest entries at
the top.

## 2026-09-23

- Enabled branch protection on `main` (PR required, no direct pushes).
- Added `CLAUDE.md`. Migrated the release process fully into GitHub Actions (`prepare-release.yml` + reworked `release.yml`), removed `scripts/release.ps1` and npm publishing (PR #1, merged as `fcc6b92`).
- Read the 2026-09-21 internal security review. Triaged findings; F1 (unauthenticated socket) and F2 (arbitrary code execution) are Critical and were implemented first (PR #2): loopback bind + per-session auth token for F1, full removal of `send_code_to_revit` for F2.
- Discovered `dotnet` is not installed in this WSL/host environment. Found that `docker run mcr.microsoft.com/dotnet/sdk:8.0 dotnet build -p:EnableWindowsTargeting=true` successfully builds both `plugin/RevitMCPPlugin.csproj` and `commandset/RevitMCPCommandSet.csproj` (both set `UseWPF`) for compile-only verification, despite the default `NETSDK1100` refusal on Linux. Verified both projects build with 0 errors for `net48` (R20) and `net8.0-windows10.0.19041.0` (R26). Documented this in `CLAUDE.md`.
- Added the security review itself to the repo (`docs/security-reviews/2026-09-21-security-review.md`) and split tracker-style content out of `CLAUDE.md` into this file, `BACKLOG.md`, `TODO.md`, and `CHANGELOG.md`.
- PR #2 is still open pending manual verification against a real Revit instance (see `TODO.md`) — this environment has no Revit install.
