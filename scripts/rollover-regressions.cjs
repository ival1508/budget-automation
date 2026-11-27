// Offline tests for Step 1 Foundation Cleanups & Annual Rollover Kit (Budget 2027).
const assert = require('node:assert/strict');
const vm = require('node:vm');

function parseA1(a1) {
  const match = String(a1).match(/^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/);
  assert.ok(match, 'Unsupported A1 range: ' + a1);
  const toCol = s => [...s].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0);
  const col = toCol(match[1]);
  const row = Number(match[2]);
  const endCol = match[3] ? toCol(match[3]) : col;
  const endRow = match[4] ? Number(match[4]) : row;
  return { row, col, height: endRow - row + 1, width: endCol - col + 1 };
}

function makeMockWorkbook(id, name, initialSheets = {}, tz = 'Asia/Kuala_Lumpur') {
  const sheets = [];
  let nextId = 100;

  function createSheet(sheetName, values = [], formulas = []) {
    const state = {
      id: ++nextId,
      name: sheetName,
      hidden: false,
      values: values.map(r => r.slice()),
      formulas: formulas.map(r => r.slice())
    };
    const api = {
      _state: state,
      getSheetId: () => state.id,
      getName: () => state.name,
      setName: n => { state.name = n; return api; },
      hideSheet: () => { state.hidden = true; return api; },
      showSheet: () => { state.hidden = false; return api; },
      isSheetHidden: () => state.hidden,
      getMaxRows: () => Math.max(100, state.values.length),
      getMaxColumns: () => Math.max(30, ...state.values.map(r => r.length), 0),
      getLastRow: () => state.values.length,
      getLastColumn: () => Math.max(0, ...state.values.map(r => r.length), ...state.formulas.map(r => r.length)),
      copyTo: destSs => {
        const cloned = destSs._createSheet('Copy of ' + state.name, state.values, state.formulas);
        return cloned;
      },
      getRange: (rowOrA1, col, height = 1, width = 1) => {
        let r = rowOrA1, c = col, h = height, w = width;
        if (typeof rowOrA1 === 'string') {
          const parsed = parseA1(rowOrA1);
          r = parsed.row; c = parsed.col; h = parsed.height; w = parsed.width;
        }
        const rangeObj = {
          getValues: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => state.values[r - 1 + ri]?.[c - 1 + ci] ?? '')),
          getDisplayValues: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => {
              const v = state.values[r - 1 + ri]?.[c - 1 + ci] ?? '';
              return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
            })),
          getFormulas: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => state.formulas[r - 1 + ri]?.[c - 1 + ci] ?? '')),
          getValue: () => rangeObj.getValues()[0][0],
          getDisplayValue: () => rangeObj.getDisplayValues()[0][0],
          getFormula: () => rangeObj.getFormulas()[0][0],
          setValues: mat => {
            mat.forEach((rowVals, ri) => rowVals.forEach((val, ci) => {
              state.values[r - 1 + ri] ||= [];
              state.formulas[r - 1 + ri] ||= [];
              if (typeof val === 'string' && val.startsWith('=')) {
                state.formulas[r - 1 + ri][c - 1 + ci] = val;
                if (state.values[r - 1 + ri][c - 1 + ci] === undefined) {
                  state.values[r - 1 + ri][c - 1 + ci] = 0;
                }
              } else {
                state.values[r - 1 + ri][c - 1 + ci] = val;
                state.formulas[r - 1 + ri][c - 1 + ci] = '';
              }
            }));
            return rangeObj;
          },
          setValue: val => rangeObj.setValues([[val]]),
          setFormulas: mat => {
            mat.forEach((rowForms, ri) => rowForms.forEach((f, ci) => {
              state.values[r - 1 + ri] ||= [];
              state.formulas[r - 1 + ri] ||= [];
              state.formulas[r - 1 + ri][c - 1 + ci] = f;
              if (state.values[r - 1 + ri][c - 1 + ci] === undefined || state.values[r - 1 + ri][c - 1 + ci] === '') {
                state.values[r - 1 + ri][c - 1 + ci] = 0;
              }
            }));
            return rangeObj;
          },
          setFormula: f => rangeObj.setFormulas([[f]]),
          clearContent: () => {
            for (let ri = 0; ri < h; ri++) {
              for (let ci = 0; ci < w; ci++) {
                if (state.values[r - 1 + ri]) state.values[r - 1 + ri][c - 1 + ci] = '';
                if (state.formulas[r - 1 + ri]) state.formulas[r - 1 + ri][c - 1 + ci] = '';
              }
            }
            return rangeObj;
          },
          clearDataValidations: () => rangeObj,
          setWrap: () => rangeObj,
          setNote: () => rangeObj,
          clearNote: () => rangeObj
        };
        return rangeObj;
      }
    };
    sheets.push(api);
    return api;
  }

  Object.entries(initialSheets).forEach(([sName, spec]) => {
    createSheet(sName, spec.values || [], spec.formulas || []);
  });

  return {
    _sheets: sheets,
    _createSheet: createSheet,
    getId: () => id,
    getName: () => name,
    getSpreadsheetTimeZone: () => tz,
    getSheets: () => sheets.slice(),
    getSheetByName: sName => sheets.find(s => s.getName() === sName) || null,
    insertSheet: sName => createSheet(sName, [], []),
    deleteSheet: sheetObj => {
      const idx = sheets.indexOf(sheetObj);
      if (idx >= 0) sheets.splice(idx, 1);
    }
  };
}

