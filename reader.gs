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
 * STAGE 1: Reads daily pacing metrics directly from the active monthly tab without recomputing the saldo chain.
 * Returns:
 * - K_cumulative_today: monthly tab col K, today's row — the reality check
 * - L_saldo_yesterday: col L, yesterday's row (0 if day 1)
 * - D17_flat_daily: cell D17 — flat pacing
 * - D19_realistic_daily: cell D19 — budget left ÷ days left
 * - days_left: remaining days in the month (including today)
 * - days_to_positive: Math.ceil(Math.abs(K)/D17) when K < 0, else 0
 * 
 * @param {Date} [optDate] - Optional Date instance. Defaults to current SGT date.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {{ K_cumulative_today: number, L_saldo_yesterday: number, D17_flat_daily: number, D19_realistic_daily: number, days_left: number, days_to_positive: number }}
 */
function getDailyPacing(optDate, ss) {
  let targetDate = (optDate instanceof Date) ? optDate : null;
  let spreadsheet = ss;
  if (optDate && typeof optDate.getSheetByName === 'function') {
    spreadsheet = optDate;
    targetDate = (ss instanceof Date) ? ss : null;
  }
  if (!targetDate) {
    targetDate = new Date();
  }

  // Date calculations in Asia/Singapore
  const targetYear = parseInt(Utilities.formatDate(targetDate, 'Asia/Singapore', 'yyyy'), 10);
  const targetMonth = parseInt(Utilities.formatDate(targetDate, 'Asia/Singapore', 'M'), 10); // 1-12
  const targetDay = parseInt(Utilities.formatDate(targetDate, 'Asia/Singapore', 'd'), 10);   // 1-31
  const targetFullStr = Utilities.formatDate(targetDate, 'Asia/Singapore', 'dd.MM.yyyy');

  const totalDaysInMonth = new Date(targetYear, targetMonth, 0).getDate();
  const daysLeft = Math.max(1, totalDaysInMonth - targetDay + 1);

  const defaultResult = {
    K_cumulative_today: 0,
    L_saldo_yesterday: 0,
    D17_flat_daily: 0,
    D19_realistic_daily: 0,
    days_left: daysLeft,
    days_to_positive: 0
  };

  try {
    const activeInfo = getActiveMonthTab(spreadsheet, targetDate);
    if (!activeInfo || !activeInfo.exists) {
      Logger.log(`⚠️ Warning: ${activeInfo ? activeInfo.message : 'Active month tab not found'}`);
      return defaultResult;
    }
    const sheet = activeInfo.sheet;

    // 1. Read Cell D17 (Flat Daily Pacing)
    const d17CellRef = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.MONTHLY_TAB_STRUCTURE && SHEET_FACTS.MONTHLY_TAB_STRUCTURE.FLAT_DAILY_PACING_CELL) || 'D17';
    const d17Range = sheet.getRange(d17CellRef);
    const d17FlatDaily = parseAmountNumber(d17Range.getValue(), d17Range.getDisplayValue());

    // 2. Read Cell D19 (Realistic Daily Budget = budget left ÷ days left)
    const d19CellRef = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.MONTHLY_TAB_STRUCTURE && (SHEET_FACTS.MONTHLY_TAB_STRUCTURE.CURRENT_DAILY_BUDGET_CELL || SHEET_FACTS.MONTHLY_TAB_STRUCTURE.saldoCell)) || 'D19';
    const d19Range = sheet.getRange(d19CellRef);
    const d19RealisticDaily = parseAmountNumber(d19Range.getValue(), d19Range.getDisplayValue());

    // 3. Read Daily Tracker Range (Cols H to L starting from Row 2)
    // Col H (index 0): Date
    // Col J (index 2): Spend
    // Col K (index 3): Budget Cumulative Beginning of Day
    // Col L (index 4): Saldo End of Day
    const lastRow = Math.max(sheet.getLastRow(), 32);
    const trackerRange = sheet.getRange(2, 8, lastRow - 1, 5);
    const rawValues = trackerRange.getValues();
    const displayValues = trackerRange.getDisplayValues();

    let kCumulativeToday = 0;
    let lSaldoYesterday = 0;
    let todayRowFound = false;
    let yesterdayRowFound = false;

    const yesterdayDay = targetDay - 1;

    for (let r = 0; r < rawValues.length; r++) {
      const rawDateCell = rawValues[r][0];
      const displayDateStr = String(displayValues[r][0] || '').trim();

      let rowDay = null;
      if (rawDateCell instanceof Date) {
        if (rawDateCell.getFullYear() === targetYear && rawDateCell.getMonth() === (targetMonth - 1)) {
          rowDay = rawDateCell.getDate();
        }
      } else if (typeof rawDateCell === 'number') {
        rowDay = rawDateCell;
      } else if (displayDateStr) {
        if (displayDateStr === targetFullStr) {
          rowDay = targetDay;
        } else {
          const match = displayDateStr.match(/^(\d{1,2})[\/\.-]?/);
          if (match) {
            rowDay = parseInt(match[1], 10);
          }
        }
      }

      // Fallback: row index correspondence (Row 2 = Day 1, etc.)
      if (rowDay === null && r < totalDaysInMonth) {
        rowDay = r + 1;
      }

      // Match Today
      if (rowDay === targetDay && !todayRowFound) {
        kCumulativeToday = parseAmountNumber(rawValues[r][3], displayValues[r][3]); // Col K
        todayRowFound = true;
      }

      // Match Yesterday
      if (yesterdayDay >= 1 && rowDay === yesterdayDay && !yesterdayRowFound) {
        lSaldoYesterday = parseAmountNumber(rawValues[r][4], displayValues[r][4]); // Col L
        yesterdayRowFound = true;
      }
    }

    // 4. Calculate days_to_positive: Math.ceil(Math.abs(K)/D17) when K < 0, else 0
    let daysToPositive = 0;
    if (kCumulativeToday < 0) {
      daysToPositive = (d17FlatDaily > 0) ? Math.ceil(Math.abs(kCumulativeToday) / d17FlatDaily) : 0;
    }

    return {
      K_cumulative_today: kCumulativeToday,
      L_saldo_yesterday: lSaldoYesterday,
      D17_flat_daily: d17FlatDaily,
      D19_realistic_daily: d19RealisticDaily,
      days_left: daysLeft,
      days_to_positive: daysToPositive
    };
  } catch (e) {
    Logger.log(`Error in getDailyPacing: ${e.message}`);
    return defaultResult;
  }
}

