/**
 * Budget 2026 Automation v1 - Read APIs Component
 * File: reader.gs
 * 
 * Module for reading financial spreadsheet state cleanly without modifying cells or formulas.
 */

/**
 * Helper function for clean number parsing across currency formats, spaces, and Russian decimal commas.
 * Handles numbers, strings with currency symbols (S$, $, ₽), spaces (including non-breaking spaces),
 * and converts decimal commas (,) to dots (.).
 * 
 * @param {*} rawVal - Raw value from spreadsheet cell.
 * @param {string} [displayVal] - Displayed formatted string from spreadsheet cell.
 * @return {number} Parsed floating point number.
 */
function parseAmountNumber(rawVal, displayVal) {
  if (typeof rawVal === 'number' && !isNaN(rawVal)) {
    return rawVal;
  }
  const valStr = String(displayVal || rawVal || '').trim();
  if (!valStr) return 0;

  // Remove currency symbols (S$, $, ₽, etc.), alphabet letters, non-breaking and thin spaces
  let cleaned = valStr.replace(/[^\d.,\s-]/g, '').trim();
  cleaned = cleaned.replace(/\s+/g, '');

  // Handle both commas and dots (e.g. "1 234,56" or "1,234.56")
  if (cleaned.indexOf(',') !== -1 && cleaned.indexOf('.') !== -1) {
    if (cleaned.indexOf(',') < cleaned.indexOf('.')) {
      cleaned = cleaned.replace(/,/g, ''); // Comma thousand separator
    } else {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.'); // Dot thousand separator, comma decimal
    }
  } else if (cleaned.indexOf(',') !== -1) {
    cleaned = cleaned.replace(',', '.'); // Only comma decimal
  }

  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Generates the exact Russian tab name for the current month in Asia/Singapore timezone,
 * using SHEET_FACTS to handle irregular Cyrillic single-letter tabs (Jan-Apr) vs. full names (May+).
 * 
 * @param {Date} [optDate] - Optional Date object. Defaults to current SGT date.
 * @return {string} Russian month tab name (e.g., "Я'26", "Июль'26", "Август'26").
 */
function getCurrentMonthTabName(optDate) {
  const date = optDate instanceof Date ? optDate : new Date();
  
  if (typeof SHEET_FACTS !== 'undefined' && typeof SHEET_FACTS.getMonthTabName === 'function') {
    return SHEET_FACTS.getMonthTabName(date);
  }

  // Fallback map if SHEET_FACTS is unavailable
  const monthStr = Utilities.formatDate(date, 'Asia/Singapore', 'M');
  const monthNum = parseInt(monthStr, 10);
  const fallbackNames = {
    1: "Я'26", 2: "Ф'26", 3: "М'26", 4: "А'26",
    5: "Май'26", 6: "Июнь'26", 7: "Июль'26", 8: "Август'26",
    9: "Сентябрь'26", 10: "Октябрь'26", 11: "Ноябрь'26", 12: "Декабрь'26"
  };
  
  return fallbackNames[monthNum] || '';
}

/**
 * STAGE 1: getActiveMonthTab() → returns correct tab via the month map.
 * If current month's tab does not exist yet (JIT created), returns clear missing signal.
 * Once Stage 6 exists, this routes through ensureMonthTab() to auto-create it.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss]
 * @param {Date} [optDate]
 * @return {Object} { tabName, sheet, exists, status, message }
 */
function getActiveMonthTab(ss, optDate) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) return { exists: false, status: 'NO_SPREADSHEET', error: 'No active spreadsheet found.' };
  
  const tabName = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.getMonthTabName) 
    ? SHEET_FACTS.getMonthTabName(optDate) 
    : getCurrentMonthTabName(optDate);
    
  let sheet = spreadsheet.getSheetByName(tabName);
  
  // Hook for Stage 6 automated JIT creation once ensureMonthTab exists
  if (!sheet && typeof ensureMonthTab === 'function') {
    sheet = ensureMonthTab(spreadsheet, tabName, optDate);
  }
  
  if (!sheet) {
    return {
      tabName: tabName,
      exists: false,
      status: 'current-month tab missing',
      message: `⚠️ Current month tab "${tabName}" does not exist yet. Please create it by hand or run Stage 6 creator.`
    };
  }
  
  return {
    tabName: tabName,
    sheet: sheet,
    exists: true,
    status: 'ACTIVE'
  };
}

/**
 * Reads expected mandatory expense items from Range D3:G13 of the current month's tab.
 * Returns planned items with name, planned_amount, and checkbox status (is_checked).
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Array<Object>} Array of objects: [{ name: "Аренда", planned_amount: 17092.33, is_checked: false }]
 */
