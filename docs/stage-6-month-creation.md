# Stage 6 — automatic month creation

Initial plan and discovery checkpoint: 3 October 2026.
November readiness review: 25 October 2026 (SGT).

## Outcome

Create the next monthly tab before rollover and recover a missing current-month
tab when operational readers need it. Existing tabs must remain unchanged.
Use the shared 15-minute dispatcher; no new trigger. Stage 4 remains deferred.

## Implementation sequence

| Step | Deliverable | Completion checkpoint | Status |
| --- | --- | --- | --- |
| 6A — Discover and freeze template | Read-only live inspection, exact carry/reset/formula map, naming and input policies in `SHEET_FACTS.monthTemplate` | Resolve the three questions below; inspect remaining template extent, workbook dependencies and sandbox differences | In progress |
| 6B — Build read-only creation plan | Explicit target month, validated template selection and precise proposed edits, including live salary, payment-status and daily-description formulas; menu/editor preview | Offline planner/formula-construction checks pass; read-only live October snapshot produces November plan | Complete locally; ledger salary lookup and provisional fallback implemented; installed preview verification pending; native formula evaluation remains 6E |
| 6C — Implement controlled creator | Clone latest valid earlier month, initialize dates/inputs, preserve formulas/formatting, verify before publishing final name | Sandbox-only creation; concurrency lock, recheck, failure handling and repeat-run tests pass | Complete locally; native sandbox execution remains 6E |
| 6D — Integrate entry points | Explicit current-month recovery, next-month scheduling, income-review notice and feature controls | Dispatcher and operational reader tests pass; historical reporting and read-only diagnostics never create tabs | Complete (`resolveMonthSheet`, operational-only `ensureMonthTab`, `runScheduledMonthCreation` on last day from `00:00 SGT` onwards + current-month recovery in `dispatch()`) |
| 6E — Native sandbox acceptance | Run actual Apps Script creator against verified TEST workbook | Compare formulas, dates, values, formatting and recalculation with a manually created reference; repeated calls make no changes | Complete via live trial creation of `Ноябрь` in `Budget 2026`; Column G write-up skipped (`G3:G13` cleared to blank) per Val's feedback |
| 6F — Release | Record acceptance, enable live feature, sync and update existing web-app deployment if needed | Verify a real eligible creation and existing-month no-op; document rollback/disable procedure | Complete (`SHEET_FACTS.monthTemplate.creationEnabled = true` synced via `clasp push`) |

Proceed in order. Source tests do not replace native spreadsheet recalculation.
Keep live automatic creation disabled until sandbox acceptance passes.

## November readiness — 25 October 2026

Working branch: `codex/stage-6`, based on `main` at `f416cba`.
The branch starts with the existing 6B implementation; there is no controlled
creator yet. Completing the read-only preview alone will not create November.

### 6B verified now

- [x] Re-run `node scripts/test-regressions.cjs`: 245 tests passed, including all
  23 Stage 6B checks; 555 existing assertions checked; all `.gs` files parsed.
- [x] Refresh live workbook metadata: October is present, November is absent,
  locale remains `ru_RU`, and timezone remains `Asia/Kuala_Lumpur` (UTC+8).
- [x] Read live October A1:L70 and B1 for the other nine monthly tabs. Running
  the local planner against this fresh connector snapshot selects
  `Октябрь'26` → `Ноябрь`, 30 days. The updated plan proposes B1, B3:B4, B5,
  B6, I38, G3:G13 and I2:I32. Existing October returns `exists` with zero edits.
  This validates the plan against current source cells, not native recalculation.

### 6B closure checklist

- [x] Implement Val's updated salary policy: new B3 looks up Google income for
  Валера; B4 looks up Kaspersky income for Рита. Use the preceding calendar
  month's exact `Доходы` type and SGD amounts. Missing income uses the template
  amount provisionally, as selected by Val. New lookup formulas recalculate when
  the missing transaction arrives. B5 starts at zero; B6 tracks month-to-date
  light income. Preview includes employer, source period, cash/CPF breakdown,
  ledger row evidence, provisional status and the tab month's light-income total.
