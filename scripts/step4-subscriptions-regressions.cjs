// Offline regression tests for Step 4: Automated Subscription Radar (Подписки),
// /subs Telegram digest, auto-registration hook, Quarterly Coach brief, and rollover carryover.
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

function makeWorkbook(sheetsSpec, id = 'wb-step4') {
  const sheets = {};
  Object.entries(sheetsSpec).forEach(([name, initialRows]) => {
    const values = initialRows.map(r => r.slice());
    const formulas = initialRows.map(r => r.map(c => (typeof c === 'string' && c.startsWith('=')) ? c : ''));
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
          getFormulas: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => formulas[r - 1 + ri]?.[c - 1 + ci] ?? '')),
          getValue: () => rng.getValues()[0][0],
          getFormula: () => rng.getFormulas()[0][0],
          setValues: mat => {
            mat.forEach((rowVals, ri) => rowVals.forEach((val, ci) => {
              values[r - 1 + ri] ||= [];
              formulas[r - 1 + ri] ||= [];
              if (typeof val === 'string' && val.startsWith('=')) {
                formulas[r - 1 + ri][c - 1 + ci] = val;
              } else {
                values[r - 1 + ri][c - 1 + ci] = val;
                formulas[r - 1 + ri][c - 1 + ci] = '';
              }
            }));
            return rng;
          },
          setValue: val => rng.setValues([[val]]),
          clearContent: () => rng
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

function buildSubscriptionsFixtureRows(withAlerts = true) {
  const rows = Array.from({ length: 47 }, () => Array(12).fill(''));
  rows[0] = ['BUDGET 2026 — AUTOMATED SUBSCRIPTION RADAR (ПОДПИСКИ)', '', '', '', '', '', '', '', 'As of:', 46354, '50/30/20 Target:', 250];
  rows[4] = [139.90, '', 73.10, '', 213.00, '', 2736.95, '', withAlerts ? 4 : 0, '', 386.60, ''];
  rows[9] = [
    'YouTube Premium', '^youtube premium$', 'Monthly', 'DBS CC SGD', '18th',
    27.98, withAlerts ? 31.98 : 27.98, 46344, 11, 315.78, withAlerts ? 31.98 : 27.98,
    withAlerts ? '⚠ Price Hike +14,3% (S$27,98 → S$31,98)' : '✓ Active (Monthly · 18th)'
  ];
  rows[10] = [
    'OpenAI / ChatGPT', '^(openai|open ai|chat\\s*gpt)', 'Monthly', 'DBS CC SGD', '22nd',
    30.30, 30.30, 46348, 10, 302.40, 30.30, '✓ Active (Monthly · 22nd)'
  ];
  rows[11] = [
    'Amazon Prime (Monthly)', '^amazon prime$', 'Monthly', 'DBS CC SGD', '16th',
    4.99, 4.99, 46342, 10, 49.90, 4.99,
    withAlerts ? '⚠ Overlap: Monthly S$4.99 + Annual S$49.90 both billed' : '✓ Active (Monthly · 16th)'
  ];
  rows[12] = [
    'Google One (Annual Plan)', '^google( one)?$', 'Annual', 'DBS CC SGD', 'May 17',
    289.98, 289.98, 46159, 1, 289.98, 24.17, '✓ Active (Annual · May 17)'
  ];
  rows[13] = [
    'Foodpanda (pandapro)', '^foodpanda membership', 'Annual', 'DBS CC SGD', 'Feb 28',
    59.88, 59.88, 46081, 1, 59.88, 4.99, '✓ Active (Annual · Feb 28)'
  ];
  rows[14] = [
    'Redshield VPN', '^redshield vpn', 'Cancelled', 'DBS CC SGD', "Off (Aug'26)",
    15.74, 15.74, 46251, 2, 31.62, 0,
    withAlerts ? '⚠ Zombie Charge After Cancel (17.11)!' : '✓ Confirmed Off (autorenew disabled)'
  ];
  // Populate rows 16..28 (indices 15..27) matching the 19-row live catalog so rows 29..31 are the 3 open slots
  for (let idx = 15; idx <= 27; idx++) {
    rows[idx] = ['Existing Plan #' + (idx + 1), '^existing plan ' + (idx + 1) + '$', 'One-off', 'DBS CC SGD', 'Varies', 0, 0, '—', 0, 0, 0, 'One-off'];
  }
  // Rows 29..31 (indices 28..30) are empty pre-allocated auto-registration slots with formulas in G..L
  for (let idx = 28; idx <= 30; idx++) {
    rows[idx] = ['', '', '', '', '', '', '=LIVE_G', '=LIVE_H', '=LIVE_I', '=LIVE_J', '=LIVE_K', '=LIVE_L'];
  }
  rows[31] = ['TOTAL CORE ПОДПИСКИ', '100% Ledger Reconciled', '17 Active', 'DBS CC / SGD', 'Monthly + Annual', 209.00, '', 46352, 118, 2736.95, 213.00, ''];
  rows[35] = ['Anytime Fitness (Gym)', '^anytime fitness$', 'Развлечения', 'DBS CC SGD', '1st–2nd', 115.00, 115.00, 46328, 17, 1803.08, 115.00, ''];
  rows[36] = ['MyRepublic (Broadband + Mobile)', '^myrepublic$', 'Счётчики', 'DBS CC SGD', '9th & 15th', 42.70, 8.71, 46341, 22, 971.97, 42.70, ''];
  rows[37] = ['Circles.Life (Mobile)', '^circles\\.life$', 'Счётчики', 'DBS CC SGD', '3rd–4th', 15.90, 37.70, 46329, 9, 244.38, 15.90, ''];
  if (withAlerts) {
    rows[42] = ['Perplexity Pro', '', 'Подписки', '', '', '', 27.50, 46350, 1, 27.50, '', '⚠ New unmapped subscription'];
  }
  return rows;
}

module.exports = test => {
  test('Step 4: readSubscriptionRadarStatus & /subs detect price hikes, overlaps, zombie charges, renewals, and unmapped merchants', c => {
    const wb = makeWorkbook({ Подписки: buildSubscriptionsFixtureRows(true) });
    // Jan 20, 2027 -> next month is Feb (Foodpanda pandapro renewal window!)
    const status = c.readSubscriptionRadarStatus(wb, new Date('2027-01-20T08:00:00Z'));
    assert.ok(status);
    assert.equal(status.all_in_run_rate_sgd, 213.00);
    assert.equal(status.annualized_run_rate_sgd, 2556.00);
    assert.equal(status.headroom_monthly_sgd, 37.00);
    assert.equal(status.watchlist_monthly_sgd, 173.60);
    assert.equal(status.price_hikes.length, 1);
    assert.equal(status.price_hikes[0].name, 'YouTube Premium');
    assert.equal(status.price_hikes[0].hike_pct, 14.3);
    assert.equal(status.overlaps_and_duplicates.length, 1);
    assert.equal(status.zombie_charges.length, 1);
    assert.equal(status.unmapped_merchants.length, 1);
    assert.equal(status.unmapped_merchants[0].merchant, 'Perplexity Pro');
    assert.equal(status.upcoming_renewals.length, 1);
    assert.equal(status.upcoming_renewals[0].name, 'Foodpanda (pandapro)');

    const html = c.renderSubscriptionRadarTelegramSummary(status);
    assert.match(html, /Subscription Radar \(Подписки 2026\)/);
    assert.match(html, /S\$213\.00\/mo/);
    assert.match(html, /YouTube Premium:<\/b> S\$27\.98 → <b>S\$31\.98<\/b> \(\+14\.3%/);
    assert.match(html, /Redshield VPN/);
    assert.match(html, /Perplexity Pro/);
    assert.match(html, /Foodpanda \(pandapro\)/);
  });

  test('Step 4: syncSubscriptionsAfterWrite auto-registers brand-new Подписки merchants into R29..R31 while preserving live G..L formulas', c => {
    const wb = makeWorkbook({ Подписки: buildSubscriptionsFixtureRows(false) });
    const writeRes = {
      dryRun: false,
      writtenCount: 3,
      writtenRows: [
        // 1. Existing alias (ChatGPT) -> already matched by ^(openai|open ai|chat\s*gpt), must NOT duplicate
        { date: '2026-11-22', account: 'DBS CC SGD', type: 'Расходы', category: 'Подписки', where: 'ChatGPT', amount: 30.30, amount_sgd: 30.30 },
        // 2. Brand-new monthly subscription -> auto-registered in Row 29
        { date: '2026-11-25', account: 'DBS CC SGD', type: 'Расходы', category: 'Подписки', where: 'Claude Pro', amount: 28.50, amount_sgd: 28.50 },
        // 3. Brand-new annual subscription -> auto-registered in Row 30 as Annual
        { date: '2026-11-28', account: 'DBS CC SGD', type: 'Расходы', category: 'Подписки', where: '1Password Family', amount: 82.00, amount_sgd: 82.00, notes: 'Annual plan' }
      ]
    };

    const synced = c.syncSubscriptionsAfterWrite(writeRes.writtenRows, writeRes, wb);
    assert.equal(synced.subscriptionSync.registeredCount, 2);

    const subSheet = wb.getSheetByName('Подписки');
    assert.deepEqual(subSheet.getRange('A29:F29').getValues()[0], [
      'Claude Pro', '^claude pro$', 'Monthly', 'DBS CC SGD', '25th', 28.50
    ]);
    assert.equal(subSheet.getRange('G29').getFormula(), '=LIVE_G'); // Formula in Col G untouched!
    assert.deepEqual(subSheet.getRange('A30:F30').getValues()[0], [
      '1Password Family', '^1password family$', 'Annual', 'DBS CC SGD', 'Nov 28', 82
    ]);

    // Second run with same merchant is idempotent
    const second = c.syncSubscriptionsAfterWrite(writeRes.writtenRows, { dryRun: false, writtenRows: writeRes.writtenRows }, wb);
    assert.equal(second.subscriptionSync, undefined);
    assert.equal(subSheet.getRange('A31').getValue(), '');
  });

  test('Step 4: Monthly Coach emits Quarterly Subscription Radar on quarter-ends, exception watch on alerts, and stays quiet when clean', c => {
    const cleanStatus = c.readSubscriptionRadarStatus(makeWorkbook({ Подписки: buildSubscriptionsFixtureRows(false) }), new Date('2027-08-10T08:00:00Z'));
    const alertStatus = c.readSubscriptionRadarStatus(makeWorkbook({ Подписки: buildSubscriptionsFixtureRows(true) }), new Date('2026-11-28T08:00:00Z'));

    // 1. Clean non-quarter month -> empty string (zero noise)
    assert.equal(c.renderSubscriptionCoachLine(cleanStatus, '2027-08'), '');

    // 2. Clean quarter-end month -> emits Quarterly Subscription Radar brief
    const qLine = c.renderSubscriptionCoachLine(cleanStatus, '2027-09');
    assert.match(qLine, /Quarterly Subscription Radar \(Подписки\):/);
    assert.match(qLine, /All active plans match baseline with zero overlaps/);

    // 3. Non-quarter month with anomalies -> emits Subscription Radar Watch inside renderMonthlyReview
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
        subscriptions: alertStatus
      }
    });
    assert.match(rendered, /Subscription Radar Watch:/);
    assert.match(rendered, /YouTube Premium/);
  });

  test('Step 4: readPortfolioHealthStatus resolves GSU/Kids dynamically after SRS STI ETF move and rollover carries Подписки latest baselines', c => {
    // Summary with SRS — STI ETF moved to Row 25 (GSU at Row 23, Kids at Row 24)
    const sumRows = Array.from({ length: 37 }, () => Array(10).fill(''));
    sumRows[4] = [2387957, '', -4758.19, '', 473326];
    sumRows[10] = ['DBS SGD', 'DBS', 87851.54, '', '', '', 'GSU % of Net Worth', '', 0.137];
    sumRows[11] = ['DBS CC SGD', 'DBS', -39770.03, '', '', '', 'GSU % of Liquid Assets', '', 0.691];
    sumRows[12] = ['Citibank CC', 'Citibank', -370.70, '', '', '', 'Liquid Runway (Months)', '', 13.5];
    sumRows[20] = ['1. Cash', 'SAYE (Syfe / Bank)', 17978.30];
    sumRows[22] = ['2. Liquid Inv.', 'GSU — GOOG Vested', 327099.00];
    sumRows[23] = ['3. Earmarked', 'Kids Funds (Глаша + Тёма)', 227486.00];
    sumRows[24] = ['3. Retirement', 'SRS — STI ETF (DBS Vickers · 6,180 sh)', 35720.40];
    sumRows[35] = ['NET WORTH', 'Total Net Worth', 2387957];

    const srcWb = makeWorkbook({
      Summary: sumRows,
      Подписки: buildSubscriptionsFixtureRows(true)
    }, 'src-2026');

    const health = c.readPortfolioHealthStatus(srcWb, new Date('2026-11-28T10:00:00Z'));
    assert.ok(health);
    assert.equal(health.parents_liquid_sgd, 473326);
    assert.equal(health.gsu_vested_sgd, 327099);
    assert.equal(health.kids_earmarked_sgd, 227486);
    assert.equal(health.gsu_liquid_pct, 0.691);

    // Rollover carries YouTube Premium hiked price (31.98 in Col G) into 2027 Baseline (Col F) while preserving 2027 Col G formula
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };
    const dstSubsRows = buildSubscriptionsFixtureRows(false);
    dstSubsRows[9][6] = '=2027_LIVE_FORMULA';
    const dstWb = makeWorkbook({
      Transactions: [['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где', 'Заметки', '50/30/20']],
      Подписки: dstSubsRows
    }, 'dst-2027');

    const roll = c.syncYearEndRollover(srcWb, dstWb, { dryRun: false, activate: false, targetYear: 2027 });
    assert.equal(roll.status, 'synced');
    assert.equal(dstWb.getSheetByName('Подписки').getRange('F10').getValue(), 31.98);
    assert.equal(dstWb.getSheetByName('Подписки').getRange('G10').getFormula(), '=2027_LIVE_FORMULA');
  });
};
