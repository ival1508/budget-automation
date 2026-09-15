# PRD implementation review — 9 September 2026

The project implements the main Stage 0–2 modules and the Stage 3A–3F pipeline, but the current checkout does not meet the reconciler's acceptance criteria. Do not treat the latest staging counts as evidence that matching and commit are ready for live use.

Follow-up: the confirmed P1 regressions and staging/status handling described below
have now been corrected in the local source. See README's offline regression checks.
This document preserves the original findings as an audit snapshot, not the current
failure list. Deployment and the real Sheets sandbox checkpoint remain unverified.
Broader policy questions (four-day matching window, credit inclusion, taxonomy
fallback, and how to approve genuine same-key purchase occurrences) remain separate
from these regression fixes.

Scope: the two supplied attachments and the current working tree, including nine already-modified source files. The supplied PRD ends at Stage 3F. Later weekly/monthly helpers are present but are not assessed as completed later stages. No source fixes, deployments, live endpoint calls, sheet writes, or Telegram messages were performed for this review.

## Implementation coverage

| Stage | Present in code | Assessment |
|---|---|---|
| 0 — Discovery | Month maps, 11-column schema, range configuration, discovery helpers | Substantial implementation. The supplied PRD declares discovery complete, but config does not freeze `mandatoryColumnGType`, `NON_LEDGER_MANDATORY`, or `monthTemplate`. Do not infer those facts from their absence. |
| 1 — Readers | Active month lookup, pacing, today spend, mandatory reads, category mapping, sheet-based 50/30/20 reads and target header | Substantial implementation with gaps: number-parser collision, missing-tab status lost downstream, zero-planned/CPF semantics absent from mandatory reader, static taxonomy fallback. |
| 2 — Daily coach | Payload, generation/fallback, two-user dispatch, per-user morning times, sent keys, Singapore timezone | Implemented, but negative daily allowance is mislabeled as total overspend. Prompt/category selection also differs from PRD. Live delivery checkpoint was not independently verified. |
| 3A — Parsing | DBS/Citi CSV handling, PDF/model path, encryption detection, period derivation | Implemented. Multi-section DBS and posting dates are useful additions. Exact real-bank fixture and PDF acceptance remains unverified here. |
| 3B — Normalization | Shared merchant normalization, dates, amounts, signs | Implemented; local normalization test passes. Shared global number parsers remain incompatible. |
| 3C — Matching | Exact keys, fuzzy/canonical matching, cardholder handling, ambiguity output | Not acceptance-ready: rows disappear from all output buckets, account isolation is missing, and matching reads external alias state. |
| 3D — Filtering | Auditable exclusions, fee/reversal pairing, credit handling | Implemented but materially changed from PRD: positive expenses bypass transfer checks and some credits remain proposals. Updated tests validate that policy, not the original policy. |
| 3E — Review staging | Checkboxes, category inference/dropdowns, cardholder/type columns, source/status, end-to-end orchestration | Implemented. Re-runs erase existing review state; staging also updates merchant learning before approval. |
| 3F — Commit | Reads checked rows, lock, Phase-1 writer, 11 columns, F:G copy-down, dry-run, imported status | Code exists. Provided development notes demonstrate 3A–3E staging, not the required sandbox real-write, balance-chain, and second-run no-op checkpoint. |

## Findings, ordered by impact

### 1. Unauthenticated GET diagnostics expose financial data and trigger live writes — P1

`webhook.gs:14–154` dispatches actions without checking a secret or allowlist. `check_spreadsheets` returns ledger comparisons containing dates, merchants and amounts; `run_live_reconcile` reads a fixed Drive statement and runs live staging. The checked-in manifest specifies `ANYONE_ANONYMOUS` and execution as the deploying user. The POST secret check does not protect GET.

If deployed with that configuration, anyone with the URL can invoke these actions, overwrite `_Reconcile`, trigger merchant-learning changes and consume model quota. Remove public diagnostic actions or authenticate before dispatch; keep live mutations out of unauthenticated GET routes. This finding is based on source/configuration, not an attempted live request.

### 2. Reconciler dry-run disables ordinary Telegram saving while reporting success — P1

`config.gs:36` sets `SHEET_FACTS.DRY_RUN = true`. `writer.gs:140–160` applies it whenever a caller omits the override and reports would-be rows as `writtenCount`. Ordinary approvals call `appendTransactions(transactions)` without an override, then announce “Logged to Sheet” and clear pending transactions (`callbacks.gs:86–102`).