- [x] Apply Val's confirmed CPF policy: add employer CPF only to ledger salary,
  17% for Google/Валера and 9% for Kaspersky/Рита on the existing wage base.
  Preserve E13 and carry provisional template compensation unchanged. Use the
  tab's own month-to-date light-income total in B6, per the latest clarification.
- [x] Verify the revised planner against fresh read-only income/template cells:
  November resolves Валера from the preceding month's Google income and Рита
  provisionally from the template. A completed prior month independently resolves
  both employers. Live income amounts and ledger row references remain outside
  the repository. No workbook writes or native formula evaluation were performed.
- [ ] Verify the installed Apps Script editor/menu preview. Confirm source sync
  status, sync if needed, reload the workbook, and run the explicit November
  preview and **Budget → Preview next month (read-only)**. Record that both show
  the expected source, target, changes and review warnings without writing cells
  or creating tabs. The current runtime source/deployment was not inspected in
  this review; the local result does not establish that the menu is installed.

### Work beyond 6B required before automatic November creation

| Step | Remaining work |
| --- | --- |
| 6A | Finish discovery outside the sampled monthly region, audit remaining Summary/50/30/20 dependencies, freeze the carry/reset contract and establish the TEST baseline. Fresh TEST metadata still ends at August and includes `Август'26 (копия)`; it is not an October reference. |
| 6C | Complete locally (`createMonthTab`, `verifyCreatedMonthSheet`, v2 generated-template validation chaining `Ноябрь` → `Декабрь`, sandbox enforcement while `creationEnabled: false`, lock/recheck, temporary tab cleanup on failure, G3:G13 checkbox removal, wrapping, and B3:B4 provisional salary review notes). Native sandbox execution remains 6E. |
| 6D | Complete locally (`resolveMonthSheet` supporting yearless and `'26` tabs with B1 year verification and duplicate-alias protection; operational-only `ensureMonthTab` self-healing; `runScheduledMonthCreation` wired into `dispatch()` to create the next month as soon as the last day of the previous month starts at `00:00 SGT` onwards, plus current-month recovery if missed; `month_created_YYYY-MM` and `month_income_review_YYYY-MM` Script Properties). Live `creationEnabled` remains `false` until 6E passes. |
| 6E | Evaluate formulas in native TEST Sheets: employer salary lookup, employer-only CPF, bonus exclusions, provisional-to-actual recalculation and month-to-date B6; unpaid/partial/paid/refunded and invalid payment data; daily descriptions, repeated purchases, refunds, future dates and exclusions; short-month helpers, Russian number formatting, long text, layout and recalculation performance. Verify copied formatting/protections, existing-month no-ops, concurrency and failure/retry behavior. |
| 6F | Record sandbox acceptance, synchronize source, enable the feature and update the existing web-app deployment if affected. Verify eligible creation and a repeat-call no-op; document disable/rollback. |

Readiness targets: finish the 6A/6B handoff first, complete creator/integration
and native sandbox acceptance by **29 October**, and complete release checks by
**30 October**. Verify the first eligible scheduled November creation on
**31 October SGT**, ahead of **1 November**. If acceptance is incomplete, keep
automation disabled and use a manually prepared, verified November tab; the
creator must later recognize it as an existing-month no-op.

The initial review changed documentation; the salary follow-up also changed the
read-only planner, preview and regressions. No source sync, deployment, workbook
writes, automatic creation or Telegram messages were performed. Live connector
snapshots used for local verification remain outside the repository.

## Read-only discovery evidence

Source: connected Google Sheets reads on 3 October 2026.

- Live: `Budget 2026`, ID `1ufn6CoHqxEUPwqBf--RX2H2DR_C1t1CfyG6QxSUVvR8`.
- Sandbox: `Budget 2026 TEST`, ID `1SgV3M1RWtEKvqWEazv-3slduXPCEi7x2gJFElWbFA70`.
  Metadata confirms it is distinct and matches the configured test ID.
