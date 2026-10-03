# Changes synced on 3 October 2026

This checkpoint collects all pending work since `1e89178` on `codex/stage-5`.
Earlier commits remain the authoritative history; this file describes the changes
included in this checkpoint, rather than claiming every item was built today.

## Monthly coach (Stage 5)

- Added `monthlyInsights.gs` to analyze ordinary spending against the monthly
  budget, separate mandatory costs and allocations, explain category overruns,
  identify contributing purchases, and use recorded history for recommendations.
- Added category-level analysis and target recommendations, with missing-history
  limits and evidence-backed report rendering rather than invented model claims.
- Hardened monthly readers, money/percentage handling, missing-data detection,
  and report grounding. Added a read-only monthly coach menu preview.
- Added complete delivery of long Telegram reviews as multiple parts, with saved
  report content and progress so retries resume after accepted parts. Expired
  monthly snapshots are cleaned up.
- Added monthly review, complete-delivery, Stage 5 and snapshot verification
  tooling. See `stage-5-monthly-coach.md` for prior verification and limitations.

## Next-month preview (Stage 6B)

- Added a read-only planner and menu preview showing the source template, target
  month, and exact proposed cell changes. Automatic creation remains disabled.
- Recognizes legacy and yearless Russian month names, selects an earlier valid
  template, treats existing months as no-ops, and rejects annual boundary or
  unsupported-template changes.
- Plans date/input resets, live mandatory payment status, daily spending
  descriptions and the I38 date helper correction while preserving other formulas.
- Added a synthetic template fixture and offline checks. Native Sheets formula
  recalculation, formatting and a controlled creator remain future acceptance work.
- Updated configuration, README and staged requirements/checkpoint documents.

## Telegram transaction corrections

- Fixed the rename handler's reassignment of a constant, which previously threw
  before saving and allowed the reply to fall through to general AI extraction.
- Rename replies now stop after handling success, stale state or failure.
- Merchant and category edits are transaction-local, take precedence over learned
  aliases, and are excluded from global merchant learning on approval.
- Rename prompts identify the selected item and amount. A saved transaction
  snapshot rejects replies if that selection changed or expired.
- Added regressions for S$46.86 FairPrice to Unity / Медицина with S$16.10 left
  unchanged, both editing orders, stale/reordered state, expiry, processed state
  and failure without AI fallback.
- This does not migrate previously saved incorrect aliases or ledger rows.

## Verification and release scope

- `node scripts/test-regressions.cjs`: 198 tests passed, with 555 existing
  assertions exercised and all Apps Script source files parsed.
- `node scripts/telegram-edit-regressions.cjs`: six checks passed.
- `git diff --check`: passed.
- `clasp push` synchronizes Apps Script source. It does not update a versioned
  web-app deployment; that separate step is required for the existing Telegram
  webhook to use these changes.
- No live transaction repair, workbook migration, automatic month creation or
  live Telegram acceptance test is included in this checkpoint.
