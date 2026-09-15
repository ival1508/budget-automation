// Read-only month-end fixtures. All model calls and Telegram deliveries stay offline.
const assert = require('node:assert/strict');
const vm = require('node:vm');

function date(c, iso) {
  return vm.runInContext(`new Date(${JSON.stringify(iso)})`, c);
}
function clock(c, iso) {
  c.monthlyTestEpoch = Date.parse(iso);
  if (!c.monthlyTestClockInstalled) {
    vm.runInContext(`const MonthlyOriginalDate = Date;
      Date = class extends MonthlyOriginalDate {
        constructor(...args) { super(...(args.length ? args : [monthlyTestEpoch])); }
        static now() { return monthlyTestEpoch; }
      };`, c);
    c.monthlyTestClockInstalled = true;
  }
}
function fixture(c) {
  const matrices = {}, sheets = {}, reads = [];
  function sheet(name, rows) {
    matrices[name] = rows;
    return sheets[name] = {
      getLastRow: () => rows.length, getLastColumn: () => Math.max(...rows.map(row => row.length)),
      getRange: (row, col, height = 1, width = 1) => {
        if (typeof row === 'string') {
          const match = row.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
          assert.ok(match, row);
          const column = letters => [...letters].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
          col = column(match[1]); row = +match[2];
          width = match[3] ? column(match[3]) - col + 1 : 1;
          height = match[4] ? +match[4] - row + 1 : 1;
        }
        reads.push({ name, row, col, height, width });
        const values = () => Array.from({ length: height }, (_, r) =>
          Array.from({ length: width }, (_, p) => rows[row + r - 1]?.[col + p - 1] ?? ''));
        const display = () => values().map(line => line.map(value =>
          value && typeof value.getTime === 'function' ? c.Utilities.formatDate(value, 'Asia/Singapore', 'dd.MM.yyyy') : String(value)));
        return { getValues: values, getDisplayValues: display, getValue: () => values()[0][0], getDisplayValue: () => display()[0][0] };
      }
    };
  }
  const budget = Array.from({ length: 8 }, () => Array(32).fill(''));
  const periods = ['09/2026', '10/2026', '01/2027', '11/2027', '12/2026', '02/2028'];
  periods.forEach((period, i) => { budget[0][2 + i * 2] = period; });
  budget[0][30] = 'Target month 06/2026';
  const summaries = [[2, 'Needs', 3500, 3000, 0.6, 0.5], [4, 'Wants', 900, 800, 0.2, 0.3], [6, 'Savings', 2000, 2200, 0.2, 0.2]];
  for (const [r, label, actual, target, percent, targetPercent] of summaries) {
    budget[r][0] = budget[r][1] = label;
    periods.forEach((_, i) => { budget[r][2 + i * 2] = i === 1 ? 50 : actual; budget[r][3 + i * 2] = percent; });
    budget[r][30] = target; budget[r][31] = targetPercent;
  }
  for (const [r, label, actual, target] of [[3, 'Кредит', 250, 250], [5, 'Рестораны', 700, 500], [7, 'Инвестиции', 1000, 1100]]) {
    budget[r][1] = label;
    periods.forEach((_, i) => { budget[r][2 + i * 2] = i === 1 ? 9 : actual; });
    budget[r][30] = target;
  }
  sheet('50/30/20', budget);
  for (const [name, period] of [["Сентябрь'26", '09.2026'], ["Октябрь'26", '10.2026'], ["Я'27", '01.2027'], ["Декабрь'26", '12.2026'], ["Ф'28", '02.2028']]) {
    const rows = Array.from({ length: 32 }, () => Array(12).fill(''));
    const planned = [['Кредит', 250, false], ['Помощница', 100, true], ['Коммунальные', 100, false], ['Интернет', 75, false], ['Родители', 0, false], ['CPF', 900, false]];
    planned.forEach(([label, amount, checked], i) => {
      rows[i + 2][3] = label; rows[i + 2][4] = amount; rows[i + 2][6] = checked;
    });
    rows[16][3] = 80; rows[18][3] = 30;
    rows[1][7] = '01.' + period; rows[1][9] = 100; rows[1][10] = 80;
    rows[30][7] = '30.' + period; rows[30][9] = 200; rows[30][10] = 80;
    sheet(name, rows);
  }
  const ledger = [Array(11).fill('header')];
  const transaction = (when, type, amount, category, where) =>
    ledger.push([when, 'DBS SGD', type, amount, amount, 1, '', category, where || '', '', '']);
  transaction('01.09.2026', 'Расходы', 100, 'Рестораны');
  transaction('30.09.2026', 'Расходы', 200, 'Рестораны');
  transaction(date(c, '2026-09-30T15:59:00Z'), 'Расходы', 15, 'Дом');
  transaction(date(c, '2026-09-30T16:01:00Z'), 'Расходы', 999, 'Дом'); // October in SGT.
  transaction('15.09.2026', 'Расходы', 25, 'Подарки');
  transaction('15.09.2026', 'Расходы', 30, 'Развлечения');
  transaction('25.09.2026', 'Обязательные расходы', 100, 'Кредит', 'Bank A');
  transaction('30.09.2026', 'Обязательные расходы', 150, 'Кредит', 'Bank B');
  transaction('30.09.2026', 'Обязательные расходы', 40, 'Коммунальные');
  transaction('30.09.2026', 'Доходы', 5000, 'Рестораны');
  transaction('30.09.2026', 'Снятие денег', 1000, 'Рестораны');
  transaction('01.10.2026', 'Обязательные расходы', 75, 'Интернет');
  transaction('01.10.2026', 'Расходы', 50, 'Рестораны');
  sheet('Transactions', ledger);
  const ss = { getSheetByName: name => sheets[name] || null, getSpreadsheetTimeZone: () => 'Asia/Singapore' };
  c.SpreadsheetApp.getActiveSpreadsheet = () => ss;
  return { ss, matrices, sheets, reads };
}
function scheduler(c, iso = '2026-09-30T15:31:00Z') {
  clock(c, iso);
  const f = fixture(c), sends = [], scans = [];
  c.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  c.sendTelegramMessage = (text, chat) => {
    const recipients = chat ? [String(chat)] : Array.from(c.getActiveTelegramUsers(), user => user.chat_id);
    recipients.forEach(chatId => sends.push({ text, chat: chatId }));
  };
  c.scanConfiguredStatementInbox = () => scans.push(sends.length);
  return { ...f, sends, scans };
}