function getMandatoryExpenses(ss) {
  try {
    const activeInfo = getActiveMonthTab(ss);
    if (!activeInfo || !activeInfo.exists) {
      Logger.log(`⚠️ Warning: ${activeInfo ? activeInfo.message : 'Sheet not found'}`);
      return [];
    }
    const sheet = activeInfo.sheet;

    // Read D3:G13 where description (Col D), planned amount (Col E), % of total budget (Col F), and checkbox (Col G) are listed
    const rangeStr = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.MONTHLY_TAB_STRUCTURE)
      ? SHEET_FACTS.MONTHLY_TAB_STRUCTURE.MANDATORY_EXPENSES_RANGE
      : 'D3:G13';
    const range = sheet.getRange(rangeStr);
    const rangeValues = range.getValues();
    const rangeDisp = range.getDisplayValues();
    const cleaned = [];

    for (let i = 0; i < rangeValues.length; i++) {
      const label = String(rangeValues[i][0] || '').trim();
      const amount = parseAmountNumber(rangeValues[i][1], rangeDisp[i][1]);
      // Col G is index 3 in D:G range (Col D=0, Col E=1, Col F=2, Col G=3)
      const rawCheck = rangeValues[i].length > 3 ? rangeValues[i][3] : rangeValues[i][2];
      const paidFlag = (rawCheck === true || String(rawCheck).toUpperCase() === 'TRUE');

      // Filter out empty cells, blanks, zeros, and dashes in description
      if (label && label !== '0' && label !== '0.00' && label !== '0,00' && label !== '-' && label !== '—' && label !== '--') {
        cleaned.push({
          label: label,
          amount: amount,
          paidFlag: paidFlag,
          // Backward compatible keys for legacy consumers
          name: label,
          planned_amount: amount,
          is_checked: paidFlag
        });
      }
    }

    return cleaned;
  } catch (e) {
    Logger.log(`Error in getMandatoryExpenses: ${e.message}`);
    return [];
  }
}

function getExpectedMandatoryExpenses(ss) {
  return getMandatoryExpenses(ss);
}

/**
 * Reads logged transactions from the "Transactions" tab for the current month
 * where Type equals "Обязательные расходы".
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Array<Object>} Array of logged objects: [{ description: "Mortgage July", actual_amount: 17092.33 }]
 */
function getLoggedMandatoryThisMonth(ss) {
  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return [];

    const transTabName = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.CORE_TABS) ? SHEET_FACTS.CORE_TABS.TRANSACTIONS : 'Transactions';
    const sheet = spreadsheet.getSheetByName(transTabName);
    if (!sheet) {
      Logger.log(`⚠️ Warning: "${transTabName}" sheet not found.`);
      return [];
    }

    const lastRow = sheet.getLastRow();
    const startRow = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE) ? SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE.DATA_START_ROW : 2;
    if (lastRow < startRow) return [];

    // Determine current month & year in SGT
    const now = new Date();
    const currentMonthYearStr = Utilities.formatDate(now, 'Asia/Singapore', 'MM.yyyy');

    const numCols = sheet.getLastColumn();
    const rawData = sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).getValues();
    const dispData = sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).getDisplayValues();

    const targetType = (typeof TRANSACTION_TYPES !== 'undefined' && TRANSACTION_TYPES.FIXED_EXPENSE)
      ? TRANSACTION_TYPES.FIXED_EXPENSE
      : 'Обязательные расходы';

    const groups = {};

    for (let r = 0; r < rawData.length; r++) {
      const row = rawData[r];
      const disp = dispData[r];
      const cellDate = row[0];
      const typeColC = String(row[2] || '').trim().replace(/\t/g, '');

      // Match Type (Column C only)
      const isFixedType = (typeColC === targetType);
      if (!isFixedType) continue;

      let dateMatch = false;
      if (cellDate instanceof Date) {
        const rowMonthYearStr = Utilities.formatDate(cellDate, 'Asia/Singapore', 'MM.yyyy');
        dateMatch = (rowMonthYearStr === currentMonthYearStr);
      } else if (typeof cellDate === 'string' && cellDate.trim()) {
        const parts = cellDate.trim().split('.');
        if (parts.length === 3) {
          const monthYear = `${parts[1].padStart(2, '0')}.${parts[2]}`;
          dateMatch = (monthYear === currentMonthYearStr);
        }
      }

      if (dateMatch) {
        const category = String(row[7] || '').trim(); // Col H
        const where = String(row[8] || '').trim();    // Col I
        const amount = parseAmountNumber(row[4], disp[4]) || parseAmountNumber(row[3], disp[3]) || 0;

        // Exact enum string with hyphen spacing
        const label = where ? `${category} - ${where}` : category;
        const key = label.toLowerCase();

        if (!groups[key]) {
          groups[key] = {
            label: label,
            category: category,
            where: where,
            amount: 0,
            // Backward compatibility
            description: label,
            actual_amount: 0
          };
        }
        groups[key].amount = Number((groups[key].amount + amount).toFixed(2));
        groups[key].actual_amount = groups[key].amount;
      }
    }

    return Object.values(groups);
  } catch (e) {
    Logger.log(`Error in getLoggedMandatoryThisMonth: ${e.message}`);
    return [];
  }
}

function getLoggedMandatoryExpenses(ss) {
  return getLoggedMandatoryThisMonth(ss);
}

/**
 * Scans Column H (Dates / Дата) in the active month's tab starting from row 2 to find today's date,
 * and extracts daily budget metrics from Column J (daily_spend), Column K (daily_budget), and Column L (daily_saldo).
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Object} Status object with daily_spend, daily_budget, and daily_saldo parsed as numbers.
 */
