# Stage 5 — an evidence-based monthly review

## Current contract (19 September 2026)

The user replaced the short bucket recital with an explanatory review:

1. How did Расходы finish against its monthly spending pot?
2. What happened to the overall allocation plan and savings?
3. Which categories explain the largest overruns, and where was spending restrained?
4. Which specific purchases contributed, could explain an overrun, or look unusual?
5. What does recorded history suggest about more realistic future targets?

The former four-sentence/one-category limit no longer applies. The report uses
bullets, every over-target spending category, threshold-crossing transaction analysis, one
positive example and up to three evidence-based category-target recommendations. Payment counts
and target basis are supporting context, not the opening message.

## Sources and calculations

`monthlyInsights.gs` owns the new analysis and rendering. The existing monthly
payload and heartbeat remain the entry points. Daily coaching is unchanged.

- **Расходы:** net SGD E amounts for the exact ordinary-expense type, across all
  accounts, for the reporting month. Fixed payments, withdrawals and income are
  excluded. Refunds recorded as negative ordinary expenses reduce the total.
- **Monthly pot:** D15 of the selected monthly tab. The live formula is B14-E14,
  income minus planned mandatory allocations, including planned savings. This
  is a monthly plan, not D17 daily pacing or D19's remaining daily allowance.
  Missing D15 is reported as unavailable, not zero or an inferred allowance.
- **Overall allocations:** read the native unlabeled Total row of `50/30/20` for
  that month and the current target column. Never sum bucket totals to recreate
  the sheet summary. Savings is shown separately so an unfunded saving target
  cannot masquerade as good discipline. This is not a cash-balance reconciliation.
- **Category drivers:** rank Needs/Wants subcategory actual-minus-target amounts.
  Show both Обязательные расходы and Расходы. Reserve the target for mandatory
  payments first: any excess from mandatory payments is a structural shortfall;
  the rest of the overrun is attributed to ordinary spending. A mixed category
  can have both. Unreconciled or negative component totals disable this split.
  Category variance and variance against D15 have different bases; the code does
  not claim that the ranked category gaps sum to the ordinary-spending overrun.
- **Positive evidence:** meaningful headroom of at least S$50 and 10% of target,
  with observed ordinary activity, no committed ledger payments and no positive
  monthly mandatory plan for that category. The ledger must reconcile to its
  sheet total. Savings, missing data, unpaid commitments and empty categories
  cannot produce praise for discipline.

## Integrated category analysis (20 September)

Every over-target Needs/Wants category is displayed, including zero-target
categories. There is no top-two category filter. Each category block contains:

- Actual overrun against its target.
- Mandatory amount and any structural gap.
- Ordinary amount, allowance after reserving mandatory payments, and remaining gap.
- Up to three ordinary transactions crossing or adding to that gap, nested in bullets. For longer lists, detail the first crossing and summarize the rest by count, full charge total, and date range.

The transaction list reserves the reporting month's net mandatory payments first,
then walks ordinary transactions by date and ledger row within each day. A positive
charge appears when the running ordinary total after it exceeds the remaining
allowance. Analyze every such charge, with no S$100 floor or top-N limit; the display rule above keeps longer lists concise. Identify
crossing charges and their over-allowance portion. A charge landing exactly on
the allowance does not cross it. Refunds reduce the running total and can bring
spending below the allowance, after which a later charge can cross it again.

This is a retrospective allocation order, not a claim that a later mandatory
payment had already cleared when an earlier purchase occurred. Dates have no
intraday timestamps, so ledger order resolves same-day ties. Charges made while
over the allowance can be offset later; the list does not claim that summing its
full charge amounts equals the final net overrun. Each occurrence retains its
merchant, date, account and amount in the analysis; identical-looking rows count separately in the summary. Summary totals are before refunds, not the final net budget gap.

Unreconciled categories remain visible but omit transaction attribution. Negative
component totals also disable attribution. Structural-only gaps show the mandatory
amount and explain why there is no ordinary crossing charge.

## History and planning recommendations

Look back over the reporting month and five preceding months. The current month
never enters its own baseline. Earlier months need an existing monthly tab,
ledger activity and readable bucket summaries; missing months are not zeroes.
Missing category cells are excluded from category comparisons. Each historical
read uses its own explicit month anchor.

At least three earlier months must reconcile each category's ordinary plus
mandatory ledger amounts to its native sheet total within two cents. Compute
separate monthly medians for both components over the **same** observations;
legitimate zero components stay in the sample. Proposed targets sum these two
medians, not a claimed median of the total.

- **Repeated material gap:** at least two thirds of earlier totals exceeded the
  current target, and the sum of component medians exceeds it by at least S$100
  and 20%. Propose an explicit total split into a commitment baseline and ordinary
  allowance. State that any increase needs funding from another allocation or
  confirmed income. Ordinary spending is not assumed to be entirely optional.
- **Changed commitments:** when this month's mandatory amount differs from its
  historical median by at least S$100 and 25%, do not blindly reuse the older
  commitment baseline. Offer a provisional target using the latest mandatory
  amount plus the historical ordinary median, conditional on confirming that
  bills have changed rather than shifted between months.
