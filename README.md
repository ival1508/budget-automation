# Budget 2026 Automation

Telegram bot + Google Apps Script that logs transactions to the
"Budget 2026" sheet and sends a daily budget coach brief.

## ⚠️ Deployment gotchas (read before touching deployments)

**`clasp push` is NOT a deploy.** Push updates the editor code; the /exec URL
serves a specific deployed *version*. After pushing:
  Deploy → Manage deployments → ✏️ pencil → Version: New version → Deploy
NEVER click "New deployment" — it mints a new URL and 404s the webhook.

**Current /exec URL** (Version 63, 30 Aug 2026):
https://script.google.com/macros/s/AKfycbyhRAocN8rNBhWl3NBL7yIgStBCLIrgHfxNNOC-zt6Pa7HBvQPJ9b7tykdeu4QuMm3_/exec

**Deployment settings MUST be:** Execute as = Me · Who has access = Anyone
(anything else gives Telegram a 401)

**Re-registering the webhook?** doPost validates `e.parameter.secret` against
the WEBHOOK_SECRET script property. The secret must be URL-encoded INTO the
/exec URL or the bot silently returns "Unauthorized" with a 200 and no reply:

  https://api.telegram.org/bot<TOKEN>/setWebhook?url=<EXEC_URL>%3Fsecret%3D<WEBHOOK_SECRET>

Verify: https://api.telegram.org/bot<TOKEN>/getWebhookInfo
The reported `url` must end in ?secret=...

## Script Properties required
TELEGRAM_BOT_TOKEN · GEMINI_API_KEY · WEBHOOK_SECRET · AUTHORIZED_CHAT_IDS

## Scheduling
ONE trigger: `dispatch()` every 15 minutes (created by `setupTriggers()`,
which deletes all existing triggers first). It fires six jobs by clock time,
each guarded by a `sent_<key>=<date>` Script Property. Do not add .atHour()
triggers — .atHour only guarantees the hour, not the minute.

## Verification
Run `verifyStages012()` in the Apps Script editor — 39 read-only checks
across Stages 0–2. Antigravity cannot run Apps Script; it must never be
trusted to report test output it did not execute.

## Docs
See /docs for the PRD and the staged build prompts.

## Offline regression checks

Run `node scripts/test-regressions.cjs` (Node.js 18 or later). It needs no credentials
or dependencies and performs no network or live-sheet operations. It checks the
existing isolated reconciler tests plus matching completeness/account isolation,
locale parsing, all four Telegram save paths, staging archives, commit status,
locking, and missing/negative coach data. Sheet mocks record formula copy requests;
they do not validate actual Sheets recalculation.

GET serves a health check only. Run diagnostics and `runAllTests()` from the Apps
Script editor; the old `?action=...` diagnostic routes are removed.

Reconciliation still defaults to `SHEET_FACTS.DRY_RUN = true`. User-confirmed
Telegram saves explicitly request real writes. Staging reruns copy the previous
review to `_Reconcile_<uuid>` before replacing it. Inference does not update
merchant learning until it exists in the approved ledger. Commit marks written
rows `imported` and skipped key collisions `duplicate_review`, so legitimate
same-key purchases remain visible for manual review rather than being reported
as imported.

Before deployment, run the Stage 3F sandbox checkpoint in Apps Script: verify
11-column writes, F:G balance calculations, and a second commit importing no new
rows. Offline tests cannot certify that checkpoint or installed triggers.

### Apps Script verification received on 9 September

The supplied `runAllTests()` log records 18/20 tests passing (391 assertions passed,
2 failed). The controlled sandbox commit test passed: two rows appended, correct
11-column layout, F:G formulas present, credit balance increased by S$270, repeat
commit added zero rows, and test rows were cleaned up. Fixture staging also passed
without changing the ledger row count. This verifies the controlled commit path,
not a reviewed full real-statement import or production deployment.

The two environment-dependent failures are corrected locally: explicit null/empty
inference keys disable the model instead of reading a saved key, and canonical
matching uses an explicit alias snapshot. The coach also rejects generated money
amounts absent from its monetary payload fields, addressing the unsupported S$50
cap visible in the log. Sync these changes and rerun `runAllTests()` in the editor
for the next Apps Script verification result.

### Merchant duplicate coverage

The subsequent Apps Script log passed all 20 tests (393 assertions), but its live
reconciliation still proposed merchant-name duplicates. `test_reportedMerchantDuplicates()`
now covers all ten user-reported examples, including normalized bank input and
reversed statement order. It is included automatically in `runAllTests()` and in
the offline regression command.

