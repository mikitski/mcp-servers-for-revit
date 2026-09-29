# TODO

Near-term, concrete action items. Contrast with `BACKLOG.md` (larger/unscheduled
issues) and `docs/security-reviews/` (the source findings). Check items off or
delete them once done; this file should stay short.

- [ ] Manually verify the F1/F2 security fixes (merged in PR #2) against a running Revit instance — follow `docs/manual-verification.md` end to end (loopback bind, token round-trip, unauthorized request rejected, `send_code_to_revit` gone from the Settings UI)
- [ ] Confirm the two required Actions repo settings are enabled (workflow read/write permissions, Actions can create PRs) and do a real end-to-end test of `prepare-release.yml` → PR → merge → `release.yml`
- [ ] Decide on an approach for F4 (destructive-op confirmation/dry-run) — design work, not a quick patch
