// Offline regression tests for Step 3: Promoted Summary + CashCoverage v3 on 2026, CapitalPlan 2026,
// ETF - STI check-in wiring, Loans tracker (/loans), Multimodal /checkin flow, and Coach Portfolio Health Watch.
const assert = require('node:assert/strict');

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

function makeWorkbook(sheetsSpec, id = 'wb-step3') {
  const sheets = {};
  Object.entries(sheetsSpec).forEach(([name, spec]) => {
    const initialRows = Array.isArray(spec) ? spec : spec.values;
    const explicitFormulas = (!Array.isArray(spec) && spec.formulas) ? spec.formulas : null;
    const values = initialRows.map(r => r.slice());
    const formulas = initialRows.map((r, ri) => r.map((cell, ci) => {
      if (explicitFormulas && explicitFormulas[ri] && explicitFormulas[ri][ci] !== undefined) {
        return explicitFormulas[ri][ci];
      }
      return (typeof cell === 'string' && cell.startsWith('=')) ? cell : '';
    }));
    sheets[name] = {
      _values: values,
      _formulas: formulas,
      getName: () => name,
      getLastRow: () => values.length,
      getLastColumn: () => Math.max(0, ...values.map(r => r.length)),
      getRange: (rowOrA1, col, height = 1, width = 1) => {
        let r = rowOrA1, c = col, h = height, w = width;
        if (typeof rowOrA1 === 'string') {
          const p = parseA1(rowOrA1);
          r = p.row; c = p.col; h = p.height; w = p.width;
        }
        const rng = {
          getValues: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => values[r - 1 + ri]?.[c - 1 + ci] ?? '')),
          getDisplayValues: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => {
              const v = values[r - 1 + ri]?.[c - 1 + ci] ?? '';
              return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
            })),
          getFormulas: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => formulas[r - 1 + ri]?.[c - 1 + ci] ?? '')),
          getValue: () => rng.getValues()[0][0],
          getDisplayValue: () => rng.getDisplayValues()[0][0],
          getFormula: () => rng.getFormulas()[0][0],
          setValues: mat => {
            mat.forEach((rowVals, ri) => rowVals.forEach((val, ci) => {
              values[r - 1 + ri] ||= [];
              formulas[r - 1 + ri] ||= [];
              if (typeof val === 'string' && val.startsWith('=')) {
                formulas[r - 1 + ri][c - 1 + ci] = val;
                if (values[r - 1 + ri][c - 1 + ci] === undefined) values[r - 1 + ri][c - 1 + ci] = 0;
              } else {
                values[r - 1 + ri][c - 1 + ci] = val;
                formulas[r - 1 + ri][c - 1 + ci] = '';
              }
            }));
            return rng;
          },
          setValue: val => rng.setValues([[val]]),
          setFormula: f => {
            formulas[r - 1] ||= [];
            formulas[r - 1][c - 1] = f;
            return rng;
          },
          clearContent: () => {
            for (let ri = 0; ri < h; ri++) {
              for (let ci = 0; ci < w; ci++) {
                if (values[r - 1 + ri]) values[r - 1 + ri][c - 1 + ci] = '';
                if (formulas[r - 1 + ri]) formulas[r - 1 + ri][c - 1 + ci] = '';
              }
            }
            return rng;
          }
        };
        return rng;
      }
    };
  });
  return {
    getId: () => id,
    getName: () => 'Budget Workbook',
    getSpreadsheetTimeZone: () => 'Asia/Singapore',
    getSheetByName: n => sheets[n] || null,
    getSheets: () => Object.values(sheets)
  };
}