With the current configuration, users can approve transactions, receive success, and lose the pending proposal without any ledger append. Scope dry-run to reconciliation or pass explicit execution mode from each workflow; callbacks must not interpret simulated writes as saved transactions.

### 3. Matching can silently lose statement rows — P1, locally reproduced

In `reconciler.gs:1480–1520`, the single-candidate branch may choose a different statement row as the winner. The currently processed losing row is not put into `missing` or `ambiguous`, and the loop never revisits it. A conflicting cardholder can also produce zero compatible competitors and no output classification.

Reproductions using actual `findMissing`:

- Two S$20 Popular Bookstores statement rows, dated 17 and 15 August; one S$20 ledger row dated 15 August with descriptor `POPULAR-POS 1`: **2 inputs → 1 matched, 0 missing, 0 ambiguous**.
- One Rita statement row and one otherwise plausible ledger row explicitly noted Val: **1 input → 0 matched, 0 missing, 0 ambiguous**.

This directly breaks the catch-all-missing requirement. Require every input row to have exactly one classification, tracked by stable source identity. Add competing-row and input-order tests before tuning scores further.

### 4. Fuzzy matching ignores account identity — P1, locally reproduced

The candidate loop at `reconciler.gs:1382–1430` compares amount, dates, merchant and cardholder, but never checks `s.account === l.account`. Exact keys do contain accounts; the fuzzy fallback bypasses that protection.

Reproduction: a DBS S$20 Popular Bookstores purchase on 15 August matches a Citi S$20 Popular Bookstores ledger transaction on 16 August. A genuine missing transaction is thereby suppressed. Enforce normalized account identity before fuzzy scoring, with explicit exceptions only if the data model requires them.

### 5. The latest HTTP test endpoint can report false success — P1

`assertEq` and `assertClose` (`tests.gs:45–117`) return booleans and log failures; they do not throw. `runAllTests` tracks failures correctly, but `doGet?action=run_unit_tests` (`webhook.gs:75–93`) calls two tests directly and labels each PASSED unless an exception occurs.

Local execution of the location-suffix/multifactor test produced a failed assertion: expected `store`, got `store beijing`. It returned normally. Therefore the endpoint's reported PASSED status does not substantiate the development notes' “100% passed” claim. Use the assertion-aware runner and return its failure counts.

### 6. Two incompatible global `parseAmountNumber` functions collide — P1, locally reproduced

`reader.gs:17` supports decimal commas and a display-value fallback. `reconciler.gs:871` defines the same global name, removes every comma, and ignores the second argument. The project cannot safely have both contracts under one global name.

Loading reader then reconciler, as in the supplied development commands, makes `parseAmountNumber('S$1 234,56')` return **123456**, rather than **1234.56**. Loading the other way changes the statement parser's credit-suffix/null behavior instead. Use distinct names or one explicitly tested shared contract. Numeric sheet cells are unaffected by this particular decimal-comma example; text-valued amounts are at risk.

### 7. Coach labels a daily shortfall as the whole month's overspend — P1

`coach.gs:103–104` sets `over_budget_by = abs(realisticDaily)`. The prompt at `coach.gs:211` instructs the model to call that amount “past the month's budget.” D19 is a per-day figure, not a monthly total.

Local payload reproduction: D19 = −100 and three days remaining produces `over_budget_by: 100`; under the PRD's stated D19 relationship, that represents a S$300 remaining-budget shortfall. Read the sheet's actual monthly remaining/overspend figure if reporting that quantity, or retain truthful per-day wording. Do not relabel D19.

### 8. Review state is overwritten, and learning precedes approval — P2

`stageProposals` clears the existing `_Reconcile` tab before building the replacement (`reconciler.gs:3128`). A second run loses ticks, category edits, statuses and the previous statement's pending review. It does not participate in the commit lock, so commit locking alone does not serialize both operations.

Staging also cleans merchant aliases and persists inferred merchant categories (`reconciler.gs:3175,3557`), even though the reviewer has not accepted them. Preserve or version staging sessions, coordinate staging/commit concurrency, and defer durable learning until confirmation. At minimum, document these effects; the current “safe to run repeatedly” description is incomplete.

### 9. Commit status does not distinguish written and deduplicated rows — P2

