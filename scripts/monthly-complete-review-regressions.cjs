const assert = require('node:assert/strict');
const {clock, date} = require('./monthly-coach-regressions.cjs');
module.exports = test => {
  const row = (amount, day, index, type = 'Расходы') => ({amount, date: '2026-08-' + day, row: index, type, category: 'Развлечения', merchant: 'Shop ' + index, account: 'DBS', monthIndex: 2026 * 12 + 7});
  test('complete review: includes crossing and every later charge, even small amounts, with refunds and recrossing', c => {
    const category = {name: 'Развлечения', target: 450, committed: 0, driver: 'ordinary'};
    const rows = [row(250, '01', 2), row(200, '02', 3), row(100, '03', 4), row(1, '03', 5), row(-200, '04', 6), row(50, '05', 7), row(60, '06', 8)];
    const result = c.monthlyThresholdTransactions(category, rows.reverse());
    assert.deepEqual(Array.from(result, item => item.row), [4, 5, 8]);
    assert.deepEqual(Array.from(result, item => item.crossing), [true, false, true]);
    assert.equal(result[2].over_target_portion, 11);
    assert.equal(c.monthlyThresholdTransactions({...category, driver: 'unresolved'}, rows).length, 0);
  });
  test('complete review: reserves commitments irrespective of payment date; no threshold list cap', c => {
    const rows = [row(400, '30', 1, 'Обязательные расходы'), ...Array.from({length: 40}, (_, i) => row(10, '01', i + 2))];
    const category = {name: 'Развлечения', target: 450, committed: 400, driver: 'ordinary'};
    assert.equal(c.monthlyThresholdTransactions(category, rows).length, 35);
    assert.equal(c.monthlyThresholdTransactions({...category, committed: 500}, rows).length, 40);
  });
  test('complete review: all over-target categories appear with their own transaction details', c => {
    const categories = Array.from({length: 6}, (_, i) => ({name: 'Category ' + i, actual: 200, target: 100}));
    const rows = categories.map((category, i) => ({...row(200, '01', i + 2), category: category.name}));
    const review = c.analyzeMonthlyReview(rows, '2026-08-31', {needs: {sub_categories: categories}, wants: {sub_categories: []}}, {months: [], unavailable: []}, {amount: 1000}, []);
    assert.equal(review.over_drivers.length, 6);
    review.over_drivers.forEach(category => {
      assert.equal(category.threshold_transactions.length, 1);
      assert.match(c.renderMonthlyOverrun(category), /• Расходы/);
      assert.match(c.renderMonthlyOverrun(category), /◦ Shop/);
    });
  });
  test('complete review: show up to three charges, otherwise show first crossing and summarize the rest', c => {
    const category = {name: 'Развлечения', target: 450, committed: 0, driver: 'ordinary', variance: 140, ordinary: 590, ordinary_gap: 140, structural_gap: 0};
    const rows = [row(450, '01', 1), row(100, '02', 2), row(10, '03', 3), row(20, '04', 4), row(10, '05', 5)];
    category.threshold_transactions = c.monthlyThresholdTransactions(category, rows.slice(0, 4));
    const short = c.renderMonthlyOverrun(category);
    assert.equal((short.match(/◦ Shop/g) || []).length, 3);
    assert.doesNotMatch(short, /After that/);
    category.threshold_transactions = c.monthlyThresholdTransactions(category, rows);
    const long = c.renderMonthlyOverrun(category);
    assert.match(long, /Shop 2 on 2026-08-02.*crossed the allowance; S\$100.00/);
    assert.doesNotMatch(long, /Shop [345]/);
    assert.match(long, /3 further charges totaling S\$40.00 \(2026-08-03–2026-08-05\)/);
  });
  test('complete review: summary retains recrossing charges after refunds without claiming a net gap', c => {
    const category = {name: 'Развлечения', target: 450, committed: 0, driver: 'ordinary', variance: 30, ordinary: 480, ordinary_gap: 30, structural_gap: 0};
    category.threshold_transactions = c.monthlyThresholdTransactions(category,
      [row(500, '01', 1), row(10, '02', 2), row(-100, '03', 3), row(50, '04', 4), row(20, '04', 5)]);
    const text = c.renderMonthlyOverrun(category);
    assert.match(text, /Shop 1 on 2026-08-01/);
    assert.match(text, /3 further charges totaling S\$80.00/);
    assert.match(text, /before refunds, not the net budget gap/);
  });
  test('complete review: large Unicode and HTML reports split without losing transactions or breaking markup', c => {
    const text = '<b>Category &amp; more</b>\n' + Array.from({length: 150}, (_, i) => '  ◦ ' + i + ' Магазин &amp; покупки S$123.00').join('\n');
    const parts = c.splitMonthlyReview(text);
    assert.ok(parts.length > 1); assert.equal(parts.join('\n'), text);
    parts.forEach(part => { assert.ok(part.length <= 2500); assert.ok(Buffer.byteLength(part) < 9000); assert.notEqual(c.monthlyCoachPlainText(part), null); });
    const huge = c.splitMonthlyReview('<b>' + '&amp;'.repeat(1500) + '</b>');
    assert.equal(huge.map(part => c.monthlyCoachPlainText(part)).join('').replace(/\n/g, ''), '&'.repeat(1500));
  });
  test('complete review: scheduled multipart retry resumes failed part using frozen content', c => {
    clock(c, '2026-08-31T15:30:00Z');
    c.LockService = {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})};
    const slot = c.getMonthEndDeliverySlot(date(c, '2026-08-31T15:30:00Z'));
    const sent = []; let fail = true;
    c.sendTelegramMessage = text => { if (text === 'part two' && fail) throw new Error('Rejected'); sent.push(text); };
    const key = 'month_end_2026-08_a_coach';
    assert.equal(c.deliverScheduledMessage(key, slot, 'a', () => ({parts: ['part one', 'part two', 'part three']}), key), false);
    assert.deepEqual(sent, ['part one']);
    assert.equal(c.PropertiesService.getScriptProperties().getProperty(key), null);
    fail = false; clock(c, '2026-08-31T15:45:00Z');
    assert.equal(c.deliverScheduledMessage(key, slot, 'a', () => { throw new Error('Must not rebuild frozen report'); }, key), true);
    assert.deepEqual(sent, ['part one', 'part two', 'part three']);
    assert.equal(c.PropertiesService.getScriptProperties().getProperty(key), 'sent');
    assert.equal(c.PropertiesService.getScriptProperties().getProperty('parts_' + key + '_2026-08_count'), null);
  });
};
