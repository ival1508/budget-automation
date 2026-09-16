# Stage 4B — canonical mandatory-payment matching

Implemented locally. Live comparison with the monthly sheet remains pending.

## Behavior

`mandatory.gs` contains the explicit map for the eleven monthly labels in the
PRD. The nine ledger-backed labels map directly to their transaction categories.
`CPF` is planning-only. Any zero-planned line is satisfied and excluded from
paid/unpaid counts; excluded lines remain visible in a separate report note.
Positive `Родители` has no automatic mapping: it remains unpaid and is marked
for mapping review. A `Другое` transaction does not silently satisfy it.

Matching ignores case and repeated whitespace, then compares exact categories.
It never infers categories from merchant descriptions or 50/30/20 buckets.
`Авто` cannot match `Транспорт`. Legacy transaction category `Аренда` is not
silently aliased to `Квартира`; correct or explicitly map legacy data if needed.
Custom plan labels outside the map may match an identical ledger category.
Ambiguous free text is left for review; no LLM fallback is invoked.

Payments from different merchants in the same category are summed for the
monthly plan, including refunds. A net total below the planned amount remains
unpaid (`partial` if positive). Comparisons use cents. Duplicate positive plans
for the same category fail rather than reuse the same payment twice.

## Integration

- `matchMandatoryPayments(expected, logged)` is pure: no sheet writes or services.
  It returns paid/unpaid/excluded counts, individual results, excluded planning
  items and unplanned ledger groups. Inputs must already be filtered to the
  reporting month and `Обязательные расходы` transaction type.
- The existing weekly report and its fallback now use this matcher and a
  deterministic HTML formatter. Gemini credentials are no longer needed for it.
- The weekly path ignores G flags while their meaning remains unconfirmed.
  `summarizeMonthlyMandatory` explicitly opts into the pre-existing Stage 5
  paid-flag behavior. Neither path writes G.
- Context reads use strict mandatory readers. Missing sheets, invalid amounts,
  malformed dates and missing categories cannot become apparently empty history.
  SGD comes from E; blank/error E cannot fall back to original-currency D.
- This part matches **monthly category plans**. The manually edited Calendar
  remains intact. Item/account-level allocation, expected dates, overdue sets,
  due-this-week sets and reminders are now implemented in [Part C](stage-4c-reminders.md). A monthly
  category total must not independently settle multiple Calendar obligations.

## Verification

Run `node scripts/test-regressions.cjs`, or run `test_mandatoryMatching()` in the
Apps Script editor for the pure PRD fixture: one paid, one unpaid, CPF and
zero-planned Родители. The offline suite also covers all nine canonical mappings,
category isolation, partials/refunds, exclusions, duplicate plans, invalid data,
HTML escaping, strict ledger reads and monthly-summary compatibility.

Before live acceptance, sync the source and compare the weekly report's category
totals with the selected month's Transactions. No deployment, real sheet edits,
model calls or Telegram messages were performed during this implementation.