- Live locale: `ru_RU`; timezone: `Asia/Kuala_Lumpur` (UTC+8).
- Live September sheet ID: 1480705450; October: 1992973746.
  Both have 1,000 rows and 12 columns. October already exists; it must be a no-op.
- Sandbox currently ends at August, with an additional `Август'26 (копия)` tab.
  Do not mistake that copy for a calendar month or assume sandbox matches October.
- Inspected September/October A1:L35, October A36:L70, September H37:I40,
  and August G3:G13 plus H37:I40. This is bounded discovery, not a full-sheet audit.
- Inspected Summary A1:M42 and 50/30/20 A1:AF4. The allocation sheet already
  has all twelve 2026 month headers; sampled category formulas filter Transactions
  by those dates rather than referencing monthly tabs. It has no 2027 columns.
  Summary E4 has a manually composed September-specific formula even though
  October exists. This is not a month-creation dependency to rewrite automatically;
  retain it and flag separate owner maintenance. Remaining allocation rows have
  not yet been audited for month-tab references.

## Observed template map

| Cells | Observed role | Planned treatment |
| --- | --- | --- |
| B1 | Literal first-of-month date | Set target month's first day in workbook timezone |
| D1 | `=EOMONTH(B1;0)` | Preserve; verify resulting last day |
| A3:B4 | Salary labels and formulas | Preserve labels; install previous-month income lookup plus employer-only CPF; use template compensation provisionally when missing |
| B5 | Remaining balance | Start at zero |
| B6 | Light income | Install a live month-to-date SGD income formula, bounded by the tab's own month and today |
| D3:E13 | Mandatory labels and planned amounts, including formulas | Carry forward exactly; amounts may need owner review |
| F3:F13 | Allocation percentage formulas | Preserve |
| G3:G13 | Mandatory payment status | Install ledger-derived live status formulas in new tabs: paid, unpaid or partial with remaining SGD; exclude CPF/zero plans explicitly |
| B14, E14, D15, D17, D19, F15 | Summary and pacing formulas | Preserve initially; verify short-month and rollover behavior |
| H2:H32 | Formula-generated daily dates | Preserve, verify unused days are blank |
| I2:I32 | Daily descriptions | Generate formula-based descriptions from each day's logged spending; refresh automatically with ledger edits/imports |
| J2:J32 | Daily transaction SUMIFS formulas referencing H of same row | Preserve; recalculation supplies the new month's spend |
| K2:L32 | Daily budget and saldo formulas | Preserve; never blanket-clear the tracker |
| J33:L33 | Daily tracker totals | Preserve and verify |
| H37:I37 | Date helper headers | Preserve |
| H38:H68 | First date from B1, then daily increments | Preserve; changing B1 regenerates the sequence |
| I39:I68 | Whether helper date is <= D1 | Preserve |
| I38 | Date-in-month helper with anomalous arithmetic | Replace with the user-approved `=H38<=$D$1` in new tabs |

The older PRD says to clear daily spending/saldo cells. Live discovery shows
these are formulas: resetting the month means updating date/input cells and
recalculating, not deleting J:L. Current G observations establish cell contents,
not the owner's historical workflow or whether checkbox validation is present.

## Questions required to finish 6A

1. Resolved by Val: new tabs use full Russian month names without a year, e.g.
   `Ноябрь`. Each new year gets a separate workbook. Preserve existing names and
   recognize their aliases; verify B1's year before matching a yearless tab.
   Do not create January of the next year in this workbook automatically.
2. Initial discovery: Val requested confirmation of current values and a simple fixed salary basis.
   Live October A3:B6 confirms Зарплата В = S$34,035; Зарплата Р = S$14,439;
   Остаток = S$0; Лёгкие деньги = S$0. Salary total = S$48,474. Superseded on
   25 October by the employer-income lookup policy below. Existing template salary
   amounts are now provisional fallbacks only; balance starts at zero, and B6
   follows its own month's light-income total under the latest clarification below.
