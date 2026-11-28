/**
 * Annual Workbook Rollover, Year-End Sync & Archive Freeze Utilities.
 * File: rollover.gs
 *
 * Keeps the single GAS deployment + Telegram webhook intact across annual workbooks by:
 * 1. Freezing volatile formulas (TODAY, NOW, GOOGLEFINANCE) in retired workbooks with full
 *    _ArchivedFormulas backup (refusing to freeze transient #N/A or #REF! evaluation errors).
 * 2. Syncing Dec 31 closing balances, reference tables, Historical_Benchmarks (2026-12),
 *    [Automated] Папа debt 2026 closing rows, and Kids 2026 closing accruals into Budget 2027,
 *    with dryRun=true by default and optional ACTIVE_SPREADSHEET_ID + BUDGET_WORKBOOK_YEAR cutover.
 */

const ROLLOVER_VOLATILE_FORMULA_RE = /\b(TODAY|NOW|GOOGLEFINANCE)\s*\(/i;
const ROLLOVER_PROTECTED_SHEETS = Object.freeze([
  'Transactions',
  'LineItems',
  '_ArchivedFormulas',
  'Historical_Benchmarks',
  'Merchants',
  'Products',
  'Calendar',
  '-',
  '_TestFixtures'
]);
const ROLLOVER_DEFAULT_FREEZE_SHEETS = Object.freeze([
  'Summary',
  'Summary [Staging]',
  'CashCoverage',
  '[Automated] Папа debt',
  'Kids',
  'CapitalPlan',
  'Loans',
  'Отдых 2027 Plan',
  'Assets',
  'Assets_details'
]);
const ROLLOVER_REFERENCE_TABS = Object.freeze([
  'Merchants',
  'Products',
  'Calendar',
  'Asset_checkin_accounts',
  '-'
]);

function resolveRolloverSpreadsheet_(spreadsheetOrId, label) {
  if (spreadsheetOrId && typeof spreadsheetOrId.getSheetByName === 'function') {
    return spreadsheetOrId;
  }
  const id = String(spreadsheetOrId || '').trim();
  if (!id) throw new Error(label + ' spreadsheet ID or instance is required.');
  if (typeof SpreadsheetApp === 'undefined' || typeof SpreadsheetApp.openById !== 'function') {
    throw new Error('Cannot open ' + label + ': SpreadsheetApp.openById is unavailable.');
  }
  const opened = SpreadsheetApp.openById(id);
  if (!opened || (typeof opened.getId === 'function' && opened.getId() !== id)) {
    throw new Error(label + ' spreadsheet identity mismatch for ' + id);
  }
  return opened;
}

function rolloverColToLetter_(col) {
  let letters = '';
  let n = col;
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function isRolloverFormulaError_(value) {
  if (typeof value !== 'string') return false;
  return /^(#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|ERROR!)|Err:)/i.test(value.trim());
}

/**
 * Scans dashboard and monthly tabs for volatile formulas (TODAY, NOW, GOOGLEFINANCE),
 * backs up [ArchivedAt, Sheet, Cell, Formula, FrozenValue] to _ArchivedFormulas,
 * and replaces those cells with their evaluated values when dryRun === false.
 * Never touches append-only ledgers (Transactions, LineItems).
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet|string} spreadsheetOrId
 * @param {Object} [options] - { dryRun?: boolean (default true), sheets?: string[], allowSandbox?: boolean, allowErrorValues?: boolean }
 */
function freezeAnnualWorkbook(spreadsheetOrId, options) {
  const opts = Object.assign({ dryRun: true, allowSandbox: false, allowErrorValues: false }, options || {});
  const dryRun = opts.dryRun !== false;
  const ss = resolveRolloverSpreadsheet_(spreadsheetOrId, 'Archive target');
  const ssId = typeof ss.getId === 'function' ? ss.getId() : '';
  if (!opts.allowSandbox && typeof SHEET_FACTS !== 'undefined' && ssId && ssId === SHEET_FACTS.TEST_SPREADSHEET_ID) {
    throw new Error('Refusing to run freezeAnnualWorkbook on TEST_SPREADSHEET_ID without allowSandbox=true.');
  }

  const explicitNames = Array.isArray(opts.sheets) && opts.sheets.length ? new Set(opts.sheets) : null;
  const protectedSet = new Set(ROLLOVER_PROTECTED_SHEETS);
  const defaultTargets = new Set(ROLLOVER_DEFAULT_FREEZE_SHEETS);

  const candidateSheets = ss.getSheets().filter(sheet => {
    const name = sheet.getName();
    if (protectedSet.has(name)) return false;
    if (explicitNames) return explicitNames.has(name);
    if (defaultTargets.has(name)) return true;
    return typeof monthCreationIdentity === 'function' && Boolean(monthCreationIdentity(name));
  });

  const matches = [];
  const errorCells = [];

  candidateSheets.forEach(sheet => {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return;
    const range = sheet.getRange(1, 1, lastRow, lastCol);
    const formulas = range.getFormulas();
    const values = range.getValues();
    const sheetName = sheet.getName();
    for (let r = 0; r < formulas.length; r++) {
      const fRow = formulas[r] || [];
      const vRow = values[r] || [];
      for (let c = 0; c < fRow.length; c++) {
        const formula = String(fRow[c] || '');
        if (!formula || !ROLLOVER_VOLATILE_FORMULA_RE.test(formula)) continue;
        const cell = rolloverColToLetter_(c + 1) + (r + 1);
        const val = vRow[c];
        if (!opts.allowErrorValues && isRolloverFormulaError_(val)) {
          errorCells.push(sheetName + '!' + cell + ' (' + val + ')');
        }
        matches.push({
          sheet: sheetName,
          cell: cell,
          row: r + 1,
          col: c + 1,
          formula: formula,
          value: val
        });
      }
    }
  });

  if (errorCells.length) {
    throw new Error('Cannot freeze workbook while volatile cells evaluate to errors: ' + errorCells.slice(0, 5).join(', '));
  }

  if (dryRun) {
    return {
      status: 'dry_run',
      dryRun: true,
      spreadsheetId: ssId,
      count: matches.length,
      matches: matches
    };
  }

  return withBudgetWriteLock(() => {
    const timestamp = new Date().toISOString();
    let archive = ss.getSheetByName('_ArchivedFormulas');
    if (!archive) {
      archive = ss.insertSheet('_ArchivedFormulas');
      archive.getRange(1, 1, 1, 5).setValues([['ArchivedAt', 'Sheet', 'Cell', 'Formula', 'FrozenValue']]);
    }
    if (matches.length) {
      const startRow = Math.max(2, archive.getLastRow() + 1);
      const archiveRows = matches.map(m => [
        timestamp,
        m.sheet,
        m.cell,
        m.formula,
        m.value instanceof Date ? m.value.toISOString() : m.value
      ]);
      archive.getRange(startRow, 1, archiveRows.length, 5).setValues(archiveRows);
      matches.forEach(m => {
        const targetSheet = ss.getSheetByName(m.sheet);
        targetSheet.getRange(m.row, m.col).setValue(m.value);
      });
    }
    if (typeof archive.hideSheet === 'function') {
      try { archive.hideSheet(); } catch (_) {}
    }
    if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.flush === 'function') {
      SpreadsheetApp.flush();
    }
    return {
      status: 'frozen',
      dryRun: false,
      spreadsheetId: ssId,
      count: matches.length,
      archiveSheet: '_ArchivedFormulas',
      matches: matches
    };
  });
}

function readClosingAccountBalances_(sourceSs) {
  const summary = sourceSs.getSheetByName('Summary');
  if (!summary) throw new Error('Source Summary tab is missing.');
  const a2a4 = summary.getRange('A2:A4').getValues().map(r => String(r[0] || '').trim());
  if (JSON.stringify(a2a4) === JSON.stringify(['Citibank CC', 'DBS CC SGD', 'DBS SGD'])) {
    const d2d4 = summary.getRange('D2:D4').getValues().map(r => Number(r[0]));
    return [
      { account: 'DBS SGD', balanceSgd: Number(d2d4[2].toFixed(2)) },
      { account: 'DBS CC SGD', balanceSgd: Number(d2d4[1].toFixed(2)) },
      { account: 'Citibank CC', balanceSgd: Number(d2d4[0].toFixed(2)) }
    ];
  }
  const a11a13 = summary.getRange('A11:A13').getValues().map(r => String(r[0] || '').trim());
  if (JSON.stringify(a11a13) === JSON.stringify(['DBS SGD', 'DBS CC SGD', 'Citibank CC'])) {
    const c11c13 = summary.getRange('C11:C13').getValues().map(r => Number(r[0]));
    return [
      { account: 'DBS SGD', balanceSgd: Number(c11c13[0].toFixed(2)) },
      { account: 'DBS CC SGD', balanceSgd: Number(c11c13[1].toFixed(2)) },
      { account: 'Citibank CC', balanceSgd: Number(c11c13[2].toFixed(2)) }
    ];
  }
  throw new Error('Unrecognized Summary account balance rows in source workbook.');
}

function buildOpeningSeedRow_(account, balanceSgd, seedYear, rowNumber) {
  const closingPrevYearSerial = Math.round((Date.UTC(seedYear - 1, 11, 31) - Date.UTC(1899, 11, 30)) / 86400000);
  const rounded = Number(balanceSgd.toFixed(2));
  const r = Math.max(2, Number(rowNumber) || 2);
  return [
    closingPrevYearSerial,
    account,
    'Перевод',
    0,
    `=IF(D${r}="";"";D${r})`,
    rounded,
    `=IF(OR(C${r}="Доходы";C${r}="Доходы - премия";C${r}="Доходы - лёгкие деньги";C${r}="Получение денег");F${r}+D${r};F${r}-D${r})`,
    '',
    '[Rollover Seed]',
    'Opening balance carried from Budget ' + (seedYear - 1),
    `=IF(H${r}="";"";IFNA(VLOOKUP(H${r};'-'!$B:$C;2;FALSE);"UNKNOWN"))`
  ];
}

function buildBalanceTemplateRow_(account, seedYear, rowNumber) {
  const closingPrevYearSerial = Math.round((Date.UTC(seedYear - 1, 11, 31) - Date.UTC(1899, 11, 30)) / 86400000);
  const r = Math.max(3, Number(rowNumber) || 5);
  return [
    closingPrevYearSerial,
    account || 'DBS SGD',
    'Перевод',
    0,
    `=IF(D${r}="";"";D${r})`,
    `=INDEX(Transactions!G:G;MAX((OFFSET(B${r};-ROW()+1;0;ROW()-1;1)=B${r})*ROW((OFFSET(B${r};-ROW()+1;0;ROW()-1;1)));0))`,
    `=IF(OR(C${r}="Доходы";C${r}="Доходы - премия";C${r}="Доходы - лёгкие деньги";C${r}="Получение денег");F${r}+D${r};F${r}-D${r})`,
    '',
    '[Rollover Template]',
    'R1C1 running-balance template row for writer.gs',
    `=IF(H${r}="";"";IFNA(VLOOKUP(H${r};'-'!$B:$C;2;FALSE);"UNKNOWN"))`
  ];
}

/**
 * Syncs closing year-end state from Budget 2026 into Budget 2027:
 * - Reference catalogs (Merchants, Products, Calendar, Asset_checkin_accounts, -)
 * - Opening bank/CC seed balances in Budget 2027 Transactions ([Rollover Seed] rows)
 * - [Automated] Папа debt Oct–Dec 2026 evaluated closing rows (rows 31..33)
 * - Kids 2026 closing accruals into Budget 2027 Kids Section 3 (2026 — Глаша / 2026 — Тёма)
 * - Optional Script Properties cutover (ACTIVE_SPREADSHEET_ID + BUDGET_WORKBOOK_YEAR='2027') when activate=true
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet|string} source2026OrId
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet|string} target2027OrId
 * @param {Object} [options] - { dryRun?: boolean (default true), activate?: boolean (default false), targetYear?: number (default 2027) }
 */
function syncYearEndRollover(source2026OrId, target2027OrId, options) {
  const opts = Object.assign({ dryRun: true, activate: false, targetYear: 2027 }, options || {});
  const dryRun = opts.dryRun !== false;
  const activate = Boolean(opts.activate);
  const targetYear = Number(opts.targetYear) || 2027;

  const sourceSs = resolveRolloverSpreadsheet_(source2026OrId, 'Source 2026');
  const targetSs = resolveRolloverSpreadsheet_(target2027OrId, 'Target 2027');
  const sourceId = typeof sourceSs.getId === 'function' ? sourceSs.getId() : 'source';
  const targetId = typeof targetSs.getId === 'function' ? targetSs.getId() : 'target';
  if (sourceId === targetId) {
    throw new Error('Source and target spreadsheets must be distinct workbooks.');
  }

  const plan = {
    sourceId: sourceId,
    targetId: targetId,
    targetYear: targetYear,
    referenceTabs: [],
    openingBalances: readClosingAccountBalances_(sourceSs),
    papaDebtRows: [],
    kidsSummary2026: null,
    scriptProperties: activate
      ? { ACTIVE_SPREADSHEET_ID: targetId, BUDGET_WORKBOOK_YEAR: String(targetYear) }
      : null
  };

  if (plan.openingBalances.some(entry => !Number.isFinite(entry.balanceSgd))) {
    throw new Error('Source closing account balances contain a non-numeric value.');
  }

  ROLLOVER_REFERENCE_TABS.forEach(tabName => {
    const srcSheet = sourceSs.getSheetByName(tabName);
    const dstSheet = targetSs.getSheetByName(tabName);
    if (!srcSheet || !dstSheet) return;
    const rows = srcSheet.getLastRow();
    const cols = srcSheet.getLastColumn();
    plan.referenceTabs.push({ tab: tabName, rows: rows, cols: cols });
  });

  const srcPapa = sourceSs.getSheetByName('[Automated] Папа debt');
  const dstPapa = targetSs.getSheetByName('[Automated] Папа debt');
  if (srcPapa && dstPapa && srcPapa.getLastRow() >= 33) {
    const papaVals = srcPapa.getRange(31, 1, 3, 17).getValues();
    papaVals.forEach((row, idx) => {
      const rowNum = 31 + idx;
      if (typeof row[1] === 'number' && Number.isFinite(row[1])) {
        plan.papaDebtRows.push({ row: rowNum, valuesBtoQ: row.slice(1, 17) });
      }
    });
  }

  const srcKids = sourceSs.getSheetByName('Kids');
  const dstKids = targetSs.getSheetByName('Kids');
  if (srcKids && dstKids && srcKids.getLastRow() >= 30) {
    const row30 = srcKids.getRange(30, 1, 1, 10).getValues()[0] || [];
    if (String(row30[0] || '').indexOf('2026') !== -1 && typeof row30[1] === 'number' && typeof row30[4] === 'number') {
      plan.kidsSummary2026 = {
        glashaActualCore: Number(row30[1].toFixed(2)),
        glashaNlcs: Number(row30[2].toFixed(2)),
        glashaVt: Number(row30[4].toFixed(4)),
        temaActualCore: Number(row30[5].toFixed(2)),
        temaNlcs: Number(row30[6].toFixed(2)),
        temaVt: Number(row30[8].toFixed(4))
      };
    }
  }

  const srcLoans = sourceSs.getSheetByName('Loans');
  const dstLoans = targetSs.getSheetByName('Loans');
  plan.loansClosing = null;
  if (srcLoans && dstLoans && srcLoans.getLastRow() >= 9) {
    const scLive = Number(srcLoans.getRange(6, 4, 1, 1).getValues()[0][0]);
    const bmwLive = Number(srcLoans.getRange(7, 4, 1, 1).getValues()[0][0]);
    if (Number.isFinite(scLive) && scLive >= 0 && Number.isFinite(bmwLive) && bmwLive >= 0) {
      plan.loansClosing = {
        scMortgageSgd: Number(scLive.toFixed(2)),
        bmwLoanSgd: Number(bmwLive.toFixed(2))
      };
    }
  }

  if (dryRun) {
    return {
      status: 'dry_run',
      dryRun: true,
      activated: false,
      plan: plan
    };
  }

  return withBudgetWriteLock(() => {
    // 1. Sync reference tabs (preserving formulas where present, e.g. '-' tab)
    plan.referenceTabs.forEach(item => {
      if (item.rows < 1 || item.cols < 1) return;
      const srcSheet = sourceSs.getSheetByName(item.tab);
      const dstSheet = targetSs.getSheetByName(item.tab);
      const srcRange = srcSheet.getRange(1, 1, item.rows, item.cols);
      const values = srcRange.getValues();
      const formulas = srcRange.getFormulas();
      const merged = values.map((r, ri) => r.map((v, ci) => (formulas[ri] && formulas[ri][ci]) ? formulas[ri][ci] : v));
      const dstLastRow = dstSheet.getLastRow();
      const dstLastCol = dstSheet.getLastColumn();
      if (dstLastRow > item.rows && dstLastCol >= 1) {
        dstSheet.getRange(item.rows + 1, 1, dstLastRow - item.rows, Math.max(dstLastCol, item.cols)).clearContent();
      }
      dstSheet.getRange(1, 1, item.rows, item.cols).setValues(merged);
    });

    // 2. Upsert [Rollover Seed] opening balance rows + [Rollover Template] F:G formula row in target Transactions
    const dstTx = targetSs.getSheetByName('Transactions');
    if (!dstTx) throw new Error('Target Transactions tab is missing.');
    const txLastRow = dstTx.getLastRow();
    const existingRows = txLastRow >= 2 ? dstTx.getRange(2, 1, txLastRow - 1, 11).getValues() : [];
    plan.openingBalances.forEach(entry => {
      const existingIdx = existingRows.findIndex(r =>
        String(r[1] || '').trim() === entry.account && String(r[8] || '').trim() === '[Rollover Seed]'
      );
      const targetRowNum = existingIdx >= 0 ? (existingIdx + 2) : Math.max(2, dstTx.getLastRow() + 1);
      const seedRow = buildOpeningSeedRow_(entry.account, entry.balanceSgd, targetYear, targetRowNum);
      dstTx.getRange(targetRowNum, 1, 1, 11).setValues([seedRow]);
    });
    const refreshedLastRow = dstTx.getLastRow();
    const refreshedRows = refreshedLastRow >= 2 ? dstTx.getRange(2, 1, refreshedLastRow - 1, 11).getValues() : [];
    const hasTemplateRow = refreshedRows.some(r => String(r[8] || '').trim() === '[Rollover Template]');
    if (!hasTemplateRow) {
      const tplRowNum = Math.max(3, dstTx.getLastRow() + 1);
      const primaryAccount = (plan.openingBalances[0] && plan.openingBalances[0].account) || 'DBS SGD';
      dstTx.getRange(tplRowNum, 1, 1, 11).setValues([buildBalanceTemplateRow_(primaryAccount, targetYear, tplRowNum)]);
    }

    // 3. Stamp evaluated Oct–Dec 2026 closing rows into target [Automated] Папа debt
    if (dstPapa && plan.papaDebtRows.length) {
      plan.papaDebtRows.forEach(item => {
        dstPapa.getRange(item.row, 2, 1, 16).setValues([item.valuesBtoQ]);
      });
    }

    // 4. Update 2026 — Глаша & 2026 — Тёма rows in target Kids Section 3
    if (dstKids && plan.kidsSummary2026) {
      const kidsLastRow = dstKids.getLastRow();
      const colA = kidsLastRow >= 34 ? dstKids.getRange(34, 1, kidsLastRow - 33, 2).getValues() : [];
      colA.forEach((pair, idx) => {
        const rNum = 34 + idx;
        const label = String(pair[0] || '') + ' ' + String(pair[1] || '');
        if (/2026/.test(label) && /Глаша|G3|P3/i.test(label)) {
          dstKids.getRange(rNum, 3, 1, 2).setValues([[plan.kidsSummary2026.glashaNlcs, plan.kidsSummary2026.glashaActualCore]]);
          dstKids.getRange(rNum, 7, 1, 1).setValues([[plan.kidsSummary2026.glashaVt]]);
        } else if (/2026/.test(label) && /Тёма|Тема|Pre-KG/i.test(label)) {
          dstKids.getRange(rNum, 3, 1, 2).setValues([[plan.kidsSummary2026.temaNlcs, plan.kidsSummary2026.temaActualCore]]);
          dstKids.getRange(rNum, 7, 1, 1).setValues([[plan.kidsSummary2026.temaVt]]);
        }
      });
    }

    // 4b. Stamp Dec 2026 closing loan principals into target Loans (Row 13 Col H for SC Mortgage, Row 30 Col H for BMW 640i)
    if (dstLoans && plan.loansClosing) {
      dstLoans.getRange(13, 8, 1, 1).setValues([[plan.loansClosing.scMortgageSgd]]);
      dstLoans.getRange(30, 8, 1, 1).setValues([[plan.loansClosing.bmwLoanSgd]]);
    }

    // 5. Optional Script Properties cutover
    if (activate) {
      const props = PropertiesService.getScriptProperties();
      props.setProperty('ACTIVE_SPREADSHEET_ID', targetId);
      props.setProperty('BUDGET_WORKBOOK_YEAR', String(targetYear));
    }

    if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.flush === 'function') {
      SpreadsheetApp.flush();
    }

    return {
      status: 'synced',
      dryRun: false,
      activated: activate,
      plan: plan
    };
  });
}
