# TODO

Near-term, concrete action items. Contrast with `BACKLOG.md` (larger/unscheduled
issues) and `docs/security-reviews/` (the source findings). Check items off or
delete them once done; this file should stay short.

- [x] Manually verify the F1/F2 security fixes and the Revit 2027 port against a running Revit instance: loopback bind confirmed (`netstat` showed `127.0.0.1:8080`, not `0.0.0.0:8080`), token round-trip confirmed (`get_current_view_info` succeeded end-to-end via the WSL relay against live Revit 2027), `send_code_to_revit` confirmed removed from `command.json`/the codebase.
- [ ] Still not directly verified against the live instance: that a request with a missing/wrong token is actually rejected (verified in isolation earlier, not against this real Revit session), and visual confirmation that `send_code_to_revit` doesn't appear in the Settings UI's command list (would require opening Revit's UI, deferred while the user's unrelated test is running).
- [ ] Confirm the two required Actions repo settings are enabled (workflow read/write permissions, Actions can create PRs) and do a real end-to-end test of `prepare-release.yml` → PR → merge → `release.yml`
- [ ] Decide on an approach for F4 (destructive-op confirmation/dry-run) — design work, not a quick patch