function getDailyBudgetStatus(ss) {
  const defaultStatus = { daily_spend: 0, daily_budget: 0, daily_saldo: 0 };

  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return defaultStatus;

    const tabName = getCurrentMonthTabName();
    const sheet = spreadsheet.getSheetByName(tabName);

    if (!sheet) {
      Logger.log(`⚠️ Warning: Sheet "${tabName}" not found for daily budget status.`);
      return defaultStatus;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return defaultStatus;

    // Determine target SGT date parts
    const now = new Date();
    const targetYear = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy'), 10);
    const targetMonth = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'M'), 10) - 1; // 0-indexed (0-11)
    const targetDay = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'd'), 10);
    const targetFullStr = Utilities.formatDate(now, 'Asia/Singapore', 'dd.MM.yyyy');

    // Read Range H2:L (Col H: Date, Col J: daily_spend, Col K: daily_budget, Col L: daily_saldo)
    // Range starts at Row 2, Col 8 (H), numCols 5 (H, I, J, K, L)
    const rawValues = sheet.getRange(2, 8, lastRow - 1, 5).getValues();
    const displayValues = sheet.getRange(2, 8, lastRow - 1, 5).getDisplayValues();

    let bestMatch = null;

    for (let r = 0; r < rawValues.length; r++) {
      const rawDateCell = rawValues[r][0]; // Col H (index 0 in range)
      const displayDateStr = String(displayValues[r][0] || '').trim();
      let matchesToday = false;

      // 1. Date object comparison (exact year, month, date matching)
      if (rawDateCell instanceof Date) {
        matchesToday = (
          rawDateCell.getDate() === targetDay &&
          rawDateCell.getMonth() === targetMonth &&
          rawDateCell.getFullYear() === targetYear
        );
      }

      // 2. Display value comparison (fallback for formatted date strings like "26", "26.07", "26.07.2026")
      if (!matchesToday && displayDateStr) {
        if (displayDateStr === targetFullStr || displayDateStr === String(targetDay)) {
          matchesToday = true;
        } else {
          // Check if displayed string starts with today's day number (e.g., "26", "26.07")
          const dayMatch = displayDateStr.match(/^(\d{1,2})[\/\.-]?/);
          if (dayMatch && parseInt(dayMatch[1], 10) === targetDay) {
            matchesToday = true;
          }
        }
      }

      // 3. Raw number comparison (fallback for day number cells)
      if (!matchesToday && typeof rawDateCell === 'number') {
        matchesToday = (rawDateCell === targetDay);
      }

      if (matchesToday) {
        // Relative to Col H (index 0): Col J = index 2 (Траты), Col K = index 3 (Бюджет), Col L = index 4 (Сальдо)
        const dailySpend = parseAmountNumber(rawValues[r][2], displayValues[r][2]);
        const dailyBudget = parseAmountNumber(rawValues[r][3], displayValues[r][3]);
        const dailySaldo = parseAmountNumber(rawValues[r][4], displayValues[r][4]);

        const candidate = {
          daily_spend: dailySpend,
          daily_budget: dailyBudget,
          daily_saldo: dailySaldo
        };

        if (!bestMatch) {
          bestMatch = candidate;
        } else if (candidate.daily_budget > 0 || candidate.daily_spend > 0) {
          bestMatch = candidate;
        }
      }
    }

    if (bestMatch) {
      return bestMatch;
    }

    Logger.log(`Info: Today's date (${targetFullStr}) row not found in Column H of ${tabName}. Returning defaults.`);
    return defaultStatus;
  } catch (e) {
    Logger.log(`Error in getDailyBudgetStatus: ${e.message}`);
    return defaultStatus;
  }
}

/**
 * STAGE 1: getDailySaldo() → {saldo, daysLeftInMonth} from SHEET_FACTS.saldoCell (D19 & Daily Tracker).
 * Also includes currentDailyBudget from cell D19 for downstream calculations.
 */
function getDailySaldo(ss) {
  try {
    const activeInfo = getActiveMonthTab(ss);
    if (!activeInfo || !activeInfo.exists) {
      return { saldo: 0, currentDailyBudget: 0, daysLeftInMonth: 1, status: activeInfo ? activeInfo.status : 'MISSING' };
    }
    const sheet = activeInfo.sheet;

    const now = new Date();
    const year = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy'), 10);
    const month = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'M'), 10);
    const day = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'd'), 10);
    const totalDays = new Date(year, month, 0).getDate();
    const daysLeftInMonth = Math.max(1, totalDays - day + 1);

    const cellRef = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.MONTHLY_TAB_STRUCTURE && (SHEET_FACTS.MONTHLY_TAB_STRUCTURE.saldoCell || SHEET_FACTS.MONTHLY_TAB_STRUCTURE.CURRENT_DAILY_BUDGET_CELL)) || 'D19';
    const d19Raw = sheet.getRange(cellRef).getValue();
    const d19Disp = sheet.getRange(cellRef).getDisplayValue();
    const currentDailyBudget = parseAmountNumber(d19Raw, d19Disp);

    const dailyStatus = getDailyBudgetStatus(sheet.getParent());
    let saldo = dailyStatus.daily_saldo;

    if (!saldo && currentDailyBudget > 0) {
      saldo = Number((currentDailyBudget * daysLeftInMonth).toFixed(2));
    }

    return {
      saldo: saldo,
      daysLeftInMonth: daysLeftInMonth,
      currentDailyBudget: currentDailyBudget
    };
  } catch (e) {
    Logger.log(`Error in getDailySaldo: ${e.message}`);
    return { saldo: 0, currentDailyBudget: 0, daysLeftInMonth: 1, error: e.message };
  }
}