- **Possible exception:** all earlier totals were within today's target. Keep
  that target for now and review the exceptional month before raising it.
- **Insufficient/ambiguous evidence:** no numerical target recommendation.

Include up to three proposals, prioritizing structural gaps and changed/repeated
commitments, then the largest current category variances. These are proposals
only; neither targets nor transaction types are changed automatically.

Historical comparisons explicitly use **current** category targets. Historical
versions of targets are unavailable; the report never claims these were the
budgets in force in earlier months. Five previous months are useful evidence,
not a multi-year trend or proof of complete transaction capture.

## Grounding and delivery

New monthly payloads include `monthly_review`. Their prose is rendered directly
from checked evidence rather than asking a model to invent a financial narrative.
There is no model call for the new review. Shared generation/preview/scheduler
entry points remain intact; legacy monthly payloads retain the old validated
model path for compatibility. HTML fields are escaped, and the review validator
rejects text that differs from the evidence rendering.

`previewMonthlyCoach(reportDate, spreadsheet)` and **💰 Budget → Preview monthly
coach** show the review without Telegram delivery, sheet writes or acceptance
markers. The default month is the latest completed one, except the last-day
23:30 closing window. `sendMonthlyCoach` remains the explicit send entry point.

The heartbeat still runs reminder → coach per active user from **23:30 SGT on
the last day until 02:30 next day**, with acknowledgement, backoff and per-step
markers. The closing reporting month stays fixed across midnight/year rollover;
retries read that month's latest data. No statement-import completion is awaited.

## Verification and live preview

`node scripts/test-regressions.cjs`: **188 tests passed, 555 existing assertions**.
New coverage checks net ordinary spending, D15 selection, category reconciliation,
contribution versus sole-cause language, refunds, outlier sample thresholds,
positive-evidence exclusions, minimum trend evidence, missing history, HTML and
mutated-figure rejection. Scheduler and reporting-month regressions still pass.

Read-only August checkpoint from the live **Budget 2026** workbook, retrieved
19 September 2026 and executed against the local source:

- Расходы: **S$10,908.37**, pot **S$9,581.16**, **S$1,327.21 over**.
- Overall recorded allocations: **S$26,127.91** vs **S$35,882.71**; Savings **S$0**
  vs **S$7,496.54**, so the lower allocation total is not an unqualified win.
- Leading overruns: Развлечения **S$1,560.65**, Школа & Детский сад **S$1,304.14**.
- Club Zoom, 5 August, **S$360**, contributes to the entertainment gap.
- Lazada SG, 15 August, **S$446.33**: Home would be **S$800.06**, within its
  **S$1,000** target, without that charge.
- Groceries: **S$1,602.60** vs **S$2,200**, **S$597.40** headroom.
- Utilities exceeded today's **S$350** target in all five earlier recorded
  months; their median was **S$550.79**.
- Earlier ordinary-spend median: **S$8,904.12**, March–July 2026.

`scripts/verify-monthly-snapshot.cjs` independently checks snapshot summary
cells, ordinary-spend sums, the D15 variance and payment counts. Private ledger
snapshots are stored outside the repository. No live spreadsheet changes,
model requests or Telegram messages were performed for this redesign.

**Pending:** sync/deploy and verify the native preview and real delivery. The
snapshot checkpoint verifies local source calculations, not deployed behavior.

### Follow-up: mandatory versus ordinary spending

The August preview now separates School & Kindergarten's **S$857.90 structural
gap** (mandatory S$4,757.90 versus the S$3,900 target) from **S$446.24 ordinary
spending**. Entertainment's S$1,560.65 overrun is entirely ordinary spending.

Target proposals use March–July component medians:

- School: historical mandatory **S$3,501.90**, ordinary **S$235**; since current
  mandatory rose to **S$4,757.90**, propose **S$4,992.90 provisionally**, subject
  to confirming upcoming fees and payment timing.
- Housing: historical mandatory **S$16,833.84** but current mandatory **S$7,333.84**;
  avoid reinstating the old baseline. Provisional target **S$7,333.84**, if the
  reduced commitment is confirmed.
- Transport: **S$2,707 mandatory + S$1,140.22 ordinary = S$3,847.22**, compared
  with the current **S$3,100** target. The ordinary allowance is the component
  to review for adjustments.

The expanded snapshot preview spans multiple Telegram messages. It was
not sent. New regressions cover structural/mixed/ordinary attribution, component
medians, unreconciled history and changed commitments.

### Complete delivery of long reviews

Manual and scheduled monthly delivery split the complete HTML review into bounded
parts. No category or rendered analysis is dropped to fit one message. Part sizing also
fits Script Properties' per-value byte limit for Cyrillic text. Scheduled multipart
reports freeze their text when sending begins and record acknowledgement per part,
per recipient. A retry resumes at the failed part; the coach step is complete only
after every part succeeds. The original month-end deadline still applies. Completed
snapshots are removed; expired incomplete snapshots are removed on the next monthly
run. An ambiguous network outcome after server acceptance remains a transport limit.

The August snapshot contains 21 entertainment charges crossing or adding to the
S$450 allowance. Club Zoom's S$360 charge is the first crossing, of which S$146.47
lies over the allowance. The remaining 20 charges are summarized together, including small purchases.
