# Monthly bonus, GSU and savings view

Recorded: 3 October 2026. Accounting rules updated: 4 October 2026. Live status reviewed: 28 October 2026. Target: 31 October 2026. Status: partly implemented in the workbook; funding, formula and accounting acceptance remains open. Parent: [PRD](PRD_Budget2026_Automation_v2.4_stages.md).

**28 October status correction:** the live workbook already contains a combined
bonus/GSU section in rows 28–30 and combined totals in rows 32–35. This is partial
implementation, not an empty destination. `AA28:AA30` sum January–September only
although October's U column is populated (confirm any completed-month-only YTD
policy and advance it at October close); `U34` reads `U23` whereas September's
`S34` uses `S32-S33`; October's funding check `U35=U26+U29` is not balanced. The
current withdrawal formulas in the sampled months select `GSU GOOG` only, so
coverage of other funding sources and reinvestment treatment still needs review.
Summary!E4 also explicitly references October. No formulas were changed during
this read-only check. See the [current punch list](phase-2-progress-review-2026-10-28.md).

## Outcome

Below row 26 of `50/30/20`, show by month what additional compensation arrived, how much remains saved, and how much accumulated savings was consumed. Make a S$20,000 donation and other major purchases visible with their funding source. Moving cash to ETFs/SRS/CPF or selling GSUs to reinvest must not look like consumption. Preserve the existing regular-budget calculation and its bonus/equity exclusions.

## Authoritative household accounting rules

The user's 4 October corrections govern the requirements below:

- `Отдых` already recorded as `Обязательные расходы` counts toward holiday spending when allocated. Using that funded reserve does not create another `Расходы` entry. For a S$3,000 holiday payment covered by S$2,000 already accounted for on Wise, add only S$1,000 as current-month `Расходы`.
- RUB holiday funding is recorded once at the transfer, against the holiday allocation or as additional holiday spending for the uncovered portion. Do not track the subsequent RUB-card purchases or require card statements/itemization.
- Use one monthly `Difference`. Surpluses increase `Отложения`; additional spending reduces monthly `Отложения`. Do not add before/after Difference rows or a separate original-surplus display. Any shortage remaining after available monthly savings is reduced requires explicit funding.

These are household budget recognition rules. Asset balances and settlement transfers can still be reconciled without charging an already-accounted holiday amount to spending or retained savings again. Do not introduce a separate purchase-consumption dashboard to override these rules. Treat prefunded holiday money as earmarked, already budgeted funds, separate from uncommitted savings; movement or use of that money must not create a second savings deduction.

## Proposed view

Reuse the existing month alignment after inspecting the sheet. Add YTD for flows and latest closing balance for stocks; never sum monthly balances. All monetary reporting is in SGD, with original currency, valuation date and FX rate retained in supporting records. Display forecast and actual distinctly: expected bonuses and unvested GSU awards are not saved assets. Unknown values remain unavailable, not zero.

| Monthly row/group | Meaning |
|---|---|
| Expected cash bonus / expected GSU vesting | Separate forecast rows, excluded from actual totals |
| Cash bonus received | Net cash received; record gross, withholding and any separately reserved tax where known |
| GSUs vested | Net shares received and their vest-date SGD value; withheld shares/tax shown separately |
| Regular income added to tracked savings | Actual net new funding from salary, excluding bonuses, vesting and internal transfers; not simply the existing Savings category total |
| New savings before drawdowns | Regular additions + net bonus + net vesting value, less any additional tax provision not already deducted |
| Savings used for charity | Actual savings-funded donation amounts, with event details |
| Savings used for other major purchases | Actual savings-funded purchases, with event details |
| Savings used for other spending | Any other consumption funded from savings, including budget shortfalls |
| Fees and tax adjustments | Costs and changes in tax provision not already netted above; releases/refunds reverse the relevant amount |
| Net new savings retained | New savings before drawdowns less savings-funded spending, fees and tax adjustments; may be negative |
| Cash moved to ETFs / SRS / CPF | Informational transfer rows, not deductions from total retained savings |
| GSUs sold | Share count and net proceeds; informational conversion, not new compensation |
| Use of GSU sale proceeds | Reinvested / held in cash / spent / taxes and fees / unallocated; spending detail splits charity and purchases |
| Closing tracked assets | Cash / unsold GSUs / other investments, including SRS and CPF within the declared tracking scope |
| Closing obligations / available tracked savings | Show reserved tax and outstanding savings-funded card liabilities separately; available savings deducts both once from tracked assets |

