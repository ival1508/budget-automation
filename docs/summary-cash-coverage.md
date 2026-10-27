# Summary cash coverage — plan and implementation

Implemented 28 October 2026. Scope: automate Summary!E4 and use its latest value
in each daily coach brief. Source: `cashCoverage.gs`, with daily integration in
`coach.gs` and setup/preview entries in the Budget menu.

## Confirmed calculation

E4 compares recorded DBS SGD funds with **all pending current-month commitments,
the remaining Расходы budget, and income already assigned to the next month**.
Regular Google/Kaspersky payroll received in DBS during this month funds the
following budget month, matching Stage 6's preceding-month salary policy.
It remains reserved until calendar rollover. Unreceived income is excluded.

**Correction after Val's Niseko check:** version 92 incorrectly treated deposited
payroll as free current-month funding and removed the existing S$30,900 reserve.
The Niseko charges were already in the card balance. That wrong funding-period
assumption changed a S$24,300 deficit into a S$6,600 surplus. The corrected model
preserves the deficit and protects next month's received payroll automatically.

```
Cash after cards = Summary!D4 + Summary!D2 + Summary!D3
Pending mandatory costs = sum(max(0, planned - net logged fixed payments))
Remaining ordinary budget = max(0, current month's L33)
Next-month funding = net regular Google/Kaspersky payroll received in DBS this month
E4 = round(Cash after cards - Pending mandatory costs - Remaining ordinary budget - Next-month funding, 2)
```

- Card balances retain their sign, including card credits. Payments and their
  later card settlements must not consume coverage twice.
- Read all eleven D3:E13 monthly plan rows. CPF is a non-cash planning line and
  contributes no pending settlement cost. Match fixed payments by category,
  reporting month and dates through today; refunds reopen the remaining plan.
- `Родители` also matches the explicit `[Родители]` merchant tag used in the ledger.
  Tagged payments are assigned to that plan once, independently of their general
  category. Unmatched plans remain reserved; no fuzzy matching is used.
- Floor remaining ordinary budget at zero: already-incurred overspend is in the
  balances and cannot create cash by becoming a negative future reserve.
- Reserve actual net bank payroll only: no employer CPF, forecast salaries,
  bonuses, dividends, reimbursements or payroll credited to another account.
  Signed payroll corrections adjust the reserve; ambiguous/invalid data is
  unavailable. On rollover, the preceding month's reserve releases to fund the
  new month's plan. The Niseko payment is counted once through its card balance.
- This is coverage of **recorded** balances, payments and plans. It does not fetch
  bank balances directly or establish that all transactions have been recorded.

## Completed build steps

1. **Audit and policy:** inspected the old formula, account identities, monthly
   plans and ledger. Preserve the all-commitments policy and next-month funding.
   The old formula still reserved a logged MOE payment; ledger matching clears it.
2. **Native calculation:** `CashCoverage` contains the current month, account and
   commitment breakdown, with formulas feeding E4. TODAY uses the workbook's
   verified Singapore-equivalent timezone. Both legacy and yearless month aliases
   are checked against B1; duplicates or date mismatches yield unavailable data.
   Pre-created November does not replace October before calendar rollover.
3. **Read-only daily variable:** `readCashCoverage` returns `amount_sgd`, `as_of`,
   `month_tab`, `source`, `status` and an error reason when unavailable. It verifies
   managed formulas, current month and recalculation date. No reader creates tabs
   or writes cells. Formula normalization preserves quoted text.
4. **Daily output:** each new daily payload includes `cash_coverage`. A
   deterministic Settlement line is added to generated and fallback briefs;
   negative coverage calls for funding or a transfer. Coverage stays out of model
   arithmetic and remains separate from D19. Monthly reviews are unchanged.
5. **Installation:** explicit setup previews components, recognizes the audited
   legacy formula, checks account identities, records rollback evidence and
   verifies native values. Repeated setup is a no-op; unknown owner formulas are
   preserved. The live helper/E4 were installed together with a native Sheet
   batch and read back successfully.

## Verification

- **270 offline tests**, **556 existing assertions**, all `.gs` files parsed.
- **Seven Telegram edit regressions** pass; network delivery is mocked.
- **Eight native funding-period checks** pass in the existing TEST workbook:
  Niseko deficit, zero coverage without Niseko, before/after payday, a second
  salary, actual savings funding, calendar rollover and invalid current payroll.
  The original 15 native checks in version 92 verified the earlier arithmetic;
  they did not establish that its payroll-availability assumption was correct.
- Live E4 and its helper breakdown recalculate without errors. A local adapter
  over the native readback verifies the daily reader and rendered coverage line;
  this is not an Apps Script execution or a real Telegram delivery.
- Native formatting/merged ranges and unchanged Summary formatting were checked
  through cell metadata. No authenticated visual browser was available.
- **Corrected release: version 93**, superseding the incorrect version 92
  availability policy. All 33 application files are checked against the editor
  and immutable release. The existing web-app deployment is updated in place;
  its URL and deployment count are unchanged. Temporary native-test tabs were
  removed from the TEST workbook after verification.

## Operations and rollback

Reload Sheets for **Budget → Preview settlement coverage setup** and **Set up
settlement coverage**. The `CashCoverage` tab shows planned, logged and pending
costs, and row 25 shows received payroll protected for next month. Its hidden
rows 10–11 hold the calculation contract and original E4 formula
as inert JSON. No new trigger is required; native formulas recalculate and the
existing daily coach reads E4.

For workbook rollback, restore the `formula` from CashCoverage!B11 to Summary!E4
before removing the helper. That historical formula still references its original
month and must be reviewed if restored after rollover. For a full code rollback,
restore the pre-feature editor source and web-app version 91 together; version
92 contains the incorrect payroll policy and is not a financial rollback target.
Scheduled Apps Script triggers use editor source rather than the versioned
web-app deployment. Receipt of the next scheduled morning brief remains an
operational observation, not a test message sent by this work.