/**
 * Reads the "50/30/20" tab to extract actual spending pacing and targets for Needs, Wants, and Savings.
 * Layout: Col A = Bucket Type, Col B = Category Name / Total. Row 1 = Month Headers "MM/YYYY".
 * Target month column holds $ actual spend, Column AE (rows 1-2) holds target header and target dollar amounts.
 * 
 * Returns exactly:
 * {
 *   needs: { actual, target },
 *   wants: { actual, target },
 *   savings: { actual, target },
 *   target_header
 * }
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {{ needs: { actual: number, target: number }, wants: { actual: number, target: number }, savings: { actual: number, target: number }, target_header: string }}
 */
// Set to true to inspect row-by-row parsing and summary matching on the 50/30/20 tab
const DEBUG_503020 = false;

/**
 * Reads the "50/30/20" tab to extract actual spending pacing and targets for Needs, Wants, and Savings.
 * Layout: Col A = Bucket Type, Col B = Category Name / Total. Row 1 = Month Headers "MM/YYYY".
 * Target month column holds $ actual spend, Column AE (rows 1-2) holds target header and target dollar amounts.
 * 
 * Returns exactly:
 * {
 *   needs: { actual, target },
 *   wants: { actual, target },
 *   savings: { actual, target },
 *   target_header
 * }
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @param {boolean} [optDebug] - Optional debug flag override.
 * @return {{ needs: { actual: number, target: number }, wants: { actual: number, target: number }, savings: { actual: number, target: number }, target_header: string }}
 */