Rows above are a design, not fixed cell addresses. Use grouped detail where necessary to keep the overview readable. Show both **net new savings retained this month/YTD** and **closing available tracked savings**; these answer different questions. Show investment/FX gains and losses separately so market growth is not reported as saving income.

## Funding and event records

Reuse the existing `Assets` / `Asset_details` tabs reported by the user as the asset source of truth; inspect their actual schema before implementation. Extend their existing records with linked event detail where needed rather than creating a parallel asset register. `CapitalEvents` is only a possible supporting table if the existing structure cannot retain event history, not a required new user-facing tab. Minimum event fields: stable event ID, effective date, actual/forecast status, event type, account/asset, original amount/currency, SGD amount/FX, share quantity where relevant, source transaction ID, linked transfer/sale ID, purpose, funding source, allocated amount and confirmation status. Add valuation snapshots and explicit opening balances for the assets included in scope.

Funding source and purpose are separate dimensions. Sources include current income, accumulated cash savings, GSU proceeds, other investments and unknown/mixed. Purposes include charity, a named purchase, ordinary spending, reinvestment, cash retention, tax and fees. An event can have multiple funding allocations, each linked to its evidence. Cash bonus can remain identifiable as a source cohort where explicitly tracked, but do not invent provenance once money is mixed.

- A sale in September can fund spending in October. Carry unspent proceeds forward and link later uses to the original sale; do not infer funding from same-month timing alone.
- Track every drawdown from savings regardless of size. Separately flag major spending through a configurable threshold and an explicit manual flag; the threshold is not yet chosen. Group split payments under one purchase/event to prevent threshold evasion by installments.
- Keep planned and actual exceptional spending distinct. A S$20,000 planned donation is forecast until paid. Actual donations are described neutrally, separately from discretionary purchases.
- Show major-purchase cost and the portion newly funded from savings. Already-accounted holiday funding follows the rules above: reserve use is settlement of that allocation, not a second expense or savings deduction. RUB holiday purchases are not itemized.
- Preserve existing transaction categories and the household recognition rules above. Funding detail must not add spending again to household expenditure totals.
- Credit-card settlement is a transfer. Charge only amounts not already recognized under the household budget rules; link reserve use and later settlement without a duplicate expense. A cash withdrawal alone does not justify new spending.
- Refunds reverse the linked drawdown; reimports, transfer pairs and repeated sale records must be idempotent. Allocation totals cannot exceed the event's available amount. Unallocated proceeds and unknown funding remain visible.

## Reconciliation and measurement

Define the tracked asset boundary before backfilling: selected cash savings accounts, vested GSUs and selected investments, with opening balances and an as-of date. Include destination assets for ETF/SRS/CPF transfers or carry them as tracked contributions with valuation unavailable. Do not claim a complete household net worth when accounts or valuations are missing. The 4 October notes explicitly include CPF in asset inflows: read actual compulsory CPF additions from existing asset records when available, separately from spendable cash income. Do not invent a bank transaction for pre-account CPF. Voluntary transfers from already tracked cash preserve savings and are not new household asset inflows. Identify genuinely new SAYE funding and GSU vesting similarly; include compulsory CPF additions in new savings only where recorded and within the declared boundary.

At the aggregate boundary:

`Closing available savings = opening available savings + net new savings retained + investment/FX gains or losses + scope adjustments`

Scope adjustments, such as bringing an existing asset into tracking, must be explicit and excluded from new savings. Internal transfers and GSU sales net to zero across assets apart from fees, tax and separately reported gains/losses. Value sold shares out of the GSU balance; do not retain both sold shares and sale cash. Carry tax reserves separately and release them when the reserved tax is paid so it is not deducted twice. Gross-to-net compensation and sale calculations must state whether fees and withholding are already included.

For new savings-funded card spending not already accounted for, recognize the drawdown when incurred, with an outstanding liability until settlement. Already-accounted holiday payments use their earmarked funding without a second deduction from available savings; show their unpaid card obligation in settlement coverage. Available savings deducts that liability once; subsequent settlement reduces both cash and the liability without a second savings drawdown. Include money moved to the settlement account within the tracked boundary until paid, or retain equivalent linked settlement records. Earmarking cash to cover a liability is not an additional deduction on top of the liability. Separately show future commitments against free funds; do not treat unspent plans as actual consumption.

