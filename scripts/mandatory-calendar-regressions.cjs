const assert = require('node:assert/strict');
const vm = require('node:vm');
const { clock, date } = require('./monthly-coach-regressions.cjs');
const entry = (item, day, amount = 100, category = 'Квартира', account = 'DBS') =>
  ({ item, expected_day_of_month: day, typical_amount: amount, category, account });
const payment = (item, amount = 100, category = 'Квартира', account = 'DBS') => ({ item, amount, category, account });
const plan = (name = 'Квартира', amount = 1000) => ({ name, amount });
function workbook(c) {
  const matrices = {
    Calendar: [['item', 'category', 'expected_day_of_month', 'typical_amount', 'account', 'active'],
      ['Mortgage',  'Квартира', 1, 100, 'DBS', true], ['Rent', 'Квартира', 10, 200, 'Citi', true],
      ['IRAS', 'Налоги', 6, 50, 'DBS', false]],
    Transactions: [Array(11).fill('header'),
      ['01.09.2026', 'DBS', 'Обязательные расходы', 100, 100, '', '', 'Квартира', 'Bank mortgage'],
      ['10.08.2026', 'Citi', 'Обязательные расходы', 200, 200, '', '', 'Квартира', 'Rent'],
      ['10.09.2026', 'Citi', 'Расходы', 200, 200, '', '', 'Квартира', 'Rent'],
      ['20.09.2026', 'Citi', 'Обязательные расходы', 200, 200, '', '', 'Квартира', 'Rent']],
    "Сентябрь'26": [['Квартира', 300, '', true], ['Налоги', 50, '', false]]
  };
  const ss = {getSheetByName: name => {
    const cells = matrices[name];
    if (!cells) return null;
    return {getLastRow: () => cells.length, getLastColumn: () => 11,
      getRange: (r, col, height = 1, width = 1) => {
        const values = typeof r === 'string' ? cells : Array.from({length: height}, (_, i) =>
          Array.from({length: width}, (_, j) => cells[r - 1 + i]?.[col - 1 + j] ?? ''));
        return {getValues: () => values, getDisplayValues: () => values.map(row => row.map(String))};
      }};
  }};
  return {ss, matrices};
}
module.exports = test => {
  test('Stage 4C: ordered overdue/upcoming sets, partial amounts and current-month window', c => {
    const items = [entry('Late', 20, 100, 'Налоги'), entry('Tomorrow', 17, 100, 'Авто'),
      entry('Yesterday', 15), entry('Today', 16, 100, 'Лин'), entry('Later', 23, 100, 'НКО')];
    const result = c.evaluateMandatoryCalendar(items, [payment('Yesterday', 40)], [plan()], '2026-09-16');
    assert.deepEqual(Array.from(result.overdue, item => item.item), ['Yesterday']);
    assert.equal(result.overdue[0].remaining, 60);
    assert.deepEqual(Array.from(result.dueThisWeek, item => item.item), ['Today', 'Tomorrow', 'Late']);
    assert.equal(result.dueToday.length, 1); assert.equal(result.later.length, 1);
    const html = c.formatMandatoryCalendarBrief(result);
    assert.ok(html.indexOf('Overdue') < html.indexOf('Due this week'));
    assert.doesNotMatch(html, /All clear/);
  });
  test('Stage 4C: single category/account matches mapped category regardless of description', c => {
    const result = c.evaluateMandatoryCalendar([entry('Mortgage', 1)], [payment('GIRO home loan')], [plan()], '2026-09-16');
    assert.equal(result.paid.length, 1); assert.equal(result.overdue.length, 0);
    assert.match(c.formatMandatoryCalendarBrief(result), /All clear/);
    const wrong = c.evaluateMandatoryCalendar([entry('Auto', 1, 100, 'Авто')], [payment('Auto', 100, 'Транспорт')], [plan()], '2026-09-16');
    assert.equal(wrong.overdue.length, 1);
  });
  test('Stage 4C: two same-category obligations require distinct item matches; no payment reuse', c => {
    const items = [entry('Mortgage', 1), entry('Rent', 10)];
    const result = c.evaluateMandatoryCalendar(items, [payment(' mortgage ')], [plan()], '2026-09-16');
    assert.equal(result.paid.length, 1); assert.equal(result.overdue[0].item, 'Rent');
    const ambiguous = c.evaluateMandatoryCalendar(items, [payment('Housing', 200)], [plan()], '2026-09-16');
    assert.equal(ambiguous.review.length, 2); assert.equal(ambiguous.paid.length, 0); assert.equal(ambiguous.overdue.length, 0);
    assert.doesNotMatch(c.formatMandatoryCalendarBrief(ambiguous), /All clear/);
    assert.throws(() => c.evaluateMandatoryCalendar([entry('Rent', 1), entry('rent', 10)], [], [plan()], '2026-09-16'), /Duplicate/);
  });
  test('Stage 4C: account separation, split payments, refunds and ambiguous refunds', c => {
    const items = [entry('Rent', 1), entry('Rent', 1, 100, 'Квартира', 'Citi')];
    const result = c.evaluateMandatoryCalendar(items, [payment('Rent', 60), payment('Rent', 60), payment('Rent', -30)], [plan()], '2026-09-16');
    assert.equal(result.overdue.length, 2); assert.equal(result.overdue.find(item => item.account === 'DBS').remaining, 10);
    assert.equal(result.overdue.find(item => item.account === 'Citi').actual, 0);
    const ambiguous = c.evaluateMandatoryCalendar([entry('Rent', 1), entry('Mortgage', 1)],
      [payment('Rent', 100), payment('Mortgage', 100), payment('Unknown refund', -100)], [plan()], '2026-09-16');
    assert.equal(ambiguous.review.length, 2); assert.equal(ambiguous.paid.length, 0);
  });
  test('Stage 4C: EOM, 31-day clamping, leap years and year rollover', c => {
    for (const [anchor, last] of [['2024-02-28', 29], ['2025-02-28', 28], ['2026-04-30', 30], ['2026-12-31', 31], ['2027-01-01', 31]]) {
      const result = c.evaluateMandatoryCalendar([entry('Salary', 'EOM'), entry('Tax', 31, 100, 'Налоги')], [], [plan()], anchor);
      const items = [...result.dueThisWeek, ...result.later];
      assert.equal(items.length, 2); assert.ok(items.every(item => item.dueDay === last));
      assert.equal(result.overdue.length, 0);
    }
    const end = c.evaluateMandatoryCalendar([entry('First', 1), entry('Last', 'EOM')], [], [plan()], '2026-12-30');
    assert.equal(end.overdue[0].dueDate, '2026-12-01'); assert.equal(end.dueThisWeek[0].dueDate, '2026-12-31');
  });
  test('Stage 4C: CPF, monthly zero overrides and zero Calendar amounts never appear', c => {
    const items = [entry('CPF', 'bad', 100, 'CPF'), entry('Родители', 1), entry('Holiday', 1, 100, 'Отдых'), entry('Zero', 1, 0, 'Лин')];
    const result = c.evaluateMandatoryCalendar(items, [], [plan('Родители', 0), plan('Отдых', 0)], '2026-09-16');
    assert.equal(result.excluded, 4); assert.equal(result.overdue.length, 0);
    const html = c.formatMandatoryCalendarBrief(result);
    assert.doesNotMatch(html, /CPF|Родители|Holiday/);
    assert.match(c.formatMandatoryCalendarBrief(c.evaluateMandatoryCalendar([], [], [], '2026-09-16')), /No confirmed/);
  });
  test('Stage 4C: workbook reads filter inactive, other-month/type/future rows and ignore G', c => {
    const f = workbook(c), now = date(c, '2026-09-16T00:00:00Z');
    const status = c.getMandatoryCalendarStatus(f.ss, now);
    assert.equal(status.activeCount, 2); assert.equal(status.paid[0].item, 'Mortgage');
    assert.equal(status.overdue[0].item, 'Rent'); // G=true does not settle either Calendar item.
    f.matrices.Calendar[1][5] = 'yes';
    assert.throws(() => c.getMandatoryCalendarStatus(f.ss, now), /checkbox/);
    f.matrices.Calendar[1][5] = true; f.matrices.Transactions[1][4] = '#REF!';
    assert.throws(() => c.getMandatoryCalendarStatus(f.ss, now), /amount/);
    delete f.matrices.Calendar;
    assert.throws(() => c.getMandatoryCalendarStatus(f.ss, now), /Calendar is missing/);
  });
  test('Stage 4C: invalid calendar dates/amounts stop results; output escapes user text', c => {
    for (const day of [0, 32, '', 'Monday', 1.5]) assert.throws(() => c.evaluateMandatoryCalendar([entry('Rent', day)], [], [plan()], '2026-09-16'), /day/);
    assert.throws(() => c.evaluateMandatoryCalendar([entry('Rent', 1, '')], [], [plan()], '2026-09-16'), /amount/);
    const status = c.evaluateMandatoryCalendar([entry('<Rent & bill>', 1)], [], [plan()], '2026-09-16');
    assert.match(c.formatMandatoryCalendarBrief(status), /&lt;Rent &amp; bill&gt;/);
    assert.doesNotMatch(c.formatMandatoryCalendarBrief(status), /undefined|NaN/);
  });
  test('Stage 4C: menu previews locally and weekly normal entry point uses Calendar', c => {
    const status = c.evaluateMandatoryCalendar([entry('Rent', 1)], [], [plan()], '2026-09-16');
    c.getMandatoryCalendarStatus = () => status;
    c.sendTelegramMessage = () => { throw new Error('Menu must not send Telegram'); };
    let shown;
    c.SpreadsheetApp.getUi = () => ({alert: text => { shown = text; }});
    c.checkMandatoryPaymentsNow(); assert.match(shown, /Overdue/); assert.doesNotMatch(shown, /<b>/);
    assert.match(c.generateWeeklyMandatoryReport(), /Overdue/);
  });
  test('Stage 4C: configurable weekly time/day uses bounded SGT catch-up', c => {
    vm.runInContext("SHEET_FACTS.MANDATORY_REMINDERS.WEEKLY_DAY = 'Tue'; SHEET_FACTS.MANDATORY_REMINDERS.WEEKLY_TIME = '10:30'", c);
    assert.equal(c.getMandatoryWeeklySlot(date(c, '2026-09-21T02:30:00Z')), null);
    assert.equal(c.getMandatoryWeeklySlot(date(c, '2026-09-22T02:29:00Z')), null);
    assert.equal(c.getMandatoryWeeklySlot(date(c, '2026-09-22T02:30:00Z')).period, '2026-09-22');
    assert.equal(c.getMandatoryWeeklySlot(date(c, '2026-09-22T05:30:00Z')), null);
  });
  test('Stage 4C: real dispatcher builds Calendar brief, retries failure and preserves accepted users', c => {
    clock(c, '2026-09-21T01:00:00Z');
    const f = workbook(c), sent = [], props = c.PropertiesService.getScriptProperties();
    // Keep Rent genuinely unpaid at the reporting anchor; future-dated evidence is tested separately.
    f.matrices.Transactions.pop();
    c.SpreadsheetApp.getActiveSpreadsheet = () => f.ss;
    c.LockService = {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})};
    c.scanConfiguredStatementInbox = () => {};
    ['96069960', '402188776'].forEach(id => props.setProperty('sent_morning_coach_' + id, '2026-09-21'));
    let reject = true;
    c.sendTelegramMessage = (text, chat) => {
      assert.match(text, /Overdue/); assert.match(text, /Rent/); assert.doesNotMatch(text, /Mortgage/);
      sent.push(chat); if (chat === '96069960' && reject) throw new Error('Rejected');
    };
    c.dispatch(); c.dispatch(); assert.deepEqual(sent, ['96069960', '402188776']);
    reject = false; clock(c, '2026-09-21T01:15:00Z'); c.dispatch(); c.dispatch();
    assert.deepEqual(sent, ['96069960', '402188776', '96069960']);
    assert.equal(props.getProperty('sent_weekly_mandatory_audit_96069960'), '2026-09-21');
  });
  test('Stage 4C: same-day is opt-in, per-recipient acceptance/retry, and one summary per day', c => {
    clock(c, '2026-09-16T13:00:00Z');
    const users = [{chat_id: 'a'}, {chat_id: 'b'}], sent = [];
    const now = () => date(c, new Date(c.monthlyTestEpoch).toISOString());
    c.getMandatoryCalendarStatus = () => { throw new Error('Disabled must not read'); };
    c.runMandatorySameDayAlerts(now(), users);
    vm.runInContext('SHEET_FACTS.MANDATORY_REMINDERS.SAME_DAY_ENABLED = true', c);
    c.LockService = {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})};
    c.getMandatoryCalendarStatus = () => c.evaluateMandatoryCalendar([entry('Rent', 16)], [], [plan()], now());
    let reject = true;
    c.sendTelegramMessage = (text, chat) => { sent.push(chat); if (chat === 'a' && reject) throw new Error('Delivery rejected'); };
    c.runMandatorySameDayAlerts(now(), users); c.runMandatorySameDayAlerts(now(), users);
    assert.deepEqual(sent, ['a', 'b']);
    reject = false; clock(c, '2026-09-16T13:15:00Z');
    c.runMandatorySameDayAlerts(now(), users); c.runMandatorySameDayAlerts(now(), users);
    assert.deepEqual(sent, ['a', 'b', 'a']);
    clock(c, '2026-09-17T13:00:00Z'); c.runMandatorySameDayAlerts(now(), users);
    assert.equal(sent.length, 3); // Yesterday's overdue bill does not generate another day-of ping.
  });
  test('Stage 4C: same-day retry rechecks payments; missing data never delivers all-clear', c => {
    clock(c, '2026-09-16T13:00:00Z');
    vm.runInContext('SHEET_FACTS.MANDATORY_REMINDERS.SAME_DAY_ENABLED = true', c);
    c.LockService = {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})};
    let attempts = 0, paid = false;
    c.sendTelegramMessage = () => { attempts++; throw new Error('Rejected'); };
    c.getMandatoryCalendarStatus = (_, asOf) => c.evaluateMandatoryCalendar([entry('Rent', 16)], paid ? [payment('Rent')] : [], [plan()], asOf);
    c.runMandatorySameDayAlerts(date(c, '2026-09-16T13:00:00Z'), [{chat_id: 'a'}]);
    paid = true; clock(c, '2026-09-16T13:15:00Z');
    c.runMandatorySameDayAlerts(date(c, '2026-09-16T13:15:00Z'), [{chat_id: 'a'}]);
    assert.equal(attempts, 1);
    c.getMandatoryCalendarStatus = () => { throw new Error('Missing sheet'); };
    assert.throws(() => c.generateWeeklyMandatoryReport(), /Missing sheet/);
    c.runMandatorySameDayAlerts(date(c, '2026-09-16T13:15:00Z'), [{chat_id: 'a'}]);
    assert.equal(attempts, 1);
  });
};
