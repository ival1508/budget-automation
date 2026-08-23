/**
 * Budget 2026 Automation v1 - Bootstrap & Learning Store Initialization
 * File: bootstrap.gs
 */

const MERCHANTS_TAB_NAME = 'Merchants';
const TRANSACTIONS_TAB_NAME = 'Transactions';

/**
 * Checks if the hidden 'Merchants' tab exists in the active spreadsheet.
 * If it does not exist, creates it automatically, appends the header row,
 * and hides the sheet (§5.2).
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {GoogleAppsScript.Spreadsheet.Sheet} The Merchants sheet instance.
 */
function initializeLearningStore(ss) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  let merchantsSheet = spreadsheet.getSheetByName(MERCHANTS_TAB_NAME);

  if (!merchantsSheet) {
    merchantsSheet = spreadsheet.insertSheet(MERCHANTS_TAB_NAME);
    
    // Header row: merchant, category, count, last_seen, aliases (§5.2)
    const headers = [['merchant', 'category', 'count', 'last_seen', 'aliases']];
    merchantsSheet.getRange(1, 1, 1, 5).setValues(headers);
    merchantsSheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    
    // Hide sheet as specified in §5.2
    merchantsSheet.hideSheet();
  } else {
    // If sheet exists with older 4-column structure, ensure 5th header exists
    if (merchantsSheet.getLastColumn() < 5) {
      merchantsSheet.getRange(1, 5).setValue('aliases').setFontWeight('bold');
    }
  }

  return merchantsSheet;
}

/**
 * Helper to retrieve the Transactions sheet, throwing if missing.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {GoogleAppsScript.Spreadsheet.Sheet} The Transactions sheet instance.
 */
function getTransactionsSheet(ss) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(TRANSACTIONS_TAB_NAME);
  if (!sheet) {
    throw new Error(`Sheet "${TRANSACTIONS_TAB_NAME}" not found in active spreadsheet.`);
  }
  return sheet;
}