Reconcile cash, share quantities and other assets separately. If opening balances, source attribution or valuations are incomplete, show the known flows and reconciliation gap, and label closing totals partial/unavailable. Do not manufacture a full savings figure from `Отложения (премия)` alone: that category cannot distinguish compensation, reinvestment and consumption.

## Monthly closing and funding discipline — added 4 October

The user's notes make this primarily a discipline and reconciliation feature, using existing asset tabs. Add a compact closing block alongside the monthly bonus/savings overview:

| Closing field | Rule |
|---|---|
| Monthly Отложения | Automatically absorb a positive Difference into savings; reduce this month's savings for additional spending before requiring other funding. Their resulting monthly amount shows the effect directly |
| Difference | Keep a single existing monthly result, targeting zero after savings adjustment and confirmed funding; verify its formula, sign and period against the monthly tab |
| Savings transfer status | Planned / pending / completed, with actual source and destination; a formula allocation is not evidence money moved |
| Remaining deficit and confirmed funding | A shortage beyond available monthly savings requires named source(s) and amount(s); no automatic investment sale or unexplained balancing entry |
| Debit-account coverage gap | Available settlement-account balance minus unpaid card obligations and remaining cash commitments due within the same stated horizon; exclude already-paid items and avoid duplicating card purchases as future cash expenses |

This is a budget allocation rule, not automatic banking. During an open month amounts are provisional. Do not add before/after Difference fields or require a separate original-surplus display: the resulting monthly `Отложения` shows the effect. Do not silently let savings become negative to hide a funding shortage. If accumulated assets fund a remaining deficit, record the confirmed source and drawdown. Never call this new income or borrowing unless there is an actual loan. Funding assignments alone do not close a debit-account coverage gap: show pending transfers and unsettled sales separately from cash already available.