function get503020Status(ss, optDebug) {
  const isDebug = (typeof optDebug === 'boolean') ? optDebug : (typeof DEBUG_503020 !== 'undefined' ? Boolean(DEBUG_503020) : false);

  const defaultPacing = {
    needs: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
    wants: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
    savings: { actual: 0, target: 0, total_actual: 0, total_percent: '0%', sub_categories: [] },
    target_header: ''
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

    // Helper to safely extract string without ever returning literal "undefined" or "null"
    function safeCellStr(val) {
      if (val === null || val === undefined) return '';
      const s = String(val).trim();
      return (s === 'undefined' || s === 'null') ? '' : s;
    }

    // 1. Inspect Columns AC through AH (indices 29-34) at Row 1, and dynamically locate target header & target spend column
    const colLabels = ['AC (29)', 'AD (30)', 'AE (31)', 'AF (32)', 'AG (33)', 'AH (34)'];
    const startCol = 29;
    const endCol = Math.min(34, lastCol);
    const numInspectCols = Math.max(0, endCol - startCol + 1);

    let targetHeader = '';
    let targetSpendColIndex = -1; // 0-indexed column

    if (numInspectCols > 0) {
      const inspectRow1 = sheet.getRange(1, startCol, 1, numInspectCols).getDisplayValues()[0];
      for (let c = 0; c < numInspectCols; c++) {
        const colNum = startCol + c;
        const colLabel = colLabels[c] || `Col ${colNum}`;
        const r1 = safeCellStr(inspectRow1 ? inspectRow1[c] : '');
        const lowerR1 = r1.toLowerCase();

        // Match column if Row 1 contains target keyword (e.g. "Target month")
        if (!targetHeader && (lowerR1.includes('target') || lowerR1.includes('цел') || lowerR1.includes('план'))) {
          targetHeader = r1;
          targetSpendColIndex = colNum - 1; // 0-indexed
          if (isDebug) {
            Logger.log(`  -> Matched Target Header in ${colLabel}: "${targetHeader}" (0-indexed col: ${targetSpendColIndex})`);
          }
        }
      }
    }

    // Fallback: If no explicit keyword matched across AC-AH, check Column AE (col 31) Row 1 directly
    if (!targetHeader && lastCol >= 31) {
      const aeRow1 = sheet.getRange(1, 31).getDisplayValue();
      const h1 = safeCellStr(aeRow1);
      if (h1) {
        targetHeader = h1;
        targetSpendColIndex = 30; // index 30 = Col AE
      }
    }

    if (targetSpendColIndex === -1) {
      targetSpendColIndex = 30; // default to Column AE
    }

    if (!targetHeader) {
      Logger.log('⚠️ [LOUD WARNING] Target header could not be found in Row 1 of 50/30/20 tab (checked columns AC-AH). Returning empty string.');
      targetHeader = '';
    }

    defaultPacing.target_header = targetHeader;

    // 2. Generate current month string in "MM/yyyy" format (e.g. "08/2026") and find target month column index
    const now = new Date();
    const targetMonthYearStr = Utilities.formatDate(now, 'Asia/Singapore', 'MM/yyyy');
    const altMonthYearStr = Utilities.formatDate(now, 'Asia/Singapore', 'M/yyyy');

    // Read Row 1 to find the column index matching "MM/yyyy"
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

      if (formattedHeader.indexOf(targetMonthYearStr) !== -1 || dispVal.indexOf(targetMonthYearStr) !== -1 ||
          formattedHeader.indexOf(altMonthYearStr) !== -1 || dispVal.indexOf(altMonthYearStr) !== -1) {
        targetColIndex = c;
        break;
      }
    }

    if (targetColIndex === -1) {
      Logger.log(`⚠️ [LOUD WARNING] Current month header "${targetMonthYearStr}" not found in Row 1 of "50/30/20" tab. Returning zero pacing.`);
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
      target_header: targetHeader
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

    // Optional diagnostic log to inspect sheet layout during execution
    if (isDebug) {
      Logger.log('\n--- [DEBUG] 50/30/20 Tab Row Inspection (Cols A, B, Current Month, Target Cols) ---');
      for (let d = 0; d < rowDisplayData.length; d++) {
        const rNum = d + 3;
        const cA = String(rowDisplayData[d][0] || '').trim();
        const cB = String(rowDisplayData[d][1] || '').trim();
        const cAmt = targetColIndex !== -1 ? parseAmountNumber(rowRawData[d][targetColIndex], rowDisplayData[d][targetColIndex]) : 0;
        const cTarget = (rowRawData[d].length > targetSpendColIndex && targetSpendColIndex !== -1)
          ? parseAmountNumber(rowRawData[d][targetSpendColIndex], rowDisplayData[d][targetSpendColIndex])
          : (rowRawData[d].length > 30 ? parseAmountNumber(rowRawData[d][30], rowDisplayData[d][30]) : 0);
        if (cA || cB || cAmt || cTarget) {
          Logger.log(`[Row ${rNum}] Col A: "${cA}" | Col B: "${cB}" | Current Month Amt: ${cAmt} | Target Spend: ${cTarget}`);
        }
      }
      Logger.log('---------------------------------------------------------------------------\n');
    }

    // 4. Iterate through rows
    for (let r = 0; r < rowDisplayData.length; r++) {
      const colA = String(rowDisplayData[r][0] || '').trim();
      const colB = String(rowDisplayData[r][1] || '').trim();

      // Determine active bucket from Column A (Needs, Wants, Savings - strictly NO Taxes)
      const lowerA = colA.toLowerCase();
      if (lowerA.includes('needs') || lowerA.includes('потребности') || lowerA.includes('нужды')) {
        currentBucket = 'needs';
      } else if (lowerA.includes('wants') || lowerA.includes('желания') || lowerA.includes('хотелки')) {
        currentBucket = 'wants';
      } else if (lowerA.includes('savings') || lowerA.includes('сбережения') || lowerA.includes('отложения') || lowerA.includes('инвестиции')) {
        currentBucket = 'savings';
      }

      if (!currentBucket || (!colA && !colB)) continue;

      const colAmount = targetColIndex !== -1 ? parseAmountNumber(rowRawData[r][targetColIndex], rowDisplayData[r][targetColIndex]) : 0;
      const colPercent = (targetColIndex !== -1 && rowRawData[r].length > targetColIndex + 1)
        ? parsePercentString(rowRawData[r][targetColIndex + 1], rowDisplayData[r][targetColIndex + 1])
        : '0%';

      // Target dollar value from dynamically matched target column or Column AE (index 30)
      const targetSpend = (rowRawData[r].length > targetSpendColIndex && targetSpendColIndex !== -1)
        ? parseAmountNumber(rowRawData[r][targetSpendColIndex], rowDisplayData[r][targetSpendColIndex])
        : (rowRawData[r].length > 30 ? parseAmountNumber(rowRawData[r][30], rowDisplayData[r][30]) : 0);
      const targetPercentCol = targetSpendColIndex !== -1 ? targetSpendColIndex + 1 : 31;
      const targetPercent = rowRawData[r].length > targetPercentCol ? parsePercentString(rowRawData[r][targetPercentCol], rowDisplayData[r][targetPercentCol]) : '0%';

      const lowerB = colB.toLowerCase();

      // Ignore overall budget Grand Total rows so they do not overwrite a section's totals
      if (lowerA.includes('grand total') || lowerB.includes('grand total') || lowerA.includes('итого по бюджету') || lowerB.includes('итого по бюджету')) {
        continue;
      }

      // Check if this row is a spreadsheet summary / non-category row (Total, Total income, Difference, etc.)
      const isExcludedSummaryRow = lowerB === 'total' || lowerB === 'total income' || lowerB === 'difference' ||
                                  lowerB === 'итого' || lowerB === 'всего' || lowerB === 'разница' ||
                                  lowerB === 'всего доход' || lowerB === 'итого доход' || lowerB === 'доход' ||
                                  lowerB.includes('difference') || lowerB.includes('разница') ||
                                  (lowerB.startsWith('total') && !lowerB.includes('needs') && !lowerB.includes('wants') && !lowerB.includes('savings'));

      // Identify bucket summary/total row
      const isTotalRow = lowerB.includes('total') || lowerB.includes('итого') || lowerB.includes('всего') ||
                         lowerA.includes('total') || lowerA.includes('итого') || lowerA.includes('всего') ||
                         (colA !== '' && colB !== '' && lowerB === lowerA) ||
                         (currentBucket === 'needs' && (lowerB === 'needs' || lowerB === 'потребности' || lowerB === 'нужды')) ||
                         (currentBucket === 'wants' && (lowerB === 'wants' || lowerB === 'желания' || lowerB === 'хотелки')) ||
                         (currentBucket === 'savings' && (lowerB === 'savings' || lowerB === 'сбережения' || lowerB === 'отложения'));

      if (isTotalRow) {
        if (!result[currentBucket].found_summary) {
          if (isDebug) {
            Logger.log(`📌 Matched summary for [${currentBucket}] at Row ${r + 3}: Actual=${colAmount}, Target=${targetSpend}`);
          }
          result[currentBucket].total_actual = colAmount;
          result[currentBucket].actual = colAmount;
          result[currentBucket].total_percent = colPercent;
          result[currentBucket].target = targetSpend;
          result[currentBucket].target_percent = targetPercent;
          result[currentBucket].found_summary = true;
        }
      } else if (!isExcludedSummaryRow && colB) {
        result[currentBucket].sub_categories.push({
          name: colB || colA,
          actual: colAmount,
          percent: colPercent,
          target: targetSpend
        });
      }
    }

    // Fallback: sum sub-categories if no summary row was encountered for a bucket
    ['needs', 'wants', 'savings'].forEach(k => {
      const bucket = result[k];
      if (!bucket.found_summary && bucket.sub_categories.length > 0) {
        if (isDebug) {
          Logger.log(`⚠️ No summary row found for [${k}]; falling back to sum of ${bucket.sub_categories.length} subcategories.`);
        }
        bucket.actual = Number(bucket.sub_categories.reduce((sum, sub) => sum + sub.actual, 0).toFixed(2));
        bucket.total_actual = bucket.actual;
        bucket.target = Number(bucket.sub_categories.reduce((sum, sub) => sum + sub.target, 0).toFixed(2));
      }
      delete bucket.found_summary;
    });

    return {
      needs: { actual: result.needs.actual, target: result.needs.target, total_actual: result.needs.total_actual, total_percent: result.needs.total_percent, sub_categories: result.needs.sub_categories },
      wants: { actual: result.wants.actual, target: result.wants.target, total_actual: result.wants.total_actual, total_percent: result.wants.total_percent, sub_categories: result.wants.sub_categories },
      savings: { actual: result.savings.actual, target: result.savings.target, total_actual: result.savings.total_actual, total_percent: result.savings.total_percent, sub_categories: result.savings.sub_categories },
      target_header: result.target_header
    };
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
 * STAGE 1: getTodaySpend(optDate) → Sum of column E (Сумма в SGD) in Transactions
 * where Column C (Тип) equals "Расходы" and Column A (Дата) matches the target date.
 * Strictly EXCLUDES "Обязательные расходы", "Снятие денег", and all income types.
 * Pure read: no writes, no Telegram triggers, no side-effects.
 * 
 * @param {Date|string} [optDate] - Optional target date (Date object or 'DD.MM.YYYY' / 'YYYY-MM-DD'). Defaults to today in SGT.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSs] - Optional Spreadsheet instance.
 * @return {number} Total SGD spend on the target date.
 */
function getTodaySpend(optDate, optSs) {
  try {
    const spreadsheet = optSs || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return 0;

    const sheet = spreadsheet.getSheetByName('Transactions');
    if (!sheet) {
      Logger.log('⚠️ Warning: Sheet "Transactions" not found.');
      return 0;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return 0;

    const tz = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Singapore';
    const now = new Date();

    // Determine canonical target date string in DD.MM.YYYY format
    let targetDateStr = '';
    if (optDate) {
      if (optDate instanceof Date) {
        targetDateStr = Utilities.formatDate(optDate, tz, 'dd.MM.yyyy');
      } else {
        targetDateStr = typeof normalizeDateString === 'function' ? normalizeDateString(optDate) : String(optDate).trim();
      }
    } else {
      targetDateStr = Utilities.formatDate(now, tz, 'dd.MM.yyyy');
    }

    // Read range A2:E (Col A: Date, Col B: Account, Col C: Type, Col D: Amount, Col E: Amount in SGD)
    const rawValues = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    const displayValues = sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues();

    let totalSpend = 0;

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
        const amountSgd = parseAmountNumber(rawValues[r][4], displayValues[r][4]); // Col E (index 4)
        totalSpend += amountSgd;
      }
    }

    return Number(totalSpend.toFixed(2));
  } catch (e) {
    Logger.log(`Error in getTodaySpend: ${e.message}`);
    return 0;
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
 * Reads the runtime Category-to-50/30/20 Bucket taxonomy from the reference tab ("-").
 * Column B holds the Category name, and its paired adjacent column holds the Bucket.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Object<string, string>} Mapping of category names to their respective bucket ('Needs'|'Wants'|'Savings'|'Taxes'|'-').
 */
function getCategoryBucketMap(ss) {
  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      Logger.log('⚠️ [WARNING] No spreadsheet found. Falling back to static CATEGORY_TO_BUCKET from constants.gs.');
      return Object.assign({}, typeof CATEGORY_TO_BUCKET !== 'undefined' ? CATEGORY_TO_BUCKET : {});
    }

    const tabName = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.CORE_TABS && SHEET_FACTS.CORE_TABS.REFERENCE)
      ? SHEET_FACTS.CORE_TABS.REFERENCE
      : '-';

    let sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet) {
      sheet = spreadsheet.getSheetByName('-') || spreadsheet.getSheetByName(' - ') || spreadsheet.getSheetByName('Reference');
    }

    if (!sheet) {
      Logger.log('⚠️ [WARNING] Reference tab "-" not found in spreadsheet. Falling back to static CATEGORY_TO_BUCKET from constants.gs.');
      return Object.assign({}, typeof CATEGORY_TO_BUCKET !== 'undefined' ? CATEGORY_TO_BUCKET : {});
    }

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 2) {
      Logger.log('⚠️ [WARNING] Reference tab "-" has insufficient rows/columns. Falling back to static CATEGORY_TO_BUCKET from constants.gs.');
      return Object.assign({}, typeof CATEGORY_TO_BUCKET !== 'undefined' ? CATEGORY_TO_BUCKET : {});
    }

    // Read Col A to Col C (Category is Col B / index 1, Bucket is Col C / index 2)
    const numColsToFetch = Math.max(lastCol, 3);
    const data = sheet.getRange(1, 1, lastRow, numColsToFetch).getDisplayValues();
    const map = {};

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const category = String(row[1] || '').trim(); // Column B
      if (!category) continue;

      const lowerCat = category.toLowerCase();
      if (lowerCat === 'категория' || lowerCat === 'category' || lowerCat === 'итого' || lowerCat === 'всего') {
        continue;
      }

      // Read strictly from ONE fixed column: Column C (index 2)
      const rawBucket = String(row[2] || '').trim();
      const lowerBucket = rawBucket.toLowerCase();

      let bucket = null;
      if (lowerBucket === 'needs') {
        bucket = 'Needs';
      } else if (lowerBucket === 'wants') {
        bucket = 'Wants';
      } else if (lowerBucket === 'savings' || lowerBucket === 'сбережения' || category === 'Отложения (премия)') {
        bucket = 'Savings';
      } else if (lowerBucket === 'taxes' || lowerBucket === 'налоги') {
        bucket = 'Taxes';
      } else if (rawBucket === '-' || lowerBucket === 'кредитка') {
        bucket = '-';
      } else {
        Logger.log(`⚠️ [LOUD WARNING] Category "${category}" in tab "-" has unrecognized/empty bucket: "${rawBucket}".`);
        bucket = 'UNKNOWN';
      }

      map[category] = bucket;
    }

    if (Object.keys(map).length === 0) {
      Logger.log('⚠️ [WARNING] Extracted 0 categories from tab "-". Falling back to static CATEGORY_TO_BUCKET from constants.gs.');
      return Object.assign({}, typeof CATEGORY_TO_BUCKET !== 'undefined' ? CATEGORY_TO_BUCKET : {});
    }

    return map;
  } catch (err) {
    Logger.log(`⚠️ [WARNING] Error reading "-" tab: ${err.message}. Falling back to static CATEGORY_TO_BUCKET from constants.gs.`);
    return Object.assign({}, typeof CATEGORY_TO_BUCKET !== 'undefined' ? CATEGORY_TO_BUCKET : {});
  }
}

