/**
 * Optional Bound Menu Shim for "Budget 2027" (Google Sheets -> Extensions -> Apps Script).
 *
 * NOTE: Telegram webhooks (/trips, /tax, /items, /mandatory), 15-minute scheduled triggers,
 * daily/monthly coaching, CashCoverage, and automatic month creation all run directly from the
 * primary budget-automation GAS project once Script Properties ACTIVE_SPREADSHEET_ID and
 * BUDGET_WORKBOOK_YEAR='2027' are set — no bound script is required for day-to-day automation.
 *
 * If you also want the interactive "🤖 Budget Automation" menu inside the Budget 2027 spreadsheet UI,
 * add the primary GAS project as a Library (identifier: BudgetCore) and paste this shim.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🤖 Budget Automation')
    .addItem('Preview next month tab', 'shimPreviewNextMonth')
    .addItem('Create next month tab now', 'shimCreateNextMonth')
    .addSeparator()
    .addItem('Sync Папа debt benchmark rates', 'shimSyncPapaRates')
    .addToUi();
}

function shimPreviewNextMonth() { return BudgetCore.showMonthCreationPreview(); }
function shimCreateNextMonth() { return BudgetCore.createNextMonthFromMenu(); }
function shimSyncPapaRates() { return BudgetCore.syncPapaDebtRatesFromMenu(); }
