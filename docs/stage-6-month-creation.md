# Stage 6 — automatic month creation

Plan and discovery checkpoint: 3 October 2026.

## Outcome

Create the next monthly tab before rollover and recover a missing current-month
tab when operational readers need it. Existing tabs must remain unchanged.
Use the shared 15-minute dispatcher; no new trigger. Stage 4 remains deferred.

## Implementation sequence

| Step | Deliverable | Completion checkpoint | Status |
| --- | --- | --- | --- |
| 6A — Discover and freeze template | Read-only live inspection, exact carry/reset/formula map, naming and input policies in `SHEET_FACTS.monthTemplate` | Resolve the three questions below; inspect remaining template extent, workbook dependencies and sandbox differences | In progress |
| 6B — Build read-only creation plan | Explicit target month, validated template selection and precise proposed edits, including live payment-status and daily-description formulas; menu/editor preview | Offline planner/formula-construction checks pass; read-only live October snapshot produces November plan | Complete locally; native formula evaluation remains 6E |
| 6C — Implement controlled creator | Clone latest valid earlier month, initialize dates/inputs, preserve formulas/formatting, verify before publishing final name | Sandbox-only creation; concurrency lock, recheck, failure handling and repeat-run tests pass | Pending |
| 6D — Integrate entry points | Explicit current-month recovery, next-month scheduling, income-review notice and feature controls | Dispatcher and operational reader tests pass; historical reporting and read-only diagnostics never create tabs | Pending |
| 6E — Native sandbox acceptance | Run actual Apps Script creator against verified TEST workbook | Compare formulas, dates, values, formatting and recalculation with a manually created reference; repeated calls make no changes | Pending |
| 6F — Release | Record acceptance, enable live feature, sync and update existing web-app deployment if needed | Verify a real eligible creation and existing-month no-op; document rollback/disable procedure | Pending |

Proceed in order. Source tests do not replace native spreadsheet recalculation.
Keep live automatic creation disabled until sandbox acceptance passes.

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
| A3:B4 | Salary labels and formulas | Carry forward; mark for owner review |
| B5:B6 | Remaining balance and extra income | Start at zero with the fixed salary baseline; show explicitly in preview |
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
2. Val requested confirmation of current values and a simple fixed salary basis.
   Live October A3:B6 confirms Зарплата В = S$34,035; Зарплата Р = S$14,439;
   Остаток = S$0; Лёгкие деньги = S$0. Salary total = S$48,474. Proposed contract:
   carry these salary amounts as the baseline, with zero balance/extra income
   unless explicitly supplied. Do not infer historical extra income as recurring.
   Distinguish values from storage: existing salary cells contain arithmetic formulas.
3. Resolved after diagnosis: Val selected `=H38<=$D$1` for I38.
4. Scope extension from Val: G3:G13 must show live payment status, including
   partial-payment remainder, and I2:I32 must generate daily spend descriptions.

## Live status and daily descriptions — accepted scope

These additions belong to the generated month template. They do not require
enabling Stage 4 Calendar reminders. Existing month tabs are not migrated by
ordinary month creation; an existing month remains a no-op.

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
- Carry salary formulas and mandatory plans forward with a visible review note.
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
- Salary/mandatory formulas and formatting preserved; chosen transient inputs
  reset; no source sheet or Transactions writes.
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