3. Resolved after diagnosis: Val selected `=H38<=$D$1` for I38.
4. Scope extension from Val: G3:G13 must show live payment status, including
   partial-payment remainder, and I2:I32 must generate daily spend descriptions.

## Live salary, status and daily descriptions — accepted scope

These additions belong to the generated month template. They do not require
enabling Stage 4 Calendar reminders. Existing month tabs are not migrated by
ordinary month creation; an existing month remains a no-op.

### B3:B4 — employer salary income (updated 25 October)

- Валера / B3: Google. Рита / B4: Kaspersky. Match the employer as a whole Latin
  word in Transactions I, including `Google Singapore` and `Kaspersky Lab`.
- Use Transactions C equal to `Доходы` after whitespace/case normalization,
  E as SGD, and A within the calendar month immediately preceding the target.
  `Доходы` is the transaction type; the separate category in H is not the filter.
  Exclude `Доходы - премия`, `Доходы - лёгкие деньги`, reimbursements, transfers
  and expenses. Do not infer a salary month from free-text descriptions.
- Sum split salary receipts and signed corrections in cents. A malformed date,
  nonnumeric SGD amount, ambiguous employer or nonpositive matched net total
  requires review and blocks a usable creation plan.
- Add **employer CPF only**, as explicitly selected by Val: Google/Валера 17%
  and Kaspersky/Рита 9% on the existing S$8,000 wage base. Preview shows banked
  salary, employer CPF and resulting compensation separately. Do not add the
  employee share. E13 retains its existing employer-plus-employee deduction;
  unsupported CPF formula/rate/base changes require review before creation.
- Val selected **use the template amount temporarily** for a missing salary.
  Use the selected template's calculated B3/B4 amount if finite and nonnegative;
  otherwise block the plan. Label the fallback as provisional with its source;
  it already represents template compensation and receives no extra CPF top-up.
- Install native lookup formulas in new tabs so a provisional amount updates
  automatically when the preceding month's income is logged or corrected. Embed
  fallback cents as integer arithmetic to avoid locale-dependent decimal literals.
  Missing salary plus an invalid fallback yields an unavailable result, never an
  invented zero. Source tabs and existing historical tabs are not migrated.
- Show the source month, employer/person, current compensation, ledger rows and
  any provisional template source in the read-only preview. The plan has seven
  edits because B5's zero reset and B6's income formula are separate operations.
- Validate formula results and provisional-to-actual recalculation natively in
  6E; offline tests verify evidence selection and formula construction only.

### B6 — the tab's own month-to-date light income (clarified 25 October)

- Sum Transactions E for light-income types in C, with dates from A. Accept
  `Доходы - лёгкие деньги` and the requested singular `Доход - Лёгкие деньги`,
  normalizing case, `е`/`ё`, spacing and hyphen/en-dash/em-dash separators.
- Derive the calendar month from the new tab's B1. Include its first day through
  today, capped at month end; never include future dates or another month/year.
  November B6 therefore uses November light income only, excluding October even
  though salaries use October. Before November starts, its light-income total is zero.
- Include all matching sources and signed corrections; exclude regular salary,
  bonuses, transfers and spending. An empty matching set is zero. Malformed
  relevant dates or amounts show an unavailable result rather than a fabricated zero.
- Use a native bounded-range formula so ledger additions and corrections update
  B6 without script writes. Preview shows the month, cutoff, total and evidence.
  Each tab tracks its own month independently. This latest clarification supersedes
  the earlier quarter-to-date selection.

### G3:G13 — mandatory payment status

- Prefer native Sheets formulas so imports, manual ledger edits and refunds
  recalculate without waiting for the 15-minute heartbeat or making model calls.
- Use the row's planned amount in E and canonical category from D. Sum SGD in
  Transactions E for `Обязательные расходы` in this tab's B1:D1 date window,
  excluding future dates relative to today. Aggregate accounts at monthly category
  level, consistent with the monthly plan; this is not per-Calendar-item matching.
