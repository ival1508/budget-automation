const assert = require('node:assert/strict');
const vm = require('node:vm');
const { fixture, date, clock } = require('./monthly-coach-regressions.cjs');
module.exports = test => {
  test('Stage 5: ISO dates count ordinary spend; blank SGD and malformed dates fail closed', c => {
    const report = date(c, '2026-09-30T12:00:00Z');
    const f = fixture(c);
    f.matrices.Transactions[1][0] = '2026-09-01';
    assert.equal(c.buildCoachPayload('monthly', f.ss, report).volatile_categories[0].actual, 300);
    for (const damage of [
      f => { f.matrices.Transactions[1][4] = ''; },
      f => { f.matrices.Transactions[1][0] = '31.09.2026'; },
      f => { f.matrices.Transactions[1][7] = ''; },
      f => { f.matrices['50/30/20'][0][30] = '#REF!'; },
      f => { f.matrices['50/30/20'][2][3] = ''; },
      f => { delete f.sheets.Transactions; }
    ]) {
      const damaged = fixture(c); damage(damaged);
      const payload = c.buildCoachPayload('monthly', damaged.ss, report);
      assert.equal(payload.error, 'monthly_read_error');
      assert.match(c.generateMonthlyCoachBrief(payload), /unavailable/);
      assert.equal(payload.buckets, undefined);
    }
  });
  test('Stage 5: all monthly readers share one anchor, including a clock change during reading', c => {
    clock(c, '2026-09-30T15:59:00Z');
    const f = fixture(c), report = date(c, '2026-09-30T15:59:00Z');
    for (const name of ['get503020Status', 'getMandatoryExpenses', 'getLoggedMandatoryThisMonth', 'getCurrentMonthCategorySplits']) {
      const original = c[name];
      c[name] = (...args) => {
        assert.equal(args[0], f.ss); assert.equal(args[name === 'get503020Status' ? 2 : 1], report);
        clock(c, '2026-09-30T16:01:00Z'); return original(...args);
      };
    }
    const payload = c.buildCoachPayload('monthly', f.ss, report);
    assert.equal(payload.report_month, '2026-09'); assert.equal(payload.error, undefined);
    assert.deepEqual(Array.from(payload.volatile_categories, row => row.actual), [300, 30, 15, 25]);
  });
  test('Stage 5: no discretionary activity produces no focus, while refunds reduce ordinary totals', c => {
    const f = fixture(c), report = date(c, '2026-09-30T12:00:00Z');
    f.matrices.Transactions.push(['20.09.2026', 'DBS SGD', 'Расходы', -50, -50, '', '', 'Рестораны', '', '', '']);
    assert.equal(c.buildCoachPayload('monthly', f.ss, report).volatile_categories[0].actual, 250);
    f.matrices.Transactions.forEach(row => { if (row[2] === 'Расходы') row[2] = 'Доходы'; });
    const payload = c.buildCoachPayload('monthly', f.ss, report);
    assert.equal(payload.category_focus, null);
    assert.ok(payload.volatile_categories.every(item => item.actual === 0));
    assert.equal(c.monthlyCoachBriefIsGrounded(c.buildFallbackMonthlyBrief(payload), payload), true);
  });
  test('Stage 5: percentages above 100% are read as fractions; financial fields round to cents', c => {
    const f = fixture(c), report = date(c, '2026-09-30T12:00:00Z');
    f.matrices['50/30/20'][2][3] = 1.25;
    f.matrices['50/30/20'][2][2] = 3500.12345;
    f.matrices['50/30/20'][5][2] = 700.12345;
    const payload = c.buildCoachPayload('monthly', f.ss, report);
    assert.equal(payload.buckets.needs.actual_percent, '125.0%');
    assert.equal(payload.buckets.needs.actual, 3500.12);
    assert.equal(payload.category_focus.actual, 700.12);
  });
  test('Stage 5: model cannot swap category amounts, add categories, contradictory counts or trend claims', c => {
    const f = fixture(c), payload = c.buildCoachPayload('monthly', f.ss, date(c, '2026-09-30T12:00:00Z'));
    delete payload.monthly_review; // Legacy model-response compatibility.
    const good = c.buildFallbackMonthlyBrief(payload);
    for (const bad of [
      good.replace('finished at S$700.00', 'finished at S$3,500.00'),
      good.replace('including S$300.00', 'including S$500.00'),
      good.replace('next month.', 'next month; Дом also needs cuts.'),
      good.replace('next month.', 'next month; 2 unpaid and 0 unpaid.'),
      good.replace('next month.', 'next month; spending improved.'),
      good.replace('next month.', 'next month; bills were missed.'),
      good.replace('next month.', 'next month; rent must be cut.'),
      good.replace('next month.', 'tomorrow.'),
      good.replace('<b>', '<b style="color:red">'),
      good.replace('</b>', '</i>')
    ]) assert.equal(c.monthlyCoachBriefIsGrounded(bad, payload), false, bad);
    // Verify the shared engine falls back, not merely the helper's return value.
    c.PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', 'offline-test');
    c.callGeminiApiWithRetry = () => ({text: JSON.stringify({candidates: [{content: {parts: [{text: good.replace('including S$300.00', 'including S$500.00')}]}}]})});
    assert.equal(c.generateMonthlyCoachBrief(payload), good);
  });
  test('Stage 5: escaped target-header text survives validation and menu preview sends nothing', c => {
    clock(c, '2026-10-01T01:00:00Z'); const f = fixture(c);
    f.matrices['50/30/20'][0][30] = 'Target month & family plan';
    c.sendTelegramMessage = () => { throw new Error('Preview must not send'); };
    let shown = '';
    c.SpreadsheetApp.getUi = () => ({alert: text => { shown = text; }});
    const result = c.showMonthlyCoachPreview();
    assert.equal(result.payload.report_month, '2026-09');
    assert.match(shown, /Target month & family plan/); assert.doesNotMatch(shown, /<b>/);
    assert.equal(c.monthlyCoachBriefIsGrounded(result.brief, result.payload), true);
    assert.equal(c.PropertiesService.getScriptProperties().getProperty('month_end_2026-09_96069960_coach'), null);
  });
  test('Stage 5: actual December payload is regenerated across midnight without January leakage', c => {
    clock(c, '2026-12-31T15:30:00Z'); const f = fixture(c), sends = [];
    c.LockService = {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})};
    c.scanConfiguredStatementInbox = () => {};
    vm.runInContext('SHEET_FACTS.USERS.RITA.active = false', c);
    let fail = true;
    c.sendTelegramMessage = text => {
      if (!text.includes('upload the bank statements') && fail) throw new Error('Rejected');
      sends.push(text);
    };
    c.dispatch(); assert.equal(sends.length, 1);
    f.matrices['50/30/20'][2][10] = 4321; // December changes before the retry.
    f.matrices['50/30/20'][2][6] = 9999; // January must not leak into the retrospective.
    fail = false; clock(c, '2026-12-31T16:15:00Z'); c.dispatch(); c.dispatch();
    assert.equal(sends.length, 2); assert.match(sends[1], /Декабрь'26/);
    assert.match(sends[1], /Расходы finished/); assert.doesNotMatch(sends[1], /9,999/);
    assert.equal(c.buildCoachPayload('monthly', f.ss, date(c, '2026-12-31T15:30:00Z')).buckets.needs.actual, 4321);
    assert.equal(c.PropertiesService.getScriptProperties().getProperty('month_end_2026-12_96069960_coach'), 'sent');
    clock(c, '2026-12-31T18:30:00Z'); c.dispatch(); assert.equal(sends.length, 2);
  });
};
