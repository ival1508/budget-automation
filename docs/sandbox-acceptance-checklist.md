# Reconciler sandbox acceptance — 16 September 2026

Status: **complete — confirmed by Val on 16 September 2026**. Val explicitly
confirmed both the full sandbox acceptance checklist and the live webhook's
existing-deployment new-version update are done. Checklist completion below is
recorded from that owner confirmation; no new execution, individual run-result
inspection or deployed-version lookup was performed during this update.

Source implementation and 136 offline tests pass. The completed sandbox scope
covers actual Apps Script, Drive, statement extraction and Sheets calculation.
Use the current [PRD](PRD_Budget2026_Automation_v2.4_stages.md) policies and
[menu/file guide](stage-3g-entry-points.md). Actual daily/monthly coaching delivery
acceptance is separate from this reconciler acceptance and deployment update.

## 1. Prepare one isolated test environment

- [x] Make a copy of Budget 2026 named **Budget 2026 TEST**. Record its spreadsheet
  ID from the URL and confirm it differs from the live workbook ID.
- [x] Open the copy's bound Apps Script project and sync the current root script
  files there. Confirm this is a different script project from the live project.
  The repository's existing `clasp` target is the original project; pushing there
  does not update a newly copied sandbox project.
- [x] In the **sandbox project's** `config.gs`, set
  `SHEET_FACTS.TEST_SPREADSHEET_ID` to the copied workbook ID and retain
  `DRY_RUN: true`. Set both sandbox users' `active` fields to `false` while testing
  reconciler pickup, keeping cardholder mappings unchanged. The shared dispatcher
  then has no active coaching recipients. Do not register a sandbox webhook or
  run manual coach-send helpers for this acceptance.
- [x] Create separate Drive folders, e.g. **BudgetStatements TEST/inbox** and
  **BudgetStatements TEST/processed**. Record their folder IDs from their URLs.
  **Configure these before choosing setup:** its default folder search can reuse
  the existing live `BudgetStatements` folders even in a separate script project.
- [x] Set these Script Properties in the sandbox project:

| Property | Sandbox value |
|---|---|
| `STATEMENT_SPREADSHEET_ID` | Copied workbook ID |
| `STATEMENT_INBOX_ID` | TEST inbox folder ID |
| `STATEMENT_PROCESSED_ID` | TEST processed folder ID |
| `GEMINI_API_KEY` | Working key for PDF/model parsing |

Leave the Telegram bot token absent for this reconciler-only test. Do not copy
live inbox IDs into the sandbox settings. `TEST_SPREADSHEET_ID` controls native
test targets; menu imports use the open workbook and scans use
`STATEMENT_SPREADSHEET_ID`. Verify all three select the copy.

- [x] Run `runAllTests()` in this sandbox project and save the actual summary.
  It performs controlled sandbox staging/commit writes. The fixture-dependent
  parser tests require the historical `_TestFixtures` entries `dbs_small_csv`,
  `citibank_csv` and `dbs_csv`; the latter expects the original 253-row sample.
  Bootstrapping creates headers only. If those fixtures are absent, obtain the
  original samples before treating the harness as green; arbitrary replacement
  statements will not satisfy its fixed expectations.
- [x] After harness completion, reset **sandbox-only** `_Reconcile`,
  `_ReconcileHistory` and `_ReconcileFiles` test/copied state, so copied dismissals
  or old file IDs cannot affect the acceptance run. Preserve `_TestFixtures`.
  Record any harness ledger rows as test data, outside the bank acceptance set.
- [x] Reload the copied spreadsheet. Choose **💰 Budget → Set up Drive inbox and
  automatic scan**, then **Pause automatic inbox scan** for controlled manual
  tests. Repeat setup once and check the Apps Script Triggers page: one
  15-minute `dispatch` trigger, no second dispatcher. Pause again until step 7.

## 2. Choose real files and write expected results first

- [x] Obtain **four original files**: DBS CSV, DBS PDF, Citi CSV and Citi PDF.
  Use overlapping windows between exports; include every applicable card section,
  particularly household/supplementary cards. Do not convert files to Google Docs
  or Sheets. Use a bounded period you can check line by line.
- [x] Ensure there will be real proposals to review. If the copied ledger already
  contains every purchase, remove a few identified entries **only from the copy**
  and record them as deliberately missing. Include an expense, a received-money
  credit if available, and a Grandparents purchase where applicable. Leave some
  source purchases logged to exercise matching.
- [x] Save a values/formulas snapshot of sandbox Transactions A:K **after** the
  harness and controlled removals, before any file scan. This is the baseline.
- [x] Create an `Acceptance` tab or worksheet with one row for each real statement
  occurrence. Repeated identical purchases need separate numbered occurrences;
  overlapping exports of one purchase refer to the same occurrence.

| Occurrence ID | File + line/page/card section | Transaction/posting dates | Account + holder/last4 | Signed amount + raw descriptor | Expected result | Ledger/review/history reference | Actual result / pass |
|---|---|---|---|---|---|---|---|
| DBS-001 | Fill from original | Fill | Fill | Fill | Already logged / propose / ambiguous / exclude with reason | Fill | Fill |

For every line, decide the expected classification against the baseline and PRD
policy. A purchase absent from the queue must have a matching ledger occurrence,
a valid exclusion, or a remembered dismissal; otherwise it is a failure. One
ledger occurrence cannot explain two distinct purchases. Use exact amounts and
source identities rather than matching a total count.

## 3. Scan and verify overlap plus retained review

- [x] Drop the first CSV into the TEST inbox and choose **Reconcile statements
  from Drive**. Compare every resulting proposal/ambiguity with the worksheet;
  verify dates, account, holder, signed amount, type and descriptor/source.
  Transactions values/formulas must still equal the baseline.