/**
 * Reads the "50/30/20" tab to extract actual spending pacing and granular sub-category breakdowns.
 * Layout: Col A = Bucket Type, Col B = Category Name / Total. Row 1 = Month Headers "MM/YYYY".
 * Target month column holds $ actual spend, target month column + 1 holds % percentage.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Object} Granular pacing object { needs: { total_actual, total_percent, sub_categories }, ... }
 */
function get503020Status(ss) {
  const defaultPacing = {
    needs: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
    wants: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
    savings: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
    taxes: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] }
  };

  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return defaultPacing;

    const sheet = spreadsheet.getSheetByName('50/30/20');
    if (!sheet) {
      Logger.log('⚠️ Warning: Sheet "50/30/20" not found.');
      return defaultPacing;
    }

    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    if (lastCol === 0 || lastRow < 3) return defaultPacing;

    // 1. Generate current month string in "MM/yyyy" format (e.g. "07/2026")
    const now = new Date();
    const targetMonthYearStr = Utilities.formatDate(now, 'Asia/Singapore', 'MM/yyyy');

    // 2. Read Row 1 to find the column index matching "MM/yyyy"
    const headerRaw = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const headerDisplay = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];

    let targetColIndex = -1;

    for (let c = 0; c < headerRaw.length; c++) {
      const rawVal = headerRaw[c];
      const dispVal = String(headerDisplay[c] || '').trim();

      let formattedHeader = '';
      if (rawVal instanceof Date) {
        formattedHeader = Utilities.formatDate(rawVal, 'Asia/Singapore', 'MM/yyyy');
      } else if (dispVal) {
        formattedHeader = dispVal;
      }

      if (formattedHeader.indexOf(targetMonthYearStr) !== -1 || dispVal.indexOf(targetMonthYearStr) !== -1) {
        targetColIndex = c;
        break;
      }
    }

    if (targetColIndex === -1) {
      Logger.log(`⚠️ Warning: Current month header "${targetMonthYearStr}" not found in Row 1 of "50/30/20" tab.`);
      return defaultPacing;
    }

    // 3. Read data starting from Row 3 to lastRow
    const numRows = lastRow - 2;
    const maxReadCol = sheet.getLastColumn();
    const rowRawData = sheet.getRange(3, 1, numRows, maxReadCol).getValues();
    const rowDisplayData = sheet.getRange(3, 1, numRows, maxReadCol).getDisplayValues();

    const result = {
      needs: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
      wants: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
      savings: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
      taxes: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] }
    };

    let currentBucket = null;

    function parsePercentString(rawVal, displayVal) {
      if (displayVal && String(displayVal).indexOf('%') !== -1) {
        return String(displayVal).trim();
      }
      if (typeof rawVal === 'number' && !isNaN(rawVal)) {
        const pct = rawVal <= 1 ? (rawVal * 100).toFixed(1) : rawVal.toFixed(1);
        return pct + '%';
      }
      if (displayVal && String(displayVal).trim()) {
        return String(displayVal).trim();
      }
      return '0%';
    }

    // Diagnostic log to inspect sheet layout during execution
    Logger.log('\n--- [DEBUG] 50/30/20 Tab Row Inspection (Cols A, B, Current Month, AE, AF) ---');
    for (let d = 0; d < rowDisplayData.length; d++) {
      const rNum = d + 3;
      const cA = String(rowDisplayData[d][0] || '').trim();
      const cB = String(rowDisplayData[d][1] || '').trim();
      const cAmt = targetColIndex !== -1 ? parseAmountNumber(rowRawData[d][targetColIndex], rowDisplayData[d][targetColIndex]) : 0;
      const cTarget = rowRawData[d].length > 30 ? parseAmountNumber(rowRawData[d][30], rowDisplayData[d][30]) : 0;
      if (cA || cB || cAmt || cTarget) {
        Logger.log(`[Row ${rNum}] Col A: "${cA}" | Col B: "${cB}" | Current Month Amt: ${cAmt} | Col AE Target: ${cTarget}`);
      }
    }
    Logger.log('---------------------------------------------------------------------------\n');

    // 4. Iterate through rows
    for (let r = 0; r < rowDisplayData.length; r++) {
      const colA = String(rowDisplayData[r][0] || '').trim();
      const colB = String(rowDisplayData[r][1] || '').trim();

      // Determine active bucket from Column A
      const lowerA = colA.toLowerCase();
      if (lowerA.includes('needs') || lowerA.includes('потребности') || lowerA.includes('нужды')) {
        currentBucket = 'needs';
      } else if (lowerA.includes('wants') || lowerA.includes('желания') || lowerA.includes('хотелки')) {
        currentBucket = 'wants';
      } else if (lowerA.includes('taxes') || lowerA.includes('налог')) {
        currentBucket = 'taxes';
      } else if (lowerA.includes('savings') || lowerA.includes('сбережения') || lowerA.includes('отложения') || lowerA.includes('инвестиции')) {
        currentBucket = 'savings';
      }

      if (!currentBucket || (!colA && !colB)) continue;

      const colAmount = parseAmountNumber(rowRawData[r][targetColIndex], rowDisplayData[r][targetColIndex]);
      const colPercent = parsePercentString(rowRawData[r][targetColIndex + 1], rowDisplayData[r][targetColIndex + 1]);

      // Target dollar value specifically from Column AE (index 30), Target % from Column AF (index 31)
      const targetSpend = rowRawData[r].length > 30 ? parseAmountNumber(rowRawData[r][30], rowDisplayData[r][30]) : 0;
      const targetPercent = rowRawData[r].length > 31 ? parsePercentString(rowRawData[r][31], rowDisplayData[r][31]) : '0%';

      const lowerB = colB.toLowerCase();

      // Ignore overall budget Grand Total rows so they do not overwrite a section's totals
      if (lowerA.includes('grand total') || lowerB.includes('grand total') || lowerA.includes('итого по бюджету') || lowerB.includes('итого по бюджету')) {
        continue;
      }

      // Do NOT treat (colA !== '' && !colB) as a total row; that is typically a section header
      const isTotalRow = lowerB.includes('total') || lowerB.includes('итого') || lowerB.includes('всего') ||
                         lowerA.includes('total') || lowerA.includes('итого') || lowerA.includes('всего') ||
                         (colA !== '' && colB !== '' && lowerB === lowerA) ||
                         (currentBucket === 'needs' && (lowerB === 'needs' || lowerB === 'потребности' || lowerB === 'нужды')) ||
                         (currentBucket === 'wants' && (lowerB === 'wants' || lowerB === 'желания' || lowerB === 'хотелки')) ||
                         (currentBucket === 'savings' && (lowerB === 'savings' || lowerB === 'сбережения' || lowerB === 'отложения')) ||
                         (currentBucket === 'taxes' && (lowerB === 'taxes' || lowerB === 'налог' || lowerB === 'налоги'));

      if (isTotalRow) {
        // Prevent subsequent Grand Total rows at the bottom of the table from overwriting already matched category summaries
        if (!result[currentBucket].found_summary) {
          Logger.log(`📌 Matched summary for [${currentBucket}] at Row ${r + 3}: Actual=${colAmount}, Target=${targetSpend}`);
          result[currentBucket].total_actual = colAmount;
          result[currentBucket].actual = colAmount;
          result[currentBucket].total_percent = colPercent;
          result[currentBucket].target = targetSpend;
          result[currentBucket].target_percent = targetPercent;
          result[currentBucket].found_summary = true;
        }
      } else {
        // Do not add section headers (where colB is empty and colA is the bucket name) to subcategories
        if (colB) {
          result[currentBucket].sub_categories.push({
            name: colB || colA,
            actual: colAmount,
            percent: colPercent,
            target: targetSpend
          });
        }
      }
    }

    // Only fallback to summing sub-categories if NO summary row was encountered for a bucket
    Object.keys(result).forEach(k => {
      const bucket = result[k];
      if (!bucket.found_summary && bucket.sub_categories.length > 0) {
        Logger.log(`⚠️ No summary row found for [${k}]; falling back to sum of ${bucket.sub_categories.length} subcategories.`);
        bucket.actual = Number(bucket.sub_categories.reduce((sum, sub) => sum + sub.actual, 0).toFixed(2));
        bucket.total_actual = bucket.actual;
        bucket.target = Number(bucket.sub_categories.reduce((sum, sub) => sum + sub.target, 0).toFixed(2));
      }
      delete bucket.found_summary;
    });

    return result;
  } catch (e) {
    Logger.log(`Error in get503020Status: ${e.message}`);
    return defaultPacing;
  }
}