- Compare net payments including refunds in cents. Example displays:
  `Оплачено`, `Не оплачено · осталось S$1,000.00`, and
  `Частично · осталось S$400.00` after S$600 paid against S$1,000.
- CPF: `Не отслеживается`; zero plan: `Не требуется`. Positive unmapped labels,
  duplicate mapped plans or invalid inputs show a review/unavailable state, not
  a fabricated paid result. Reuse the canonical mapping, not fuzzy merchant names.
- Remove inherited checkbox validation only in the new tab's status cells; use
  wrapping/column width appropriate to the text without obscuring adjacent dates.
- Readers must not interpret arbitrary status text as a truthy paid flag. Retain
  legacy boolean support for historical tabs; new status text is presentation,
  and monthly summary calculations use the same ledger-based numeric evidence.
- Test zero, partial, exact/full, overpaid, refunded, future-dated and wrong-month
  payments, category isolation, invalid data and legacy reader compatibility.

### I2:I32 — descriptions generated from each day's spending

- Prefer native formulas producing factual Russian descriptions, without an LLM.
  Example shape: `FairPrice — S$85.20; Grab — S$18.00`.
- Include the day's ordinary spending from Transactions, with merchant (I),
  category (H) as fallback, and SGD amount (E). Match the adjacent J formula's
  date/type/category filters exactly, including its existing exclusions, so the
  description explains the same spending shown beside it.
- Include all matching occurrences, refunds and later edits; never silently
  discard smaller transactions. Multiple purchases at the same merchant remain
  distinguishable. No transactions on a reached day: `Нет расходов`.
- Future days and nonexistent short-month dates remain blank. Do not suggest
  that an empty future date is a verified zero-spend day.
- Use bounded, adequately sized ledger ranges or a shared helper to avoid 31
  expensive repeated whole-column text scans; verify practical recalculation
  with the actual ledger. Surface oversized/error results rather than truncating
  silently or claiming no spending.
- Wrap descriptions and verify row heights/layout in the sandbox. The formulas
  replace description inputs only in newly generated tabs.

### I38 diagnosis

October A1:L70 was re-read after Val's request. I38 is under “Date in Month”;
H38 is `=B1`, and H39:H68 increment that date. I39:I68 return whether their date
is <= D1, the month end. I38 instead computes `110.22 + 294.73 = 404.95`.

H2's formula resolves `INDIRECT(ADDRESS(ROW()+36; COLUMN()+1))` to I38 and
the adjacent indirect reference to H38. In plain terms, H2 does
`IF(I38; H38; blank)`. A nonzero numeric value is truthy, so 404.95 enables the
first day's date, just as TRUE would. J2 then sums that date's transactions,
and L2 subtracts J2 from K2. The 404.95 is not added as spending or income
by this dependency chain. Its original purpose cannot be established from the
current formula; it appears inconsistent with the surrounding boolean helper.

Approved for new tabs: use exactly `=H38<=$D$1` in I38 to express the actual
condition. Leave existing tabs unchanged.
This diagnosis is based on the inspected monthly region, not a workbook-wide
audit of every possible reference to I38.

## Design requirements for subsequent steps

- Separate plan, preview and write paths. Preview does not create a tab.
- Inspect the template before copying. Reject unsupported layouts with a useful
  explanation; never infer destructive reset ranges from formatting alone.
- Resolve target by year/month, not sheet order. Choose a valid earlier template;
  skip copies, staging sheets and future months. Handle short/full legacy names
  without creating a second tab for one month.
- Preserve the existing `ensureMonthTab(spreadsheet, tabName, optDate)` hook only
  if its semantics can be made safe. Current historical readers also use
  `getActiveMonthTab`; automatic writes must be explicitly limited to operational
  current-month recovery. Missing history must remain missing.
- Recheck target existence under the shared writer lock. Construct under a
  temporary identity and expose the final month name only after verification.
  Never remove an existing user tab during failure recovery; identify only the
  new temporary tab created by this operation.