/**
 * Test function for getCategoryBucketMap:
 * Asserts 22 entries and spot-checks expected bucket assignments.
 */
function test_getCategoryBucketMap() {
  Logger.log('====================================================');
  Logger.log('      TEST: getCategoryBucketMap() EXECUTION');
  Logger.log('====================================================\n');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const map = getCategoryBucketMap(ss);
  const categories = Object.keys(map);

  Logger.log(`Total Categories Loaded: ${categories.length}`);
  Logger.log('Category Bucket Map:\n' + JSON.stringify(map, null, 2));

  const assertions = [
    { cat: 'Квартира', expected: 'Needs' },
    { cat: 'Рестораны', expected: 'Wants' },
    { cat: 'Отложения', expected: 'Savings' },
    { cat: 'Налоги', expected: 'Taxes' },
    { cat: 'Кредитка', expected: '-' },
    { cat: 'Авто', expected: 'Wants' },
    { cat: 'Транспорт', expected: 'Needs' }
  ];

  let passed = true;

  if (categories.length === 22) {
    Logger.log('✅ PASS: Exactly 22 categories loaded.');
  } else {
    Logger.log(`⚠️ WARNING: Expected 22 categories, but loaded ${categories.length}.`);
    passed = false;
  }

  Logger.log('\n--- Spot Checks ---');
  assertions.forEach(a => {
    const actual = map[a.cat];
    if (actual === a.expected) {
      Logger.log(`✅ PASS: "${a.cat}" -> "${actual}"`);
    } else {
      Logger.log(`❌ FAIL: "${a.cat}" (Expected: "${a.expected}", Got: "${actual}")`);
      passed = false;
    }
  });

  Logger.log('\n====================================================');
  Logger.log(passed ? '🎉 ALL ASSERTIONS PASSED' : '❌ SOME ASSERTIONS FAILED');
  Logger.log('====================================================');
  return map;
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

  Logger.log('\n--- 5. get503020Status() [Needs/Wants/Savings vs Target] ---');
  const pacing503020 = get503020Status(ss);
  Logger.log(JSON.stringify(pacing503020, null, 2));

  Logger.log('\n--- 6. getCategoryVelocity() [Volatile Discretionary Sums] ---');
  const velocity = getCategoryVelocity(ss);
  Logger.log(JSON.stringify(velocity, null, 2));

  Logger.log('\n--- 7. getCategoryBucketMap() [Runtime Taxonomy from "-" Tab] ---');
  const catBucketMap = getCategoryBucketMap(ss);
  Logger.log(`Total Categories in Map: ${Object.keys(catBucketMap).length}`);
  Logger.log(JSON.stringify(catBucketMap, null, 2));

  Logger.log('\n--- 8. getDailyPacing() [Direct Cell Reads from Monthly Tab] ---');
  const dailyPacing = getDailyPacing(null, ss);
  Logger.log(JSON.stringify(dailyPacing, null, 2));

  Logger.log('\n--- 9. getTodaySpend() [Direct Transactions Sum (Тип == "Расходы")] ---');
  const todaySpend = getTodaySpend(null, ss);
  Logger.log(`Today's Discretionary Spend: S$${todaySpend}`);

  Logger.log('\n====================================================');
  Logger.log('   🏁 STAGE 1 CHECKPOINT COMPLETED FOR VAL TO EYEBALL');
  Logger.log('====================================================');
}