/**
 * Scans the "Transactions" tab for rows logged on today's SGT date (or specified date) where Type equals "Расходы".
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @param {Date|string} [optTargetDate] - Optional specific date to match (Date object or 'DD.MM.YYYY' / 'YYYY-MM-DD'). Defaults to today in SGT.
 * @return {Array<Object>} Sorted array of objects: [{ date, description, amount, category, account, type, notes }] descending by amount.
 */
function getTodaysTransactions(ss, optTargetDate) {
  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return [];

    const sheet = spreadsheet.getSheetByName('Transactions');
    if (!sheet) {
      Logger.log('⚠️ Warning: Sheet "Transactions" not found.');
      return [];
    }

    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const tz = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Singapore';
    const now = new Date();
    
    // Determine canonical target date string in DD.MM.YYYY format
    let targetDateStr = '';
    if (optTargetDate) {
      if (optTargetDate instanceof Date) {
        targetDateStr = Utilities.formatDate(optTargetDate, tz, 'dd.MM.yyyy');
      } else {
        targetDateStr = typeof normalizeDateString === 'function' ? normalizeDateString(optTargetDate) : String(optTargetDate).trim();
      }
    } else {
      targetDateStr = Utilities.formatDate(now, tz, 'dd.MM.yyyy');
    }

    // Read range A2:J (Col A: Date, Col B: Account, Col C: Type, Col E: Amount, Col H: Category, Col I: Description/Where, Col J: Notes)
    const rawValues = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
    const displayValues = sheet.getRange(2, 1, lastRow - 1, 10).getDisplayValues();

    const todaysTxns = [];

    for (let r = 0; r < rawValues.length; r++) {
      // 1. Strict Type Filter: Column C (index 2) MUST equal "Расходы"
      const rawType = String(rawValues[r][2] || displayValues[r][2] || '').trim();
      if (rawType !== 'Расходы') {
        continue;
      }

      // 2. Strict Exact Date Match against targetDateStr (DD.MM.YYYY)
      const rawDateCell = rawValues[r][0]; // Col A (index 0)
      const displayDateStr = String(displayValues[r][0] || '').trim();
      let rowDateStr = '';

      if (rawDateCell instanceof Date) {
        try {
          rowDateStr = Utilities.formatDate(rawDateCell, tz, 'dd.MM.yyyy');
        } catch (e) {
          rowDateStr = typeof normalizeDateString === 'function' ? normalizeDateString(rawDateCell) : '';
        }
      } else if (displayDateStr || rawDateCell) {
        rowDateStr = typeof normalizeDateString === 'function' ? normalizeDateString(displayDateStr || rawDateCell) : String(displayDateStr || rawDateCell).trim();
      }

      if (rowDateStr === targetDateStr) {
        const account = String(displayValues[r][1] || '').trim(); // Col B (index 1)
        const type = String(displayValues[r][2] || '').trim(); // Col C (index 2)
        const amount = parseAmountNumber(rawValues[r][4], displayValues[r][4]); // Col E (index 4)
        const category = String(displayValues[r][7] || '').trim(); // Col H (index 7)
        const description = String(displayValues[r][8] || '').trim() || String(displayValues[r][7] || '').trim(); // Col I (index 8)
        const notes = displayValues[r].length > 9 ? String(displayValues[r][9] || '').trim() : ''; // Col J (index 9)

        todaysTxns.push({
          date: rowDateStr,
          description: description,
          amount: amount,
          category: category,
          account: account,
          type: type,
          notes: notes
        });
      }
    }

    // Sort descending by amount
    todaysTxns.sort((a, b) => b.amount - a.amount);
    return todaysTxns;
  } catch (e) {
    Logger.log(`Error in getTodaysTransactions: ${e.message}`);
    return [];
  }
}

