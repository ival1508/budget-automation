// Offline tests only: no credentials, network, Google services, or live writes.
// Run: node scripts/test-regressions.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceFiles = ['constants.gs', 'config.gs', 'bootstrap.gs', 'calendar.gs', 'mandatory.gs', 'mandatoryCalendar.gs', 'monthlyInsights.gs', 'reader.gs', 'enricher.gs',
  'writer.gs', 'reconciler.gs', 'tests.gs', 'matchingRegressionTests.gs', 'testStage3G.gs', 'coach.gs', 'nudge.gs', 'webhook.gs', 'callbacks.gs', 'monthCreation.gs'];
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
    SpreadsheetApp: { flush: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props[key] || null, setProperty: (key, value) => { props[key] = value; },
      deleteProperty: key => { delete props[key]; }
    }) },
    Utilities: {
      parseCsv, base64Encode: bytes => Buffer.from(bytes).toString('base64'), getUuid: () => crypto.randomUUID(),
      computeDigest: (_, text) => Array.from(crypto.createHash('sha256').update(text).digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      formatDate: (date, tz, fmt) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz,
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
          hourCycle: 'h23', weekday: 'short' }).formatToParts(date).map(p => [p.type, p.value]));
        return ({ yyyy: parts.year, yy: parts.year.slice(-2), M: String(+parts.month), d: String(+parts.day),
          H: String(+parts.hour), m: String(+parts.minute), E: parts.weekday,
          'MM.yyyy': `${parts.month}.${parts.year}`, 'MM/yyyy': `${parts.month}/${parts.year}`,
          'M/yyyy': `${+parts.month}/${parts.year}`, 'yyyy-MM': `${parts.year}-${parts.month}`,
          'yyyy-MM-dd': `${parts.year}-${parts.month}-${parts.day}`, 'HH:mm': `${parts.hour}:${parts.minute}`,
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
test('missing sandbox ID stops resolution, native commit tests and commits before sheet access', c => {
  let sheetAccess = 0;
  c.SpreadsheetApp = {
    openById: () => { sheetAccess++; throw new Error('Unexpected open'); },
    getActiveSpreadsheet: () => { sheetAccess++; throw new Error('Unexpected live access'); }
  };
  for (const id of [undefined, null, '', '   ']) {
    c.sandboxIdForTest = id;
    vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID = sandboxIdForTest', c);
    assert.throws(() => c.getTargetSpreadsheet(true), /TEST_SPREADSHEET_ID is required/);
    assert.throws(() => c.test_commitStaged(), /TEST_SPREADSHEET_ID is required/);
    assert.throws(() => c.commitStaged(true, false), /TEST_SPREADSHEET_ID is required/);
    assert.throws(() => c.commitStaged(true, false, {}), /TEST_SPREADSHEET_ID is required/);
  }
  assert.equal(sheetAccess, 0);
});
test('sandbox access failure cannot fall back to the active workbook or mutate it', c => {
  let liveAccess = 0, opened = 0;
  c.SpreadsheetApp = {
    openById: () => { opened++; throw new Error('Sandbox access denied'); },
    getActiveSpreadsheet: () => { liveAccess++; throw new Error('Unexpected live access'); }
  };
  assert.throws(() => c.getTargetSpreadsheet(true), /Cannot open TEST_SPREADSHEET_ID.*Sandbox access denied/);
  assert.throws(() => c.test_commitStaged(), /Cannot open TEST_SPREADSHEET_ID/);
  assert.throws(() => c.commitStaged(true, false), /Cannot open TEST_SPREADSHEET_ID/);
  assert.equal(opened, 3); assert.equal(liveAccess, 0);
});
test('wrong or unverifiable sandbox identity is rejected before cleanup, locks or writes', c => {
  let mutations = 0;
  const wrong = { getId: () => 'live-workbook', getSheetByName: () => { mutations++; throw new Error('Unexpected sheet access'); } };
  c.SpreadsheetApp = { openById: () => wrong, getActiveSpreadsheet: () => { mutations++; return wrong; } };
  c.LockService = { getScriptLock: () => { mutations++; throw new Error('Unexpected lock'); } };
  assert.throws(() => c.test_commitStaged(), /Sandbox spreadsheet identity does not match/);
  assert.throws(() => c.commitStaged(true, false), /Sandbox spreadsheet identity does not match/);
  for (const returned of [null, {}, wrong]) {
    c.SpreadsheetApp.openById = () => returned;
    assert.throws(() => c.getTargetSpreadsheet(true), /Sandbox spreadsheet identity does not match/);
  }
  for (const dry of [true, false]) {
    assert.throws(() => c.commitStaged(true, dry, wrong), /Sandbox spreadsheet identity does not match/);
    assert.throws(() => c.commitStaged(true, dry, {}), /Sandbox spreadsheet identity does not match/);
  }
  assert.equal(mutations, 0);
});
test('verified sandbox can be reused without reopening and ordinary targets still resolve normally', c => {
  const sandboxId = vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID', c);
  const sandbox = { getId: () => sandboxId }, active = { getId: () => 'active-workbook' };
  let opened = 0, activeReads = 0;
  c.SpreadsheetApp = {
    openById: id => { opened++; assert.equal(id, sandboxId); return sandbox; },
    getActiveSpreadsheet: () => { activeReads++; return active; }
  };
  vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID = "  " + SHEET_FACTS.TEST_SPREADSHEET_ID + "  "', c);
  assert.equal(c.getTargetSpreadsheet(true), sandbox);
  assert.equal(c.getTargetSpreadsheet(true, sandbox), sandbox);
  assert.equal(opened, 1); assert.equal(activeReads, 0);
  assert.equal(c.getTargetSpreadsheet(false), active);
  assert.equal(c.getTargetSpreadsheet(false, sandbox), sandbox);
  assert.equal(activeReads, 1);
});
for (const name of ['test_normalizeRows', 'test_findMissing', 'test_filterNonSpend', 'test_feeReversalPairing',
  'test_cleanMerchantDisplayName', 'test_computeMerchantSimilarity',
  'test_dbsMultiSectionAndCardholderMatching', 'test_locationSuffixStrippingAndMultiFactorMatching',
  'test_ambiguousInferencePipeline', 'test_grabAmbiguityAndConflictCheck', 'test_geminiTier3', 'test_reportedMerchantDuplicates', 'test_netsFlashpayDuplicate', 'test_claimedLedgerDuplicateReview', 'test_statementCardIdentityGuard', 'test_stage3GInboxRetries', 'test_stage3GInboxFailures', 'test_stage3GRecoveryMarker', 'test_stage3GMenuAndScheduler', 'test_stage3GModelCardSections', 'test_stage3GChangedFile', 'test_reconcileDateValues', 'test_transactionDerivedFormulaBuilders']) {
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
  constructor(name, data = []) { this.name = name; this.data = data; this.copies = []; this.validations = new Map(); this.formats = new Map(); }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getMaxRows() { return 100; }
  clear() { this.data = []; }
  deleteRows(row, count) { this.data.splice(row - 1, count); }
  clearConditionalFormatRules() {}
  setFrozenRows() {}
  setColumnWidth() {}
  copyTo(ss) { const clone = new Sheet('Copy', structuredClone(this.data)); ss.archives.push(clone); return clone; }
  getRange(row, col, height = 1, width = 1) {
    const sheet = this;
    const range = {
      getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => sheet.data[row - 1 + r]?.[col - 1 + c] ?? '')),
      getDisplayValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => String(sheet.data[row - 1 + r]?.[col - 1 + c] ?? ''))),
      setValues: values => { values.forEach((r, ri) => r.forEach((v, ci) => {
        sheet.data[row - 1 + ri] ||= []; sheet.data[row - 1 + ri][col - 1 + ci] = v;
      })); return range; },
      setFormulas: values => range.setValues(values),
      getFormulas: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => {
        const value = sheet.data[row - 1 + r]?.[col - 1 + c];
        return typeof value === 'string' && value.startsWith('=') ? value : '';
      })),
      setValue: value => range.setValues([[value]]),
      getFormula: () => '=F2-D2',
      copyTo: target => sheet.copies.push(target),
      setNumberFormat: format => { sheet.formats.set(col, format); return range; }, setFontWeight: () => range, setBackground: () => range,
      setFontColor: () => range, setHorizontalAlignment: () => range, setBackgrounds: () => range,
      insertCheckboxes: () => range, setDataValidation: rule => { sheet.validations.set(col, rule); return range; }
    };
    return range;
  }
}
const headers = ['✓', 'date', 'account', 'Cardholder', 'Тип', 'amount', 'merchant', 'proposed category', 'proposed bucket', 'confidence', 'source_row', 'status'];
const transactionHeaders = ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где', 'Notes', '50/30/20 Category'];
function storage(c) {
  const ledger = new Sheet('Transactions', [transactionHeaders, ['15.08.2026', 'DBS CC SGD', 'Расходы', 20, 20, 100, 80, 'Другое', 'Old Merchant', '', 'Wants']]);
  const staging = new Sheet('_Reconcile', [headers]);
  const reference = new Sheet('-', [['', 'Категория', '50/30/20'], ['', 'Другое', 'Wants'], ['', 'Транспорт', 'Needs']]);
  const sheets = { Transactions: ledger, _Reconcile: staging, '-': reference };
  const ss = { archives: [], getSheetByName: name => sheets[name] || null,
    insertSheet: name => (sheets[name] = new Sheet(name)) };
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
test('sandbox dry-run and real commit reuse the verified instance and remain idempotent', c => {
  const { ledger, staging, ss } = storage(c);
  const sandboxId = vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID', c);
  ss.getId = () => sandboxId;
  let opened = 0;
  c.SpreadsheetApp.openById = id => { opened++; assert.equal(id, sandboxId); return ss; };
  c.SpreadsheetApp.getActiveSpreadsheet = () => { throw new Error('Unexpected live access'); };
  const sandbox = c.getTargetSpreadsheet(true);
  c.SpreadsheetApp.openById = () => { throw new Error('Verified sandbox must not be reopened'); };
  staging.data.push(staged('Sandbox purchase', 30));
  const dry = c.commitStaged(true, true, sandbox);
  assert.equal(dry.committedCount, 1); assert.equal(ledger.data.length, 2);
  const real = c.commitStaged(true, false, sandbox);
  assert.equal(real.committedCount, 1); assert.equal(ledger.data.length, 3);
  assert.equal(c.commitStaged(true, false, sandbox).committedCount, 0);
  assert.equal(ledger.data.length, 3); assert.equal(opened, 1);
});
test('native commit test passes its already-verified sandbox to the commit path', c => {
  const { ss } = storage(c);
  ss.getId = () => vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID', c);
  let opened = 0, commitCalls = 0;
  c.SpreadsheetApp.openById = () => { opened++; return ss; };
  c.SpreadsheetApp.getActiveSpreadsheet = () => { throw new Error('Unexpected live access'); };
  const stop = new Error('Stop before actual commit');
  c.commitStaged = (useTest, dry, selected) => {
    commitCalls++; assert.equal(useTest, true); assert.equal(dry, true); assert.equal(selected, ss);
    throw stop;
  };
  assert.throws(() => c.test_commitStaged(), error => error === stop);
  assert.equal(opened, 1); assert.equal(commitCalls, 1);
});
test('commit dry-run, mixed duplicates, real write, and repeat preserve correct statuses', c => {
  const { ledger, staging, ss, lock } = storage(c);
  staging.data.push(staged('Old Merchant'), staged('New Merchant', 30));
  const dry = c.commitStaged(false, true, ss);
  assert.equal(dry.committedCount, 1); assert.equal(ledger.data.length, 2);
  assert.equal(staging.data[1][11], 'proposed'); assert.equal(staging.data[2][11], 'proposed');
  const real = c.commitStaged(false, false, ss);
  assert.equal(real.committedCount, 1); assert.equal(real.skippedCount, 1);
  assert.equal(staging.data[1][11], 'duplicate_review'); assert.equal(staging.data[2][11], 'imported');
  assert.equal(ledger.data[2].length, 11); assert.equal(ledger.data[2][9], '');
  assert.equal(ledger.data[2][4], c.transactionAmountSgdFormula(3));
  assert.equal(ledger.data[2][10], c.transactionBucketFormula(3));
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
test('existing Transactions rows can be migrated to row-local E and K formulas', c => {
  const { ledger, ss, lock } = storage(c);
  const originalD = ledger.data[1][3]; const originalH = ledger.data[1][7];
  const result = c.repairTransactionDerivedFormulas(ss);
  assert.equal(result.updatedRows, 1);
  assert.equal(ledger.data[1][3], originalD); assert.equal(ledger.data[1][7], originalH);
  assert.equal(ledger.data[1][4], c.transactionAmountSgdFormula(2));
  assert.equal(ledger.data[1][10], c.transactionBucketFormula(2));
  assert.equal(lock.acquired, lock.released);
});
test('Transactions formula repair validates layout before changing either column', c => {
  const { ledger, ss, lock } = storage(c);
  ledger.data[0][4] = 'Unexpected';
  const before = structuredClone(ledger.data);
  assert.throws(() => c.repairTransactionDerivedFormulas(ss), /layout is unexpected/);
  assert.deepEqual(ledger.data, before);
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
  assert.equal(typeof staging.data[1][1], 'number');
  assert.equal(c.reconcileDateString(staging.data[1][1], ss), '09.09.2026');
  assert.equal(staging.formats.get(2), 'dd.MM.yyyy');
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
  assert.equal(ledger.data[2][10], c.transactionBucketFormula(3));
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
  let args, html, shown = 0;
  const ss = {};
  c.SpreadsheetApp.getActiveSpreadsheet = () => ss;
  c.HtmlService = { createHtmlOutput: value => {
    html = value;
    return { setWidth() { return this; }, setHeight() { return this; } };
  } };
  c.SpreadsheetApp.getUi = () => ({ showModalDialog: () => { shown++; } });
  c.commitStaged = (...values) => { args = values; return { dryRun: true }; };
  assert.equal(c.previewReconcileCommit().dryRun, true);
  assert.deepEqual(args, [false, true, ss]);
  assert.equal(shown, 1);
  assert.match(html, /No eligible rows would be appended/);
});
test('Sheets preview shows actual writer rows and duplicate identities without changing review or ledger', c => {
  const { staging, ledger, ss, lock } = storage(c);
  let html, dialogs = 0;
  c.HtmlService = { createHtmlOutput: value => {
    html = value;
    return { setWidth() { return this; }, setHeight() { return this; } };
  } };
  c.SpreadsheetApp.getUi = () => ({ showModalDialog: () => { assert.equal(lock.held, false); dialogs++; } });
  const credit = staged('Approved Refund', -31); credit[4] = 'Получение денег';
  const gp = staged('Grandparents Purchase', 32); gp[3] = 'Grandparents';
  const unticked = staged('Leave Pending', 33); unticked[0] = false;
  staging.data.push(staged('Old Merchant'), credit, gp, staged('Grandparents Purchase', 32), unticked);
  const originalReview = structuredClone(staging.data), originalLedger = structuredClone(ledger.data);
  const result = c.previewReconcileCommit();
  assert.equal(result.committedCount, 2); assert.equal(result.skippedCount, 2);
  assert.deepEqual(Array.from(result.rowOutcomes, row => [row.stagingRow, row.status]),
    [[2, 'duplicate_review'], [3, 'would_import'], [4, 'would_import'], [5, 'duplicate_review']]);
  for (const row of result.rows2D) for (const column of [0, 1, 2, 3, 7, 8, 9]) {
    if (row[column] !== '') assert.ok(html.includes(String(row[column])));
  }
  assert.ok(html.includes(c.transactionAmountSgdFormula(3).replace(/"/g, '&quot;')));
  assert.ok(html.includes(c.transactionBucketFormula(4).replace(/"/g, '&quot;').replace(/'/g, '&#39;')));
  assert.match(html, /Review row 2:.*Old Merchant/);
  assert.match(html, /Review row 5:.*Grandparents Purchase/);
  assert.ok(!html.includes('Leave Pending'));
  assert.match(html, /does not calculate their results/);
  assert.deepEqual(staging.data, originalReview); assert.deepEqual(ledger.data, originalLedger);
  assert.equal(ledger.copies.length, 0); assert.equal(ss.getSheetByName('_ReconcileHistory'), null);
  assert.equal(c.previewReconcileCommit().committedCount, 2);
  assert.deepEqual(staging.data, originalReview); assert.deepEqual(ledger.data, originalLedger);
  staging.data = [headers, staged('Old Merchant')];
  assert.equal(c.previewReconcileCommit().committedCount, 0);
  assert.match(html, /No eligible rows would be appended/); assert.match(html, /Review row 2:/);
  staging.data = [headers];
  assert.equal(c.previewReconcileCommit().committedCount, 0);
  assert.match(html, /No eligible rows would be appended/);
  assert.equal(dialogs, 4);
});
test('preview escapes all bank and reviewed text and exposes no executable import controls', c => {
  const malicious = '<script>alert("bank")</script>&';
  const html = c.buildReconcileCommitPreviewHtml({ committedCount: 1, skippedCount: 1,
    rows2D: [[malicious, 'DBS CC SGD', 'Расходы', 31, '=D3', '', '', malicious, malicious, malicious, '=H3']],
    rowOutcomes: [{ stagingRow: 2, status: 'would_import' }, { stagingRow: 3, status: 'duplicate_review',
      transaction: { date: malicious, account: malicious, where: malicious, amount: 31 } }] });
  assert.ok(!html.includes(malicious));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;bank&quot;)&lt;/script&gt;&amp;'));
  assert.ok(!/<script|onclick|google\.script\.run|<button/i.test(html));
});
test('Drive pipeline appends, preserves review, and deduplicates overlapping files', c => {
  const { staging, ledger, ss } = storage(c);
  staging.data.push(staged('Reviewed Merchant', 45));
  const before = structuredClone(staging.data[1]);
  const statement = { account: 'DBS CC SGD', rows: [
    { date: '20.08.2026', amount: 31, merchant: 'New Shop', card_last4: '0465', type: 'PURCHASE' }
  ] };
  const first = c.reconcileAndStage(statement, ss, { append: true, fileId: 'first' });
  assert.equal(first.stagedCount, 1);
  assert.deepEqual(staging.data[1], before);
  assert.equal(staging.data[2][3], 'Grandparents');
  assert.match(staging.data[2][10], /^\[Drive:first\]/);
  assert.equal(ledger.data.length, 2);
  const second = c.reconcileAndStage(statement, ss, { append: true, fileId: 'overlap' });
  assert.equal(second.stagedCount, 0);
  assert.equal(second.matchedCount, 1);
  assert.equal(staging.data.length, 3);
  assert.equal(ss.archives.length, 0);
});
test('append rejects old staging layout without changing review', c => {
  const { staging, ss } = storage(c);
  staging.data[0] = ['old layout']; staging.data.push(staged('Keep me'));
  const before = structuredClone(staging.data);
  assert.throws(() => c.stageProposals([], [], ss, [], { append: true }), /layout is outdated/);
  assert.deepEqual(staging.data, before);
});
test('menu import explicitly writes reviewed rows and moves them into history', c => {
  const { staging, ledger, ss } = storage(c); ss.toast = () => {};
  staging.data.push(staged('Menu Purchase', 50));
  const result = c.importReviewedReconciliation();
  assert.equal(result.committedCount, 1); assert.equal(ledger.data.length, 3);
  assert.equal(staging.data.length, 1);
  assert.equal(ss.getSheetByName('_ReconcileHistory').data[1][11], 'imported');
  assert.equal(c.importReviewedReconciliation().committedCount, 0);
});
test('date repair preserves review, handles mixed cells, and is repeatable', c => {
  const { staging, ss } = storage(c);
  ss.getSpreadsheetTimeZone = () => 'Asia/Singapore';
  const nativeDate = vm.runInContext("new Date('2026-08-31T16:00:00Z')", c);
  for (const date of ['31.08.2026', nativeDate, '', '09.07.2026']) {
    const row = staged('Keep edited merchant'); row[1] = date; staging.data.push(row);
  }
  const otherColumns = () => staging.data.map(row => row.filter((_, index) => index !== 1));
  const before = structuredClone(otherColumns());
  c.repairReconcileDates();
  assert.deepEqual(otherColumns(), before);
  assert.equal(staging.formats.get(2), 'dd.MM.yyyy');
  assert.equal(staging.data[2][1], staging.data[1][1] + 1);
  assert.equal(staging.data[3][1], '');
  const repaired = structuredClone(staging.data);
  c.repairReconcileDates();
  assert.deepEqual(staging.data, repaired);
  assert.equal(c.readPendingReconcileRows(ss)[1].date, '01.09.2026');
});
test('invalid repair changes no cells and releases the lock', c => {
  const { staging, lock } = storage(c);
  staging.data.push(staged('Keep'), staged('Invalid'));
  staging.data[2][1] = '31.02.2026';
  const before = structuredClone(staging.data);
  assert.throws(() => c.repairReconcileDates(), /Row 3: Invalid staging date/);
  assert.deepEqual(staging.data, before);
  assert.equal(lock.held, false);
});
test('real date cells import with correct day and remain idempotent', c => {
  const { staging, ledger, ss } = storage(c);
  ss.getSpreadsheetTimeZone = () => 'Asia/Singapore';
  const row = staged('September purchase', 30);
  row[1] = vm.runInContext("new Date('2026-08-31T16:00:00Z')", c);
  staging.data.push(row);
  assert.equal(c.readPendingReconcileRows(ss)[0].date, '01.09.2026');
  assert.equal(c.commitStaged(false, false, ss).committedCount, 1);
  assert.equal(ledger.data[2][0], '01.09.2026');
  assert.equal(c.commitStaged(false, false, ss).committedCount, 0);
});
for (const name of ['test_reviewQueueArchiveRecovery', 'test_reviewQueueDismissalMatching', 'test_refreshPendingReviewMatching']) {
  test(name, c => {
    c[name]();
    assert.equal(c.logs.filter(l => l.includes('❌ FAIL')).length, 0);
    assertions += c.logs.filter(l => l.includes('✅ PASS')).length;
  });
}
test('selected dismissal archives only the selection with reason and never imports', c => {
  const { staging, ledger, ss } = storage(c);
  staging.data.push(staged('Keep checked'), staged('Dismiss me'));
  const ledgerBefore = structuredClone(ledger.data);
  ss.getActiveSheet = () => staging;
  ss.getActiveRangeList = () => ({ getRanges: () => [{ getRow: () => 3, getLastRow: () => 3 }] });
  ss.toast = () => {};
  c.SpreadsheetApp.getUi = () => ({ ButtonSet: { OK_CANCEL: 1 }, Button: { OK: 'OK' },
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => 'Recorded in another account' }) });
  assert.equal(c.dismissSelectedReconcileRows(), 1);
  assert.deepEqual(ledger.data, ledgerBefore);
  assert.equal(staging.data.length, 2);
  assert.equal(staging.data[1][6], 'Keep checked');
  assert.equal(staging.data[1][0], true);
  const archived = ss.getSheetByName('_ReconcileHistory').data[1];
  assert.equal(archived[11], 'dismissed');
  assert.equal(archived[12], 'Recorded in another account');
});
test('dismissal cancellation and concurrent review changes preserve pending rows', c => {
  const { staging, ss } = storage(c);
  staging.data.push(staged('Keep'));
  ss.getActiveSheet = () => staging;
  ss.getActiveRangeList = () => ({ getRanges: () => [{ getRow: () => 2, getLastRow: () => 2 }] });
  const ui = { ButtonSet: { OK_CANCEL: 1 }, Button: { OK: 'OK' },
    prompt: () => ({ getSelectedButton: () => 'CANCEL' }) };
  c.SpreadsheetApp.getUi = () => ui;
  assert.equal(c.dismissSelectedReconcileRows(), 0);
  assert.equal(staging.data[1][11], 'proposed');
  ui.prompt = () => {
    staging.data[1][6] = 'Concurrent edit';
    return { getSelectedButton: () => 'OK', getResponseText: () => '' };
  };
  assert.throws(() => c.dismissSelectedReconcileRows(), /review changed/);
  assert.equal(staging.data[1][11], 'proposed');
  assert.equal(ss.getSheetByName('_ReconcileHistory'), null);
});
test('dismissal survives edited fields and another upload through the actual pipeline', c => {
  const { staging, ss } = storage(c);
  const statement = { account: 'DBS CC SGD', rows: [
    { date: '20.08.2026', amount: 31, merchant: 'New Shop', card_last4: '0465', type: 'PURCHASE' }
  ] };
  assert.equal(c.reconcileAndStage(statement, ss, { append: true, fileId: 'first' }).stagedCount, 1);
  staging.data[1][6] = 'Reviewed name';
  staging.data[1][5] = 32;
  staging.data[1][11] = 'dismissed';
  c.withBudgetWriteLock(() => c.archiveCompletedReconcileRowsUnlocked(ss));
  const again = c.reconcileAndStage(statement, ss, { append: true, fileId: 'new-upload' });
  assert.equal(again.stagedCount, 0);
  assert.equal(again.reviewedExcludedCount, 1);
  assert.equal(staging.data.length, 1);
  assert.equal(c.stagingHasDriveFile(ss, 'first'), true);
});
test('archive write failure preserves completed rows for retry', c => {
  const { staging, ss } = storage(c);
  staging.data.push(staged('Completed'));
  staging.data[1][11] = 'imported';
  const insert = ss.insertSheet;
  ss.insertSheet = name => {
    const sheet = insert(name), getRange = sheet.getRange.bind(sheet);
    sheet.getRange = (row, ...args) => {
      const range = getRange(row, ...args);
      if (row > 1) range.setValues = () => { throw new Error('Archive write failed'); };
      return range;
    };
    return sheet;
  };
  assert.throws(() => c.withBudgetWriteLock(() => c.archiveCompletedReconcileRowsUnlocked(ss)), /Archive write failed/);
  assert.equal(staging.data[1][6], 'Completed');
  assert.equal(staging.data[1][11], 'imported');
});
test('dismissed rows are never imported even if ticked after archive failure', c => {
  const { staging, ledger, ss } = storage(c);
  staging.data.push(staged('Dismissed')); staging.data[1][11] = 'dismissed';
  assert.equal(c.commitStaged(false, false, ss).committedCount, 0);
  assert.equal(ledger.data.length, 2);
});
test('refresh archives recorded rows and preserves every pending edit without ledger writes', c => {
  const { staging, ledger, ss } = storage(c);
  ss.toast = () => {};
  const present = staged('Old Merchant'); present[0] = false;
  const pending = staged('New Purchase', 50);
  const uncertain = staged('Unrelated Merchant', 20); uncertain[11] = 'duplicate_review';
  staging.data.push(present, pending, uncertain);
  const beforeLedger = structuredClone(ledger.data), beforePending = structuredClone([pending, uncertain]);
  const result = c.refreshPendingReconciliation();
  assert.equal(result.reconciledCount, 1);
  assert.equal(result.remainingCount, 2);
  assert.deepEqual(staging.data.slice(1), beforePending);
  assert.deepEqual(ledger.data, beforeLedger);
  const history = ss.getSheetByName('_ReconcileHistory');
  assert.equal(history.data[1][11], 'reconciled');
  assert.match(history.data[1][12], /Already in Transactions row 2/);
  assert.equal(c.refreshPendingReconciliation().reconciledCount, 0);
  assert.equal(history.data.length, 2);
});
test('refresh interrupted after history write safely resumes and excludes completed rows from import', c => {
  const { staging, ledger, ss } = storage(c); ss.toast = () => {};
  staging.data.push(staged('Old Merchant'));
  const originalDelete = staging.deleteRows;
  staging.deleteRows = () => { throw new Error('Interrupted archive removal'); };
  assert.throws(() => c.refreshPendingReconciliation(), /Interrupted archive removal/);
  assert.equal(staging.data[1][11], 'reconciled');
  assert.equal(c.commitStaged(false, false, ss).committedCount, 0);
  assert.equal(c.readPendingReconcileRows(ss).length, 0);
  assert.equal(ledger.data.length, 2);
  staging.deleteRows = originalDelete;
  assert.equal(c.refreshPendingReconciliation().archivedCount, 1);
  assert.equal(staging.data.length, 1);
  assert.equal(ss.getSheetByName('_ReconcileHistory').data.length, 2);
});
test('refresh does not reuse an imported history occurrence after a later manual ledger addition', c => {
  const { staging, ledger, ss } = storage(c); ss.toast = () => {};
  ledger.data[1][9] = 'Val';
  staging.data.push(staged('Old Merchant'));
  c.refreshPendingReconciliation();
  staging.data.push(staged('Old Merchant'));
  assert.equal(c.refreshPendingReconciliation().reconciledCount, 0);
  ledger.data.push(ledger.data[1].slice());
  assert.equal(c.refreshPendingReconciliation().reconciledCount, 1);
  assert.equal(staging.data.length, 1);
});
test('screenshot merge preserves review edits, multiplicity and card/currency identity', c => {
  const old = { date: '11.09.2026', account: 'DBS CC SGD', amount: 12, where: 'Cafe', currency: 'SGD', type: 'Расходы', category: 'Edited category' };
  const fresh = { ...old, category: 'Model category' };
  const before = JSON.stringify(old);
  const result = c.mergeScreenshotProposals([old], [fresh, { ...fresh }, { ...fresh, currency: 'USD' }, { ...fresh, cardholder: 'Grandparents' }]);
  assert.equal(result.length, 4);
  assert.equal(result[0], old);
  assert.equal(JSON.stringify(old), before);
  assert.equal(c.mergeScreenshotProposals(result, [fresh]).length, 4);
});
function photoWebhookFixture(c) {
  const scriptProps = c.PropertiesService.getScriptProperties();
  scriptProps.setProperty('WEBHOOK_SECRET', 'offline-webhook-secret');
  scriptProps.setProperty('AUTHORIZED_CHAT_IDS', '42');
  vm.runInContext('SHEET_FACTS.USERS = { OFFLINE: { chat_id: "42", active: true } }', c);
  const cache = new Map(), properties = { latest_token_42: 'active' };
  let held = false;
  c.CacheService = { getScriptCache: () => ({ get: key => cache.get(key) || null,
    put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) };
  c.PropertiesService.getUserProperties = () => ({ getProperty: key => properties[key] || null,
    setProperty: (key, value) => { properties[key] = value; } });
  c.LockService = { getScriptLock: () => { throw new Error('Statement scanner owns the script lock'); },
    getUserLock: () => ({ waitLock: () => { assert.equal(held, false); held = true; }, releaseLock: () => { held = false; } }) };
  c.HtmlService = { createHtmlOutput: text => text };
  c.getTelegramFilePath = () => 'photo.jpg';
  c.fetchTelegramFileAsBase64 = () => ({ inlineData: { mimeType: 'image/jpeg', data: 'fake-photo' } });
  const previous = { date: '10.09.2026', account: 'DBS CC SGD', amount: 12, currency: 'SGD', where: 'Old Shop' };
  const incoming = { ...previous, date: '11.09.2026', where: 'New Shop' };
  let stored, delivered;
  c.getPendingTransactions = () => stored || [previous];
  c.savePendingTransactions = (rows, token) => { assert.equal(held, true); stored = rows; return token || 'fresh'; };
  c.sendConfirmationMessage = (_, token, rows) => { delivered = rows; };
  const run = (extra, updateId = 123) => c.doPost({ parameter: { secret: 'offline-webhook-secret' }, postData: { contents: JSON.stringify({ update_id: updateId, message: {
    chat: { id: 42 }, photo: [{ file_id: 'photo' }], ...extra
  } }) } });
  return { previous, incoming, run, held: () => held, stored: () => stored, delivered: () => delivered };
}
test('plain screenshot extracts outside locks without resending old rows, then merges latest state', c => {
  const f = photoWebhookFixture(c);
  c.extractTransactions = (inputs, context) => {
    assert.equal(f.held(), false);
    assert.equal(context.previous_proposal, undefined);
    // A different screenshot completed while this request was extracting.
    c.getPendingTransactions = () => [f.previous, { ...f.previous, where: 'Concurrent Shop' }];
    return [f.incoming];
  };
  assert.equal(f.run({}), 'OK');
  assert.equal(f.stored().length, 3);
  assert.equal(f.delivered().length, 3);
  assert.equal(f.held(), false);
  assert.ok(c.logs.some(line => line.includes('proposal_total')));
});
test('caption corrections retain previous proposal context and serial processing', c => {
  const f = photoWebhookFixture(c);
  c.extractTransactions = (_, context) => {
    assert.equal(f.held(), true);
    assert.equal(context.previous_proposal[0], f.previous);
    return [{ ...f.previous, amount: 15 }];
  };
  f.run({ caption: 'Correct the previous amount to 15' });
  assert.equal(f.stored().length, 1);
  assert.equal(f.stored()[0].amount, 15);
});
test('screenshot finishing after approval does not resurrect the processed proposal', c => {
  const f = photoWebhookFixture(c);
  c.extractTransactions = () => { c.getPendingTransactions = () => 'PROCESSED'; return [f.incoming]; };
  f.run({});
  assert.equal(f.stored().length, 1);
  assert.equal(f.stored()[0].where, 'New Shop');
});
test('captioned album photo retains correction context without collecting other images', c => {
  const f = photoWebhookFixture(c);
  c.Utilities.sleep = () => { throw new Error('Albums must not wait for more photos'); };
  c.extractTransactions = (inputs, context) => {
    assert.equal(f.held(), true);
    assert.equal(context.previous_proposal[0], f.previous);
    assert.ok(inputs.some(input => input.text));
    return [f.incoming];
  };
  f.run({ media_group_id: 'group', caption: 'Correct the previous merchant' });
  assert.equal(f.stored().length, 1);
});
test('all three album photos process even when delivered sequentially and larger than cache limits', c => {
  const f = photoWebhookFixture(c);
  const cache = c.CacheService.getScriptCache();
  c.CacheService.getScriptCache = () => ({ ...cache, put: (key, value) => {
    assert.ok(!key.startsWith('album_'));
    assert.ok(Buffer.byteLength(value) <= 100000);
    cache.put(key, value);
  } });
  c.fetchTelegramFileAsBase64 = () => ({ inlineData: { mimeType: 'image/jpeg', data: 'a'.repeat(200000) } });
  c.Utilities.sleep = () => { throw new Error('Unexpected album delay'); };
  let extractions = 0;
  c.extractTransactions = inputs => {
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].inlineData.data.length, 200000);
    return [{ ...f.incoming, where: 'Shop ' + (++extractions) }];
  };
  for (const id of [101, 102, 103]) f.run({ media_group_id: 'three-photos', message_id: id }, id);
  assert.equal(extractions, 3);
  assert.equal(f.stored().length, 4); // Existing proposal plus all three new photos.
  assert.deepEqual(Array.from(f.delivered(), row => row.where), ['Old Shop', 'Shop 1', 'Shop 2', 'Shop 3']);
  f.run({ media_group_id: 'three-photos', message_id: 102 }, 102);
  assert.equal(extractions, 3); // A Telegram retry does not process a fourth photo.
});
test('three album extractions completing out of order merge without overwriting one another', c => {
  const f = photoWebhookFixture(c);
  let number = 0;
  c.extractTransactions = () => {
    const current = ++number;
    if (current < 3) f.run({ media_group_id: 'concurrent', message_id: 200 + current }, 200 + current);
    return [{ ...f.incoming, where: 'Photo ' + current }];
  };
  f.run({ media_group_id: 'concurrent', message_id: 200 }, 200);
  assert.equal(number, 3);
  assert.deepEqual(Array.from(f.stored(), row => row.where), ['Old Shop', 'Photo 3', 'Photo 2', 'Photo 1']);
});
test('overlapping album screenshots merge shared rows and keep every distinct purchase', c => {
  const f = photoWebhookFixture(c);
  let number = 0;
  c.extractTransactions = () => [f.incoming, { ...f.incoming, amount: ++number, where: 'Distinct ' + number }];
  for (const id of [300, 301, 302]) f.run({ media_group_id: 'overlap', message_id: id }, id);
  assert.equal(f.stored().length, 5); // Previous + shared row + three distinct rows.
  assert.equal(f.stored().filter(row => row.where === 'New Shop').length, 1);
});
test('Telegram proposal rejection is surfaced while an unchanged overlap is harmless', c => {
  vm.runInContext(fs.readFileSync(path.join(root, 'telegramUI.gs'), 'utf8'), c);
  c.PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', 'offline-test');
  c.PropertiesService.getUserProperties = () => ({ getProperty: () => '42', setProperty: () => {} });
  c.formatTransactionConfirmationHtml = () => 'Proposal';
  c.getMainProposalKeyboard = () => ({});
  let description = 'Bad Request: message is too long';
  c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 400,
    getContentText: () => JSON.stringify({ ok: false, error_code: 400, description }) }) };
  assert.throws(() => c.sendConfirmationMessage(42, 'token', [], true), /proposal delivery failed.*too long/);
  description = 'Bad Request: message is not modified';
  assert.doesNotThrow(() => c.sendConfirmationMessage(42, 'token', [], true));
});
require('./monthly-coach-regressions.cjs')(test);
require('./stage5-regressions.cjs')(test);
require('./monthly-review-regressions.cjs')(test);
require('./monthly-complete-review-regressions.cjs')(test);
require('./delivery-regressions.cjs')(test);
require('./webhook-auth-regressions.cjs')(test);
require('./calendar-regressions.cjs')(test);
require('./mandatory-regressions.cjs')(test);
require('./mandatory-calendar-regressions.cjs')(test);
require('./month-creation-regressions.cjs')(test);
console.log(`${passed} tests passed; ${assertions} existing assertions checked; all .gs files parsed.`);