function buildPromotedSummarySpec() {
  const values = Array.from({ length: 38 }, () => Array(10).fill(''));
  const formulas = Array.from({ length: 38 }, () => Array(10).fill(''));
  values[0] = ['BUDGET 2026 — EXECUTIVE SUMMARY', '', '', '', '', '', '', 'As of:', new Date('2026-11-28T00:00:00Z'), "Ноябрь'26"];
  values[1] = ['Subtitle', '', '', '', '', '', '', 'USD/SGD:', 1.29, 'SGD/RUB: 63.3'];
  values[4] = [2387957, '', -4758.19, '', 509046, '', -2635783, '', 7134];
  formulas[4][2] = '=CashCoverage!B12';
  values[10] = ['DBS SGD', 'DBS', 87851.54, 'Operating', 'Transactions', 'Live', 'GSU % of Net Worth', '', 0.137, '✓ Within 20%'];
  values[11] = ['DBS CC SGD', 'DBS', -39770.03, 'Headroom', 'Transactions', 'Live', 'GSU % of Liquid Assets', '', 0.643, '⚠ Concentrated (>35%)'];
  values[12] = ['Citibank CC', 'Citibank', -370.70, 'Included', 'Transactions', 'Live', 'Liquid Runway (Months)', '', 14.5, '✓ Strong (>=12m)'];
  values[20] = ['1. Cash', 'SAYE (Syfe / Bank)', 17978.30, 0.004, 'Assets_details'];
  values[22] = ['2. Liquid Inv.', 'STI ETF (DBS Vickers · 6,180 sh)', 35720.40, 0.007, 'Assets_details'];
  values[23] = ['2. Liquid Inv.', 'GSU — GOOG Vested', 327099.00, 0.065, 'Assets_details'];
  values[24] = ['3. Earmarked', 'Kids Funds (Глаша + Тёма)', 227486.00, 0.045, 'Kids'];
  values[28] = ['4. Real Estate', 'Apartment #02-66 (Keppel Bay)', 3200000, 0.637, 'Manual'];
  values[29] = ['TOTAL ASSETS', 'Gross Assets', 5023740, 1, 'All'];
  values[31] = ['5. Liability', 'Mortgage (SC — #02-66)', -2321234.72, -0.462, 'Loans'];
  formulas[31][2] = '=-Loans!D6';
  values[32] = ['5. Liability', 'Папа Loan (Multi-currency)', -195923.08, -0.039, '[Automated] Папа debt'];
  values[33] = ['5. Liability', 'BMW 640i Loan (DBS)', -78484.64, -0.016, 'Loans'];
  formulas[33][2] = '=-Loans!D7';
  values[34] = ['TOTAL DEBT', 'All Liabilities', -2635783, -0.525, 'Cards + Loans', '', '100% Automated'];
  values[35] = ['NET WORTH', 'Total Net Worth (Vested, SGD)', 2387957, 0.475, 'Single Source'];
  return { values, formulas };
}

function buildLoansSheetRows() {
  const rows = Array.from({ length: 42 }, () => Array(11).fill(''));
  rows[4] = ['Facility / Liability', 'Lender', "Anchor (Nov'26)", 'Live Principal (SGD)', 'Annual EIR', 'Monthly Cash', 'Monthly CPF OA', 'Monthly Interest', 'Monthly Principal', 'Est. Remaining', 'Rule'];
  rows[5] = ['SC Mortgage — #02-66 (Keppel Bay)', 'Standard Chartered', 2321234.72, 2321234.72, 0.0235, 6196.04, 2000, 4545.75, 3650.29, '413 mos (34.5 yrs)', 'Auto'];
  rows[6] = ['BMW 640i Loan (HP HPR146871H)', 'DBS Bank', 78484.64, 78484.64, 0.0518, 2707, 0, 338.79, 2368.21, '31 mos (Jun 2029)', 'Auto'];
  rows[7] = ['Папа Loan (Multi-currency Family)', 'Family (USD/EUR/SGD)', 195923.08, 195923.08, 0, 1214.11, 0, 0, 1214.11, 'FX Waterfall + P4', 'Live'];
  rows[8] = ['TOTAL NON-CARD DEBT', 'All 3 Facilities', 2595642.44, 2595642.44, 0.0226, 10117.15, 2000, 4884.54, 7232.61, 'Debt/Gross: 51.7%', '100% automated'];
  rows[11] = [46356, 'Nov 2026', 6196.04, 2000, 8196.04, 4552.9, 3643.14, '', 2321234.72, '✓ Verified Anchor', 'Anchor'];
  rows[12] = [46387, 'Dec 2026', 0, 0, 0, 0, 0, '', 2321234.72, 'Scheduled', 'Live'];
  rows[28] = [46356, 'Nov 2026', 2707, 0, 2707, 348.97, 2358.03, '', 78484.64, '✓ Verified Anchor', 'Anchor'];
  rows[29] = [46387, 'Dec 2026', 0, 0, 0, 0, 0, '', 78484.64, 'Scheduled', 'Live'];
  return rows;
}

