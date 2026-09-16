# Stage 4A — mandatory-payment calendar

Implemented locally; live historical verification and Val's review are pending.
Parts B/C (canonical paid matching, due dates and reminders) are separate work.

## Run and review

After syncing the source to Apps Script, reload the spreadsheet and choose
**💰 Budget → Seed / review mandatory calendar draft**. Alternatively run
`previewCalendarSeed()` for a read-only proposal or `seedCalendar()` to create
and append the draft. All runners accept an optional spreadsheet; preview/seed
also accept a reporting date and `{ lookbackMonths: 6, minimumMonths: 3 }`.

The visible `Calendar` tab has exactly these columns:

| Column | Meaning |
| --- | --- |
| item | Transactions I, falling back to category when I is blank |
| category | Transactions H |
| expected_day_of_month | Integer 1–31 or `EOM` (last day of month) |
| typical_amount | Typical monthly total in SGD |
| account | Transactions B |
| active | Checkbox; every new proposal starts unchecked |

Val should check the proposed identity, date, amount and account against reality,
edit them as needed, and check `active` only for confirmed items. Leave rejected
items unchecked. Execution logs include excluded/invalid rows and candidates
with insufficient history. Date-cell notes identify source Transactions rows,
observed date spread and multiple payments in a month. These row references
refer to the ledger at seed time; subsequent sorting can move them.

## Derivation rules

- Use `Обязательные расходы` rows in the six completed SGT calendar months before
  the reporting month. Require observations in at least three distinct months.
- Group by item, category and account, ignoring case and repeated whitespace.
  No LLM, fuzzy aliases or hardcoded item/date rules are involved.
- Only positive, readable SGD amounts from E qualify. Blank/error E never falls
  back to original-currency D. Refunds/zero rows are reported as excluded.
  CPF is excluded using the existing non-ledger config.
- For each month, take the median payment day and total payment amount. Across
  months, take the median of those days (rounded) and median of those totals.
  This gives each observed month one vote. Missing months are not zero payments.
- Propose `EOM` when at least two thirds of monthly median dates fall on the last
  two calendar days. This heuristic needs review, particularly fixed dates near
  month-end and payments shifted by weekends.
- Multiple payments sharing an identity are flagged for review. If they represent
  separate obligations, split/edit the draft manually before activating it.
  Account changes and unnormalized merchant descriptions can also split candidates.

## Preservation and scope

Seeding uses the shared budget writer lock and appends missing identities only.
It preserves all existing rows, edits and checkboxes. Unexpected headers stop the
write. Changing an item's name/category/account changes its identity; a later
seed can propose the old identity again. Keep rejected identities as inactive
rows to suppress their reappearance. No Transactions or monthly G cells are
written, and no reminders or triggers are enabled by Stage 4A.

## Verification

Run `node scripts/test-regressions.cjs`. The suite covers the three-item
`test_seedCalendar()` fixture (IRAS ≈ 6, Лин = EOM, auto loan ≈ 4), recurrence,
SGD failures, date windows/year rollover, leap years, SGT boundaries, monthly
weighting, account isolation, repeated seeding and preservation of human edits.
The Apps Script `test_seedCalendar()` runner is also an offline fixture test.

Live acceptance remains: preview actual history; check at least three known
items against their ledger dates (±2 days, or EOM); inspect skipped candidates;
seed and review the visible draft with Val. Fixture results do not establish that
actual merchant descriptions or history will produce those same three items.
