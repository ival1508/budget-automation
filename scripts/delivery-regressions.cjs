// All Telegram requests are intercepted; tests never send messages or use credentials.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { clock, date, fixture } = require('./monthly-coach-regressions.cjs');
const users = ['96069960', '402188776'];
function setup(c, iso = '2026-09-16T00:01:00Z') {
  clock(c, iso);
  const calls = [], builds = [], props = c.PropertiesService.getScriptProperties();
  props.setProperty('TELEGRAM_BOT_TOKEN', 'offline-token');
  props.setProperty('AUTHORIZED_CHAT_IDS', 'unrelated-chat');
  props.setProperty('TELEGRAM_CHAT_ID', 'old-fallback');
  let locked = false;
  c.LockService = { getScriptLock: () => ({
    tryLock: () => { if (locked) return false; locked = true; return true; }, releaseLock: () => { locked = false; }
  }) };
  const selected = value => c.Utilities.formatDate(value || date(c, iso), 'Asia/Singapore', 'dd.MM.yyyy');
  c.buildCoachPayload = (period, _, reportDate) => {
    builds.push(period); return { period, report_date: selected(reportDate) };
  };
  c.generateCoachBrief = payload => { assert.equal(locked, false); return 'Morning ' + payload.report_date; };
  c.getBudgetCoachContext = (_, reportDate) => ({ report_date: selected(reportDate) });
  c.generateWeeklyMandatoryReport = payload => { builds.push('weekly'); return 'Weekly ' + payload.report_date; };
  c.generateMonthlyCoachBrief = payload => 'Monthly ' + payload.report_date;
  c.generateDailyTransactionsRecap = (_, reportDate) => { builds.push('recap'); return 'Recap ' + selected(reportDate); };
  c.scanConfiguredStatementInbox = () => {};
  const f = { calls, builds, props, setTime: value => clock(c, value), respond: () => ({ code: 200, body: { ok: true, result: { message_id: calls.length } } }) };
  c.UrlFetchApp = { fetch: (_, options) => {
    assert.equal(locked, false);
    const payload = JSON.parse(options.payload); calls.push(payload);
    const response = f.respond(payload);
    return { getResponseCode: () => response.code, getContentText: () => typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
  } };
  f.markMorning = () => users.forEach(id => props.setProperty('sent_morning_coach_' + id,
    c.Utilities.formatDate(date(c, new Date(c.monthlyTestEpoch).toISOString()), 'Asia/Singapore', 'yyyy-MM-dd')));
  return f;
}
const reject = (delay = 0) => ({ code: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: delay } } });