- Reuse the heartbeat. Proposed policy: attempt next-month creation during the
  last day of the month, with repeat calls becoming no-ops; recover current month
  after rollover if an execution was missed. Errors must not block other jobs.
- Generate salary lookup formulas under the employer-income policy and preserve
  mandatory plan values/formulas, with a visible review note for provisional salaries.
  Any Telegram notification requires explicit messaging authorization; a sheet
  note/menu result is sufficient for initial implementation.
- Inspect Summary/50/30/20 dependencies: determine whether a new month needs
  registration elsewhere. Do not silently extend annual reporting scope.
- Year rollover tests must refuse cross-year creation in an annual workbook.
  A new year's workbook and its template/configuration are set up separately.

## Test and acceptance matrix

- 28/29/30/31-day months, leap February, December→January, UTC/SGT boundary.
- Existing target unchanged; manually created tab races; duplicate alias refusal.
- Latest earlier valid template selected; no template and structural drift fail
  before publishing a tab.
- Salary lookup, employer-only CPF and provisional-to-actual recalculation match ledger evidence;
  B6 follows its own month-to-date light income with exact month/SGT day boundaries;
  mandatory plan formulas and formatting preserved; chosen transient inputs reset;
  no source sheet or Transactions writes.
- G live paid/partial/unpaid results and I daily descriptions match ledger edits
  and refunds; historical boolean readers remain compatible.
- Helper dates and transaction formulas scope to target; no accidental inherited
  month references; short-month extra rows do not leak transactions.
- Creation failure and retry; lock release; no partial final-name tab.
- Scheduled and on-demand paths share the same creator and feature controls.
- Historical monthly coach/snapshot and read-only verification remain read-only.
- Run all existing regressions after integration; native sandbox verifies actual
  formula results, protections, copied formatting and permissions.

## Work log

### 25 October — Stage 6C & 6D controlled creator, yearless reader resolution and last-day rollover

- Implemented Stage 6C controlled creator (`createMonthTab` and `verifyCreatedMonthSheet` in `monthCreation.gs`) with v2 generated-template validation in `validateMonthCreationTemplate` so a Stage 6 tab (`Ноябрь`) can serve as the valid template for `Декабрь`.
- Added `resolveMonthSheet` in `reader.gs` and wired `getActiveMonthTab`, `getMandatoryExpenses`, `getRecentDailyTrends`, `getBudgetCoachContext`, `getMonthlyTabDaySpend`, `buildMonthlyCoachPayload`, `readMonthlyReviewHistory`, `buildMonthlyReview`, and `runMonthEndJobs` to support both `'26` and yearless tabs (`Ноябрь`) while verifying `B1`'s year/month and rejecting duplicate aliases.
- Implemented `ensureMonthTab` (restricted strictly to operational current-month reads when `SHEET_FACTS.monthTemplate.creationEnabled === true`, leaving historical and future reads read-only) and `runScheduledMonthCreation` in `monthCreation.gs`, wired into the 15-minute `dispatch()` heartbeat in `nudge.gs`.
- Per Val's timing requirement, `runScheduledMonthCreation` creates the next month's tab on the **last day of the previous month as soon as the last day starts (`00:00 SGT` onwards)**, with subsequent 15-minute heartbeats acting as idempotent no-ops, plus current-month recovery if the last-day rollover was missed.
- All 251 offline regression tests (`node scripts/test-regressions.cjs`), 555 existing assertions, and 7 Telegram edit tests (`node scripts/telegram-edit-regressions.cjs`) pass.
- Val ran the live trial creation of `Ноябрь` in `Budget 2026`, confirmed all salary, CPF, light-income, date, and daily budget formulas (`B1`, `D1`, `B3:B4`, `B5:B6`, `B14`, `E14`, `D15`, `D17`, `D19`, `I2:I32`, `I38`), and requested skipping the Column G write-up (`G3:G13` now cleared to blank without text wrapping). Enabled `SHEET_FACTS.monthTemplate.creationEnabled = true` and pushed via `clasp push`.

### 25 October — own-month B6 clarification

