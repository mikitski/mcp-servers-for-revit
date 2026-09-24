# TODO

Near-term, concrete action items. Contrast with `BACKLOG.md` (larger/unscheduled
issues) and `docs/security-reviews/` (the source findings). Check items off or
delete them once done; this file should stay short.

- [ ] Manually verify PR #2 against a running Revit instance before merging (no Revit available in the environment that built it):
  - [ ] Plugin loads and the ribbon's socket binds `127.0.0.1:8080` only (check with `netstat`, not `0.0.0.0:8080`)
  - [ ] MCP server can still call a tool end-to-end (token round-trip works)
  - [ ] A raw request to the socket without a token is rejected
  - [ ] `send_code_to_revit` no longer appears in the Settings UI's command list
- [ ] Confirm the two required Actions repo settings are enabled (workflow read/write permissions, Actions can create PRs) and do a real end-to-end test of `prepare-release.yml` → PR → merge → `release.yml`
- [ ] Decide on an approach for F4 (destructive-op confirmation/dry-run) — design work, not a quick patch
- [ ] Add a CI workflow that builds the solution on pull requests (currently nothing validates a PR compiles before merge)