function buildCheckinFixtureSheets() {
  const accounts = [
    ['Order', 'Account ID', 'Asset', 'Active', 'Method', 'Input currency', 'Tracked scope', 'Price symbol', 'FX pair', 'Previous units or basis'],
    [1, 'saye', 'SAYE', true, 'Manual balance', 'SGD', 'SAYE bank balance', '', '', ''],
    [2, 'ibkr_v', 'ETF - IBRK V', true, 'Manual balance', 'SGD', 'IBKR Home total', '', '', ''],
    [3, 'goog', 'GSU GOOG', true, 'Holdings × price', 'USD', 'Vested GOOG shares', 'NASDAQ:GOOG', 'USDSGD', 930.718],
    [4, 'layan', 'Illiquid - Layan', true, 'Valuation × FX', 'THB', 'Layan basis', '', 'THBSGD', 7000000],
    [5, 'sti_etf', 'ETF - STI', true, 'Holdings × price', 'SGD', '6,180 SGX:ES3 units', 'SGX:ES3', '', 6180]
  ];
  const details = [
    ['Дата', 'Актив', 'Действие', 'Пополнение', 'На счету до', 'На счету после', 'Доходность', 'Цена', 'Куплено', 'Всего', 'Комментарии', 'Check-in key'],
    [46356, 'SAYE', 'Value check-in', 0, 17978.30, 17978.30, '', '', '', '', 'DRAFT 2026-11|saye', '2026-11|saye'],
    [46356, 'ETF - IBRK V', 'Value check-in', 0, 125454.30, 125454.30, '', '', '', '', 'DRAFT 2026-11|ibkr_v', '2026-11|ibkr_v'],
    [46356, 'GSU GOOG', 'Value check-in', 0, 327099.00, 327099.00, '', 351.45, 0, 930.718, 'DRAFT 2026-11|goog', '2026-11|goog'],
    [46356, 'Illiquid - Layan', 'Value check-in', 0, 266693.00, 266693.00, '', '', '', '', 'DRAFT 2026-11|layan', '2026-11|layan'],
    [46356, 'ETF - STI', 'Value check-in', 0, 35720.40, 35720.40, '', 5.78, 0, 6180, 'DRAFT 2026-11|sti_etf', '2026-11|sti_etf']
  ];
  const checkinsValues = [
    ['Month', 'Asset', 'Status', 'Confirmed SGD', 'Valuation as-of', 'Evidence', 'Existing draft SGD', 'Ledger row', 'Check-in key', 'Currency', 'Native', 'FX', 'FX date', 'Quote', 'Quote date', 'Units', 'Cash', 'Scope', 'Captured at', 'Locked at', 'Flows checked', 'Notes', 'Expected'],
    [46356, 'SAYE', 'Pending', '', '', '', 17978.30, 2, '2026-11|saye', 'SGD', '', '', '', '', '', '', '', 'SAYE', '', '', 'Pending', '', 5],
    [46356, 'ETF - IBRK V', 'Pending', '', '', '', 125454.30, 3, '2026-11|ibkr_v', 'SGD', '', '', '', '', '', '', '', 'IBKR V', '', '', 'Pending', '', 5],
    [46356, 'GSU GOOG', 'Pending', '', '', '', 327099.00, 4, '2026-11|goog', 'USD', '', '', '', '', '', 930.718, '', 'GOOG', '', '', 'Pending', '', 5],
    [46356, 'Illiquid - Layan', 'Pending', '', '', '', 266693.00, 5, '2026-11|layan', 'THB', '', '', '', '', '', '', '', 'Layan', '', '', 'Pending', '', 5],
    [46356, 'ETF - STI', 'Pending', '', '', '', 35720.40, 6, '2026-11|sti_etf', 'SGD', '', '', '', '', '', 6180, '', 'STI ETF', '', '', 'Pending', '', 5]
  ];
  const checkinsFormulas = checkinsValues.map((r, i) => {
    const f = Array(23).fill('');
    if (i >= 1) f[7] = `=IFERROR(MATCH(I${i + 1};Assets_details!$L:$L;0);"")`;
    return f;
  });
  return {
    Asset_checkin_accounts: accounts,
    Assets_details: details,
    Asset_checkins: { values: checkinsValues, formulas: checkinsFormulas }
  };
}

