/**
 * Google Sheets custom menu for Budget Automation.
 * File: menu.gs
 */

function onOpen() {
  buildBudgetMenu(SpreadsheetApp.getUi());
}

function buildBudgetMenu(ui) {
  const maintenance = ui.createMenu('🔧 Maintenance')
    .addItem('Preview next month (read-only)', 'showMonthCreationPreview')
    .addItem('Preview monthly coach', 'showMonthlyCoachPreview')
    .addItem('Preview Basket Review (read-only)', 'showBasketReviewPreview')
    .addItem('Repair Transactions formulas', 'repairTransactionDerivedFormulas');

  ui.createMenu('💰 Budget')
    .addItem('Create next month tab now', 'createNextMonthFromMenu')
    .addItem('Check mandatory payments now', 'checkMandatoryPaymentsNow')
    .addItem('Run morning coach now', 'sendMorningCoach')
    .addItem('Update Папа monthly rates', 'updatePapaMonthlyRatesFromMenu')
    .addSeparator()
    .addSubMenu(maintenance)
    .addToUi();
}