/**
 * Test function for getDailyPacing():
 * Asserts:
 * - D17 and D19 both parse to numbers
 * - D19_realistic_daily EXACTLY equals cell D19 read directly
 * - days_to_positive is 0 when K >= 0; matches ceil(|K|/D17) when K < 0
 * Prints all six values for comparison against the sheet.
 */
function test_getDailyPacing(optDate) {
  Logger.log('====================================================');
  Logger.log('      TEST: getDailyPacing() EXECUTION');
  Logger.log('====================================================\n');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pacing = getDailyPacing(optDate, ss);

  Logger.log('Daily Pacing Output:\n' + JSON.stringify(pacing, null, 2));

  Logger.log('\n--- Individual Field Values (Compare Against Sheet) ---');
  Logger.log(`1. K_cumulative_today:   ${pacing.K_cumulative_today}`);
  Logger.log(`2. L_saldo_yesterday:    ${pacing.L_saldo_yesterday}`);
  Logger.log(`3. D17_flat_daily:       ${pacing.D17_flat_daily}`);
  Logger.log(`4. D19_realistic_daily:  ${pacing.D19_realistic_daily}`);
  Logger.log(`5. days_left:            ${pacing.days_left}`);
  Logger.log(`6. days_to_positive:     ${pacing.days_to_positive}`);

  Logger.log('\n--- Assertion Checks ---');
  let passed = true;

  // 1. D17 and D19 both parse to numbers
  const isD17Num = typeof pacing.D17_flat_daily === 'number' && !isNaN(pacing.D17_flat_daily);
  const isD19Num = typeof pacing.D19_realistic_daily === 'number' && !isNaN(pacing.D19_realistic_daily);
  if (isD17Num && isD19Num) {
    Logger.log(`✅ PASS: D17 (${pacing.D17_flat_daily}) and D19 (${pacing.D19_realistic_daily}) parse to numbers.`);
  } else {
    Logger.log(`❌ FAIL: D17 (${pacing.D17_flat_daily}) or D19 (${pacing.D19_realistic_daily}) is not a number.`);
    passed = false;
  }

  // 2. D19_realistic_daily EXACTLY equals cell D19 read directly
  const activeTabInfo = getActiveMonthTab(ss, optDate);
  if (activeTabInfo && activeTabInfo.exists) {
    const d19Cell = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.MONTHLY_TAB_STRUCTURE && (SHEET_FACTS.MONTHLY_TAB_STRUCTURE.CURRENT_DAILY_BUDGET_CELL || SHEET_FACTS.MONTHLY_TAB_STRUCTURE.saldoCell)) || 'D19';
    const r = activeTabInfo.sheet.getRange(d19Cell);
    const directD19 = parseAmountNumber(r.getValue(), r.getDisplayValue());
    if (pacing.D19_realistic_daily === directD19) {
      Logger.log(`✅ PASS: D19_realistic_daily (${pacing.D19_realistic_daily}) EXACTLY equals cell D19 read directly (${directD19}).`);
    } else {
      Logger.log(`❌ FAIL: D19_realistic_daily (${pacing.D19_realistic_daily}) does not equal direct D19 (${directD19}).`);
      passed = false;
    }
  } else {
    Logger.log(`ℹ️ Info: Active monthly sheet not present for direct cell D19 read check.`);
  }

  // 3. days_to_positive is 0 when K >= 0; matches ceil(|K|/D17) when K < 0
  if (pacing.K_cumulative_today >= 0) {
    if (pacing.days_to_positive === 0) {
      Logger.log(`✅ PASS: K_cumulative_today >= 0 (${pacing.K_cumulative_today}) -> days_to_positive is 0.`);
    } else {
      Logger.log(`❌ FAIL: K_cumulative_today >= 0 (${pacing.K_cumulative_today}) -> days_to_positive is ${pacing.days_to_positive} (Expected: 0).`);
      passed = false;
    }
  } else {
    const expectedDays = (pacing.D17_flat_daily > 0) ? Math.ceil(Math.abs(pacing.K_cumulative_today) / pacing.D17_flat_daily) : 0;
    if (pacing.days_to_positive === expectedDays) {
      Logger.log(`✅ PASS: K_cumulative_today < 0 (${pacing.K_cumulative_today}) -> days_to_positive (${pacing.days_to_positive}) matches Math.ceil(|K|/D17) = ${expectedDays}.`);
    } else {
      Logger.log(`❌ FAIL: K_cumulative_today < 0 (${pacing.K_cumulative_today}) -> days_to_positive is ${pacing.days_to_positive} (Expected: ${expectedDays}).`);
      passed = false;
    }
  }

  Logger.log('\n====================================================');
  Logger.log(passed ? '🎉 ALL ASSERTIONS PASSED' : '❌ SOME ASSERTIONS FAILED');
  Logger.log('====================================================');

  return pacing;
}

