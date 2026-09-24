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

### Added
- `CLAUDE.md` documenting architecture, dev commands, and the development workflow.
- `docs/security-reviews/` with the internal security review this fork is responding to.
- `BACKLOG.md`, `TODO.md`, `PROGRESS.md` for tracking work outside of `CLAUDE.md`.
- `.github/workflows/build.yml`: build-only workflow (manual dispatch, plus automatic runs on PRs touching `plugin/`/`commandset/`/`server/`) that uploads a real Windows-built package as a workflow artifact — no local `dotnet` install needed to get a testable build, and PRs are now actually build-checked before merge.
- `docs/manual-verification.md`: step-by-step instructions for installing a build on a real Revit machine and smoke-testing the F1 auth fix.