function serial(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

module.exports = test => {
  test('ACTIVE_SPREADSHEET_ID & BUDGET_WORKBOOK_YEAR switch target workbook cleanly while keeping sandbox isolated', c => {
    const bound2026 = { getId: () => 'bound-2026-id', getName: () => 'Budget 2026' };
    const active2027 = { getId: () => 'live-2027-id', getName: () => 'Budget 2027' };
    const sandboxId = vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID', c);
    const sandbox = { getId: () => sandboxId, getName: () => 'Budget 2026 TEST' };
    let boundCalls = 0;

    c.SpreadsheetApp = {
      getActiveSpreadsheet: () => { boundCalls++; return bound2026; },
      openById: id => {
        if (id === 'live-2027-id') return active2027;
        if (id === sandboxId) return sandbox;
        if (id === 'mismatch-id') return { getId: () => 'wrong-id' };
        throw new Error('Unknown ID: ' + id);
      }
    };

    // Default (unset): uses bound 2026 spreadsheet and workbookYear 2026
    assert.equal(c.getActiveBudgetSpreadsheet(), bound2026);
    assert.equal(c.getConfiguredWorkbookYear(), 2026);
    assert.equal(boundCalls, 1);

    // Explicit ACTIVE_SPREADSHEET_ID routes all operational lookups to Budget 2027 without touching getActiveSpreadsheet()
    const props = c.PropertiesService.getScriptProperties();
    props.setProperty('ACTIVE_SPREADSHEET_ID', 'live-2027-id');
    assert.equal(c.getActiveBudgetSpreadsheet(), active2027);
    assert.equal(c.getTargetSpreadsheet(false), active2027);
    assert.equal(boundCalls, 1);
    // Title fallback infers 2027 when ACTIVE_SPREADSHEET_ID is set
    assert.equal(c.getConfiguredWorkbookYear(active2027), 2027);

    // Explicit BUDGET_WORKBOOK_YEAR overrides without needing spreadsheet instance
    props.setProperty('BUDGET_WORKBOOK_YEAR', '2027');
    assert.equal(c.getConfiguredWorkbookYear(), 2027);

    // Sandbox mode still strictly opens TEST_SPREADSHEET_ID
    assert.equal(c.getTargetSpreadsheet(true), sandbox);

    // Invalid year or mismatched spreadsheet ID throws safely
    props.setProperty('BUDGET_WORKBOOK_YEAR', 'not-a-year');
    assert.throws(() => c.getConfiguredWorkbookYear(), /Invalid BUDGET_WORKBOOK_YEAR/);
    props.setProperty('BUDGET_WORKBOOK_YEAR', '2027');
    props.setProperty('ACTIVE_SPREADSHEET_ID', 'mismatch-id');
    assert.throws(() => c.getActiveBudgetSpreadsheet(), /Active spreadsheet identity does not match/);
  });

  test('2027+ uniform Full\'YY naming eliminates April/August collision and chains Stage 6 createMonthTab(2027, 2)', c => {
    // 2026 legacy single-letter Jan-Apr preserved
    assert.equal(c.getCurrentMonthTabName(vm.runInContext("new Date('2026-01-15T04:00:00Z')", c)), "Я'26");
    assert.equal(c.getCurrentMonthTabName(vm.runInContext("new Date('2026-04-15T04:00:00Z')", c)), "А'26");
    assert.equal(c.getCurrentMonthTabName(vm.runInContext("new Date('2026-08-15T04:00:00Z')", c)), "Август'26");

    // 2027+ uses full Russian month names + 'YY for all 12 months
    const expected2027 = [
      "Январь'27", "Февраль'27", "Март'27", "Апрель'27", "Май'27", "Июнь'27",
      "Июль'27", "Август'27", "Сентябрь'27", "Октябрь'27", "Ноябрь'27", "Декабрь'27"
    ];
    for (let m = 1; m <= 12; m++) {
      const iso = `2027-${String(m).padStart(2, '0')}-15T04:00:00Z`;
      assert.equal(c.getCurrentMonthTabName(vm.runInContext(`new Date('${iso}')`, c)), expected2027[m - 1]);
      assert.equal(c.monthCreationPeriod(2027, m).name, expected2027[m - 1]);
      assert.deepEqual(JSON.parse(JSON.stringify(c.monthCreationIdentity(expected2027[m - 1]))), { month: m, year: 2027 });
    }
    assert.notEqual(expected2027[3], expected2027[7]); // Апрель'27 !== Август'27

    // Build a valid Stage 6 Январь'27 template and chain createMonthTab(2027, 2) -> Февраль'27 and (2027, 3) -> Март'27
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };
    const props = c.PropertiesService.getScriptProperties();
    props.setProperty('BUDGET_WORKBOOK_YEAR', '2027');

    const janVals = Array.from({ length: 70 }, () => Array(12).fill(''));
    const janForms = Array.from({ length: 70 }, () => Array(12).fill(''));
    janVals[0][1] = serial('2027-01-01');
    janForms[0][3] = '=EOMONTH(B1;0)'; janVals[0][3] = serial('2027-01-31');
    janVals[2][0] = 'Зарплата В'; janVals[2][1] = 35000;
    janVals[3][0] = 'Зарплата Р'; janVals[3][1] = 14500;
    janVals[4][1] = 0;
    janForms[5][1] = c.monthCreationLightIncomeFormula(); janVals[5][1] = 0;
    janForms[13][1] = '=SUM(INDIRECT(ADDRESS(2;COLUMN())&":"&ADDRESS(ROW()-1;COLUMN())))'; janVals[13][1] = 49500;
    janForms[13][4] = '=SUM(INDIRECT(ADDRESS(3;COLUMN())&":"&ADDRESS(ROW()-1;COLUMN())))'; janVals[13][4] = 15000;
    janForms[14][3] = '=B14-E14'; janVals[14][3] = 34500;
    janForms[16][3] = '=D15/(DAYS360(B1;D1)+1)'; janVals[16][3] = 1150;
    janForms[18][3] = '=(L33/(D1-TODAY()+1))'; janVals[18][3] = 1150;
    janForms[1][10] = '=D17';
    const mandCategories = ['Аренда', 'Помощница', 'Коммунальные', 'Интернет', 'Мобильные', 'Дети', 'Страховка', 'Подписки', 'Родители', 'Отложения', 'CPF'];
    mandCategories.forEach((cat, idx) => {
      janVals[2 + idx][3] = cat;
      janVals[2 + idx][4] = cat === 'CPF' ? 4880 : 500;
      janVals[2 + idx][6] = '';
    });
    janForms[12][4] = '=(0.09*8000+0.15*8000)+(0.17*8000+0.2*8000)';
    janVals[36][7] = 'Date Increment'; janVals[36][8] = 'Date in Month';
    janForms[37][7] = '=B1'; janForms[37][8] = '=H38<=$D$1'; janVals[37][8] = true;
    for (let r = 2; r <= 32; r++) {
      janForms[r - 1][7] = '=IF(INDIRECT(ADDRESS(ROW()+36; COLUMN()+1));INDIRECT(ADDRESS(ROW()+36; COLUMN())); )';
      janForms[r - 1][8] = c.monthCreationDescriptionFormula(r); janVals[r - 1][8] = '';
      janForms[r - 1][9] = '=SUMIFS(Transactions!E:E;Transactions!A:A;H' + r + ';Transactions!C:C;"Расходы";Transactions!H:H;"<>Отложения";Transactions!H:H;"<>Аренда")';
      janForms[r - 1][11] = '=INDIRECT(ADDRESS(ROW(); COLUMN()-1))-INDIRECT(ADDRESS(ROW(); COLUMN()-2))';
      if (r > 2) janForms[r - 1][10] = '=IF(INDIRECT(ADDRESS(ROW()+36; COLUMN()-2)); INDIRECT(ADDRESS(ROW()-1; COLUMN()+1))+D$17; INDIRECT(ADDRESS(ROW()-1; COLUMN()+1)))';
    }
    janForms[32][9] = '=SUM(J2:J32)'; janForms[32][10] = '=K32'; janForms[32][11] = '=L32';
    for (let r = 39; r <= 68; r++) {
      janForms[r - 1][7] = '=INDIRECT(ADDRESS(ROW()-1; COLUMN()))+1';
      janForms[r - 1][8] = '=IF(INDIRECT(ADDRESS(ROW(); COLUMN()-1))<=D1; true; false)';
    }

    const txRows = [
      ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'До', 'После', 'Категория', 'Где', 'Заметки', '50/30/20'],
      [serial('2027-01-25'), 'DBS SGD', 'Доходы', 31000, 31000, 0, 31000, 'Зарплата', 'Google', '', ''],
      [serial('2027-01-26'), 'DBS SGD', 'Доходы', 12600, 12600, 31000, 43600, 'Зарплата', 'Kaspersky', '', ''],
      [serial('2027-02-25'), 'DBS SGD', 'Доходы', 31000, 31000, 43600, 74600, 'Зарплата', 'Google', '', ''],
      [serial('2027-02-26'), 'DBS SGD', 'Доходы', 12600, 12600, 74600, 87200, 'Зарплата', 'Kaspersky', '', '']
    ];

    const wb2027 = makeMockWorkbook('wb-2027-id', 'Budget 2027', {
      "Январь'27": { values: janVals, formulas: janForms },
      Transactions: { values: txRows }
    });

    const febRes = c.createMonthTab(2027, 2, { spreadsheet: wb2027, sandbox: false });
    assert.equal(febRes.created, true);
    assert.equal(febRes.sheetName, "Февраль'27");
    assert.equal(febRes.source, "Январь'27");

    const marRes = c.createMonthTab(2027, 3, { spreadsheet: wb2027, sandbox: false });
    assert.equal(marRes.created, true);
    assert.equal(marRes.sheetName, "Март'27");
    assert.equal(wb2027.getSheetByName("Январь'27").isSheetHidden(), true);
    assert.equal(wb2027.getSheetByName("Февраль'27").isSheetHidden(), false);
  });

  test('cash_coverage_v3 validates promoted Summary!C5 -> CashCoverage!B12 without circularity and renders shortfall levers', c => {
    const asOf = vm.runInContext("new Date('2027-01-20T04:00:00Z')", c);
    const v3Rows = c.buildCashCoverageRowsV3();
    const ccValues = v3Rows.map(r => r.map(cell => (typeof cell === 'string' && cell.startsWith('=')) ? 0 : cell));
    const ccFormulas = v3Rows.map(r => r.map(cell => (typeof cell === 'string' && cell.startsWith('=')) ? cell : ''));
    ccValues[1][1] = "Январь'27";     // B2 selected month
    ccValues[7][1] = serial('2027-01-20'); // B8 As of
    ccValues[9][1] = 'cash_coverage_v3';   // B10 contract
    ccValues[11][1] = -3892.00;       // B12 Coverage after commitments
    ccValues[22][0] = 'Отложения';    // A23
    ccValues[22][4] = 7000.00;        // E23 Unpaid Отложения plan
    ccValues[24][1] = 31000.00;       // B25 Reserved next month salary

    const sumVals = Array.from({ length: 25 }, () => Array(6).fill(''));
    const sumForms = Array.from({ length: 25 }, () => Array(6).fill(''));
    sumVals[4][2] = -3892.00; sumForms[4][2] = '=CashCoverage!B12'; // C5
    sumVals[10][0] = 'DBS SGD'; sumVals[10][2] = 28000;
    sumVals[11][0] = 'DBS CC SGD'; sumVals[11][2] = -4200;
    sumVals[12][0] = 'Citibank CC'; sumVals[12][2] = -1800;
    sumVals[20][1] = 'SAYE (DBS Fixed Saver)'; sumVals[20][2] = 20000; // B21 / C21

    const janVals = [[ '', serial('2027-01-01') ]];
    const wb = makeMockWorkbook('wb-2027', 'Budget 2027', {
      Summary: { values: sumVals, formulas: sumForms },
      CashCoverage: { values: ccValues, formulas: ccFormulas },
      "Январь'27": { values: janVals }
    });

    const cov = c.readCashCoverage(wb, asOf);
    assert.equal(cov.status, 'available');
    assert.equal(cov.source, 'CashCoverage!B12');
    assert.equal(cov.amount_sgd, -3892);
    assert.equal(cov.unpaid_savings_plan_sgd, 7000);
    assert.equal(cov.saye_balance_sgd, 20000);

    const brief = c.appendDailyCashCoverage(
      '• <b>Pacing:</b> S$120.00/day.\n• <b>Action:</b> Keep ordinary spend steady.',
      { period: 'daily', cash_coverage: cov }
    );
    assert.match(brief, /<b>S\$3,892\.00<\/b> shortfall/);
    assert.match(brief, /trim pending Отложения from <b>S\$7,000\.00<\/b> to <b>S\$3,108\.00<\/b>/);
    assert.match(brief, /transfer <b>S\$3,892\.00<\/b> from SAYE \(<b>S\$20,000\.00<\/b> available\)/);
    assert.match(brief, /• <b>Action:<\/b> Arrange funding or a transfer to cover the settlement shortfall \(trim pending Отложения/);

    // Tampered Summary!C5 is caught immediately
    wb.getSheetByName('Summary')._state.formulas[4][2] = '=0';
    const broken = c.readCashCoverage(wb, asOf);
    assert.equal(broken.status, 'unavailable');
    assert.match(broken.reason, /Summary!C5 does not link to CashCoverage!B12/);
  });

  test('Historical_Benchmarks supplies cross-year lookback, YoY context, and target recommendations in Jan 2027', c => {
    const reportDate = vm.runInContext("new Date('2027-01-31T12:00:00Z')", c);

    // 50/30/20 with 01/2027 column (C:D) and Target columns at AE:AF (indices 30:31)
    const make50Row = (g, cat, act, pct, tgt, tgtPct) => {
      const r = Array(32).fill('');
      r[0] = g; r[1] = cat; r[2] = act; r[3] = pct; r[30] = tgt; r[31] = tgtPct;
      return r;
    };
    const bRows = [
      make50Row('Group', 'Category', '01/2027', '%', 'Target month 2026', 'Target %'),
      Array(32).fill(''),
      make50Row('Needs', 'Needs', 1800, 0.5, 1500, 0.5),
      make50Row('', 'Продукты', 1800, 0.5, 1200, 0.4),
      make50Row('Wants', 'Wants', 900, 0.25, 900, 0.3),
      make50Row('', 'Рестораны', 900, 0.25, 900, 0.3),
      make50Row('Savings', 'Savings', 1000, 0.25, 1000, 0.2),
      make50Row('', 'Инвестиции', 1000, 0.25, 1000, 0.2),
      make50Row('', 'Total', 3700, 1.0, 3400, 1.0)
    ];

    const janRows = Array.from({ length: 33 }, () => Array(12).fill(''));
    janRows[0][1] = serial('2027-01-01');
    janRows[2][3] = 'CPF'; janRows[2][4] = 4880; janRows[2][6] = '';
    janRows[13][1] = 20000; // B14 income
    janRows[13][4] = 4880;  // E14 mandatory total
    janRows[14][3] = 15120; // D15 ordinary plan

    const txRows = [
      ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'До', 'После', 'Категория', 'Где', 'Заметки', '50/30/20'],
      [vm.runInContext("new Date('2027-01-10T04:00:00Z')", c), 'DBS CC SGD', 'Расходы', 1800, 1800, 0, -1800, 'Продукты', 'FairPrice', '', 'Needs'],
      [vm.runInContext("new Date('2027-01-18T04:00:00Z')", c), 'DBS CC SGD', 'Расходы', 900, 900, -1800, -2700, 'Рестораны', 'PS.Cafe', '', 'Wants']
    ];

    const benchRows = [
      ['month', 'source_era', 'regular_inflow_sgd', 'ordinary_spend_sgd', 'needs_total_sgd', 'wants_total_sgd', 'regular_savings_sgd', 'Продукты', 'Рестораны', 'committed_by_category_json'],
      ['2026-01', '2026', 35000, 14200, 16000, 8500, 10500, 1650, 950, '{}'],
      ['2026-08', '2026', 35000, 15100, 16500, 9000, 9500, 1700, 880, '{}'],
      ['2026-09', '2026', 35000, 14800, 16200, 8700, 10100, 1750, 910, '{}'],
      ['2026-10', '2026', 35000, 15300, 16800, 8900, 9300, 1680, 920, '{}'],
      ['2026-11', '2026', 35000, 14900, 16400, 8600, 10000, 1720, 850, '{}'],
      ['2026-12', '2026', 35000, 15600, 17000, 9200, 8800, 1820, 980, '{}']
    ];

    const wb2027 = makeMockWorkbook('wb-2027', 'Budget 2027', {
      '50/30/20': { values: bRows },
      "Январь'27": { values: janRows },
      Transactions: { values: txRows },
      Historical_Benchmarks: { values: benchRows }
    });

    const payload = c.buildCoachPayload('monthly', wb2027, reportDate);
    assert.equal(payload.error, undefined);
    assert.equal(payload.month_tab, "Январь'27");
    assert.deepEqual(Array.from(payload.monthly_review.history.months), ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
    assert.equal(payload.monthly_review.history.ordinary_median, 15100);
    assert.deepEqual(JSON.parse(JSON.stringify(payload.monthly_review.history.yoy_same_month)), {
      month: '2026-01',
      ordinary: 14200,
      needs_total: 16000,
      wants_total: 8500
    });
    assert.equal(payload.monthly_review.recommendations.length, 1);
    assert.equal(payload.monthly_review.recommendations[0].name, 'Продукты');
    assert.equal(payload.monthly_review.recommendations[0].suggested_target, 1720);

    const rendered = c.renderMonthlyReview(payload);
    assert.match(rendered, /2026-08–2026-12/);
    assert.match(rendered, /Same month last year \(2026-01\), Расходы was S\$14,200\.00\./);
  });

  test('freezeAnnualWorkbook and syncYearEndRollover enforce dryRun safety, backup formulas, and sync closing state', c => {
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };

    // 1. freezeAnnualWorkbook safety & execution
    const archiveWb = makeMockWorkbook('budget-2026-live', 'Budget 2026', {
      Summary: {
        values: [
          ['Account', 'Currency', 'Native', 'SGD'],
          ['Citibank CC', 'SGD', -1200, -1200],
          ['DBS CC SGD', 'SGD', -3400, -3400],
          ['DBS SGD', 'SGD', 45000, 45000],
          ['VWRA', 'USD', 148.5, 199.2]
        ],
        formulas: [
          ['', '', '', ''],
          ['', '', '', ''],
          ['', '', '', ''],
          ['', '', '', ''],
          ['', '', '=GOOGLEFINANCE("LON:VWRA")', '=C5*GOOGLEFINANCE("USDSGD")']
        ]
      },
      "Декабрь'26": {
        values: [['', serial('2026-12-01')], ['', 520]],
        formulas: [['', ''], ['', '=(L33/(D1-TODAY()+1))']]
      },
      Transactions: {
        values: [['Дата', 'Счёт'], [serial('2026-12-10'), 'DBS SGD']],
        formulas: [['', ''], ['=TODAY()', '']] // Protected ledger must NEVER be touched
      }
    });

    // Dry run makes zero changes
    const dryFreeze = c.freezeAnnualWorkbook(archiveWb);
    assert.equal(dryFreeze.status, 'dry_run');
    assert.equal(dryFreeze.count, 3);
    assert.equal(archiveWb.getSheetByName('_ArchivedFormulas'), null);
    assert.equal(archiveWb.getSheetByName('Summary').getRange('C5').getFormula(), '=GOOGLEFINANCE("LON:VWRA")');

    // Error guard refuses to freeze transient #N/A GoogleFinance hiccup
    archiveWb.getSheetByName('Summary')._state.values[4][2] = '#N/A';
    assert.throws(() => c.freezeAnnualWorkbook(archiveWb, { dryRun: false }), /Cannot freeze workbook while volatile cells evaluate to errors/);
    archiveWb.getSheetByName('Summary')._state.values[4][2] = 148.5;

    // Live freeze backs up to _ArchivedFormulas and stamps values while leaving Transactions untouched
    const frozen = c.freezeAnnualWorkbook(archiveWb, { dryRun: false });
    assert.equal(frozen.status, 'frozen');
    assert.equal(frozen.count, 3);
    const backup = archiveWb.getSheetByName('_ArchivedFormulas');
    assert.ok(backup);
    assert.equal(backup.isSheetHidden(), true);
    assert.equal(backup.getLastRow(), 4); // header + 3 formulas
    assert.equal(archiveWb.getSheetByName('Summary').getRange('C5').getFormula(), '');
    assert.equal(archiveWb.getSheetByName('Summary').getRange('C5').getValue(), 148.5);
    assert.equal(archiveWb.getSheetByName('Transactions').getRange('A2').getFormula(), '=TODAY()');

    // 2. syncYearEndRollover dryRun vs live execution + cutover
    const papaRowsSrc = Array.from({ length: 34 }, (_, idx) => {
      if (idx >= 30 && idx <= 32) {
        const r = Array(17).fill(0);
        r[0] = serial(`2026-${idx - 20}-01`);
        r[1] = 100000 - (idx - 30) * 1000;
        return r;
      }
      return Array(17).fill('');
    });
    const kidsRowsSrc = Array.from({ length: 31 }, () => Array(10).fill(''));
    kidsRowsSrc[29] = ['Total 2026', 14681.5, 50986, 36304.5, 186.65, 27796.6, 49133, 21336.4, 109.72, 194.78];

    const src2026 = makeMockWorkbook('src-2026', 'Budget 2026', {
      Summary: {
        values: [
          ['Account', 'Currency', 'Native', 'SGD'],
          ['Citibank CC', 'SGD', -1250.4, -1250.4],
          ['DBS CC SGD', 'SGD', -3410.1, -3410.1],
          ['DBS SGD', 'SGD', 48900.75, 48900.75]
        ]
      },
      Merchants: { values: [['Merchant', 'Category'], ['FairPrice', 'Продукты'], ['Grab', 'Транспорт']] },
      '[Automated] Папа debt': { values: papaRowsSrc },
      Kids: { values: kidsRowsSrc }
    });

    const dstKidsRows = Array.from({ length: 42 }, () => Array(10).fill(''));
    dstKidsRows[38] = ['2026 — Глаша', 'Age 9 · G3/P3', 50000, 14000, 36000, 0, 180.0, 0, 0, 0];
    dstKidsRows[39] = ['2026 — Тёма', 'Age 4 · Pre-KG', 49000, 27000, 22000, 0, 105.0, 0, 0, 0];

    const dst2027 = makeMockWorkbook('dst-2027', 'Budget 2027', {
      Merchants: { values: [['Merchant', 'Category'], ['FairPrice', 'Продукты']] },
      Transactions: {
        values: [
          ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'До', 'После', 'Категория', 'Где', 'Заметки', '50/30/20'],
          [serial('2026-12-31'), 'DBS SGD', 'Перевод', 0, 0, 40000, 40000, '', '[Rollover Seed]', 'Provisional', ''],
          [serial('2027-01-01'), 'DBS CC SGD', 'Расходы', 25, 25, -3000, -3025, 'Рестораны', 'Ya Kun', '', 'Wants']
        ]
      },
      '[Automated] Папа debt': { values: Array.from({ length: 35 }, () => Array(17).fill('')) },
      Kids: { values: dstKidsRows }
    });

    assert.throws(() => c.syncYearEndRollover(src2026, src2026), /must be distinct workbooks/);

    const drySync = c.syncYearEndRollover(src2026, dst2027, { dryRun: true, activate: true });
    assert.equal(drySync.status, 'dry_run');
    assert.equal(drySync.activated, false);
    assert.equal(c.PropertiesService.getScriptProperties().getProperty('ACTIVE_SPREADSHEET_ID'), null);
    assert.equal(dst2027.getSheetByName('Merchants').getLastRow(), 2);

    const liveSync = c.syncYearEndRollover(src2026, dst2027, { dryRun: false, activate: true });
    assert.equal(liveSync.status, 'synced');
    assert.equal(liveSync.activated, true);
    assert.equal(c.PropertiesService.getScriptProperties().getProperty('ACTIVE_SPREADSHEET_ID'), 'dst-2027');
    assert.equal(c.PropertiesService.getScriptProperties().getProperty('BUDGET_WORKBOOK_YEAR'), '2027');
    assert.equal(dst2027.getSheetByName('Merchants').getLastRow(), 3);
    // Existing DBS SGD [Rollover Seed] updated in place; Ya Kun user row preserved; missing CC seeds + [Rollover Template] appended
    assert.equal(dst2027.getSheetByName('Transactions').getRange('F2').getValue(), 48900.75);
    assert.match(dst2027.getSheetByName('Transactions').getRange('G2').getFormula(), /^=IF\(OR\(C2="Доходы"/);
    assert.equal(dst2027.getSheetByName('Transactions').getRange('I3').getValue(), 'Ya Kun');
    assert.equal(dst2027.getSheetByName('Transactions').getLastRow(), 6);
    assert.equal(dst2027.getSheetByName('Transactions').getRange('I6').getValue(), '[Rollover Template]');
    assert.match(dst2027.getSheetByName('Transactions').getRange('F6').getFormula(), /^=INDEX\(Transactions!G:G/);
    // Papa debt row 33 stamped
    assert.equal(dst2027.getSheetByName('[Automated] Папа debt').getRange('B33').getValue(), 98000);
    // Kids 2026 Glasha & Tema VT updated
    assert.equal(dst2027.getSheetByName('Kids').getRange('G39').getValue(), 186.65);
    assert.equal(dst2027.getSheetByName('Kids').getRange('G40').getValue(), 109.72);
  });
};