/**
 * Test function for get503020Status():
 * Asserts:
 * - Exactly three buckets (needs, wants, savings) and NO taxes bucket
 * - All three buckets have actual AND target populated as numbers
 * - target_header is a non-empty string
 * Prints the entire result.
 */
function test_get503020Status() {
  Logger.log('====================================================');
  Logger.log('      TEST: get503020Status() EXECUTION');
  Logger.log('====================================================\n');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pacing = get503020Status(ss);

  Logger.log('50/30/20 Pacing Result:\n' + JSON.stringify(pacing, null, 2));

  Logger.log('\n--- Individual Bucket Values ---');
  Logger.log(`Target Header: "${pacing.target_header}"`);
  Logger.log(`Needs:   Actual=${pacing.needs ? pacing.needs.actual : 'undefined'}, Target=${pacing.needs ? pacing.needs.target : 'undefined'}`);
  Logger.log(`Wants:   Actual=${pacing.wants ? pacing.wants.actual : 'undefined'}, Target=${pacing.wants ? pacing.wants.target : 'undefined'}`);
  Logger.log(`Savings: Actual=${pacing.savings ? pacing.savings.actual : 'undefined'}, Target=${pacing.savings ? pacing.savings.target : 'undefined'}`);

  Logger.log('\n--- Assertion Checks ---');
  let passed = true;

  // 1. Assert three buckets exist and taxes bucket is absent
  const hasNeeds = Boolean(pacing.needs);
  const hasWants = Boolean(pacing.wants);
  const hasSavings = Boolean(pacing.savings);
  const hasNoTaxes = (pacing.taxes === undefined);

  if (hasNeeds && hasWants && hasSavings && hasNoTaxes) {
    Logger.log('✅ PASS: Exactly 3 buckets present (needs, wants, savings) and taxes bucket is absent.');
  } else {
    Logger.log(`❌ FAIL: Bucket structure incorrect. Needs: ${hasNeeds}, Wants: ${hasWants}, Savings: ${hasSavings}, NoTaxes: ${hasNoTaxes}`);
    passed = false;
  }

  // 2. Assert all three buckets have actual AND target populated as valid numbers
  const needsValid = typeof pacing.needs.actual === 'number' && !isNaN(pacing.needs.actual) &&
                     typeof pacing.needs.target === 'number' && !isNaN(pacing.needs.target);
  const wantsValid = typeof pacing.wants.actual === 'number' && !isNaN(pacing.wants.actual) &&
                     typeof pacing.wants.target === 'number' && !isNaN(pacing.wants.target);
  const savingsValid = typeof pacing.savings.actual === 'number' && !isNaN(pacing.savings.actual) &&
                       typeof pacing.savings.target === 'number' && !isNaN(pacing.savings.target);

  if (needsValid && wantsValid && savingsValid) {
    Logger.log('✅ PASS: All 3 buckets have populated numeric actual & target values.');
    Logger.log(`   - Needs:   Actual=${pacing.needs.actual}, Target=${pacing.needs.target}`);
    Logger.log(`   - Wants:   Actual=${pacing.wants.actual}, Target=${pacing.wants.target}`);
    Logger.log(`   - Savings: Actual=${pacing.savings.actual}, Target=${pacing.savings.target}`);
  } else {
    Logger.log('❌ FAIL: One or more buckets have invalid actual/target values.');
    passed = false;
  }

  // 3. Assert non-empty and valid target_header (not empty, not literal "undefined")
  if (typeof pacing.target_header === 'string' && pacing.target_header.trim().length > 0 && pacing.target_header !== 'undefined') {
    Logger.log(`✅ PASS: target_header is valid and non-empty -> "${pacing.target_header}"`);
  } else {
    Logger.log(`❌ FAIL: target_header is missing, empty, or literal "undefined" -> "${pacing.target_header}"`);
    passed = false;
  }

  Logger.log('\n====================================================');
  Logger.log(passed ? '🎉 ALL ASSERTIONS PASSED' : '❌ SOME ASSERTIONS FAILED');
  Logger.log('====================================================');

  return pacing;
}