**28 October follow-up — implemented:** automate `Summary!E4` from verified live inputs
and the current SGT month, then expose its recalculated cash-coverage amount,
as-of time, month and availability in the daily coach. Keep settlement coverage
and D19's spending allowance separately labeled; negative coverage should surface
a funding/transfer shortfall. Audit the existing manual adjustments before
replacing them, and keep October selected when November is created early. The
[PRD requirement](PRD_Budget2026_Automation_v2.4_stages.md#summarye4-automation-and-daily-cash-coverage--added-28-october)
records the reader, presentation and rollover acceptance checks.
Val clarified that all pending current-month commitments and the remaining
ordinary budget are compared with recorded account balances while protecting
regular payroll received for next month's budget. The version 92 removal of that
reserve was incorrect; version 93 derives it from actual banked payroll and
releases it at rollover. See the
[implementation and verification record](summary-cash-coverage.md).

User-stated purposes are defaults for review, not a compulsory liquidation sequence:

| Pot / asset | Intended use from the notes |
|---|---|
| Wise | Travel/holiday reserve |
| Revolut | Gifts, treats and selected home spending |
| SAYE | Larger family needs |
| GSU / ETF | Especially large needs, such as a home or renovation, after an explicit funding decision |

Separate account location from purpose: a renovation pot can span accounts, and an account can hold several pots. Show available pot balance after existing commitments. The historical note says renovation savings were exhausted after June; flag the renovation pot as requiring balance verification and a funding decision, not as a verified current zero balance.

### Reserve-funded purchases and credit cards

For Wise-funded holiday payments on a credit card, the portion already recorded under `Отдых` as `Обязательные расходы` is not recorded again as `Расходы`. Link that portion to reserve use and the required Wise-to-debit-account transfer. Keep the transfer pending until confirmed received; the reserve cannot fund another payment. `Снятие денег`/settlement records may represent this movement under the existing workbook convention, without creating extra income or expense. Revolut-funded card payments follow the same settlement discipline; do not duplicate an amount already accounted for in a funded allocation. Direct Revolut payments reduce the relevant pot.

Example: a S$3,000 holiday payment with S$2,000 on Wise already accounted for under `Отдых` / `Обязательные расходы` adds **only S$1,000 to this month's `Расходы`**. The S$2,000 reserve-to-debit transfer covers the card without new spending. The extra S$1,000 reduces monthly `Отложения`; any remaining shortage requires another explicit source. The covered allocation can be from an earlier month: do not book it again this month. The full card obligation still belongs in debit-account coverage until settled.

Keep the user's existing holiday measure: recorded `Отдых` mandatory allocations plus additional holiday `Расходы`, each counted once. Do not replace mandatory holiday allocations with purchase-date consumption or add a separate full-purchase spending metric. For the example, S$2,000 was already counted and S$1,000 is newly counted; neither the payment nor the settlement transfer adds another S$3,000.

### RUB card and travel

Use the holiday funding transfer as the single recording point. Link the amount covered by already-accounted `Отдых` funds to that allocation without another expense; record only uncovered funding as additional holiday `Расходы`. For funding not previously accounted for, count it once as holiday spending. Record the funding amount and available currency/SGD equivalent from the transfer itself.

Do not import, itemize or reconcile subsequent RUB-card purchases, require RUB-card statements, or flag their absence as missing data. No later replacement with purchase detail is required. This is intentionally a funding-based holiday budget, not a complete RUB-account consumption ledger. Any tracked residual RUB balance is earmarked holiday money, not newly available savings; do not count it again as a new asset inflow or savings contribution.

### Three-way reconciliation

Reconcile the `50/30/20` monthly Difference with the matching monthly tab using an explicit bridge for timing, savings allocations and reserve funding. Then reconcile expected settlement cash to observed bank balances, outstanding card liabilities and remaining due commitments as of a common date. A zero budget Difference does not establish that the debit account can cover the bills. Surface unexplained differences rather than forcing a balancing entry. Link closing cash/pot balances back to `Assets` / `Asset_details` and avoid counting the same money in both a pot and its hosting bank account.

## Example (illustrative, not household data)

With zero opening tracked savings, S$30,000 net bonus and S$40,000 net GSUs vesting, new savings before drawdowns is S$70,000. Sell S$25,000 of those GSUs with no price/FX change, taxes or fees. Reinvest S$20,000 of sale proceeds in ETFs, spend the remaining S$5,000 on a purchase, and donate S$20,000 from bonus cash.

The view shows S$25,000 consumed and S$45,000 retained: S$10,000 cash + S$15,000 unsold GSUs + S$20,000 ETFs. GSU-funded consumption is S$5,000; the sale itself and ETF purchase do not reduce retained savings. Regular income additions are assumed zero in this example.

## Implementation and acceptance by 31 October

1. Inspect live row 26 and the month/YTD structure, formulas and protected ranges. Verify opening balances, data availability and the desired major-spend threshold. Establish explicit ranges for both old and new sections before adding rows.
2. Build the supporting records and sheet formulas in a sandbox copy, initially allowing manual confirmed funding allocations. Automatic broker imports and funding inference are not required for the first version.
3. Render the monthly overview and event detail. Backfill available 2026 history with a visible coverage start date; earlier missing history remains unknown. The October month-end view must distinguish actual, forecast and incomplete data.
4. Extend daily/monthly readers and the monthly coach to read the sheet's new computed totals. **The current `get503020Status()` scans rows and carries its last bucket forward; it must be restricted to the existing budget section before appending the new block.** New labels such as Savings/Total must not replace existing bucket summaries or become ordinary subcategories.
5. Verify the S$70,000/S$45,000 example; pure reinvestment with zero consumption; a cross-month sale/purchase; a mixed-funded purchase; donation; tax withholding and later reserved-tax payment; fees; refunds; duplicate imports; investment/FX movements; missing opening data; and an internal CPF/SRS transfer. Confirm original 50/30/20 values and coach output remain consistent. Review native sheet recalculation and presentation before live rollout.
6. Verify surplus allocation with a pending actual transfer; an unfunded deficit; partly Wise-funded travel; Revolut direct/card purchases; card purchase and settlement across different months; compulsory CPF versus an internal top-up; RUB holiday funding recorded once with no downstream card records required; S$3,000 holiday payment with S$2,000 previously accounted for adds only S$1,000 to `Расходы`; no duplicate reserve charge; monthly `Отложения` absorbs the adjustment with one Difference field; exhausted/unknown renovation reserves; and a zero Difference with insufficient settlement cash. Confirm the existing asset tabs remain the source of truth.

Coach emphasis: explain how much was retained and which events consumed savings, especially GSU-funded consumption. Mention reinvestment as context, not overspending. Never assert that GSUs had to be sold unless a confirmed funding plan or actual linkage supports it.
