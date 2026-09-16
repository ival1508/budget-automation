# Stage 4C — Calendar reminders and missed dates

Implemented locally. No live deployment, Telegram delivery, trigger setup or
spreadsheet mutation was performed during this implementation. Val's live review
of the Calendar and the resulting overdue/upcoming sets remains pending.

## Use it

1. Sync the source to Apps Script and reload the spreadsheet.
2. Review `Calendar`, including manually added rows, and check `active` for each
   confirmed obligation. Amounts are in SGD; account/category names must match
   Transactions. `expected_day_of_month` accepts 1–31 or `EOM`.
3. Choose **💰 Budget → Check mandatory payments now**. This displays the result
   in the sheet without sending Telegram messages or changing cells.
4. Compare paid/overdue/upcoming results with the current ledger and G by eye.
   This implementation does not read G as proof of payment or write to it.
5. `/mandatory` uses the same Calendar brief in Telegram. The existing `dispatch`
   heartbeat sends the weekly brief. If no heartbeat is installed, use the
   existing trigger setup procedure; syncing source does not install a trigger.
   `setupTriggers()` replaces project triggers, so inspect existing triggers first.

## Dates and completion

- One reporting date, interpreted in SGT, anchors all reads and comparisons.
- Overdue means an unpaid expected date **before today**, within this month.
- Due this week means **today through today + 6 days**, capped at month-end.
  Next month's obligations are not included in a current-month unpaid report.
- EOM is the month's last day, including leap February. Numeric 29–31 clamp to
  the last day when the month is shorter.
- Payments must have type `Обязательные расходы`, fall within the reporting
  month, and not be future-dated relative to the check. E supplies SGD amounts;
  invalid/blank E never falls back to D. Refunds reduce the payment total.
- An item is paid when net assigned payments meet its Calendar amount, in cents.
  Partial payments remain outstanding and the report shows the remaining amount.
- CPF, zero Calendar amounts and categories/items with zero monthly plans are
  excluded. An inactive item is not tracked. No active items produces a setup
  message, rather than an all-clear result.
- All clear means no unpaid overdue or upcoming payments in the current window;
  the brief separately states how many unpaid items remain later this month.

## Matching separate obligations

Calendar categories match transaction categories exactly after case/whitespace
normalization; accounts match the same way. No fuzzy matching or LLM is used.
A single active item in a category/account pair receives payments for that pair,
regardless of merchant description. A category-only monthly total is never
reused across accounts or multiple obligations.

When multiple items share a category/account, `Calendar.item` must match
`Transactions` I (merchant/location) after case/whitespace normalization. For
example, separate rent and mortgage entries on the same account need distinct
matching names. Unassigned payments/refunds put the group in **Needs review**,
not paid or overdue, since the script cannot safely assign that money. Correct
item names or the ledger before paying again. Duplicate active identities stop
the check and require correction.

## Scheduling

`SHEET_FACTS.MANDATORY_REMINDERS` in `config.gs` controls the shared heartbeat:

| Setting | Default | Meaning |
| --- | --- | --- |
| WEEKLY_DAY | Mon | SGT weekday abbreviation, Mon–Sun |
| WEEKLY_TIME | 09:00 | Start of weekly delivery window |
| CATCH_UP_MINUTES | 180 | Retry window, capped at SGT midnight |
| SAME_DAY_ENABLED | false | Explicit opt-in for additional daily alerts |
| SAME_DAY_TIME | 21:00 | Evening check of still-unpaid items due today |

The heartbeat runs every 15 minutes; delivery occurs on the first eligible tick.
Weekly messages and optional day-of alerts are tracked per active recipient.
Failed deliveries retry within the window; successful recipients are not sent
again in that period. The day-of alert is one aggregate message per user/day,
not one message per bill. It does not repeat yesterday's overdue items. Each
retry re-reads the ledger, so a newly paid bill is no longer alerted. Ambiguous
items due today are explicitly identified for review.

Missing sheets, invalid data and malformed active Calendar rows stop report
construction. Scheduled weekly failures retain retry eligibility; daily failures
are logged and checked again on the next eligible heartbeat. Neither failure can
produce an all-clear result. Existing Telegram acknowledgement/retry behavior
is reused; a network timeout after server acceptance can still be ambiguous.

## Verification

`node scripts/test-regressions.cjs` passes 163 tests with 555 existing assertions.
Stage 4 coverage includes Parts A/B, date ordering, partial payments/refunds,
category/account isolation, ambiguous multi-item groups, exclusions, EOM and
short-month dates, leap years, year rollover, strict workbook reads, local menu
preview, configurable weekly slots, the real dispatcher-to-Calendar path,
per-recipient retries, optional day-of opt-in and once-per-day delivery.

Live checkpoint: verify the confirmed Calendar against reality, run the sheet
menu for the current month, and compare overdue/upcoming sets with the ledger
and G. Source tests do not replace this live acceptance.