/**
 * Scans Column H (Dates) in the active month's tab up to today's date to extract recent daily budget trends.
 * Pre-computes how many days spend exceeded daily baseline budget.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Object} Object: { days_analyzed, days_exceeded_budget, trends }
 */
function getRecentDailyTrends(ss) {
  const defaultResult = { days_analyzed: 0, days_exceeded_budget: 0, trends: [] };

  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return defaultResult;

    const tabName = getCurrentMonthTabName();
    const sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet) {
      Logger.log(`⚠️ Warning: Sheet "${tabName}" not found for recent daily trends.`);
      return defaultResult;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return defaultResult;

    const now = new Date();
    const targetYear = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy'), 10);
    const targetMonth = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'M'), 10) - 1;
    const targetDay = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'd'), 10);

    // Read Range H2:L (Col H: Date, Col J: Spend, Col K: Budget, Col L: Saldo)
    const rawValues = sheet.getRange(2, 8, lastRow - 1, 5).getValues();
    const displayValues = sheet.getRange(2, 8, lastRow - 1, 5).getDisplayValues();

    const trendsMap = new Map();

    for (let r = 0; r < rawValues.length; r++) {
      const rawDateCell = rawValues[r][0];
      const displayDateStr = String(displayValues[r][0] || '').trim();

      if (!displayDateStr && !rawDateCell) continue;

      let cellDay = -1;
      let cellMonth = -1;
      let cellYear = -1;

      if (rawDateCell instanceof Date) {
        cellDay = rawDateCell.getDate();
        cellMonth = rawDateCell.getMonth();
        cellYear = rawDateCell.getFullYear();
      } else if (typeof rawDateCell === 'number') {
        cellDay = rawDateCell;
        cellMonth = targetMonth;
        cellYear = targetYear;
      } else if (displayDateStr) {
        const dayMatch = displayDateStr.match(/^(\d{1,2})[\/\.-]?/);
        if (dayMatch) {
          cellDay = parseInt(dayMatch[1], 10);
          cellMonth = targetMonth;
          cellYear = targetYear;
        }
      }

      if (cellDay > 0 && cellDay <= targetDay && (cellMonth === -1 || cellMonth === targetMonth)) {
        const spend = parseAmountNumber(rawValues[r][2], displayValues[r][2]);  // Col J (index 2)
        const budget = parseAmountNumber(rawValues[r][3], displayValues[r][3]); // Col K (index 3)
        const saldo = parseAmountNumber(rawValues[r][4], displayValues[r][4]);  // Col L (index 4)

        const dateKey = displayDateStr || `Day ${cellDay}`;
        const candidate = {
          date: dateKey,
          spend: spend,
          budget: budget,
          saldo: saldo
        };

        if (!trendsMap.has(dateKey)) {
          trendsMap.set(dateKey, candidate);
        } else if (candidate.budget > 0 || candidate.spend > 0) {
          trendsMap.set(dateKey, candidate);
        }
      }
    }

    const rawTrends = Array.from(trendsMap.values());
    const last14Trends = rawTrends.slice(-14);
    let exceededCount = 0;

    last14Trends.forEach(item => {
      if (item.spend > item.budget) {
        exceededCount++;
      }
    });

    return {
      days_analyzed: last14Trends.length,
      days_exceeded_budget: exceededCount,
      trends: last14Trends
    };
  } catch (e) {
    Logger.log(`Error in getRecentDailyTrends: ${e.message}`);
    return defaultResult;
  }
}