/**
 * Helper to read Column J (Траты) for a specified date from its corresponding monthly tab.
 * Resolves the monthly tab strictly from the passed date (not today's date).
 * Logs the selected tab, row number, and cell values for full visibility.
 * 
 * @param {Date|string} optDate - Target date.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSs] - Optional Spreadsheet instance.
 * @return {number|null} Parsed amount from Col J (Траты), or null if not found.
 */
function getMonthlyTabDaySpend(optDate, optSs) {
  try {
    const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return null;

    const tz = ss.getSpreadsheetTimeZone() || 'Asia/Singapore';
    let targetDay = 0;
    let targetMonth = 0; // 1-12
    let targetYear = 0;

    if (optDate instanceof Date) {
      const dateStr = Utilities.formatDate(optDate, tz, 'dd.MM.yyyy');
      const p = dateStr.split('.');
      targetDay = parseInt(p[0], 10);
      targetMonth = parseInt(p[1], 10);
      targetYear = parseInt(p[2], 10);
    } else if (typeof optDate === 'string' && optDate.trim()) {
      const norm = typeof normalizeDateString === 'function' ? normalizeDateString(optDate) : optDate.trim();
      const p = norm.split('.');
      if (p.length === 3) {
        targetDay = parseInt(p[0], 10);
        targetMonth = parseInt(p[1], 10);
        targetYear = parseInt(p[2], 10);
      }
    }

    if (!targetMonth) {
      const now = new Date();
      const dateStr = Utilities.formatDate(now, tz, 'dd.MM.yyyy');
      const p = dateStr.split('.');
      targetDay = parseInt(p[0], 10);
      targetMonth = parseInt(p[1], 10);
      targetYear = parseInt(p[2], 10);
    }

    const monthTabMap = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.MONTH_TAB_NAMES) || {
      1: "Я'26", 2: "Ф'26", 3: "М'26", 4: "А'26",
      5: "Май'26", 6: "Июнь'26", 7: "Июль'26", 8: "Август'26",
      9: "Сентябрь'26", 10: "Октябрь'26", 11: "Ноябрь'26", 12: "Декабрь'26"
    };

    const tabName = monthTabMap[targetMonth] || '';
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      Logger.log(`⚠️ Monthly sheet "${tabName}" for month ${targetMonth} (date: ${optDate}) not found.`);
      return null;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    // Read Col H to Col J (Col 8 to Col 10: H=Date, I=DayName, J=Траты)
    const rawValues = sheet.getRange(1, 8, lastRow, 3).getValues();
    const displayValues = sheet.getRange(1, 8, lastRow, 3).getDisplayValues();

    const targetFormatted = `${String(targetDay).padStart(2, '0')}.${String(targetMonth).padStart(2, '0')}.${targetYear}`;
    Logger.log(`\n🔍 [LOOKUP] Searching Tab "${tabName}" for Date ${targetFormatted} (Day ${targetDay})...`);

    for (let r = 0; r < rawValues.length; r++) {
      const rowNum = r + 1; // 1-indexed sheet row
      const rawDate = rawValues[r][0]; // Col H
      const dispDate = String(displayValues[r][0] || '').trim();
      let match = false;

      if (rawDate instanceof Date) {
        const d = parseInt(Utilities.formatDate(rawDate, tz, 'd'), 10);
        const m = parseInt(Utilities.formatDate(rawDate, tz, 'M'), 10);
        const y = parseInt(Utilities.formatDate(rawDate, tz, 'yyyy'), 10);
        if (d === targetDay && m === targetMonth && y === targetYear) {
          match = true;
        }
      } else if (typeof rawDate === 'number' && !isNaN(rawDate)) {
        if (rawDate === targetDay) {
          match = true;
        }
      } else if (dispDate) {
        const dayMatch = dispDate.match(/^(\d{1,2})(?:[\/\.-]|$)/);
        if (dayMatch && parseInt(dayMatch[1], 10) === targetDay) {
          const fullMatch = dispDate.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
          if (fullMatch) {
            if (parseInt(fullMatch[1], 10) === targetDay && parseInt(fullMatch[2], 10) === targetMonth) {
              match = true;
            }
          } else {
            match = true;
          }
        }
      }

      if (match) {
        const rawCellSpend = rawValues[r][2];
        const dispCellSpend = displayValues[r][2];
        const parsedSpend = parseAmountNumber(rawCellSpend, dispCellSpend);
        Logger.log(`📌 [FOUND] Tab: "${tabName}", Row: ${rowNum}, Col H Date: "${dispDate}" (raw: ${rawDate}), Col J Raw: "${dispCellSpend}" -> Parsed: S$${parsedSpend}`);
        return parsedSpend;
      }
    }

    Logger.log(`⚠️ [NOT FOUND] Day ${targetDay} row not found in Tab "${tabName}".`);
    return null;
  } catch (e) {
    Logger.log(`Error in getMonthlyTabDaySpend: ${e.message}`);
    return null;
  }
}

