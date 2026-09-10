# Stage 3G — statement entry points

Stage 3A–3F checkpoint: `5876e7e` (`Complete Stage 3 reconciliation review and commit safeguards`). Stage 3G adds entry points without making Telegram part of the required monthly flow.

## Setup in Apps Script / Sheets

1. Sync the updated code, including `testStage3G.gs`, and run `runAllTests()` in the Apps Script editor.
2. Reload Budget 2026. The **💰 Budget** menu appears through `onOpen()`.
3. Select **Set up Drive inbox and automatic scan** and authorize the requested Sheets/Drive/trigger access. This creates or reuses `BudgetStatements/inbox` and `BudgetStatements/processed` in My Drive, stores their IDs and the target spreadsheet ID in Script Properties, and creates the 15-minute `dispatch` trigger only if it is absent. Existing triggers are not deleted by this setup.
4. Drop original CSV/PDF files into `inbox`. Use **Reconcile statements from Drive** for an immediate scan, or wait for the heartbeat.
5. Choose **Review staging**, review and edit the rows, tick the ones to import, then optionally choose **Preview ticked rows**.
6. Choose **Import ticked rows from staging** to write the checked rows. This explicit action performs a real commit even while the editor's reconciliation default remains dry-run. Successfully imported rows move to `_ReconcileHistory`.

## Keeping the review queue clear

`_Reconcile` is the active queue. Ticking a row means you intend to import it; it stays visible until the import succeeds. The menu then moves completed rows into `_ReconcileHistory`, preserving all reviewed fields, the source details, status, reason, and completion timestamp.

For an edge case that needs no import, select its row (or any cells in the relevant rows), then choose **Reviewed — do not import selected rows**. Enter a reason in the dialog, such as “Already included in another account” or “Personal adjustment.” The selected rows receive status `dismissed` and move to history. This action uses the highlighted selection, independently of the import checkboxes. Cancel leaves the queue unchanged.

Suspected duplicates stay in the queue as `duplicate_review` until you decide whether to dismiss or correct them. Unticked and ambiguous rows also stay for review. Previewing does not archive anything.

Use **Archive completed review rows** once to clear older `imported` rows already in your tab, or to retry an interrupted archive. Rows are saved to history before being removed, and retries reuse the saved review IDs. Editor calls to `commitStaged()` retain their statuses in staging; this cleanup menu also handles those rows. **Open review history** opens the reference tab.

Dismissals are remembered on later reconciliation runs using the original date, account, cardholder, signed amount and exact statement descriptor. One dismissed occurrence suppresses only one matching occurrence, including when the same statement is uploaded under a new file ID. Changed descriptors or other cards are not suppressed by a fuzzy match. Older rows without an original descriptor or known cardholder can still be archived, but cannot be reliably recognised on another upload. For new proposals, the original identity is retained even if you edit their displayed fields before dismissing them. Sort the whole sheet/table so all row fields stay together.

Use the sandbox spreadsheet for the first end-to-end check. If configuring sandbox and live instances, use separate script projects/configurations; setup refuses to silently rebind an existing inbox to a different spreadsheet.

## File handling

- Menu, scheduled scanner, and Apps Script editor (`reconcileFromDrive`) share the same scanner and pipeline.
- Each file appends to `_Reconcile`; earlier ticks, merchant/category/type edits and statuses are retained. Pending staging rows participate in overlap checks, so overlapping statements do not ordinarily create a second pending proposal for the same occurrence.
- Files move to `processed` only after successful staging. **Processed means staged, not imported into Transactions.** Nothing automatically approves or imports rows.
- `_ReconcileFiles` records file ID, name, modification time, status and result/error. Staging source cells include `[Drive:<file-id>]` for recovery and traceability.
- Retries of staged files retry the move rather than stage them again. A source marker recovers from a completed staging write followed by a journal failure.
- Failed/encrypted/unsupported files stay in the inbox. Unchanged failures are skipped until **Retry failed inbox files** is selected or the file changes. Other files continue processing.
- Once staged, a source file is treated as an immutable snapshot. Upload revisions as new files; edited already-staged files are not silently treated as their prior version.
- Each scan starts at most five file attempts and uses a bounded runtime budget. Remaining files wait for another scan. A single PDF/model call still depends on Apps Script/model execution limits.
- **Pause automatic inbox scan** stops scheduled scans; manual reconciliation remains available.
- Native Google documents are rejected. Upload the original bank CSV/PDF without converting it to Sheets. DBS card-section checks remain in force.

## Optional Telegram

CSV/PDF document uploads enqueue a file into the configured inbox and acknowledge it. They use the same scanner and sheet review later; no batch approval wizard is required. Telegram file IDs prevent retrying the same upload from creating another inbox file. Inbox setup must happen first.

The workbook flow needs no Telegram messages. The old unauthenticated GET diagnostics remain removed. HTTP CSV submission, a standalone CLI, and new GCP/API configuration for `clasp run` are not added in this stage; they are alternatives to the selected menu/inbox approach.

## Tests and remaining acceptance

Checkpoint verification: 62 local tests pass, including 419 assertions from the native test functions. This is an implementation checkpoint; full stage acceptance still requires the live checks below.

Two usability follow-ups remain: **Preview ticked rows** currently reports only in the Apps Script execution log, and existing pending proposals are not automatically refreshed against transactions entered manually after staging. Dismiss those already-covered rows explicitly using the review action for now.

Run `node scripts/test-regressions.cjs` locally. The suite includes date repair, queue cleanup, archive interruption/retry, selection/cancellation, and exact occurrence-based dismissal matching, alongside the pipeline and import regressions. All `.gs` files are also checked for syntax.

The Stage 3G tests are also discovered by `runAllTests()`: inbox retries, failures, recovery markers, menu/scheduler setup, model-parser card sections, and changed-file handling. Offline tests additionally exercise real pipeline append behavior, overlapping statements, preservation of review edits, and explicit menu import/idempotency using in-memory sheet doubles.

Before calling the whole stage accepted, verify in Apps Script against a sandbox:

- Menu creation and folder setup; repeat setup leaves one dispatcher.
- One real CSV and one real PDF, including an overlapping date window and all applicable card sections.
- Existing review edits survive the second file; both sources appear in the journal; successful files move to processed.
- Failed/encrypted input remains in inbox; retry does not duplicate the earlier staged rows.
- Checked rows import with correct Notes/types/balance formulas; a second import adds nothing.
- Successful imports leave the queue and appear in history. Selected edge cases save their reason without importing; uploading the same statement again respects those dismissals.
- The scheduled trigger actually picks up a newly dropped file.

No cloud folders, triggers, deployments or ledger writes were executed from the local implementation session. Earlier sandbox commit logs verify the controlled 3F commit test, but do not certify these new entry points or arbitrary statement extraction accuracy.