Matching recognizes Redshield VPN, SP Digital/SPGroup, and GV/Golden Village
identities. Food Republic stalls, vending operators, and the user-confirmed
FairPrice app payment/Unity pair require the same transaction day as well as the
existing amount/account/cardholder checks. These shared-venue relationships do not
rename merchants or rewrite categories. Unrecognized merchant names with otherwise
compatible same-day/same-amount ledger rows are staged as ambiguous with the
candidate ledger references and a reason, never auto-matched on amount/date alone.
Run `runAllTests()` and `runLiveReconcile_runner()` after syncing to verify the new
live counts; local fixtures cannot predict all matches in the full ledger.

### Latest statement and allocation diagnostics

`SHEET_FACTS.STATEMENT_FILE_ID` now selects the latest CSV for both the live runner
and the CSV-based diagnostic runner. The FlashPay regression covers the exact
28 August S$50 pair, which already matches in isolation. A further test covers a
same-day same-merchant ledger occurrence being claimed by another statement row:
the remaining collision is now ambiguous, with `already_claimed` and `claimed_by`
evidence, rather than a clean proposal. This does not reuse one ledger row for two
purchases. Known purchases by different named cardholders remain separate.

The supplied 15:50 run is a passing test-suite log, not enough evidence to determine
the full-run cause of the reported FlashPay proposal. The next reconciliation logs
its spreadsheet identity and allocation conflicts, and staging displays the claimed
row's details. Updated live counts require running the latest CSV after syncing.

### Card-section input guard

The 16:16 log showed that the previous file was a native Google Sheets document,
not CSV. Its fallback parse returned 184 rows without card identity. The runner
now targets the replacement file configured in `SHEET_FACTS.STATEMENT_FILE_ID`.
Native Google documents are rejected before implicit blob export, and DBS rows
without a four-digit card suffix stop reconciliation before staging. Unknown
cardholders display as `Unknown`, never default to Val. The replacement file's
MIME and card-section counts still need verification in the next live run.

### Review dropdowns and Notes preview

After syncing, run `repairReconcileDropdowns()` to update the existing review
without replacing its values or checkboxes. E (Тип) lists all seven transaction
types, G (merchant) has no validation, and H retains the category dropdown. New
staging runs apply the same rules. Commit preserves the explicitly reviewed type
and derives incoming/outgoing amount sign from that selection.

Grandparents rows write the literal `Grandparents` into Transactions J (Notes),
identified from the Cardholder field or the card-0465 source marker. To inspect
actual would-be rows, tick the records of interest and run `previewReconcileCommit()`.
It uses the real commit/writer path in dry-run mode, logs Notes, and leaves both
Transactions and staging statuses unchanged.

## Stage 3G: reconcile from Sheets or a Drive inbox

See [Stage 3G setup and acceptance](docs/stage-3g-entry-points.md). After syncing and
reloading the sheet, use **💰 Budget → Set up Drive inbox and automatic scan**,
then drop original statements into the inbox. **Reconcile statements from Drive**
runs immediately; **Review staging → Import ticked rows** completes the workflow.
The scheduled scanner stages only and never automatically imports transactions.

### Repair staging date sorting

New proposals store real Sheets dates in column B, displayed as `DD.MM.YYYY`.
After syncing this update, run `repairReconcileDates()` once in the Apps Script editor,
or reload the sheet and choose **💰 Budget → Repair staging dates**. This converts
existing text dates in place, preserving all other columns and row order. Then sort
the entire review table by column B (ascending). Invalid dates are reported by row
before any cells are changed. Import and pending-duplicate checks accept both legacy
text dates and real dates using the spreadsheet timezone.

### Active reconciliation queue and history

After syncing and reloading Sheets, use **💰 Budget → Reviewed — do not import selected rows**
for edge cases: highlight the rows, enter a reason, and they move to `_ReconcileHistory`.
The import menu moves successfully imported rows there automatically. Ticking alone keeps
a row in the queue until import succeeds; suspected duplicates remain for a decision.
Use **Archive completed review rows** to clear old imported rows already in staging, and
**Open review history** to see completed decisions. Dismissed occurrences with a known
original statement identity are remembered on repeat uploads. See the
[review queue guide](docs/stage-3g-entry-points.md#keeping-the-review-queue-clear).