/**
 * Test function for getTodaySpend():
 * Cross-checks getTodaySpend(date) against the monthly tab's Column J (Траты) for the same date.
 * Asserts they are exactly equal.
 * Tests:
 * 1. Today's date (or active day)
 * 2. A date with known mixed transaction types: "01.07.2026" (where Траты = 279.66, excluding mortgage 7592 and cash withdrawal 372)
 */
function test_getTodaySpend() {
  Logger.log('====================================================');
  Logger.log('      TEST: getTodaySpend() EXECUTION & CROSS-CHECK');
  Logger.log('====================================================\n');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let allPassed = true;

  // Test Case 1: Today's date
  const now = new Date();
  const todayStr = Utilities.formatDate(now, ss ? ss.getSpreadsheetTimeZone() || 'Asia/Singapore' : 'Asia/Singapore', 'dd.MM.yyyy');
  Logger.log(`--- Test Case 1: Today (${todayStr}) ---`);
  const todayTxnSpend = getTodaySpend(now, ss);
  const todayMonthlyColJ = getMonthlyTabDaySpend(now, ss);

  Logger.log(`Transactions sum (Тип == 'Расходы'): S$${todayTxnSpend}`);
  Logger.log(`Monthly tab Col J (Траты):           ${todayMonthlyColJ !== null ? `S$${todayMonthlyColJ}` : 'Row not found or empty'}`);

  if (todayMonthlyColJ !== null) {
    if (Math.abs(todayTxnSpend - todayMonthlyColJ) < 0.001) {
      Logger.log(`✅ PASS: Transactions sum matches Monthly tab Col J exactly (${todayTxnSpend} === ${todayMonthlyColJ}).`);
    } else {
      Logger.log(`❌ FAIL: Mismatch for today! Transactions=${todayTxnSpend} vs Monthly tab Col J=${todayMonthlyColJ}`);
      allPassed = false;
    }
  } else {
    Logger.log(`ℹ️ Info: Today's date row not populated in monthly tab.`);
  }

  // Test Case 2: Known mixed-type date "01.07.2026"
  const mixedDateStr = '01.07.2026';
  Logger.log(`\n--- Test Case 2: Known Mixed-Type Date (${mixedDateStr}) ---`);
  const mixedTxnSpend = getTodaySpend(mixedDateStr, ss);
  const mixedMonthlyColJ = getMonthlyTabDaySpend(mixedDateStr, ss);

  Logger.log(`Transactions sum (Тип == 'Расходы'): S$${mixedTxnSpend}`);
  Logger.log(`Monthly tab Col J (Траты):           ${mixedMonthlyColJ !== null ? `S$${mixedMonthlyColJ}` : 'Row not found or empty'}`);

  if (mixedMonthlyColJ !== null) {
    if (Math.abs(mixedTxnSpend - mixedMonthlyColJ) < 0.001) {
      Logger.log(`✅ PASS: Transactions sum matches Monthly tab Col J for ${mixedDateStr} (${mixedTxnSpend} === ${mixedMonthlyColJ}).`);
    } else {
      Logger.log(`❌ FAIL: Mismatch for ${mixedDateStr}! Transactions=${mixedTxnSpend} vs Monthly tab Col J=${mixedMonthlyColJ}`);
      allPassed = false;
    }
  } else {
    Logger.log(`ℹ️ Info: Date ${mixedDateStr} row not found in July tab ("Июль'26").`);
  }

  Logger.log('\n====================================================');
  Logger.log(allPassed ? '🎉 ALL CROSS-CHECKS PASSED' : '❌ ONE OR MORE CROSS-CHECKS FAILED');
  Logger.log('====================================================');

  return {
    today: { date: todayStr, transactions_spend: todayTxnSpend, monthly_col_j: todayMonthlyColJ },
    mixed_date: { date: mixedDateStr, transactions_spend: mixedTxnSpend, monthly_col_j: mixedMonthlyColJ }
  };
}


