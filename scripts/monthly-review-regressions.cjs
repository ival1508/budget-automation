const assert = require('node:assert/strict');
const { fixture, date } = require('./monthly-coach-regressions.cjs');
module.exports = test => {
  const report = '2026-09-30';
  const index = 2026 * 12 + 8;
  const transaction = (amount, category = 'Развлечения', extra = {}) => ({row: 2, monthIndex: index,
    date: '2026-09-15', merchant: 'Concert', account: 'DBS', category, amount, type: 'Расходы', ...extra});
  const category = (name, actual, target) => ({name, actual, target});
  const budget = categories => ({needs: {sub_categories: []}, wants: {sub_categories: categories}});
  const history = (values, name = 'Развлечения') => ({unavailable: [], months: values.map((actual, i) => ({
    month: `2026-0${i+4}`, monthIndex: index - 5 + i, ordinary: actual, categories: [category(name, actual, 100)]}))});
  const analyze = (c, rows, categories, past = history([]), plan = 500, plans = []) =>
    c.analyzeMonthlyReview(rows, report, budget(categories), past, {amount: plan, source: 'D15'}, plans);
  test('monthly review: Расходы is net ordinary spend, and D15 is the monthly cap', c => {
    const rows = [transaction(400), transaction(-50, 'Развлечения', {merchant: 'Refund'}),
      transaction(1000, 'Квартира', {type: 'Обязательные расходы'}), transaction(900, 'Развлечения', {monthIndex: index + 1})];
    const result = analyze(c, rows, [category('Развлечения', 350, 100)]);
    assert.equal(result.ordinary_total, 350); assert.equal(result.ordinary_variance, -150);
    assert.equal(analyze(c, rows, [], history([]), null).ordinary_variance, null);
    const f = fixture(c); f.matrices["Сентябрь'26"][14][3] = 1000; f.matrices["Сентябрь'26"][16][3] = 9999;
    const payload = c.buildCoachPayload('monthly', f.ss, date(c, '2026-09-30T12:00:00Z'));
    assert.equal(payload.monthly_review.ordinary_plan.amount, 1000);
    assert.equal(payload.monthly_review.ordinary_total, 370);
    assert.equal(payload.monthly_review.ordinary_variance, -630);
  });
  test('monthly review: single purchase can explain an overrun only when ledger reconciles', c => {
    const rows = [transaction(400), transaction(50, 'Развлечения', {row: 3, merchant: 'Cafe'})];
    const result = analyze(c, rows, [category('Развлечения', 450, 100)]);
    assert.equal(result.purchases[0].merchant, 'Concert');
    assert.equal(result.purchases[0].explains_overrun, true); assert.equal(result.purchases[0].without_purchase, 50);
    const mismatch = analyze(c, rows, [category('Развлечения', 800, 100)]);
    assert.equal(mismatch.purchases.length, 0);
  });
  test('monthly review: large contributors are not falsely described as the sole cause', c => {
    const rows = [transaction(200), transaction(200, 'Развлечения', {row: 3, merchant: 'Tickets'})];
    const result = analyze(c, rows, [category('Развлечения', 400, 100)]);
    assert.equal(result.purchases[0].contributes_overrun, true);
    assert.equal(result.purchases[0].explains_overrun, false);
    assert.equal(result.purchases[0].category_overrun, 300);
  });
  test('monthly review: own-history outlier threshold needs five purchases and excludes refunded merchants', c => {
    const older = Array.from({length: 5}, (_, i) => transaction(20, 'Дом', {monthIndex: index - 1, row: i + 10}));
    const rows = [...older, transaction(200, 'Дом')];
    const result = analyze(c, rows, [category('Дом', 200, 500)]);
    assert.equal(result.purchases[0].unusually_large, true); assert.equal(result.purchases[0].typical_purchase, 20);
    assert.equal(analyze(c, rows.slice(1), [category('Дом', 200, 500)]).purchases.length, 0);
    rows.push(transaction(-200, 'Дом'));
    assert.equal(analyze(c, rows, [category('Дом', 0, 500)]).purchases.length, 0);
  });
  test('monthly review: positive evidence excludes savings, unpaid commitments and immaterial headroom', c => {
    const rows = [transaction(100, 'Продукты'), transaction(50, 'Отдых'), transaction(99, 'Подарки')];
    const result = analyze(c, rows, [category('Продукты', 100, 500), category('Отдых', 50, 2000), category('Подарки', 99, 100)], history([]), 500,
      [{label: 'Отдых', amount: 2000}]);
    assert.deepEqual(Array.from(result.discipline, row => row.name), ['Продукты']);
  });
  test('monthly review: recurring target recommendations require sufficient history and a material gap', c => {
    const rows = [transaction(600)];
    const categories = [category('Развлечения', 600, 100)];
    const check = values => {
      const past = history(values);
      const earlier = past.months.map(month => transaction(month.ordinary, 'Развлечения', {monthIndex: month.monthIndex}));
      return analyze(c, [...rows, ...earlier], categories, past);
    };
    assert.equal(check([400, 450]).recommendations.length, 0);
    const recurring = check([400, 450, 500]);
    assert.equal(recurring.recommendations[0].kind, 'recurring');
    assert.equal(recurring.recommendations[0].ordinary_baseline, 450);
    assert.equal(recurring.recommendations[0].above_current_target, 3);
    assert.equal(check([101, 105, 110]).recommendations.length, 0);
    assert.equal(check([50, 70, 90]).recommendations[0].kind, 'one_off');
  });
  test('monthly review: blank historical category values do not invent low-spend months', c => {
    const past = history([10, 20, 30]);
    past.months[0].categories[0].actual_available = false;
    const result = analyze(c, [transaction(500)], [category('Развлечения', 500, 100)], past);
    assert.equal(result.recommendations.length, 0);
    const missingCurrent = category('Развлечения', 0, 500); missingCurrent.actual_available = false;
    assert.equal(analyze(c, [transaction(100)], [missingCurrent]).discipline.length, 0);
  });
  test('monthly review: committed-first attribution distinguishes structural and adjustable gaps', c => {
    const classify = (committed, ordinary, target, reconciled = true) => c.classifyMonthlyOverrun({committed, ordinary, target, actual: committed + ordinary, variance: committed + ordinary - target, reconciled});
    assert.equal(classify(500, 0, 400).driver, 'structural');
    const mixed = classify(500, 200, 400);
    assert.equal(mixed.driver, 'mixed_structural'); assert.equal(mixed.structural_gap, 100); assert.equal(mixed.ordinary_gap, 200);
    const adjustable = classify(350, 150, 400);
    assert.equal(adjustable.structural_gap, 0); assert.equal(adjustable.ordinary_gap, 100);
    assert.equal(classify(500, 200, 400, false).driver, 'unresolved');
    assert.equal(classify(-100, 800, 400).driver, 'unresolved');
  });
  test('monthly review: target updates retain mandatory baselines and require reconciled history', c => {
    const past = history([800, 900, 1000], 'Школа & Детский сад');
    const rows = past.months.flatMap((month, i) => [
      transaction(700 + i * 100, 'Школа & Детский сад', {monthIndex: month.monthIndex, type: 'Обязательные расходы'}),
      transaction(100, 'Школа & Детский сад', {monthIndex: month.monthIndex})
    ]);
    const categories = [{name: 'Школа & Детский сад', actual: 1000, target: 500, variance: 500, committed: 800, ordinary: 200, reconciled: true}];
    const result = c.buildMonthlyTargetRecommendations(categories, rows, past);
    assert.equal(result.length, 1); assert.equal(result[0].mandatory_baseline, 800); assert.equal(result[0].ordinary_baseline, 100);
    assert.equal(result[0].suggested_target, 900); assert.equal(result[0].structural, true);
    const text = c.renderMonthlyTargetRecommendation(result[0]);
    assert.match(text, /Обязательные расходы.*S\$800.00/); assert.match(text, /Расходы.*S\$100.00/);
    categories[0].committed = 400;
    const changed = c.buildMonthlyTargetRecommendations(categories, rows, past)[0];
    assert.equal(changed.kind, 'changed_commitment'); assert.equal(changed.suggested_target, 500);
    assert.match(c.renderMonthlyTargetRecommendation(changed), /If this new level is confirmed/);
    rows[0].amount += 10;
    assert.equal(c.buildMonthlyTargetRecommendations(categories, rows, past).length, 0);
  });
  test('monthly review: missing historical months are not zeroes, and current/future data do not enter baseline', c => {
    const f = fixture(c), reportDate = date(c, '2026-09-30T12:00:00Z');
    const payload = c.buildCoachPayload('monthly', f.ss, reportDate);
    assert.equal(payload.monthly_review.history.months.length, 0);
    assert.equal(payload.monthly_review.history.unavailable.length, 5);
    assert.equal(payload.monthly_review.history.ordinary_median, null);
    const text = c.generateMonthlyCoachBrief(payload);
    assert.match(text, /Fewer than three/); assert.match(text, /no longer-term spending trend/);
  });
  test('monthly review: visible narrative changes with evidence, escapes merchants, and never invokes the old model recital', c => {
    const f = fixture(c), reportDate = date(c, '2026-09-30T12:00:00Z');
    f.matrices["Сентябрь'26"][14][3] = 300;
    f.matrices['50/30/20'][5][2] = 300; f.matrices['50/30/20'][5][30] = 150;
    f.matrices.Transactions[2][8] = '<Dinner & drinks>';
    c.callGeminiApiWithRetry = () => { throw new Error('No ungrounded narration call allowed'); };
    const payload = c.buildCoachPayload('monthly', f.ss, reportDate);
    const text = c.generateMonthlyCoachBrief(payload);
    assert.match(text, /S\$70.00 over/); assert.match(text, /&lt;Dinner &amp; drinks&gt;/);
    assert.ok(text.indexOf('<b>Рестораны</b>') < text.indexOf('&lt;Dinner'));
    assert.match(text, /◦ &lt;Dinner/);
    assert.match(text, /crossed the allowance; S\$150.00/); assert.doesNotMatch(text, /Needs S\$.*vs/);
    assert.equal(c.monthlyCoachBriefIsGrounded(text, payload), true);
    assert.equal(c.monthlyCoachBriefIsGrounded(text.replace('70.00', '999.00'), payload), false);
    assert.equal(c.coachMoneyIsGrounded(text, payload), true);
    assert.notEqual(c.monthlyCoachPlainText(text), null);
    assert.ok(text.length < 4096);
  });
};