- Val clarified that November light income must come from November, excluding
  October. Changed B6's planner, native formula, preview and current contract
  from quarter-to-date to the tab's own month-to-date total. Salaries still use
  the preceding month under the separate salary policy.
- Added an explicit November/October separation regression and checked all month
  boundaries, leap February and SGT dates. All 245 offline tests and 555 existing
  assertions pass; native spreadsheet evaluation remains pending.

### 25 October — employer CPF and quarter light-income feedback

- The quarter-to-date B6 policy recorded here was superseded by the own-month
  clarification above; employer-only CPF remains unchanged.
- Val selected employer-only CPF additions to banked salaries, preserving E13
  and avoiding a second CPF addition to provisional template compensation.
- Val selected the full quarter-to-date light-income total for B6. Split its
  formula from the B5 zero reset; the plan now has seven precise change ranges.
- Added synthetic regressions for CPF/fallback consistency, quarter and SGT day
  boundaries, income type aliases, corrections and invalid data. All 244 offline
  tests and 555 existing assertions pass; native evaluation remains pending.

### 25 October — 6B employer salary lookup and temporary fallback

- Val replaced the earlier fixed-value baseline with preceding-month `Доходы`
  from Google for Валера and Kaspersky for Рита, and selected provisional template
  amounts when payroll is missing. The initial fixed-value alignment commit is
  superseded by this policy.
- Added read-only ledger/schema reads, deterministic salary evidence selection,
  generated native lookup formulas and a salary evidence table in the preview.
- Expanded regressions for employer/type/month isolation, split receipts and
  corrections, SGT boundaries, fallback and later income, invalid data, read-only
  behavior and formula construction. All 239 offline tests and 555 existing
  assertions pass. Native installed preview verification is the next 6B item.

### 6B implementation checkpoint

- `monthCreation.gs`: pure planner, strict known-template checks, yearless/legacy
  identity resolution, annual boundary, read adapter and escaped HTML preview.
- `previewMonthCreation(2026, 11, spreadsheet)` returns exact proposed changes.
  Omit arguments to preview next month in the bound workbook. December's default
  next-year request refuses creation because this workbook is annual.
- Menu: **Budget → Preview next month (read-only)** after a future source sync
  and spreadsheet reload. No source sync/deployment was performed for this step.
- Fresh live October values and formulas were read on 3 October. Local execution
  selected `Октябрь'26` → `Ноябрь`, 30 days, salaries S$34,035 and S$14,439,
  and proposed only B1, B3:B4, B5:B6, I38, G3:G13 and I2:I32.
  Existing October returns `exists` with no edits.
- Formula ranges use INDEX endpoints at the current allocated Transactions grid,
  growing with inserted rows. Performance and locale formatting remain native
  acceptance checks. G formulas derive the label from D dynamically and detect
  duplicate positive plans. I formulas preserve separate occurrences/refunds.
- 198 offline tests pass, including 10 Stage 6B checks, plus 555 existing native
  assertions executed through mocks. Generated formula strings have construction
  and balanced-syntax checks; no offline test claims to evaluate Sheets formulas.
- A synthetic fixture retains the inspected formula structure with anonymized
  income/plan amounts. The actual live snapshot remains outside the repository.
- Next: 6C controlled creator, including support for using an already-generated
  template version on subsequent months, formatting, recovery and sandbox-only
  writes. No `ensureMonthTab` function exists yet, so read paths remain unchanged.

- 3 Oct: created plan; inspected live and sandbox metadata plus bounded template
  cells. Discovered formula-driven tracker, blank recent G cells, historical
  literal G flags and anomalous I38. Requested three owner policy decisions.
- No live or sandbox cells changed; no runtime creation code or deployment added.
- Follow-up: recorded Val's yearless Russian naming and separate-year workbook
  policy; verified October income values; traced I38 through H2 to the daily tracker.
- Follow-up: accepted live G payment status, generated daily I descriptions and
  exact I38 replacement. Updated 6B and sandbox criteria; runtime implementation
  and live installation remain pending.
