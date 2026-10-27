# Phase 2 progress review — 28 October 2026 (SGT)

Stages 1–6 are implemented. Remaining work is concentrated in daily data-quality
handling, native/operational acceptance, worksheet funding/rollover dependencies,
and documentation. Stage 7 is the only numbered Phase 2 stage after Stage 6.

## Evidence and limits

The bullets below record the initial read-only review. The later Summary!E4
follow-up is corrected and released as **version 93**, with 33 matching
application files, 270 passing tests and eight native funding-period checks; see the
[implementation record](summary-cash-coverage.md). Its workbook/source changes
supersede the initial review's no-mutation statement for that follow-up only.

- Repository: `e2d291c`, with a clean worktree before this documentation review.
- Read-only Apps Script API comparison: all 32 application files match the editor
  and the existing web-app deployment, **version 91**. No sync or deploy is needed
  for those files at this checkpoint.
- `node scripts/test-regressions.cjs`: **257 tests passed, 556 existing assertions
  checked, all .gs files parsed**. The separate Telegram edit regression command
  also passes its seven checks. These use service doubles, not live Telegram.
- Live [Budget 2026](https://docs.google.com/spreadsheets/d/1ufn6CoHqxEUPwqBf--RX2H2DR_C1t1CfyG6QxSUVvR8/edit)
  metadata and bounded reads: Calendar has 12 active obligations, October exists,
  November is absent, and the bonus/GSU section is partly populated. No
  LineItems/Products tabs exist. Read ranges: Calendar!A1:L20, Summary!A1:M42,
  October!A1:L70, and 50/30/20!A25:AF39 (values), A28:AF35 (formulas).
- The current live October template passes the local read-only November planner:
  source `Октябрь'26`, target `Ноябрь`, 30 days, edits B1, B3:B4, B5, B6, I38,
  G3:G13 and I2:I32. Income history was intentionally omitted for this structural
  check; template salary fallbacks were used. Generated formulas were not
  evaluated in native Sheets during this review.
- No application source changes, workbook writes, trigger changes, Telegram
  messages, deployment changes or ledger mutations were performed. Current
  trigger inventory, execution logs and per-user acceptance markers were not read.

## Stages 1–6

| Stage | Current position | Closure work |
| --- | --- | --- |
| 1 — Readers | Core readers and strict monthly paths are deployed; prior notes record successful live pacing/spend comparisons. | Daily `buildCoachPayload` does not propagate `get503020Status().error`, so missing/read-failed bucket data can become zero values. `getCategoryBucketMap` still falls back to static taxonomy when the reference is unavailable. Define and enforce visible unavailable-data behavior. |
| 2 — Daily coach | Deployed, with historical delivery/heartbeat evidence and passing per-user retry/grounding regressions. | Guarantee the target basis in the daily output: the payload carries `target_header`, but the daily prompt/fallback do not guarantee it. Record current sheet/tone and catch-up acceptance. Daily `mandatory_warnings` remains an empty array, so Calendar warnings are not integrated into the morning brief. |
| 3 — Reconciler | 3A–3G implemented and deployed. Whole-stage sandbox acceptance was confirmed by Val on 16 September. Later balance fixes are included in version 91. | No broad rebuild required. A dedicated audited Sheets action for legitimate same-key additional purchases remains absent; retain explicit manual-entry/note plus refresh policy. New provider/parser cases need their own evidence when encountered. |
| 4 — Payment calendar | Parts A–C deployed. Live Calendar has 12 active obligations; weekly Monday 09:00 SGT delivery is wired. | Older notes defer acceptance, although setup is now present. Compare the native preview with the ledger and confirm real weekly delivery. Review numeric 30/31 dates versus EOM intent rather than changing them automatically. Same-day alerts are optional and disabled. Ledger matching does not require G write-back. |
| 5 — Monthly coach | Deployed evidence-based category/purchase review, historical target proposals, and complete multipart delivery with per-part retry. Prior live-snapshot calculations pass. | Close native preview/sheet comparison and real reminder → complete review acceptance for both users. Schedule: last day 23:30 SGT through next day 02:30, retaining the closing month. Source/deployment alignment is verified, not an open sync task. |
| 6 — Month creation | Deployed and enabled. Controlled clone/reset, operational current-month recovery, yearless/legacy reader resolution and last-day scheduling exist. Val's successful live November trial is recorded on 25 October. Summary now selects its month automatically. | November is currently absent; verify the first eligible heartbeat on 31 October from 00:00 SGT, native final formulas/values, provisional salary notes and repeat-call no-op. The original native TEST matrix is not independently evidenced by the recorded live trial. Keep 2027 setup separate. |

## Prioritized loose ends

1. **Finish the existing bonus/GSU/funding view by its 31 October target.**
   `50/30/20!AA28:AA30` stop at September's S column while October's U column is
   populated. Confirm whether YTD intentionally includes completed months only
   and advance it at October close. September net savings `S34=S32-S33` differs from October
   `U34=U23`; establish the intended combined-net-savings formula before fixing
   it. October's funding check `U35=U26+U29` is nonzero, so the current sheet does
   not yet identify enough withdrawals to explain Difference. The sampled
   withdrawal formulas cover GSU GOOG only. Confirm cash/SAYE/other-source coverage
   and distinguish transfers/reinvestment from spending-funded withdrawals.
   These are accounting/reconciliation tasks; do not change recognition rules or
   count prefunded holidays/RUB purchases again.
2. **Summary!E4 automation and daily variable — implemented 28 October.**
   Following Val's clarification, E4 uses current recorded DBS cash and signed
   card balances to cover all pending current-month mandatory costs plus the
   remaining ordinary budget while protecting payroll already received for next
   month's budget. Version 92 incorrectly removed that reserve; version 93 restores
   it from actual regular payroll receipts and releases it at rollover. Net ledger payments replace manual paid
   deductions, including the already-paid MOE amount. The native calculation
   selects the current calendar month and validates B1/aliases. The daily payload
   and deterministic Settlement line carry checked coverage or an unavailable
   status, separately from D19. The existing November creation/no-op check is
   still Stage 6 work; E4 no longer needs a monthly reference edit. See the
   [implementation, verification and rollback record](summary-cash-coverage.md).
3. **Close Stage 5 with the October review.** Use the native read-only preview
   first; compare figures with October and check complete delivery to both users
   during the 31 October 23:30–1 November 02:30 SGT window. No test messages were
   sent by this review.
4. **Harden daily unavailable-data handling and target visibility.** Resolve the
   Stage 1/2 gaps together, then record current brief/Sheet agreement. Decide how
   Calendar warnings should appear in the morning brief if retaining that PRD
   requirement.
5. **Close Stage 4 acceptance using the existing Calendar.** Do not reseed or
   replace its confirmed rows. Verify paid/partial/overdue/upcoming sets and
   weekly delivery; keep optional day-of alerts as an explicit later choice.
6. **Finish acceptance-document consolidation.** This review refreshes the PRD
   overview, README, Stage 6 status and bonus-view status. Older dated runbooks
   retain their historical checks; their old sync/test counts do not override
   this checkpoint. Record outstanding native/operational evidence as it is
   obtained, rather than declaring every old checkbox complete.

## Remaining Phase 2 scope

**Stage 7 — receipt line-item intelligence is unbuilt.** Existing photo/receipt
transaction extraction is not item capture. No item-level extraction schema,
LineItems/Products storage, parent linkage/reconciliation, `/items`, or Basket
Review implementation was found in the application source.

- **7A, capture:** extract actual receipt items (not bank screenshots), normalize
  products/brands/units, link via the transaction dedupe key, flag receipts whose
  items do not reconcile, and keep the 11-column ledger contract unchanged.
- **7B, analysis:** deterministic unit prices, merchant/brand comparisons,
  frequency and spending-change drivers, and a personal inflation measure with
  adequate comparable observations. Build after sufficient capture history;
  the PRD anticipates roughly 4–8 weeks before useful item patterns accumulate.

There is no numbered Stage 8 in the Phase 2 PRD. The October bonus/GSU/funding
view is an additional accepted scope item outside that numbering. Preparing the
2027 annual workbook is a future operating dependency: the 2026 creator
deliberately skips cross-year creation, rather than extending the annual workbook.
