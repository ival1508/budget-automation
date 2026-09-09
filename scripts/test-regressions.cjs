// Offline tests only: no credentials, network, Google services, or live writes.
// Run: node scripts/test-regressions.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceFiles = ['constants.gs', 'config.gs', 'bootstrap.gs', 'reader.gs', 'enricher.gs',
  'writer.gs', 'reconciler.gs', 'tests.gs', 'matchingRegressionTests.gs', 'coach.gs', 'webhook.gs', 'callbacks.gs'];
function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(value); value = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += ch;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
function context() {
  const logs = [], props = {};
  const c = {
    Logger: { log: value => logs.push(String(value)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props[key] || null, setProperty: (key, value) => { props[key] = value; }
    }) },
    Utilities: {
      parseCsv, getUuid: () => crypto.randomUUID(),
      computeDigest: (_, text) => Array.from(crypto.createHash('sha256').update(text).digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      formatDate: (date, tz, fmt) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz,
          year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
        return ({ yyyy: parts.year, M: String(+parts.month), d: String(+parts.day),
          'dd.MM.yyyy': `${parts.day}.${parts.month}.${parts.year}` })[fmt] || '';
      }
    }
  };
  vm.createContext(c);
  for (const file of sourceFiles) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), c, { filename: file });
  c.logs = logs;
  return c;
}
let passed = 0, assertions = 0;
function test(name, run) {
  try { run(context()); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}
for (const file of fs.readdirSync(root).filter(f => f.endsWith('.gs'))) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}
for (const name of ['test_normalizeRows', 'test_findMissing', 'test_filterNonSpend',
  'test_cleanMerchantDisplayName', 'test_computeMerchantSimilarity',
  'test_dbsMultiSectionAndCardholderMatching', 'test_locationSuffixStrippingAndMultiFactorMatching',
  'test_ambiguousInferencePipeline', 'test_grabAmbiguityAndConflictCheck', 'test_geminiTier3', 'test_reportedMerchantDuplicates', 'test_netsFlashpayDuplicate', 'test_claimedLedgerDuplicateReview', 'test_statementCardIdentityGuard']) {
  test(name, c => {
    c[name]();
    assert.equal(c.logs.filter(l => l.includes('❌ FAIL')).length, 0);
    assertions += c.logs.filter(l => l.includes('✅ PASS')).length;
  });
}
const purchase = (id, date, extra = {}) => ({ id, date, merchant: 'Popular Bookstores', amount: 20, account: 'DBS CC SGD', ...extra });
function complete(c, statement, ledger) {
  const result = c.findMissing(statement, ledger);
  const ids = [...result.matched, ...result.missing, ...result.ambiguous].map(r => r.id).sort();
  assert.deepEqual(Array.from(ids), statement.map(r => r.id).sort());
  return result;
}
test('every competing occurrence is classified in either input order', c => {
  const statement = [purchase('later', '17.08.2026'), purchase('same-day', '15.08.2026')];
  const ledger = [purchase('ledger', '15.08.2026', { merchant: 'POPULAR-POS 1' })];
  for (const order of [statement, [...statement].reverse()]) {
    const result = complete(c, order, ledger);
    assert.equal(result.matched.length, 1); assert.equal(result.missing[0].id, 'later');
  }
});
test('fuzzy candidates respect accounts and explicit cardholders', c => {
  const statement = [purchase('statement', '15.08.2026', { cardholder: 'Rita' })];
  for (const extra of [{ account: 'Citi SGD' }, { notes: 'Val' }]) {
    const result = complete(c, statement, [purchase('ledger', '16.08.2026', extra)]);
    assert.equal(result.matched.length, 0); assert.equal(result.missing.length, 1);
  }
});
test('matcher is independent of Script Properties and accepts an alias snapshot', c => {
  c.PropertiesService.getScriptProperties = () => { throw new Error('Unexpected I/O'); };
  const result = c.findMissing([purchase('s', '15.08.2026', { merchant: 'merchant alpha' })],
    [purchase('l', '16.08.2026', { merchant: 'merchant omega' })],
    { 'merchant alpha': { canonical: 'shared brand' }, 'merchant omega': { canonical: 'shared brand' } });
  assert.equal(result.matched.length, 1);
});
test('number parsers retain separate reader and statement contracts', c => {
  assert.equal(c.parseAmountNumber('S$1 234,56'), 1234.56);
  assert.equal(c.parseAmountNumber('', '1.234,56'), 1234.56);
  assert.equal(c.parseStatementAmountNumber('1,234.56 CR'), -1234.56);
  assert.equal(c.parseStatementAmountNumber('S$1 234,56'), 1234.56);
  assert.equal(c.parseStatementAmountNumber(''), null);
  vm.runInContext(fs.readFileSync(path.join(root, 'reader.gs'), 'utf8').split('const DEBUG_503020')[0], c);
  assert.equal(c.parseStatementAmountNumber('20 CR'), -20);
});
test('failed directly invoked assertions throw, including numeric assertions', c => {
  assert.throws(() => c.assertEq(1, 2, 'deliberate failure'), /Assertion failed/);
  assert.throws(() => c.assertClose(1, 2, 0.01, 'deliberate failure'), /Assertion failed/);
});
test('GET actions cannot access services or run diagnostics', c => {
  let output = '';
  c.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: text => {
    output = text; return { setMimeType: () => output };
  } };
  c.runLiveReconcile = () => { throw new Error('Unexpected mutation'); };
  c.PropertiesService = c.SpreadsheetApp = c.DriveApp = new Proxy({}, { get: () => { throw new Error('Unexpected service'); } });
  for (const action of ['run_live_reconcile', 'run_unit_tests', 'check_spreadsheets', '']) {
    c.doGet({ parameter: { action } }); assert.deepEqual(JSON.parse(output), { status: 'OK', message: 'Ready' });
  }
});
test('coach does not turn a daily shortfall into monthly overspend', c => {
  c.getDailyPacing = () => ({ K_cumulative_today: -500, D19_realistic_daily: -100, D17_flat_daily: 200, days_left: 3 });
  c.get503020Status = () => ({}); c.getTodaySpend = () => 0; c.getCurrentMonthCategorySplits = () => ({});
  const payload = c.buildCoachPayload('daily', {});
  assert.equal(payload.over_budget_by, undefined);
  assert.match(c.buildFallbackCoachBrief(payload), /already spent/);
  assert.doesNotMatch(c.buildFallbackCoachBrief(payload), /S\$100/);
  c.getDailyPacing = () => ({ error: 'missing_month' });
  const missing = c.buildCoachPayload('daily', {});
  assert.match(c.generateCoachBrief(missing), /tab is missing/);
});
// In-memory sheet double: verifies values, destinations, statuses and locking.
// It records formula copy requests; it deliberately does NOT simulate Sheets formula evaluation.
class Sheet {
  constructor(name, data = []) { this.name = name; this.data = data; this.copies = []; this.validations = new Map(); }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getMaxRows() { return 100; }
  clear() { this.data = []; }
  clearConditionalFormatRules() {}
  setFrozenRows() {}
  setColumnWidth() {}
  copyTo(ss) { const clone = new Sheet('Copy', structuredClone(this.data)); ss.archives.push(clone); return clone; }
  getRange(row, col, height = 1, width = 1) {
    const sheet = this;
    const range = {
      getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => sheet.data[row - 1 + r]?.[col - 1 + c] ?? '')),
      setValues: values => { values.forEach((r, ri) => r.forEach((v, ci) => {
        sheet.data[row - 1 + ri] ||= []; sheet.data[row - 1 + ri][col - 1 + ci] = v;
      })); return range; },
      setValue: value => range.setValues([[value]]),
      getFormula: () => '=F2-D2',
      copyTo: target => sheet.copies.push(target),
      setNumberFormat: () => range, setFontWeight: () => range, setBackground: () => range,
      setFontColor: () => range, setHorizontalAlignment: () => range, setBackgrounds: () => range,
      insertCheckboxes: () => range, setDataValidation: rule => { sheet.validations.set(col, rule); return range; }
    };
    return range;
  }
}
const headers = ['✓', 'date', 'account', 'Cardholder', 'Тип', 'amount', 'merchant', 'proposed category', 'proposed bucket', 'confidence', 'source_row', 'status'];
function storage(c) {
  const ledger = new Sheet('Transactions', [['header'], ['15.08.2026', 'DBS CC SGD', 'Расходы', 20, 20, 100, 80, 'Другое', 'Old Merchant', '', 'Wants']]);
  const staging = new Sheet('_Reconcile', [headers]);
  const ss = { archives: [], getSheetByName: name => ({ Transactions: ledger, _Reconcile: staging })[name] || null };
  const lock = { held: false, acquired: 0, released: 0, hasLock() { return this.held; },
    tryLock() { assert.equal(this.held, false); this.held = true; this.acquired++; return true; },
    releaseLock() { assert.equal(this.held, true); this.held = false; this.released++; } };
  c.LockService = { getScriptLock: () => lock };
  c.SpreadsheetApp = { getActiveSpreadsheet: () => ss, flush: () => {} };
  c.getCategoryBucketMap = selected => { assert.equal(selected, ss); return { 'Другое': 'Wants' }; };
  c.getTransactionsSheet = selected => { assert.equal(selected, ss); assert.equal(lock.held, true); return ledger; };
  return { ledger, staging, ss, lock };
}
function staged(merchant, amount = 20) { return [true, '15.08.2026', 'DBS CC SGD', 'Val', 'Расходы', amount, merchant, 'Другое', 'Wants', 1, 'Statement row', 'proposed']; }
test('commit dry-run, mixed duplicates, real write, and repeat preserve correct statuses', c => {
  const { ledger, staging, ss, lock } = storage(c);
  staging.data.push(staged('Old Merchant'), staged('New Merchant', 30));
  const dry = c.commitStaged(false, true, ss);
  assert.equal(dry.committedCount, 1); assert.equal(ledger.data.length, 2);
  assert.equal(staging.data[1][11], 'proposed'); assert.equal(staging.data[2][11], 'proposed');
  const real = c.commitStaged(false, false, ss);
  assert.equal(real.committedCount, 1); assert.equal(real.skippedCount, 1);
  assert.equal(staging.data[1][11], 'duplicate_review'); assert.equal(staging.data[2][11], 'imported');
  assert.equal(ledger.data[2].length, 11); assert.equal(ledger.data[2][9], ''); assert.equal(ledger.data[2][10], 'Wants');
  assert.equal(ledger.copies.length, 1);
  const again = c.commitStaged(false, false, ss);
  assert.equal(again.committedCount, 0); assert.equal(ledger.data.length, 3);
  assert.equal(lock.acquired, lock.released);
});
test('ordinary explicit writes work while reconciliation defaults to dry-run', c => {
  const { ledger, ss, lock } = storage(c);
  const txn = { date: '16.08.2026', account: 'DBS CC SGD', amount: 30, where: 'New Merchant', category: 'Другое' };
  assert.equal(c.appendTransactions([txn], ss).dryRun, true); assert.equal(ledger.data.length, 2);
  assert.equal(c.appendTransactions([txn], ss, false).writtenCount, 1); assert.equal(ledger.data.length, 3);
  assert.equal(lock.acquired, lock.released);
});
test('staging rerun archives review edits and releases lock; no merchant learning writes', c => {
  const { staging, ss, lock } = storage(c);
  staging.data.push(staged('Edited Merchant')); const before = structuredClone(staging.data);
  c.persistLearnedMerchantsBatch = c.cleanBadGrabAliasFromMerchantsTab = () => { throw new Error('Unapproved learning write'); };
  c.stageProposals([], [], ss, []);
  assert.equal(ss.archives.length, 1); assert.deepEqual(ss.archives[0].data, before);
  assert.equal(staging.data.length, 1); assert.equal(lock.acquired, lock.released);
});
test('archive failure does not erase pending review and releases lock', c => {
  const { staging, ss, lock } = storage(c);
  staging.data.push(staged('Edited Merchant')); const before = structuredClone(staging.data);
  staging.copyTo = () => { throw new Error('copy failed'); };
  assert.throws(() => c.stageProposals([], [], ss, []), /copy failed/);
  assert.deepEqual(staging.data, before); assert.equal(lock.acquired, lock.released);
});
test('mandatory reader satisfies zero-planned and CPF without overriding real unpaid items', c => {
  const data = [['Родители', 0, '', false], ['CPF', 2000, '', false], ['Квартира', 100, '', false]];
  c.getActiveMonthTab = () => ({ exists: true, sheet: { getRange: () => ({ getValues: () => data, getDisplayValues: () => data }) } });
  assert.deepEqual(Array.from(c.getMandatoryExpenses({}), r => r.paidFlag), [true, true, false]);
});
for (const action of ['approve:token', 'force_all:token', 'skip_dups:token', 'resolve_dup:token:0:force']) {
  test(`Telegram ${action.split(':')[0]} writes before acknowledging and clearing`, c => {
    const { ledger, ss } = storage(c);
    const pending = [{ date: '16.08.2026', account: 'DBS CC SGD', amount: 30, where: 'New Merchant', category: 'Другое', flags: [] }];
    c.getPendingTransactions = () => pending;
    c.flagExistingDuplicates = rows => rows;
    c.savePendingTransactions = c.updateMerchantLearningStore = () => {};
    c.findNextUnresolvedDuplicate = () => -1;
    let cleared = false;
    c.clearPendingTransactions = () => { assert.equal(ledger.data.length, 3); cleared = true; };
    c.answerCallbackQuery = c.editTelegramMessage = c.sendDiscardedMessage = () => { assert.equal(ledger.data.length, 3); };
    c.formatTransactionConfirmationHtml = () => 'Saved';
    const original = c.appendTransactions;
    c.appendTransactions = (rows, selected, dry) => {
      assert.equal(dry, false); return original(rows, ss, dry);
    };
    c.handleCallbackQuery({ id: 'query', data: action, message: { message_id: 1, chat: { id: 1 } } });
    assert.equal(cleared, true);
  });
}
test('nonempty staging keeps provisional model categories out of merchant learning', c => {
  const { staging, ss } = storage(c);
  c.getCategoryBucketMap = () => ({ 'Другое': 'Wants', 'Дом': 'Wants' });
  c.PropertiesService.getScriptProperties = () => ({ getProperty: key => key === 'GEMINI_API_KEY' ? 'mock-key' : null });
  c.inferCategoriesWithGeminiBatch = () => ({ 'unknown merchant': { category: 'Дом', clean_display_name: 'Unknown Merchant' } });
  c.persistLearnedMerchantsBatch = c.cleanBadGrabAliasFromMerchantsTab = () => { throw new Error('Unapproved learning write'); };
  const result = c.stageProposals([{ date: '16.08.2026', account: 'DBS CC SGD', merchant: 'Unknown Merchant', amount: 30 }], [], ss,
    [{ date: '15.08.2026', account: 'DBS CC SGD', where: 'Old Merchant', amount: 20, category: 'Другое' }]);
  assert.equal(result.stagedCount, 1); assert.equal(staging.data[1][7], 'Дом');
});
test('explicit null API key never falls back to the configured secret', c => {
  c.PropertiesService.getScriptProperties = () => ({ getProperty: () => 'configured-key' });
  let calls = 0;
  c.callGeminiApiWithRetry = () => { calls++; throw new Error('Unexpected network call'); };
  assert.equal(Object.keys(c.inferCategoriesWithGeminiBatch([{ id: 1, raw_descriptor: 'TEST' }], ['Дом'], [], null)).length, 0);
  assert.equal(calls, 0);
  c.test_geminiTier3();
  assert.equal(calls, 0);
});
test('canonical defaults ignore live aliases; supplied display aliases share brand identity', c => {
  c.PropertiesService.getScriptProperties = () => ({ getProperty: () => JSON.stringify({ 'simplygo auto topup': { canonical: 'SimplyGo Auto Topup' } }) });
  c.test_locationSuffixStrippingAndMultiFactorMatching();
  assert.equal(c.resolveCanonicalMerchant('SimplyGo Auto Topup'), 'simplygo');
  assert.equal(c.resolveCanonicalMerchant('Custom Transit', { 'custom transit': { canonical: 'SimplyGo Auto Topup' } }), 'simplygo');
});
test('coach rejects an invented dining cap and retains grounded monetary amounts', c => {
  const payload = { cumulative_today: 54.31, realistic_daily: 236.52, flat_daily: 245.33,
    spend_today: 2.76, days_left_in_month: 22, categories_over_target: [] };
  assert.equal(c.coachMoneyIsGrounded('Cap dining at <b>S$50</b>.', payload), false);
  assert.equal(c.coachMoneyIsGrounded('Budget is S$236.52/day; S$54 ahead.', payload), true);
  assert.equal(c.coachMoneyIsGrounded('Spend S$22 today.', payload), false);
  c.PropertiesService.getScriptProperties = () => ({ getProperty: () => 'mock-key' });
  c.callGeminiApiWithRetry = () => ({ text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Cap dining out at S$50 today.' }] } }] }) });
  const brief = c.generateCoachBrief(payload);
  assert.equal(brief, c.buildFallbackCoachBrief(payload));
  assert.doesNotMatch(brief, /S\$50/);
});
test('live runner uses the latest configured CSV file', c => {
  let selected;
  c.runLiveReconcile = fileId => { selected = fileId; return { stagedCount: 0 }; };
  c.runLiveReconcile_runner();
  assert.equal(selected, '1Omhwqr2q5kLfZCa51Mj6igN3TPX032k0');
});
test('native Google Sheets input is rejected before implicit blob export', c => {
  let exported = false;
  const file = { getMimeType: () => 'application/vnd.google-apps.spreadsheet', getBlob: () => { exported = true; throw new Error('Exported'); } };
  assert.throws(() => c.runLiveReconcile(file), /original bank CSV/);
  assert.equal(exported, false);
});
test('DBS rows without card identity stop before reading or replacing staging', c => {
  const ss = { getSheetByName: () => { throw new Error('Unexpected sheet access'); } };
  assert.throws(() => c.reconcileAndStage({ account: 'DBS CC SGD', rows: [
    { date: '09.09.2026', amount: 10, merchant: 'Merchant', account: 'DBS CC SGD' }
  ] }, ss), /no card number/);
});
test('staging does not assign unidentified cardholders to Val', c => {
  const { staging, ss } = storage(c);
  c.stageProposals([{ date: '09.09.2026', amount: 10, merchant: 'Merchant', category: 'Другое' }], [], ss, []);
  assert.equal(staging.data[1][3], 'Unknown');
  assert.match(staging.data[1][10], /Cardholder missing/);
});
test('repair sets E types, clears G merchant validation and retains H categories without changing review', c => {
  const { staging } = storage(c);
  staging.data.push(staged('Edited Merchant', 30));
  const before = structuredClone(staging.data);
  staging.validations.set(7, { oldCategoryRule: true });
  c.SpreadsheetApp.newDataValidation = () => {
    const rule = {};
    const builder = { requireValueInList: (values, dropdown) => { rule.values = Array.from(values); rule.dropdown = dropdown; return builder; },
      setAllowInvalid: value => { rule.allowInvalid = value; return builder; }, build: () => rule };
    return builder;
  };
  c.repairReconcileDropdowns();
  assert.deepEqual(staging.data, before);
  assert.equal(staging.validations.get(7), null);
  assert.equal(staging.validations.get(5).values.length, 7);
  assert.ok(staging.validations.get(5).values.includes('Обязательные расходы'));
  assert.equal(staging.validations.get(5).allowInvalid, false);
  assert.deepEqual(staging.validations.get(8).values, ['Другое']);
});
test('Grandparents tag reaches final Notes column on real-mode mock commit', c => {
  const { staging, ledger, ss } = storage(c);
  const gp = staged('Grandparents Purchase', 31); gp[3] = 'Grandparents';
  const card = staged('Tagged Card Purchase', 32); card[3] = 'Unknown'; card[10] = '[Grandparents - Card 0465] Statement';
  staging.data.push(gp, card, staged('Val Purchase', 33));
  const result = c.commitStaged(false, false, ss);
  assert.equal(result.committedCount, 3);
  assert.deepEqual(ledger.data.slice(2).map(row => row[9]), ['Grandparents', 'Grandparents', '']);
  assert.equal(ledger.data[2][10], 'Wants');
});
test('commit honors edited expense/income types over the previous amount sign', c => {
  const { staging, ledger, ss } = storage(c);
  const expense = staged('Edited Fixed Expense', -31); expense[4] = 'Обязательные расходы';
  const income = staged('Edited Income', 32); income[4] = 'Доходы - премия';
  staging.data.push(expense, income);
  c.commitStaged(false, false, ss);
  assert.equal(ledger.data[2][2], 'Обязательные расходы'); assert.equal(ledger.data[2][3], 31);
  assert.equal(ledger.data[3][2], 'Доходы - премия');
  assert.equal(ledger.data[3][3], -32); // Mock G formula is F-D; incoming money must add to it.
});
test('preview always invokes the actual commit in dry-run mode', c => {
  let args;
  c.commitStaged = (...values) => { args = values; return { dryRun: true }; };
  assert.equal(c.previewReconcileCommit().dryRun, true);
  assert.deepEqual(args, [false, true]);
});
console.log(`${passed} tests passed; ${assertions} existing assertions checked; all .gs files parsed.`);