/**
 * Master aggregator function that gathers current financial status across the spreadsheet
 * into a single structured JSON context object for AI/Budget Coach.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Object} Master context JSON object.
 */
function getBudgetCoachContext(ss) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();

  const currentDateStr = Utilities.formatDate(now, 'Asia/Singapore', 'dd.MM.yyyy');
  const monthTab = getCurrentMonthTabName(now);

  const dailyStatus = getDailyBudgetStatus(spreadsheet);
  const expectedMandatory = getExpectedMandatoryExpenses(spreadsheet);
  const loggedMandatory = getLoggedMandatoryExpenses(spreadsheet);
  const pacing503020 = get503020Status(spreadsheet);
  const todaysTxns = getTodaysTransactions(spreadsheet);
  const recentTrends = getRecentDailyTrends(spreadsheet);

  const context = {
    current_date: currentDateStr,
    month_tab: monthTab,
    daily_status: dailyStatus,
    todays_transactions: todaysTxns,
    recent_trends: recentTrends,
    mandatory_expenses: {
      expected: expectedMandatory,
      logged: loggedMandatory
    },
    pacing_50_30_20: pacing503020
  };

  Logger.log('=== Budget Coach Context Aggregated ===');
  Logger.log(JSON.stringify(context, null, 2));

  return context;
}

/**
 * Test runner function to test all Read APIs directly inside Google Apps Script Editor.
 */
function testReaderAPIs() {
  Logger.log('=== Running Phase 2 Read APIs Test Suite ===');

  const monthTab = getCurrentMonthTabName();
  Logger.log(`1. getCurrentMonthTabName(): "${monthTab}"`);

  const expectedFixed = getExpectedMandatoryExpenses();
  Logger.log(`2. getExpectedMandatoryExpenses(): ${JSON.stringify(expectedFixed)}`);

  const loggedFixed = getLoggedMandatoryExpenses();
  Logger.log(`3. getLoggedMandatoryExpenses(): ${JSON.stringify(loggedFixed)}`);

  const dailyStatus = getDailyBudgetStatus();
  Logger.log(`4. getDailyBudgetStatus(): ${JSON.stringify(dailyStatus)}`);

  const pacing = get503020Status();
  Logger.log(`5. get503020Status(): ${JSON.stringify(pacing)}`);

  const todaysTxns = getTodaysTransactions();
  Logger.log(`6. getTodaysTransactions(): ${JSON.stringify(todaysTxns)}`);

  const recentTrends = getRecentDailyTrends();
  Logger.log(`7. getRecentDailyTrends(): ${JSON.stringify(recentTrends)}`);

  Logger.log('\n8. Running getBudgetCoachContext()...');
  const masterContext = getBudgetCoachContext();

  Logger.log('=== Read APIs Test Suite Execution Complete ===');
}

/**
 * STAGE 1: getCategoryVelocity() → current-month sums for volatile discretionary categories:
 * Рестораны, Развлечения, Дом, Подарки (specifically excludes Шопинг).
 */