module.exports = test => {
  test('monthly report at October 1 reads September full-month results and payment completion', c => {
    clock(c, '2026-10-01T01:01:00Z');
    const f = fixture(c);
    c.getDailyPacing = () => { throw new Error('Monthly payload must not read daily pacing'); };
    const payload = c.buildCoachPayload('monthly', f.ss);
    assert.equal(payload.error, undefined);
    assert.equal(payload.report_month, '2026-09'); assert.equal(payload.month_tab, "Сентябрь'26");
    assert.equal(payload.report_start, '01.09.2026'); assert.equal(payload.report_end, '30.09.2026');
    assert.equal(payload.buckets.needs.actual, 3500); assert.equal(payload.buckets.needs.target, 3000);
    assert.equal(payload.buckets.savings.actual, 2000); // Not the subcategory sum of 1000.
    assert.equal(payload.buckets.needs.actual_percent, '60.0%'); assert.equal(payload.buckets.needs.target_percent, '50.0%');
    assert.deepEqual(Array.from(payload.volatile_categories, row => row.actual), [300, 30, 15, 25]);
    assert.deepEqual([payload.mandatory_summary.paid, payload.mandatory_summary.unpaid, payload.mandatory_summary.excluded], [2, 2, 2]);
    assert.equal(payload.mandatory_summary.items.find(row => row.name === 'Коммунальные').status, 'partial');
    assert.equal(payload.mandatory_summary.items.find(row => row.name === 'Интернет').actual, 0);
    assert.equal(payload.category_focus.name, 'Рестораны');
    assert.equal(payload.category_focus.discretionary_spend, 300);
    assert.ok(!('realistic_daily' in payload));
    assert.ok(!f.reads.some(row => row.name === "Октябрь'26"));
  });
  test('monthly period handles last-day boundary, leap years and December rollover in SGT', c => {
    for (const [iso, month, tab] of [
      ['2026-09-30T15:29:00Z', '2026-08', "Август'26"],
      ['2026-09-30T15:30:00Z', '2026-09', "Сентябрь'26"],
      ['2026-10-01T00:00:00Z', '2026-09', "Сентябрь'26"],
      ['2027-01-01T00:00:00Z', '2026-12', "Декабрь'26"],
      ['2028-02-29T15:30:00Z', '2028-02', "Ф'28"],
      ['2028-03-01T00:00:00Z', '2028-02', "Ф'28"]
    ]) {
      const report = c.getMonthlyReportDate(date(c, iso));
      assert.equal(c.Utilities.formatDate(report, 'Asia/Singapore', 'yyyy-MM'), month);
      assert.equal(c.getCurrentMonthTabName(report), tab);
    }
    assert.throws(() => c.getMonthlyReportDate(date(c, 'invalid')), /valid monthly report date/);
    assert.throws(() => c.buildCoachPayload('monthly', {}, '2026-09'), /valid monthly report date/);
  });
  test('explicit period reaches legacy context readers without advancing to the clock month', c => {
    clock(c, '2026-10-01T01:01:00Z'); const f = fixture(c), report = date(c, '2026-09-30T12:00:00Z');
    c.getDailyPacing = value => { assert.equal(value, report); return {}; };
    const ctx = c.getBudgetCoachContext(f.ss, report);
    assert.equal(ctx.month_tab, "Сентябрь'26"); assert.equal(ctx.pacing_50_30_20.needs.actual, 3500);
    assert.equal(ctx.daily_status.daily_spend, 215);
    assert.equal(ctx.todays_transactions.reduce((sum, row) => sum + row.amount, 0), 215);
    assert.equal(ctx.mandatory_expenses.logged.reduce((sum, row) => sum + row.amount, 0), 290);
    assert.ok(ctx.recent_trends.trends.every(row => row.date.endsWith('09.2026')));
    assert.equal(c.getCurrentMonthCategorySplits(f.ss, report)['рестораны'].discretionary, 300);
  });
  test('January reporting matches January column rather than November and preserves report year', c => {
    const f = fixture(c);
    f.matrices['50/30/20'][0][6] = '11/2027'; f.matrices['50/30/20'][0][8] = '1/2027';
    f.matrices['50/30/20'][2][6] = 9999; f.matrices['50/30/20'][2][8] = 1234;
    const payload = c.buildCoachPayload('monthly', f.ss, date(c, '2027-01-31T12:00:00Z'));
    assert.equal(payload.error, undefined); assert.equal(payload.month_tab, "Я'27");
    assert.equal(payload.buckets.needs.actual, 1234);
  });
  test('missing completed month stays unavailable despite a present new month and never creates a tab', c => {
    clock(c, '2026-10-01T01:00:00Z'); const f = fixture(c);
    delete f.sheets["Сентябрь'26"];
    c.ensureMonthTab = () => { throw new Error('Retrospective must remain read only'); };
    const payload = c.buildCoachPayload('monthly', f.ss);
    assert.equal(payload.error, 'missing_month'); assert.equal(payload.month_tab, "Сентябрь'26");
    assert.match(c.generateMonthlyCoachBrief(payload), /unavailable/);
    assert.ok(!f.reads.some(row => row.name === "Октябрь'26"));
  });
  test('monthly readers surface absent summaries, headers, formula errors and unreadable plans', c => {
    const report = date(c, '2026-09-30T12:00:00Z');
    for (const damage of [
      f => { f.matrices['50/30/20'][0][2] = ''; f.matrices['50/30/20'][0][31] = '09/2026'; },
      f => { f.matrices['50/30/20'][2][0] = 'Needs'; f.matrices['50/30/20'][2][1] = ''; },
      f => { f.matrices['50/30/20'][2][2] = '#REF!'; },
      f => { f.matrices['50/30/20'][2][31] = ''; },
      f => { f.matrices["Сентябрь'26"][2][4] = '#N/A'; },
      f => { f.matrices["Сентябрь'26"][2][6] = '#REF!'; },
      f => { f.matrices['Transactions'][7][4] = '#VALUE!'; },
      f => { f.sheets['Transactions'].getRange = () => { throw new Error('Read denied'); }; }
    ]) {
      const f = fixture(c); damage(f);
      const payload = c.buildCoachPayload('monthly', f.ss, report);
      assert.equal(payload.error, 'monthly_read_error', JSON.stringify(payload));
      assert.ok(!('buckets' in payload)); assert.match(c.generateMonthlyCoachBrief(payload), /unavailable/);
    }
  });
  test('monthly fallback uses the shared engine and omits aggregate totals and committed-cost advice', c => {
    const f = fixture(c), payload = c.buildCoachPayload('monthly', f.ss, date(c, '2026-09-30T12:00:00Z'));
    const text = c.generateMonthlyCoachBrief(payload); // No model key: deterministic fallback.
    assert.match(text, /S\$3,500.00/); assert.match(text, /2 paid, 2 unpaid/);
    assert.match(text, /Target month 06\/2026/); assert.doesNotMatch(text, /Total Monthly Spend|volatile|Кредит/);
    assert.equal(c.coachMoneyIsGrounded(text, payload), true);
    assert.equal(c.monthlyCoachBriefIsGrounded(text, payload), true);
    assert.ok((text.replace(/<[^>]*>/g, '').match(/[.!?](?=\s|$)/g) || []).length <= 4);
    assert.throws(() => c.generateMonthlyCoachBrief(c.getBudgetCoachContext(f.ss)), /explicit monthly payload/);
  });
  test('monthly model output is grounded for money, percentages, payment counts, period and length', c => {
    const f = fixture(c), payload = c.buildCoachPayload('monthly', f.ss, date(c, '2026-09-30T12:00:00Z'));
    c.PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', 'offline-test');
    const good = c.buildFallbackMonthlyBrief(payload);
    let output = good, calls = 0;
    c.callGeminiApiWithRetry = request => {
      calls++; assert.equal(JSON.parse(request.contents[0].parts[0].text).report_month, '2026-09');
      assert.match(request.systemInstruction.parts[0].text, /monthly JSON/);
      return { text: JSON.stringify({ candidates: [{ content: { parts: [{ text: output }] } }] }) };
    };
    assert.equal(c.generateMonthlyCoachBrief(payload), good);
    for (const bad of [good.replace('3,500.00', '9,999.00'), good.replace('60.0%', '99%'),
      good.replace('2 paid', '99 paid'), good.replace("Сентябрь'26", "Октябрь'26"),
      good.replace('Needs S$3,500.00', 'Needs S$900.00'), good.replace('60.0%', '20.0%'),
      good + ' Total spend was S$6400.', good + ' Another sentence. One more.',
      '<code>' + good + '</code>']) {
      output = bad; assert.equal(c.generateMonthlyCoachBrief(payload), good);
    }
    assert.equal(calls, 10);
    c.callGeminiApiWithRetry = () => { throw new Error('Offline model failure'); };
    assert.equal(c.generateMonthlyCoachBrief(payload), good);
  });
  test('month-end dispatcher sends reminder then closing-month coach once to both users before scanning', c => {
    const f = scheduler(c); c.dispatch(); c.dispatch();
    assert.equal(f.sends.length, 4);
    assert.deepEqual(f.sends.map(row => row.chat), ['96069960', '96069960', '402188776', '402188776']);
    assert.match(f.sends[0].text, /upload the bank statements/); assert.match(f.sends[1].text, /S\$3,500.00/);
    assert.match(f.sends[2].text, /upload the bank statements/); assert.match(f.sends[3].text, /S\$3,500.00/);
    assert.ok(f.sends.every(row => row.text.includes("Сентябрь'26")));
    assert.deepEqual(f.scans, [4, 4]);
  });
  test('month-end scheduling runs on leap February and December but not first-day morning or earlier days', c => {
    const f = scheduler(c);
    for (const iso of ['2026-10-01T01:01:00Z', '2026-09-29T15:31:00Z', '2026-09-30T15:29:00Z']) {
      clock(c, iso); c.dispatch();
      // The first-day morning can now catch up the daily coach, but never the old 09:00 retrospective.
      assert.ok(f.sends.every(row => !row.text.includes("Сентябрь'26")));
    }
    for (const [iso, tab] of [['2026-12-31T15:31:00Z', "Декабрь'26"], ['2028-02-29T15:31:00Z', "Ф'28"]]) {
      clock(c, iso); const before = f.sends.length; c.dispatch();
      assert.equal(f.sends.length, before + 4);
      assert.ok(f.sends.slice(before).every(row => row.text.includes(tab)));
    }
  });
  test('month-end freezes the selected period even if model generation crosses midnight', c => {
    const f = scheduler(c);
    const original = c.generateMonthlyCoachBrief;
    c.generateMonthlyCoachBrief = payload => { clock(c, '2026-09-30T16:01:00Z'); return original(payload); };
    c.dispatch(); assert.equal(f.sends.length, 4);
    assert.ok(f.sends.every(row => row.text.includes("Сентябрь'26")));
    assert.match(f.sends[3].text, /S\$3,500.00/);
  });
  test('unfinished monthly delivery retries at 23:45 without duplicating reminders or the other user', c => {
    const f = scheduler(c); const deliver = c.sendTelegramMessage;
    let attempts = 0;
    c.sendTelegramMessage = (text, chat, accepted) => {
      if (String(chat) === '96069960' && !text.includes('upload the bank statements') && ++attempts === 1) throw new Error('Rejected');
      return deliver(text, chat, accepted);
    };
    c.dispatch(); assert.equal(f.sends.length, 3);
    clock(c, '2026-09-30T15:46:00Z'); c.dispatch();
    assert.equal(f.sends.length, 4); assert.equal(attempts, 2);
    assert.equal(f.sends.filter(row => row.text.includes('upload the bank statements')).length, 2);
  });
  test('month-end prevents overlapping runs without holding the shared lock through generation', c => {
    const f = scheduler(c); let locked = false, generated = 0;
    c.LockService = { getScriptLock: () => ({ tryLock: () => { assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; } }) };
    const original = c.generateMonthlyCoachBrief;
    c.generateMonthlyCoachBrief = payload => {
      assert.equal(locked, false); generated++; c.dispatch(); return original(payload);
    };
    c.dispatch(); assert.equal(generated, 1); assert.equal(f.sends.length, 4);
  });
  test('manual monthly send defaults to the completed month and respects active recipients', c => {
    const f = scheduler(c, '2026-10-01T01:00:00Z');
    vm.runInContext('SHEET_FACTS.USERS.RITA.active = false', c);
    c.sendMonthlyCoach(undefined, f.ss);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].chat, '96069960');
    assert.match(f.sends[0].text, /S\$3,500.00/);
  });
  test('actual monthly Telegram send rejects HTTP and API errors before marking the step delivered', c => {
    c.PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', 'offline-test');
    let code = 429, ok = false;
    c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => code, getContentText: () => JSON.stringify({ ok, description: 'Rejected' }) }) };
    assert.throws(() => c.sendTelegramMessage('Monthly', '42', true), /Telegram delivery failed/);
    code = 200; assert.throws(() => c.sendTelegramMessage('Monthly', '42', true), /Telegram delivery failed/);
    ok = true; assert.doesNotThrow(() => c.sendTelegramMessage('Monthly', '42', true));
  });
  test('actual dispatcher leaves a rejected monthly API delivery pending and retries only that step', c => {
    const deliver = c.sendTelegramMessage; scheduler(c); c.sendTelegramMessage = deliver;
    c.PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', 'offline-test');
    const accepted = []; let rejected = false;
    c.UrlFetchApp = { fetch: (_, options) => {
      const payload = JSON.parse(options.payload);
      const failure = payload.chat_id === '96069960' && !payload.text.includes('upload the bank statements') && !rejected;
      if (failure) rejected = true; else accepted.push(payload);
      return { getResponseCode: () => failure ? 429 : 200, getContentText: () => JSON.stringify({ ok: !failure, description: 'Retry later' }) };
    } };
    const props = c.PropertiesService.getScriptProperties();
    c.dispatch();
    assert.equal(props.getProperty('month_end_2026-09_96069960_coach'), null);
    assert.equal(props.getProperty('month_end_2026-09_96069960_reminder'), 'sent');
    assert.equal(props.getProperty('month_end_2026-09_402188776_coach'), 'sent');
    clock(c, '2026-09-30T15:46:00Z'); c.dispatch();
    assert.equal(accepted.length, 4); assert.equal(props.getProperty('month_end_2026-09_96069960_coach'), 'sent');
  });
  test('failed month-end reminder blocks that user’s report while allowing the other user to finish', c => {
    const f = scheduler(c), deliver = c.sendTelegramMessage;
    let fail = true;
    c.sendTelegramMessage = (text, chat, accepted) => {
      if (String(chat) === '96069960' && fail) throw new Error('Reminder rejected');
      deliver(text, chat, accepted);
    };
    c.dispatch(); assert.equal(f.sends.length, 2); assert.ok(f.sends.every(row => row.chat === '402188776'));
    fail = false; clock(c, '2026-09-30T15:46:00Z'); c.dispatch();
    assert.equal(f.sends.length, 4); assert.match(f.sends[2].text, /upload the bank statements/);
    assert.match(f.sends[3].text, /S\$3,500.00/);
  });
  test('month-end active execution guard expires after an interrupted Apps Script execution', c => {
    const f = scheduler(c), props = c.PropertiesService.getScriptProperties();
    props.setProperty('month_end_running_2026-09', JSON.stringify({ token: 'interrupted', startedAt: c.monthlyTestEpoch }));
    c.dispatch(); assert.equal(f.sends.length, 0);
    clock(c, '2026-09-30T15:46:00Z'); c.dispatch(); assert.equal(f.sends.length, 4);
    assert.equal(props.getProperty('month_end_running_2026-09'), null);
  });
};
module.exports.clock = clock;
module.exports.date = date;
module.exports.fixture = fixture;