- [x] In `_Reconcile`, edit a merchant/category/type and tick selected rows. Save
  the full edited rows, including `source_row`, status and metadata.
- [x] Add the remaining real files one at a time and scan after each. Check every
  source occurrence against the worksheet, including the full PDF and all card
  sections. Verify earlier edits/ticks remain identical and overlaps do not add
  another proposal for an already represented occurrence. Uncertain identities
  or competing purchases must remain available for review.
- [x] Check `_ReconcileFiles`: each original file has its own ID/name/version and
  successful status. Check the matching original files are in TEST `processed`,
  not TEST `inbox`. Review source cells retain `[Drive:<file-id>]`. **Processed
  means staged, not imported**; Transactions must remain unchanged.

## 4. Verify failures and retry/move behavior

- [x] Add an unsupported test file, and an encrypted/unreadable PDF if available,
  alongside a valid new statement file. Scan: bad files remain in TEST inbox with
  journal errors; the valid file still stages and moves. Save the error and time.
- [x] Scan again without changing the failed file: its unchanged failure is
  skipped and the queue/ledger are unchanged. Choose **Retry failed inbox files**:
  a new attempt must occur, with an updated journal result/time; earlier staged
  occurrences must not duplicate. An unchanged invalid file may fail again.
- [x] Upload a corrected usable original as a new file and verify successful
  staging/movement. Do not edit an already-staged source in place: revisions use
  a new file ID and must still pass overlap checks.
- [x] Move an unchanged processed test file back into TEST inbox and scan. Verify
  the same journal file identity is reused, the file returns to processed, and no
  second set of review rows is created. This exercises a repeated move through
  the real service; interruption/journal-failure injection remains covered by
  regressions unless an actual failure is observed and retried during acceptance.

## 5. Review, preview and import the exact approved set

- [x] Correct the proposed category/type/merchant and write the expected approved
  A:K values in the worksheet. Leave at least one genuine pending row unticked
  for the manual-entry check. Tick only the intended imports.
- [x] Choose **Preview ticked rows**. The Sheets dialog must show the exact writer
  rows and identify skipped duplicate review rows. Verify reviewed type/sign,
  numeric amount D, category H, cleaned merchant I, Notes J and E/K formulas.
  Confirm the preview changes no Transactions values/formulas, review edits,
  ticks, statuses or history. Preview does not calculate F:G balances.
- [x] Choose **Import ticked rows from staging**. This is a real write to the
  sandbox even with `DRY_RUN: true`. Compare the appended row set with the exact
  approved, nonduplicate set. Unticked rows and duplicate collisions remain;
  successful rows appear in `_ReconcileHistory` with all reviewed/source fields.
- [x] Check A date, B account, C reviewed type, numeric D, E recalculated from D,
  H category, I merchant, J (`Grandparents` where applicable, otherwise empty),
  and K recalculated from H against `-!B:C`. E/K must contain formulas, not stale
  literal values or errors. Check F:G formulas and resulting balances using each
  account's baseline and the sheet's existing type/sign rules: expenses reduce
  and incoming credits increase the correct account balance.
- [x] In the sandbox, temporarily change one imported D and H to other valid
  values: E and K must update. Restore both values and verify restoration.
- [x] Import again and rescan unchanged files: **zero additional ledger rows**,
  no duplicated history/review occurrences, and the same identities and values.

## 6. Verify dismissal/history and manual-entry refresh

- [x] Highlight a pending edge-case row and choose **Reviewed — do not import
  selected rows**. Save a reason; verify only selected rows move to history as
  `dismissed`, with no ledger append. Check cancellation leaves review unchanged.
- [x] Upload the same statement under a new file ID. The same original known
  date/account/holder/signed-amount/descriptor occurrence stays dismissed; changed
  identities and additional occurrences must not disappear with it.
- [x] Accurately enter the unticked pending purchase in sandbox Transactions,
  including appropriate Notes and copied E/K/F:G formulas. Choose **Refresh
  pending review against Transactions**. It moves the confirmed occurrence to
  history as `reconciled`, with a ledger reference, without another ledger write.
  Unmatched/ambiguous rows keep their edits and ticks.
- [x] Refresh again: one ledger entry must not clear another genuine occurrence.
  If the files contain repeated same-key purchases, check them individually.
  Normal ticking cannot force a second same-key import. Dismiss a confirmed
  duplicate; a confirmed additional purchase needs accurate manual entry with a
  supporting Note and refresh. A dedicated Sheets force-add action is not built.

## 7. Verify actual scheduled pickup and save the evidence

- [x] Choose **Set up Drive inbox and automatic scan** to resume. Confirm the
  configured workbook and folder IDs still select TEST resources.
- [x] Drop a **new file ID** into TEST inbox. Do not click manual reconcile or run
  `dispatch` yourself. Wait for the actual trigger; allow about 30 minutes to
  observe the 15-minute heartbeat. Save the trigger execution/time, journal entry,
  original file movement and exact queue/ledger comparison. If no pickup occurs,
  record that as a failure to diagnose, not acceptance.
- [x] Pause automatic scan when finished. Save the completed worksheet, baseline
  and final Transactions values/formulas, `_Reconcile`, `_ReconcileHistory`,
  `_ReconcileFiles`, preview evidence and native harness/trigger summary.

**Pass only when every real source occurrence is accounted for, the approved
ledger delta is exact, formulas and balances agree, repeated actions are no-ops,
and scheduled pickup is observed.** Mark unavailable scenarios as untested, not
passed. Any unexplained missing expense, reused occurrence, changed review or
wrong import value blocks acceptance. Sandbox reconciler acceptance does not
certify live webhook deployment or actual coaching delivery.
