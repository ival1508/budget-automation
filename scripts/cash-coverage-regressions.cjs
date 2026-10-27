const assert = require('node:assert/strict');
const vm = require('node:vm');
const { clock, date } = require('./monthly-coach-regressions.cjs');

const tx = (day, amount, category, merchant = '', type = 'Обязательные расходы') =>
  [day, 'DBS SGD', type, amount, amount, '', '', category, merchant];
const snapshot = () => ({ asOf: '2026-10-28', balances: [-1000, 100, 5000], ordinarySgd: 1000,
  plans: [['НКО', 100], ['Школа & Детский сад', 1000], ['Родители', 181], ['Отложения', 500], ['CPF', 4880]],
  ledger: [tx('2026-10-01', 70, 'НКО'), tx('2026-10-02', -20, 'НКО'),
    tx('2026-10-03', 600, 'Школа & Детский сад'), tx('2026-10-29', 250, 'Школа & Детский сад'),
    tx('2026-10-05', 181, 'Дом', '[Родители] Amazon.sg'), tx('2026-09-30', 1000, 'Отложения'),
    tx('2026-10-06', 999, 'Школа & Детский сад', '', 'Расходы')] });

function readerFixture(c, epoch = '2026-10-28T00:00:00Z') {
  clock(c, epoch);
  const rows = c.buildCashCoverageRows('original');
  const values = { B2: "Октябрь'26", B8: 46323, B25: 3000 };
  const state = { amount: -123.45, formula: c.buildCashCoverageFormula(), timezone: 'Asia/Singapore' };
  const config = { getRange: a1 => a1 === 'A1:F25'
    ? { getFormulas: () => rows.map(row => row.map(value => typeof value === 'string' && value.startsWith('=') ? value : '')) }
    : { getValue: () => values[a1] } };
  const months = {
    "Октябрь'26": { getRange: () => ({ getValue: () => 46296 }) },
    'Ноябрь': { getRange: () => ({ getValue: () => 46327 }) }
  };
  const summary = { getRange: () => ({ getValue: () => state.amount, getFormula: () => state.formula }) };
  const ss = { getSpreadsheetTimeZone: () => state.timezone,
    getSheetByName: name => name === 'Summary' ? summary : name === 'CashCoverage' ? config : months[name] || null };
  return { ss, state, values, rows, months, config, summary };
}