When any row is written, `commitStaged` marks **all** candidate staging rows imported (`reconciler.gs:3866–3872`), including rows the writer skipped. If every candidate is skipped, none gets a terminal status. This weakens the review audit trail.

There is also a new multi-card limitation: matching distinguishes cardholders, but the writer's dedupe key still omits cardholder and multiplicity. Two valid same-date/account/amount/merchant purchases can collapse into one. Preserve the distinction between “already present” and “new occurrence approved for import,” with per-row writer outcomes; do not indiscriminately disable dedupe.

## Other PRD gaps and changes requiring a decision

- **Pure matching:** `findMissing` reads merchant aliases from Script Properties through `getMerchantAliases` (`reconciler.gs:1370`, `enricher.gs:147`). Inject an alias snapshot so identical test inputs produce identical results independently of deployed learning state.
- **Matching policy:** the code uses ±4 days and transaction-or-posting date, versus the PRD's ±3 days. It also guesses winners using score margins and main-card preference. These are meaningful policy changes, not merely normalization fixes. Blank notes do not establish that a purchase belongs to Val.
- **Development description drift:** the supplied summary describes similarity/date/canonical/category weights of 0.45/0.25/0.15/0.05. Current code instead uses tiered date scores, a 0.50 canonical merchant score, and 0.10 category credit. Record the actual algorithm and approved policy.
- **Non-spend policy:** the positive-expense guard in `filterNonSpend` bypasses transfer/repayment checks. Some credits are proposed as income, unlike original Stage 3D. The code refers to “Choice 1” and “Option B”; the supplied attachments do not establish the associated approval, so reconcile this with the PRD rather than silently reverting it.
- **Mandatory semantics:** `getMandatoryExpenses` returns the raw paid flag for S$0 planned rows and CPF, without the specified satisfied/non-ledger treatment. Future unpaid consumers must not treat these as overdue.
- **Missing month:** `getActiveMonthTab` reports absence, but `getDailyPacing` returns zero-filled defaults, and the coach payload loses the error. Users can receive apparently valid zero-budget numbers instead of the requested create-month instruction.
- **Taxonomy:** `getCategoryBucketMap` reads the reference tab normally, but falls back to hardcoded constants on errors. This conflicts with the explicit no-guessed-taxonomy requirement. The writer also calls it without forwarding its selected spreadsheet.
- **Coach scope:** the payload replaces `top_wants_categories` with `categories_over_target`; the prompt permits two categories and requires bullet formatting versus the PRD's one-category conversational brief. Decide whether these are accepted UX changes.

## Verification performed

All `.gs` files parsed successfully as JavaScript. Seven selected existing tests ran locally with minimal Apps Script mocks: **233 passing assertions and 3 failing assertions**, with no thrown errors in those seven tests.

| Test | Passing | Failing |
|---|---:|---:|
| `test_normalizeRows` | 23 | 0 |
| `test_findMissing` | 35 | 1 — expected fuzzy, got canonical |
| `test_filterNonSpend` | 27 | 0 |
| `test_cleanMerchantDisplayName` | 13 | 1 — expected Amazon SG, got Amazon |
| `test_computeMerchantSimilarity` | 8 | 0 |
| `test_dbsMultiSectionAndCardholderMatching` | 85 | 0 |
| `test_locationSuffixStrippingAndMultiFactorMatching` | 42 | 1 — Beijing suffix retained |

Some failures may reflect stale expectations after intended behavior changes. They still invalidate an unqualified all-tests-pass claim. The custom matching counterexamples above demonstrate separate functional defects, not just stale labels.

The mocks do not validate Apps Script services, sheet formula copy-down/coercion, real CSV/PDF fixture contents, installed triggers, deployed version, or live data. The reported 156 parsed / 87 matched / 65 proposals / 4 ambiguous counts are internally consistent for that run, but were not independently verified and cannot prove row-level correctness.

## Recommended sequence

1. Close diagnostic exposure and separate reconciliation dry-run from normal Telegram writes.
2. Fix matching completeness, account isolation, and assertion-aware test reporting; add regression fixtures for the reproduced cases.
3. Resolve the parser collision, coach unit error, and missing-data propagation.
4. Preserve staging review state and make commit/dedupe outcomes traceable per row.
5. Record accepted PRD deviations, then execute the full sandbox 3A–3F checkpoint: exact appended rows, F:G balance chain, and a second run importing nothing. Only then consider live commit ready.