function getCategoryVelocity(ss) {
  const targetCategories = ['Рестораны', 'Развлечения', 'Дом', 'Подарки'];
  const velocity = {
    'Рестораны': { total: 0 },
    'Развлечения': { total: 0 },
    'Дом': { total: 0 },
    'Подарки': { total: 0 }
  };

  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return velocity;

    const transTabName = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.CORE_TABS) ? SHEET_FACTS.CORE_TABS.TRANSACTIONS : 'Transactions';
    const sheet = spreadsheet.getSheetByName(transTabName);
    if (!sheet) return velocity;

    const lastRow = sheet.getLastRow();
    const startRow = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE) ? SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE.DATA_START_ROW : 2;
    if (lastRow < startRow) return velocity;

    const now = new Date();
    const currentMonthYearStr = Utilities.formatDate(now, 'Asia/Singapore', 'MM.yyyy');

    const numCols = sheet.getLastColumn();
    const rawData = sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).getValues();
    const dispData = sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).getDisplayValues();

    for (let r = 0; r < rawData.length; r++) {
      const row = rawData[r];
      const disp = dispData[r];
      const cellDate = row[0];
      const category = String(row[7] || '').trim(); // Col H

      if (!category) continue;
      if (!velocity[category]) {
        velocity[category] = { total: 0 };
      }

      let dateMatch = false;
      if (cellDate instanceof Date) {
        const rowMonthYearStr = Utilities.formatDate(cellDate, 'Asia/Singapore', 'MM.yyyy');
        dateMatch = (rowMonthYearStr === currentMonthYearStr);
      } else if (typeof cellDate === 'string' && cellDate.trim()) {
        const parts = cellDate.trim().split('.');
        if (parts.length === 3) {
          const monthYear = `${parts[1].padStart(2, '0')}.${parts[2]}`;
          dateMatch = (monthYear === currentMonthYearStr);
        }
      }

      if (dateMatch) {
        const typeColC = String(row[2] || '').trim().replace(/\t/g, '');
        // Strict Type Filter: count 'Расходы' ONLY (excludes Обязательные расходы, Снятие денег, and Income)
        if (typeColC !== 'Расходы') {
          continue;
        }

        const amount = parseAmountNumber(row[4], disp[4]) || parseAmountNumber(row[3], disp[3]) || 0;

        if (!velocity[category]['Расходы']) {
          velocity[category]['Расходы'] = 0;
        }
        velocity[category]['Расходы'] = Number((velocity[category]['Расходы'] + amount).toFixed(2));
        velocity[category].total = Number((velocity[category].total + amount).toFixed(2));
      }
    }

    return velocity;
  } catch (e) {
    Logger.log(`Error in getCategoryVelocity: ${e.message}`);
    return velocity;
  }
}

function showVelocity() {
  const v = getCategoryVelocity();
  Logger.log(JSON.stringify(v, null, 2));
  Logger.log('--- The four that matter ---');
  ['Рестораны','Развлечения','Дом','Подарки'].forEach(c =>
    Logger.log(c + ': S$' + (v[c] ? v[c].total : 'MISSING')));
}

/**
 * STAGE 1 CHECKPOINT & TEST RUNNER:
 * Runs each pure read function once against the live sheet and prints clean JSON for spot-checking.
 */
function runStage1Checkpoint() {
  Logger.log('====================================================');
  Logger.log('      STAGE 1: READ LAYER CHECKPOINT EXECUTION');
  Logger.log('====================================================\n');

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  Logger.log('--- 1. getActiveMonthTab() ---');
  const activeTab = getActiveMonthTab(ss);
  const activeTabOutput = {
    tabName: activeTab.tabName,
    exists: activeTab.exists,
    status: activeTab.status,
    message: activeTab.message || 'Active month sheet loaded successfully.'
  };
  Logger.log(JSON.stringify(activeTabOutput, null, 2));

  Logger.log('\n--- 2. getMandatoryExpenses() [Sample from D/E/G] ---');
  const mandatory = getMandatoryExpenses(ss);
  Logger.log(`Total Expected Fixed Items Found: ${mandatory.length}`);
  Logger.log(JSON.stringify(mandatory.slice(0, 5), null, 2));

  Logger.log('\n--- 3. getLoggedMandatoryThisMonth() [Grouped & Summed] ---');
  const loggedMandatory = getLoggedMandatoryThisMonth(ss);
  Logger.log(`Total Grouped Logged Fixed Items This Month: ${loggedMandatory.length}`);
  Logger.log(JSON.stringify(loggedMandatory, null, 2));

  Logger.log('\n--- 4. getDailySaldo() [From D19 / Saldo Cell & Daily Tracker] ---');
  const dailySaldo = getDailySaldo(ss);
  Logger.log(JSON.stringify(dailySaldo, null, 2));

  Logger.log('\n--- 5. get503020Status() [Needs/Wants/Savings/Taxes vs Target] ---');
  const pacing503020 = get503020Status(ss);
  const pacingSummary = {
    needs: { actual: pacing503020.needs.actual, target: pacing503020.needs.target, total_percent: pacing503020.needs.total_percent },
    wants: { actual: pacing503020.wants.actual, target: pacing503020.wants.target, total_percent: pacing503020.wants.total_percent },
    savings: { actual: pacing503020.savings.actual, target: pacing503020.savings.target, total_percent: pacing503020.savings.total_percent },
    taxes: { actual: pacing503020.taxes.actual, target: pacing503020.taxes.target, total_percent: pacing503020.taxes.total_percent }
  };
  Logger.log(JSON.stringify(pacingSummary, null, 2));

  Logger.log('\n--- 6. getCategoryVelocity() [Volatile Discretionary Sums] ---');
  const velocity = getCategoryVelocity(ss);
  Logger.log(JSON.stringify(velocity, null, 2));

  Logger.log('\n====================================================');
  Logger.log('   🏁 STAGE 1 CHECKPOINT COMPLETED FOR VAL TO EYEBALL');
  Logger.log('====================================================');
}