module.exports = test => {
  test('Telegram helper propagates rejection and retry-after without an optional acceptance flag', c => {
    const f = setup(c); f.respond = () => reject(1800);
    assert.throws(() => c.sendTelegramMessage('Brief', users[0]), error => {
      assert.match(error.message, /Telegram delivery failed.*HTTP 429/);
      assert.equal(error.retryAfterSeconds, 1800); assert.equal(error.accepted.length, 0); return true;
    });
    assert.ok(!c.logs.some(line => line.includes('✅ Telegram')));
  });
  test('Telegram helper rejects API errors, malformed replies and network failure without exposing tokens', c => {
    const f = setup(c);
    for (const response of [{ code: 200, body: { ok: false } }, { code: 204, body: { ok: true } },
      { code: 200, body: 'not-json' }, { code: 200, body: null }]) {
      f.respond = () => response;
      assert.throws(() => c.sendTelegramMessage('Brief', users[0], false), /Telegram delivery failed/);
    }
    f.respond = () => { throw new Error('https://api.telegram.org/botoffline-token/sendMessage'); };
    assert.throws(() => c.sendTelegramMessage('Brief', users[0]), error => {
      assert.match(error.message, /Network request failed/); assert.doesNotMatch(error.message, /offline-token/); return true;
    });
    f.respond = () => ({ code: 200, body: { ok: true, result: { message_id: 123 } } });
    assert.deepEqual(Array.from(c.sendTelegramMessage('Brief', users[0]), receipt => [receipt.chat_id, receipt.message_id]), [[users[0], 123]]);
  });
  test('reported morning 429 probe leaves both sent keys unset and retries on the next heartbeat', c => {
    const f = setup(c); f.respond = () => reject();
    c.dispatch(); assert.equal(f.calls.length, 2);
    users.forEach(id => assert.equal(f.props.getProperty('sent_morning_coach_' + id), null));
    c.dispatch(); assert.equal(f.calls.length, 2); // Respect backoff within the same minute.
    f.respond = () => ({ code: 200, body: { ok: true } });
    f.setTime('2026-09-16T00:16:00Z'); c.dispatch();
    assert.equal(f.calls.length, 4);
    users.forEach(id => assert.equal(f.props.getProperty('sent_morning_coach_' + id), '2026-09-16'));
    c.dispatch(); assert.equal(f.calls.length, 4);
  });
  test('mixed morning delivery honors server retry-after and never resends to an accepted user', c => {
    const f = setup(c); let fail = true;
    f.respond = payload => payload.chat_id === users[0] && fail ? reject(1800) : { code: 200, body: { ok: true } };
    c.dispatch(); assert.equal(f.calls.length, 2);
    assert.equal(f.props.getProperty('sent_morning_coach_' + users[0]), null);
    assert.equal(f.props.getProperty('sent_morning_coach_' + users[1]), '2026-09-16');
    f.setTime('2026-09-16T00:16:00Z'); c.dispatch(); assert.equal(f.calls.length, 2);
    fail = false; f.setTime('2026-09-16T00:31:00Z'); c.dispatch();
    assert.deepEqual(f.calls.map(row => row.chat_id), [users[0], users[1], users[0]]);
  });
  test('morning catches up a missed tick, shares generation per run and resets for the next day', c => {
    const f = setup(c, '2026-09-16T00:47:00Z'); c.dispatch(); c.dispatch();
    assert.equal(f.calls.length, 2); assert.deepEqual(f.builds, ['daily']);
    f.setTime('2026-09-17T00:47:00Z'); c.dispatch(); assert.equal(f.calls.length, 4);
    users.forEach(id => assert.equal(f.props.getProperty('sent_morning_coach_' + id), '2026-09-17'));
  });
  test('morning respects individual times, malformed schedules and the three-hour deadline', c => {
    const f = setup(c, '2026-09-16T00:01:00Z');
    vm.runInContext('SHEET_FACTS.USERS.RITA.morning_time = "09:30"', c);
    c.dispatch(); assert.deepEqual(f.calls.map(row => row.chat_id), [users[0]]);
    f.setTime('2026-09-16T01:31:00Z'); c.dispatch(); assert.deepEqual(f.calls.map(row => row.chat_id), users);
    const g = setup(c, '2026-09-17T03:00:00Z');
    vm.runInContext('SHEET_FACTS.USERS.RITA.morning_time = "25:00"', c);
    c.dispatch(); assert.equal(g.calls.length, 0);
    g.setTime('2026-09-17T00:00:00Z'); c.dispatch(); assert.equal(g.calls.length, 1);
  });
  test('weekly scheduler tracks acceptance per active user and retries independently', c => {
    const f = setup(c, '2026-09-21T01:01:00Z'); f.markMorning();
    let fail = true;
    f.respond = payload => payload.chat_id === users[0] && fail ? reject() : { code: 200, body: { ok: true } };
    c.dispatch(); assert.equal(f.calls.length, 2);
    assert.equal(f.props.getProperty('sent_weekly_mandatory_audit_' + users[0]), null);
    assert.equal(f.props.getProperty('sent_weekly_mandatory_audit_' + users[1]), '2026-09-21');
    fail = false; f.setTime('2026-09-21T01:16:00Z'); c.dispatch();
    assert.deepEqual(f.calls.map(row => row.chat_id), [users[0], users[1], users[0]]);
    assert.ok(f.calls.every(row => row.text.startsWith('Weekly')));
  });
  test('weekly catches up on Monday only and expires at noon before a fresh next-week run', c => {
    const f = setup(c, '2026-09-21T01:47:00Z'); f.markMorning(); c.dispatch(); assert.equal(f.calls.length, 2);
    f.setTime('2026-09-22T01:47:00Z'); f.markMorning(); c.dispatch(); assert.equal(f.calls.length, 2);
    f.setTime('2026-09-28T04:00:00Z'); c.dispatch(); assert.equal(f.calls.length, 2);
    f.setTime('2026-09-28T01:47:00Z'); f.markMorning(); c.dispatch(); assert.equal(f.calls.length, 4);
  });
  test('evening nudge uses verified per-user delivery and retains its zero-spend button on retries', c => {
    const f = setup(c, '2026-09-16T13:01:00Z'); f.respond = () => reject();
    c.dispatch(); users.forEach(id => assert.equal(f.props.getProperty('sent_daily_nudge_' + id), null));
    f.respond = () => ({ code: 200, body: { ok: true } });
    f.setTime('2026-09-16T13:16:00Z'); c.dispatch(); c.dispatch(); assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every(row => row.reply_markup.inline_keyboard[0][0].callback_data === 'nothing_today'));
    f.setTime('2026-09-16T14:00:00Z'); c.dispatch();
    assert.equal(f.calls.filter(row => row.text.includes('Anything to log')).length, 4);
  });
  test('recap retries only the failed user and stops at 23:30 without crossing into a new day', c => {
    const f = setup(c, '2026-09-16T14:01:00Z'); let fail = true;
    f.respond = payload => {
      if (payload.chat_id === users[0] && fail) throw new Error('Network timeout');
      return { code: 200, body: { ok: true } };
    };
    c.dispatch(); assert.equal(f.props.getProperty('sent_daily_evening_recap_' + users[0]), null);
    assert.equal(f.props.getProperty('sent_daily_evening_recap_' + users[1]), '2026-09-16');
    fail = false; f.setTime('2026-09-16T14:16:00Z'); c.dispatch(); assert.equal(f.calls.length, 3);
    f.setTime('2026-09-16T15:30:00Z'); c.dispatch();
    f.setTime('2026-09-16T16:01:00Z'); c.dispatch(); assert.equal(f.calls.length, 3);
  });
  test('all manual broadcasts use only active configured users and expose partial acceptance', c => {
    const f = setup(c); vm.runInContext('SHEET_FACTS.USERS.RITA.active = false; SHEET_FACTS.USERS.COPY = { ...SHEET_FACTS.USERS.VAL }', c);
    c.sendMorningCoach(); c.sendWeeklyMandatoryAudit(); c.sendDailyNudge(); c.sendDailyEveningRecap(); c.sendMonthlyCoach();
    assert.equal(f.calls.length, 5); assert.ok(f.calls.every(row => row.chat_id === users[0]));
    vm.runInContext('SHEET_FACTS.USERS.RITA.active = true', c);
    f.respond = payload => payload.chat_id === users[0] ? reject() : { code: 200, body: { ok: true } };
    assert.throws(() => c.sendWeeklyMandatoryAudit(), error => {
      assert.deepEqual(Array.from(error.accepted, row => row.chat_id), [users[1]]);
      assert.deepEqual(Array.from(error.failures, row => row.chat_id), [users[0]]); return true;
    });
    c.sendWeeklyMandatoryAudit(users[1]); assert.equal(f.calls.at(-1).chat_id, users[1]);
  });
  test('no active recipients never falls back to Script Properties or claims scheduled success', c => {
    const f = setup(c); vm.runInContext('SHEET_FACTS.USERS = {}', c);
    assert.throws(() => c.sendTelegramMessage('Broadcast'), /No active Telegram recipients/);
    c.dispatch(); assert.equal(f.calls.length, 0); assert.equal(f.builds.length, 0);
  });
  test('overlapping dispatcher runs cannot duplicate sends and do not hold a lock during generation or HTTP', c => {
    const f = setup(c); let overlap = true;
    f.respond = payload => {
      assert.equal(f.props.getProperty('sent_morning_coach_' + payload.chat_id), null);
      assert.ok(f.props.getProperty('sending_morning_coach_' + payload.chat_id));
      if (overlap) { overlap = false; c.dispatch(); }
      return { code: 200, body: { ok: true } };
    };
    c.dispatch(); assert.equal(f.calls.length, 2);
    users.forEach(id => assert.equal(f.props.getProperty('sending_morning_coach_' + id), null));
    c.dispatch(); assert.equal(f.calls.length, 2);
  });
  test('interrupted claims expire and stale retry state cannot suppress the next daily period', c => {
    const f = setup(c); f.props.setProperty('sending_morning_coach_' + users[0], JSON.stringify({ token: 'terminated', startedAt: c.monthlyTestEpoch, period: '2026-09-16' }));
    f.props.setProperty('retry_morning_coach_' + users[0], JSON.stringify({ period: '2026-09-15', attempts: 4, notBefore: c.monthlyTestEpoch + 86400000 }));
    c.dispatch(); assert.deepEqual(f.calls.map(row => row.chat_id), [users[1]]);
    f.setTime('2026-09-16T00:16:00Z'); c.dispatch(); assert.deepEqual(f.calls.map(row => row.chat_id), [users[1], users[0]]);
  });
  test('generation failures remain pending and a generation that exceeds the deadline never sends', c => {
    const f = setup(c); c.generateCoachBrief = () => { throw new Error('Generation failed'); };
    c.dispatch(); assert.equal(f.calls.length, 0);
    users.forEach(id => assert.equal(f.props.getProperty('sent_morning_coach_' + id), null));
    f.setTime('2026-09-16T00:16:00Z'); c.generateCoachBrief = () => 'Recovered'; c.dispatch(); assert.equal(f.calls.length, 2);
    const g = setup(c, '2026-09-17T02:59:00Z');
    c.generateCoachBrief = () => { g.setTime('2026-09-17T03:01:00Z'); return 'Too late'; };
    c.dispatch(); assert.equal(g.calls.length, 0);
    users.forEach(id => assert.equal(g.props.getProperty('sent_morning_coach_' + id), '2026-09-16'));
  });
  test('month-end retries a rejected report across midnight with the original month and server backoff', c => {
    const f = setup(c, '2026-09-30T15:46:00Z'); let fail = true;
    f.respond = payload => payload.chat_id === users[0] && payload.text.startsWith('Monthly') && fail ? reject(1200) : { code: 200, body: { ok: true } };
    c.dispatch(); assert.equal(f.calls.length, 4);
    f.setTime('2026-09-30T16:01:00Z'); c.dispatch(); assert.equal(f.calls.length, 4);
    fail = false; f.setTime('2026-09-30T16:16:00Z'); c.dispatch();
    assert.equal(f.calls.length, 5); assert.equal(f.calls.at(-1).text, 'Monthly 30.09.2026');
    assert.equal(f.calls.filter(row => row.text.includes('upload the bank statements')).length, 2);
  });
  test('month-end catches up a missed rollover until 02:30 and handles leap/year boundaries', c => {
    const f = setup(c, '2027-01-01T00:47:00+08:00'); c.dispatch(); assert.equal(f.calls.length, 4);
    assert.ok(f.calls.filter(row => row.text.startsWith('Monthly')).every(row => row.text === 'Monthly 31.12.2026'));
    f.setTime('2027-02-01T02:30:00+08:00'); c.dispatch(); assert.equal(f.calls.length, 4);
    for (const [iso, period] of [['2028-03-01T02:29:00+08:00', '2028-02'], ['2026-10-01T00:01:00+08:00', '2026-09']]) {
      assert.equal(c.getMonthEndDeliverySlot(date(c, iso)).period, period);
    }
    assert.equal(c.getMonthEndDeliverySlot(date(c, '2028-03-01T02:30:00+08:00')), null);
  });
  test('daily payload freezes its explicit date through all readers even when the clock changes', c => {
    clock(c, '2026-09-30T15:59:00Z'); const f = fixture(c), report = date(c, '2026-09-30T15:59:00Z');
    c.getDailyPacing = (value, ss) => { assert.equal(value, report); assert.equal(ss, f.ss); return { D19_realistic_daily: 30 }; };
    c.get503020Status = (ss, _, value) => { assert.equal(value, report); assert.equal(ss, f.ss); clock(c, '2026-09-30T16:01:00Z'); return {}; };
    c.getTodaySpend = (value, ss) => { assert.equal(value, report); assert.equal(ss, f.ss); return 215; };
    c.getCurrentMonthCategorySplits = (ss, value) => { assert.equal(value, report); assert.equal(ss, f.ss); return {}; };
    assert.equal(c.buildCoachPayload('daily', f.ss, report).spend_today, 215);
  });
};