module.exports = test => {
  test('cash coverage includes all unpaid plans, excludes CPF, respects refunds/date/type and explicit parent tags', c => {
    const s = snapshot(), result = c.calculateCashCoverage(s);
    assert.equal(result.amount_sgd, 2150);
    assert.deepEqual(Array.from(result.components, x => [x.category, x.unpaid_sgd]),
      [['НКО', 50], ['Школа & Детский сад', 400], ['Родители', 0], ['Отложения', 500]]);
    s.plans.push(['Дом', 300]);
    assert.equal(c.calculateCashCoverage(s).components.find(x => x.category === 'Дом').unpaid_sgd, 300);
  });
  test('cash coverage does not double-count a card purchase or its later settlement', c => {
    const s = snapshot(), before = c.calculateCashCoverage(s).amount_sgd;
    s.ledger.push(tx('2026-10-28', 100, 'Школа & Детский сад'));
    s.balances[0] -= 100;
    assert.equal(c.calculateCashCoverage(s).amount_sgd, before);
    s.balances[0] += 500; s.balances[2] -= 500;
    assert.equal(c.calculateCashCoverage(s).amount_sgd, before);
    s.balances[2] += 1000;
    assert.equal(c.calculateCashCoverage(s).amount_sgd, before + 1000);
  });
  test('cash coverage refuses unreadable financial inputs, duplicate plans and malformed payment dates', c => {
    for (const value of ['', null, false, '#VALUE!', NaN, Infinity]) {
      const s = snapshot(); s.balances[0] = value;
      assert.throws(() => c.calculateCashCoverage(s), /Unreadable/);
    }
    const s = snapshot(); s.plans.push(['НКО', 20]);
    assert.throws(() => c.calculateCashCoverage(s), /duplicate/);
    s.plans.pop(); s.ledger.push(tx('unknown', 20, 'НКО'));
    assert.throws(() => c.calculateCashCoverage(s), /Invalid.*date/);
  });
  test('cash coverage reader validates the current month even when November already exists', c => {
    const f = readerFixture(c), result = c.readCashCoverage(f.ss);
    assert.equal(result.status, 'available'); assert.equal(result.amount_sgd, -123.45);
    assert.equal(result.month_tab, "Октябрь'26"); assert.equal(result.source, 'Summary!E4');
    assert.equal(result.as_of, '2026-10-28T00:00:00.000Z');
    clock(c, '2026-10-31T16:00:00Z');
    f.values.B2 = 'Ноябрь'; f.values.B8 = 46327;
    assert.equal(c.readCashCoverage(f.ss).month_tab, 'Ноябрь');
    assert.equal(c.readCashCoverage(f.ss).status, 'available');
    f.state.formula = f.state.formula.replaceAll('CashCoverage!', "'CashCoverage'!");
    assert.equal(c.readCashCoverage(f.ss).status, 'available');
    f.values.B2 = "Октябрь'26";
    assert.equal(c.readCashCoverage(f.ss).status, 'unavailable');
  });
  test('cash coverage reader never reports stale, edited, ambiguous or unreadable results as zero', c => {
    const f = readerFixture(c);
    for (const value of ['', false, null, '#N/A', NaN, Infinity]) {
      f.state.amount = value; const result = c.readCashCoverage(f.ss);
      assert.equal(result.status, 'unavailable'); assert.equal(result.amount_sgd, null);
    }
    f.state.amount = 0; assert.equal(c.readCashCoverage(f.ss).amount_sgd, 0);
    f.state.formula = '=0'; assert.equal(c.readCashCoverage(f.ss).status, 'unavailable');
    f.state.formula = c.buildCashCoverageFormula();
    f.values.B8 -= 1; assert.equal(c.readCashCoverage(f.ss).status, 'unavailable'); f.values.B8 += 1;
    f.months['Октябрь'] = f.months["Октябрь'26"];
    assert.match(c.readCashCoverage(f.ss).reason, /Multiple/); delete f.months['Октябрь'];
    f.rows[1][1] = '=0'; assert.match(c.readCashCoverage(f.ss).reason, /managed/);
  });
  test('cash coverage accepts native formula separator normalization while preserving quoted text', c => {
    const f = readerFixture(c);
    f.state.formula = f.state.formula.replaceAll(';', ',');
    f.rows.forEach(row => row.forEach((v, i) => { if (typeof v === 'string' && v.startsWith('=')) row[i] = v.replaceAll(';', ','); }));
    assert.equal(c.readCashCoverage(f.ss).status, 'available');
    assert.notEqual(c.cashCoverageFormulaIdentity('=IF(A1;"A, B";0)'), c.cashCoverageFormulaIdentity('=IF(A1;"A;B";0)'));
  });
  test('cash coverage rendering distinguishes positive, zero, negative and unavailable settlement from daily allowance', c => {
    const base = { period: 'daily', cumulative_today: 50, realistic_daily: 75, days_left_in_month: 3, categories_over_target: [] };
    for (const amount of [-123.45, 0, 456.78]) {
      const payload = { ...base, cash_coverage: { status: 'available', amount_sgd: amount } };
      const text = c.buildFallbackCoachBrief(payload);
      assert.match(text, /S\$75\.00/); assert.equal((text.match(/<b>Settlement:/g) || []).length, 1);
      if (amount < 0) { assert.match(text, /S\$123\.45.*shortfall/); assert.match(text, /Arrange funding or a transfer/); }
      if (amount === 0) assert.match(text, /Fully allocated.*S\$0\.00/);
      if (amount > 0) assert.match(text, /S\$456\.78.*after reserved commitments/);
    }
    const payload = { ...base, cash_coverage: { status: 'unavailable', amount_sgd: null } };
    assert.match(c.buildFallbackCoachBrief(payload), /Coverage unavailable/);
    assert.doesNotMatch(c.buildFallbackCoachBrief(payload), /S\$0\.00/);
  });
  test('daily model and missing-key fallback both include deterministic coverage; monthly output stays separate', c => {
    const payload = { period: 'daily', cumulative_today: 50, realistic_daily: 75, days_left_in_month: 3,
      cash_coverage: { status: 'available', amount_sgd: -123.45 } };
    assert.match(c.generateCoachBrief(payload), /S\$123\.45.*shortfall/);
    c.PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', 'offline');
    let sent;
    c.callGeminiApiWithRetry = api => {
      sent = JSON.parse(api.contents[0].parts[0].text);
      return { text: JSON.stringify({ candidates: [{ content: { parts: [{ text: '• <b>Pace:</b> S$75 per day.\n• <b>Action:</b> Keep spending within the allowance.' }] } }] }) };
    };
    const brief = c.generateCoachBrief(payload);
    assert.equal(sent.cash_coverage, undefined); assert.match(brief, /S\$123\.45.*shortfall/);
    assert.equal(c.appendDailyCashCoverage('Monthly', { ...payload, period: 'monthly' }), 'Monthly');
  });
  test('cash coverage migration recognizes only audited formulas and produces a complete native plan', c => {
    const source = "'Октябрь''26'!";
    const original = '=D4-(-D2-D3+(' + source + 'E6-70,8)+' + source + 'E7-300+343+390+' + source + 'E12+' + source + 'L33+2000)';
    assert.equal(c.inspectLegacyCashCoverageFormula(original, "Октябрь'26").extra_reserve_sgd, 2000);
    assert.throws(() => c.inspectLegacyCashCoverageFormula('=D4-1000', "Октябрь'26"), /Unrecognized/);
    const rows = c.buildCashCoverageRows(original);
    assert.equal(rows.length, 25); assert.equal(JSON.parse(rows[10][1]).formula, original);
    assert.ok(rows.every(row => row.length === 6));
    assert.ok(rows[13][0].includes('D3')); assert.ok(rows[23][0].includes('D13'));
    assert.ok(c.buildCashCoverageMonthFormula().includes('oldexists+newexists<>1'));
  });
  test('cash coverage protects deposited salary for next month and cannot turn budget overspend into cash', c => {
    const s = snapshot(), before = c.calculateCashCoverage(s).amount_sgd;
    s.ledger.push(tx('2026-10-28', 3000, 'Salary', 'Google', 'Доходы'));
    s.balances[2] += 3000;
    assert.equal(c.calculateCashCoverage(s).amount_sgd, before);
    assert.equal(c.calculateCashCoverage(s).reserved_next_month_income_sgd, 3000);
    s.ordinarySgd = -200;
    assert.equal(c.calculateCashCoverage(s).remaining_ordinary_budget_sgd, 0);
    assert.equal(c.calculateCashCoverage(s).amount_sgd, before + 1000);
  });
  test('Niseko deficit remains S$24300 after S$30900 next-month payroll lands; regular costs stay funded', c => {
    const s = { asOf: '2026-10-28', balances: [0, -24300, 35900], ordinarySgd: 4000,
      plans: [['Отложения', 1000], ['CPF', 4880]],
      ledger: [tx('2026-10-17', 13185, 'Отдых', 'Niseko Portfolio', 'Большие расходы'),
        tx('2026-10-17', 11115, 'Отдых', 'Niseko Portfolio', 'Большие расходы'),
        tx('2026-10-22', 30900, 'Дом', 'Google за октябрь', 'Доходы')] };
    assert.equal(c.calculateCashCoverage(s).amount_sgd, -24300);
    assert.equal(c.calculateCashCoverage(s).reserved_next_month_income_sgd, 30900);
    s.balances[1] = 0;
    assert.equal(c.calculateCashCoverage(s).amount_sgd, 0); // Everything except Niseko is funded.
    s.balances[1] = -24300;
    s.ledger.pop(); s.balances[2] -= 30900;
    assert.equal(c.calculateCashCoverage(s).amount_sgd, -24300); // Payday did not fund the extraordinary cost.
    s.balances[2] += 24300;
    assert.equal(c.calculateCashCoverage(s).amount_sgd, 0); // An actual savings-funded transfer closes the gap.
  });
  test('next-month reserve uses received regular DBS payroll only and releases it on calendar rollover', c => {
    const rows = [tx('2026-10-22', 30900, 'Дом', 'Google', 'Доходы'),
      tx('2026-10-27', 12519, 'Дом', 'Kaspersky', 'Доходы'),
      tx('2026-10-28', -19, 'Дом', 'Kaspersky correction', 'Доходы'),
      tx('2026-10-31', 500, 'Дом', 'Google', 'Доходы'),
      tx('2026-09-24', 1000, 'Дом', 'Google', 'Доходы'),
      tx('2026-10-22', 2000, 'Дом', 'Google', 'Доходы - премия'),
      tx('2026-10-22', 100, 'Дом', 'Google Dividends', 'Доходы - лёгкие деньги')];
    const otherAccount = tx('2026-10-23', 1000, 'Дом', 'Google', 'Доходы'); otherAccount[1] = 'Other bank'; rows.push(otherAccount);
    assert.equal(c.calculateNextMonthIncomeReserve(rows, '2026-10-28'), 43400);
    assert.equal(c.calculateNextMonthIncomeReserve(rows, '2026-11-01'), 0);
    const invalid = tx('2026-10-24', '#VALUE!', 'Дом', 'Google', 'Доходы');
    assert.throws(() => c.calculateNextMonthIncomeReserve([...rows, invalid], '2026-10-28'), /Unreadable/);
    assert.throws(() => c.calculateNextMonthIncomeReserve([tx('2026-10-22', 1000, 'Дом', 'Google Kaspersky', 'Доходы')], '2026-10-28'), /Ambiguous/);
  });
  test('daily shortfall retains its funding-period explanation and rejects an unavailable reserve', c => {
    const f = readerFixture(c), coverage = c.readCashCoverage(f.ss);
    assert.equal(coverage.reserved_next_month_income_sgd, 3000);
    const line = c.appendDailyCashCoverage('', { period: 'daily', cash_coverage: coverage });
    assert.match(line, /shortfall.*next month's salary remains reserved/);
    f.values.B25 = '#N/A'; assert.equal(c.readCashCoverage(f.ss).status, 'unavailable');
  });
};