module.exports = test => {
  test('Step 3: cash_coverage_v3 validates cleanly on active-year Budget 2026 (DATE(YEAR(TODAY())...))', c => {
    const v3Formulas = c.buildCashCoverageRowsV3();
    // Override B3 to active-year formula used in promoted Budget 2026
    const activeFormulas = v3Formulas.map(r => r.slice());
    activeFormulas[2][1] = '=DATE(YEAR(TODAY());MONTH(TODAY());1)';

    const vm = require('node:vm');
    const nov1 = vm.runInContext("new Date('2026-11-01T00:00:00Z')", c);
    const nov28 = vm.runInContext("new Date('2026-11-28T08:00:00Z')", c);
    const ccValues = activeFormulas.map(r => r.map(v => (typeof v === 'string' && v.startsWith('=')) ? 0 : v));
    ccValues[1][1] = "Ноябрь'26";
    ccValues[2][1] = nov1;
    ccValues[3][1] = 9050;
    ccValues[4][1] = 0;
    ccValues[5][1] = 52469;
    ccValues[6][1] = 47710.81;
    ccValues[7][1] = nov28;
    ccValues[11][1] = -4758.19;
    ccValues[22][0] = 'Отложения';
    ccValues[22][4] = 8000;
    ccValues[24][1] = 43419;

    const wb = makeWorkbook({
      Summary: buildPromotedSummarySpec(),
      CashCoverage: { values: ccValues, formulas: activeFormulas },
      "Ноябрь'26": [[ '', nov1 ]]
    }, 'wb-2026');

    const cov = c.readCashCoverage(wb, nov28);
    assert.equal(cov.status, 'available', cov.reason || '');
    assert.equal(cov.source, 'CashCoverage!B12');
    assert.equal(cov.amount_sgd, -4758.19);
    assert.equal(cov.saye_balance_sgd, 17978.30);
    assert.equal(cov.unpaid_savings_plan_sgd, 8000);
  });

  test('Step 3: CapitalPlan reader & /tax Telegram summary support both 2026 (Yr-2 PR) and 2027 (Yr-3 PR)', c => {
    const cpRows26 = Array.from({ length: 46 }, () => Array(9).fill(''));
    cpRows26[0][0] = 'BUDGET 2026 — CAPITAL & IRAS TAX-RELIEF PLAN (YA 2027)';
    cpRows26[9] = ['Mandatory CPF', 20400, 15300, 35700, 32900, 2800];
    cpRows26[10] = ['CPF Top-Up', 8000, 8000, 16000, 0, 16000];
    cpRows26[11] = ['SRS', 15300, 15300, 30600, 0, 30600];
    cpRows26[15] = ['Headroom', 27300, 40400, 67700];
    cpRows26[16] = ['IPC Charity', 10920, 16160, 27080, 1279, 25801];
    cpRows26[18] = ['Tax Saved', 11638, 11466, 23104, 735, 22369, '', '23% Val / 18% Rita Yr-2 PR'];
    cpRows26[24] = ['IPC Standing', 120, 1440];
    cpRows26[32] = ['TOTAL 2026 PURE CASH POOL', 191637, 184045];
    cpRows26[38] = ['P3 SAYE', 128877, 26856, 102022];
    cpRows26[39] = ['SUBTOTAL P1-P3', 258919, 85775, 174423, 1.35, -67282];
    cpRows26[40] = ['P4 Papa Loan', 0, 22068, 195923];
    cpRows26[43] = ['2026 GSU Vests', 193007, 193007];

    const wb26 = makeWorkbook({ CapitalPlan: cpRows26 }, 'wb-2026');
    const st26 = c.readCapitalPlanStatus(wb26);
    assert.equal(st26.plan_year, 2026);
    assert.equal(st26.charity_target_cash_sgd, 27080);
    assert.equal(st26.charity_remaining_cash_sgd, 25801);
    const html26 = c.renderCapitalPlanTelegramSummary(st26);
    assert.match(html26, /CapitalPlan \(2026\)/);
    assert.match(html26, /23% Val \/ 18% Rita Yr-2 PR/);
    assert.match(html26, /into Q1 2027 bonus/);
  });

  test('Step 3: /loans reads SC Mortgage, BMW 640i, and Папа Loan with LTV and monthly equity build', c => {
    const wb = makeWorkbook({
      Summary: buildPromotedSummarySpec(),
      Loans: buildLoansSheetRows()
    });
    const loans = c.readLoansStatus(wb);
    assert.ok(loans);
    assert.equal(loans.sc_mortgage.live_principal_sgd, 2321234.72);
    assert.equal(loans.bmw_loan.live_principal_sgd, 78484.64);
    assert.equal(loans.papa_loan.live_principal_sgd, 195923.08);
    assert.equal(loans.home_ltv_pct, 72.5);
    assert.equal(loans.home_equity_sgd, 878765.28);

    const html = c.renderLoansTelegramSummary(loans);
    assert.match(html, /Household Loans &amp; Amortization/);
    assert.match(html, /S\$2,595,642/);
    assert.match(html, /LTV 72\.5%/);
    assert.match(html, /BMW 640i Auto Loan/);
  });

  test('Step 3: /checkin parses text & screenshot entries, confirms interactively, and locks Assets_details, Asset_checkins & Loans', c => {
    const cacheMap = new Map();
    c.CacheService = {
      getScriptCache: () => ({
        get: k => cacheMap.get(k) || null,
        put: (k, v) => { cacheMap.set(k, String(v)); },
        remove: k => { cacheMap.delete(k); }
      })
    };
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };

    const sheetsSpec = Object.assign({
      Summary: buildPromotedSummarySpec(),
      Loans: buildLoansSheetRows()
    }, buildCheckinFixtureSheets());
    const wb = makeWorkbook(sheetsSpec);
    c.SpreadsheetApp.getActiveSpreadsheet = () => wb;

    // 1. Status check before locking
    const st0 = c.readAssetCheckinStatus(wb, new Date('2026-11-28T10:00:00Z'));
    assert.equal(st0.month, '2026-11');
    assert.equal(st0.expected_count, 5);
    assert.equal(st0.locked_count, 0);
    const statusHtml = c.renderCheckinStatusTelegram(st0, c.readPortfolioHealthStatus(wb, new Date('2026-11-28T10:00:00Z')));
    assert.match(statusHtml, /0 \/ 5 Locked/);
    assert.match(statusHtml, /sti_etf/);

    // 2. Parse multi-entry text check-in (SGD balance, share count, unchanged basis, and loan override)
    const prop = c.prepareTelegramCheckinProposal({
      ss: wb,
      asOf: new Date('2026-11-28T12:00:00Z'),
      textArgs: 'saye 18500.50, goog 977.08 sh, layan unchanged, sti 6180 sh, mortgage 2317580.10'
    });
    assert.equal(prop.status, 'ready');
    assert.equal(prop.proposal.entries.length, 5);
    assert.match(prop.html, /SAYE/);
    assert.match(prop.html, /SC Mortgage/);

    // 3. Commit pending check-in
    const commitRes = c.commitPendingCheckin(prop.token, wb, new Date('2026-11-28T12:05:00Z'));
    assert.equal(commitRes.status, 'committed');
    assert.equal(commitRes.committed.length, 5);
    assert.equal(commitRes.checkin_status.locked_count, 4); // 4 of 5 assets locked (ibkr_v still pending)

    // Verify Assets_details literal writes & preserved key in Column L
    const det = wb.getSheetByName('Assets_details');
    assert.equal(det.getRange('E2').getValue(), 18500.50);
    assert.equal(det.getRange('L2').getValue(), '2026-11|saye');
    assert.equal(det.getRange('J4').getValue(), 977.08);
    assert.equal(det.getRange('L6').getValue(), '2026-11|sti_etf');

    // Verify Asset_checkins Status='Locked' AND Column H MATCH formula preserved!
    const chk = wb.getSheetByName('Asset_checkins');
    assert.equal(chk.getRange('C2').getValue(), 'Locked');
    assert.equal(chk.getRange('D2').getValue(), 18500.50);
    assert.equal(chk.getRange('H2').getFormula(), '=IFERROR(MATCH(I2;Assets_details!$L:$L;0);"")');

    // Verify Loans statement override written to Row 12 Col H (2026-11 anchor row)
    const loans = wb.getSheetByName('Loans');
    assert.equal(loans.getRange('H12').getValue(), 2317580.10);

    // Double-tap returns already_processed idempotently
    assert.equal(c.commitPendingCheckin(prop.token, wb).status, 'already_processed');

    // 4. Multimodal screenshot check-in via Gemini mock
    c.PropertiesService.getScriptProperties = () => ({
      getProperty: k => (k === 'GEMINI_API_KEY' ? 'test-key' : '')
    });
    c.callGeminiApiWithRetry = () => ({
      text: JSON.stringify({
        entries: [{ id: 'ibkr_v', value: 129100.75, currency: 'SGD', is_units: false, as_of: '2026-11-28', note: 'IBKR Home Value' }]
      }),
      modelUsed: 'mock'
    });
    const mediaProp = c.prepareTelegramCheckinProposal({
      ss: wb,
      asOf: new Date('2026-11-28T13:00:00Z'),
      mediaInputs: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }]
    });
    assert.equal(mediaProp.status, 'ready');
    assert.equal(mediaProp.proposal.entries[0].id, 'ibkr_v');
    assert.equal(mediaProp.proposal.entries[0].sgd_value, 129100.75);
    const commitMedia = c.commitPendingCheckin(mediaProp.token, wb, new Date('2026-11-28T13:02:00Z'));
    assert.equal(commitMedia.checkin_status.all_locked, true);
  });

  test('Step 3: Monthly Coach renders Portfolio Health & Check-ins watch and rollover syncs Loans closing principals', c => {
    const sheetsSpec = Object.assign({
      Summary: buildPromotedSummarySpec(),
      Loans: buildLoansSheetRows()
    }, buildCheckinFixtureSheets());
    const wb26 = makeWorkbook(sheetsSpec, 'src-2026');

    const health = c.readPortfolioHealthStatus(wb26, new Date('2026-11-28T10:00:00Z'));
    assert.ok(health);
    assert.equal(health.gsu_concentrated, true);
    assert.equal(health.checkins_locked, 0);
    assert.equal(health.checkins_expected, 5);

    const rendered = c.renderMonthlyReview({
      month_tab: "Ноябрь'26",
      report_month: '2026-11',
      target_header: 'Target month',
      buckets: { savings: { actual: 8000, target: 7345 } },
      mandatory_summary: { paid: 9, unpaid: 2 },
      monthly_review: {
        ordinary_total: 8200,
        ordinary_plan: { amount: 8830 },
        ordinary_variance: -630,
        allocations: { actual: 35000, target: 35061 },
        over_drivers: [],
        discipline: [],
        recommendations: [],
        history: { months: ['2026-06', '2026-07', '2026-08'], ordinary_median: 9100, yoy_same_month: null },
        portfolio_health: health
      }
    });
    assert.match(rendered, /Portfolio Health &amp; Check-ins:/);
    assert.match(rendered, /64\.3%<\/b> of Parents’ liquid assets/);
    assert.match(rendered, /0\/5 locked/);

    // Verify syncYearEndRollover copies closing SC Mortgage & BMW 640i principals into target Loans Row 13/30 Col H
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };
    wb26.getSheetByName('Loans').getRange('D6').setValue(2317584.43);
    wb26.getSheetByName('Loans').getRange('D7').setValue(76116.43);

    const wb27 = makeWorkbook({
      Transactions: [
        ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где', 'Заметки', '50/30/20']
      ],
      Loans: buildLoansSheetRows()
    }, 'dst-2027');

    const rollRes = c.syncYearEndRollover(wb26, wb27, { dryRun: false, activate: false, targetYear: 2027 });
    assert.equal(rollRes.status, 'synced');
    assert.deepEqual(JSON.parse(JSON.stringify(rollRes.plan.loansClosing)), {
      scMortgageSgd: 2317584.43,
      bmwLoanSgd: 76116.43
    });
    assert.equal(wb27.getSheetByName('Loans').getRange('H13').getValue(), 2317584.43);
    assert.equal(wb27.getSheetByName('Loans').getRange('H30').getValue(), 76116.43);
  });

  test("Step 3: Dec'26 P0 Closing CapitalPlan, 2027 v3 GOOG→VT DCA CapitalPlan, and shifted Kids Row 29 rollover", c => {
    // 1. Budget 2026 34-row December'26 Closing & P0 Funding Options layout
    const dec26Rows = Array.from({ length: 34 }, () => Array(9).fill(''));
    dec26Rows[0][0] = "BUDGET 2026 — DECEMBER'26 CLOSING & P0 IRAS TAX-CAP FUNDING PLAN (YA 2027 · CUTOFF 31 DEC 2026)";
    dec26Rows[9] = ['Mandatory CPF Employee (Ord. + Bonus Cap)', 20400, 15300, 35700, 32900, 0];
    dec26Rows[10] = ['P0a · CPF Cash Top-Up Relief (RSTU · S$8k each)', 8000, 8000, 16000, 0, 16000];
    dec26Rows[11] = ['P0b · SRS Contribution Relief (S$15.3k each)', 15300, 15300, 30600, 0, 30600];
    dec26Rows[15] = ['Remaining S$80k Cap Headroom (Deduction)', 27300, 40400, 67700];
    dec26Rows[16] = ['P0c · Optimal IPC Charity Cash (at 2.5× IPC)', 10920, 16160, 27080, 1279, 25801];
    dec26Rows[18] = ['Estimated Tax Saved (SRS + RSTU + Charity)', 11638, 11466, 23104, 735, 22369, 'YA 2027 Tax Bill', '23% Val / 18% Rita Yr-2 PR'];
    dec26Rows[22] = ['1. SAYE Liquid Cash Reserve (Summary!C21)', 17978.30];
    dec26Rows[25] = ["TOTAL PURE CASH AVAILABLE FOR DEC'26 P0", 29220.11, 72401, -43180.89];

    const stDec = c.readCapitalPlanStatus(makeWorkbook({ CapitalPlan: dec26Rows }, 'wb-dec26'));
    assert.equal(stDec.plan_year, 2026);
    assert.equal(stDec.dec_closing_mode, true);
    assert.equal(stDec.total_tax_advantaged_remaining_sgd, 72401);
    assert.equal(stDec.estimated_tax_saved_remaining_sgd, 22369);
    assert.equal(stDec.pure_cash_pool_plan_sgd, 29220.11);
    assert.equal(stDec.dec_p0_cash_gap_sgd, -43180.89);

    const decHtml = c.renderCapitalPlanTelegramSummary(stDec);
    assert.match(decHtml, /Dec'26 P0 IRAS Cutoff/);
    assert.match(decHtml, /S\$72,401/);
    assert.match(decHtml, /S\$22,369/);
    assert.match(decHtml, /trim ~S\$43,181 GOOG/);

    // 2. Budget 2027 42-row v3 CapitalPlan with IBKR VT stock deduction & GOOG -> Parents' VT DCA scenarios
    const cp27Rows = Array.from({ length: 42 }, () => Array(9).fill(''));
    cp27Rows[0][0] = 'BUDGET 2027 — CAPITAL & IRAS TAX-RELIEF PLAN (YA 2028 · VAL 23% + RITA 18% YR-3 PR)';
    cp27Rows[9] = ['Mandatory CPF Employee (Ord. + Bonus Cap)', 20400, 20400, 40800, 0, 40800];
    cp27Rows[10] = ['CPF Cash Top-Up Relief (RSTU · S$8k each)', 8000, 8000, 16000, 0, 16000];
    cp27Rows[11] = ['SRS Contribution Relief (S$15.3k each)', 15300, 15300, 30600, 0, 30600];
    cp27Rows[15] = ['Remaining S$80k Cap Headroom (Deduction)', 27300, 35300, 62600];
    cp27Rows[16] = ['Optimal IPC Charity Cash (at 2.5× IPC)', 10920, 14120, 25040, 0, 25040];
    cp27Rows[18] = ['Estimated Tax Saved (SRS + RSTU + Charity)', 11638, 10548, 22186, 0, 22186, 'YA 2028 Tax Bill', '23% Val / 18% Rita Yr-3 PR'];
    cp27Rows[25] = ['TOTAL 2027 PURE CASH CAPITAL POOL', 227720, 0, 227720];
    cp27Rows[31] = ['P2 · Kids Model 2A VT Cash (Net of 91.8 IBKR VT in Stock)', 39858, 0, 39858];
    cp27Rows[32] = ['P3 · Cash-Equivalent Rainy-Day Top-Up (SAYE → S$120k)', 102022, 0, 102022];
    cp27Rows[33] = ['SUBTOTAL P1–P3 CASH COMMITMENTS (Tax + Kids + SAYE)', 188480, 0, 188480, 0.828, 39240];
    cp27Rows[34] = ["P4 · Repay Dad's Loan (Папа Loan — Pure Cash Portion)", 39240, 0, 156699];
    cp27Rows[38] = ['2027 GSU Vests Baseline · Hold 100% GOOG (No VT DCA)', 0, 0];
    cp27Rows[40] = ['Scenario B · 2027 Vests + 25% Trim Existing GOOG → VT', 181775, 15148];

    const st27 = c.readCapitalPlanStatus(makeWorkbook({ CapitalPlan: cp27Rows }, 'wb-2027-v3'));
    assert.equal(st27.plan_year, 2027);
    assert.equal(st27.dec_closing_mode, false);
    assert.equal(st27.cash_left_after_saye_sgd, 39240);
    assert.equal(st27.papa_remaining_ex_gsu_sgd, 156699);
    assert.equal(st27.goog_vt_dca_monthly_scen_b_sgd, 15148);

    const html27 = c.renderCapitalPlanTelegramSummary(st27);
    assert.match(html27, /S\$39,240<\/b> pure cash for <b>Папа Loan<\/b>/);
    assert.match(html27, /Scenario B S\$15,148\/mo GOOG→VT DCA hits &lt;35% GSU/);

    // 3. Kids shifted layout (Row 29 = Total 2026 after Row 13 deleted; Section 3 rows at 34..35)
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };
    const srcKids = Array.from({ length: 42 }, () => Array(10).fill(''));
    srcKids[28] = ['Total 2026', 24800, 48200, 23400, 120.75, 18100, 39400, 21300, 109.5];
    const dstKids = Array.from({ length: 42 }, () => Array(10).fill(''));
    dstKids[33] = ['2026', 'Глаша (G3)', 0, 0, 0, 0, 0];
    dstKids[34] = ['2026', 'Тёма (Pre-KG)', 0, 0, 0, 0, 0];

    const dstWb = makeWorkbook({
      Transactions: [['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где', 'Заметки', '50/30/20']],
      Kids: dstKids
    }, 'dst-k');
    const rollKids = c.syncYearEndRollover(
      makeWorkbook({ Summary: buildPromotedSummarySpec(), Kids: srcKids }, 'src-k'),
      dstWb,
      { dryRun: false, activate: false, targetYear: 2027 }
    );
    assert.equal(rollKids.plan.kidsSummary2026.glashaVt, 120.75);
    assert.equal(rollKids.plan.kidsSummary2026.temaVt, 109.5);
    assert.equal(dstWb.getSheetByName('Kids').getRange('C34').getValue(), 48200);
    assert.equal(dstWb.getSheetByName('Kids').getRange('G34').getValue(), 120.75);
    assert.equal(dstWb.getSheetByName('Kids').getRange('C35').getValue(), 39400);
    assert.equal(dstWb.getSheetByName('Kids').getRange('G35').getValue(), 109.5);
  });
};
