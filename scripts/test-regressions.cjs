// Offline tests only: no credentials, network, Google services, or live writes.
// Run: node scripts/test-regressions.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceFiles = ['constants.gs', 'config.gs', 'bootstrap.gs', 'calendar.gs', 'mandatory.gs', 'mandatoryCalendar.gs', 'monthlyInsights.gs', 'reader.gs', 'enricher.gs',
  'writer.gs', 'prompts.gs', 'menu.gs', 'coach.gs', 'nudge.gs', 'state.gs', 'proposalEdits.gs', 'webhook.gs', 'callbacks.gs', 'monthCreation.gs', 'cashCoverage.gs', 'receiptItems.gs', 'analyzer.gs', 'papaDebt.gs'];
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
      deleteProperty: key => { delete props[key]; }, getProperties: () => ({ ...props })
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
test('missing sandbox ID stops resolution before sheet access', c => {
  let sheetAccess = 0;
  c.SpreadsheetApp = {
    openById: () => { sheetAccess++; throw new Error('Unexpected open'); },
    getActiveSpreadsheet: () => { sheetAccess++; throw new Error('Unexpected live access'); }
  };
  for (const id of [undefined, null, '', '   ']) {
    c.sandboxIdForTest = id;
    vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID = sandboxIdForTest', c);
    assert.throws(() => c.getTargetSpreadsheet(true), /TEST_SPREADSHEET_ID is required/);
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
  assert.equal(opened, 1); assert.equal(liveAccess, 0);
});
test('wrong or unverifiable sandbox identity is rejected before cleanup, locks or writes', c => {
  let mutations = 0;
  const wrong = { getId: () => 'live-workbook', getSheetByName: () => { mutations++; throw new Error('Unexpected sheet access'); } };
  c.SpreadsheetApp = { openById: () => wrong, getActiveSpreadsheet: () => { mutations++; return wrong; } };
  c.LockService = { getScriptLock: () => { mutations++; throw new Error('Unexpected lock'); } };
  for (const returned of [null, {}, wrong]) {
    c.SpreadsheetApp.openById = () => returned;
    assert.throws(() => c.getTargetSpreadsheet(true), /Sandbox spreadsheet identity does not match/);
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
test('reader number parser handles currency, spaces and European decimals', c => {
  assert.equal(c.parseAmountNumber('S$1 234,56'), 1234.56);
  assert.equal(c.parseAmountNumber('', '1.234,56'), 1234.56);
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
// It translates relative cell references but deliberately does not evaluate formulas.
function mapFormulaReferences(formula, pattern, translate) {
  return formula.split(/("(?:[^"]|"")*")/g)
    .map((part, index) => index % 2 ? part : part.replace(pattern, translate)).join('');
}
function a1ToR1C1(formula, row, col) {
  const ref = (absolute, number, current) => absolute ? String(number) : number === current ? '' : `[${number - current}]`;
  return mapFormulaReferences(formula, /(?<![A-Z0-9_])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Z0-9_])/g, (_, absCol, letters, absRow, digits) => {
    const number = [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
    return `R${ref(absRow, Number(digits), row)}C${ref(absCol, number, col)}`;
  });
}
function r1c1ToA1(formula, row, col) {
  const ref = (part, current) => !part ? [current, ''] : part.startsWith('[') ? [current + Number(part.slice(1, -1)), ''] : [Number(part), '$'];
  return mapFormulaReferences(formula, /(?<![A-Z0-9_])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Z0-9_\[\]])/g, (_, r, c) => {
    const [rowNumber, absRow] = ref(r, row), [colNumber, absCol] = ref(c, col);
    let letters = '', value = colNumber;
    while (value > 0) { letters = String.fromCharCode(65 + (value - 1) % 26) + letters; value = Math.floor((value - 1) / 26); }
    return `${absCol}${letters}${absRow}${rowNumber}`;
  });
}
class Sheet {
  constructor(name, data = []) { this.name = name; this.data = data; this.copies = []; this.validations = new Map(); this.formats = new Map(); this.hidden = false; }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getMaxRows() { return 100; }
  getMaxColumns() { return 40; }
  insertColumnsAfter() {}
  insertRowsAfter() {}
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
      setFormulasR1C1: values => range.setValues(values.map((r, ri) => r.map((formula, ci) =>
        formula ? r1c1ToA1(formula, row + ri, col + ci) : ''))),
      setFormulaR1C1: formula => range.setFormulasR1C1([[formula]]),
      getFormulas: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => {
        const value = sheet.data[row - 1 + r]?.[col - 1 + c];
        return typeof value === 'string' && value.startsWith('=') ? value : '';
      })),
      getFormulasR1C1: () => range.getFormulas().map((r, ri) => r.map((formula, ci) =>
        formula ? a1ToR1C1(formula, row + ri, col + ci) : '')),
      setValue: value => range.setValues([[value]]),
      getFormula: () => range.getFormulas()[0][0],
      copyTo: target => { sheet.copies.push(target); target.setFormulasR1C1(range.getFormulasR1C1()); },
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
  const ledger = new Sheet('Transactions', [transactionHeaders, ['15.08.2026', 'DBS CC SGD', 'Расходы', 20, 20,
    '=IFERROR(LOOKUP(2;1/($B$1:B1=B2);$G$1:G1);0)', '=F2-D2', 'Другое', 'Old Merchant', '', 'Wants']]);
  const staging = new Sheet('_Reconcile', [headers]);
  const reference = new Sheet('-', [['', 'Категория', '50/30/20'], ['', 'Другое', 'Wants'], ['', 'Транспорт', 'Needs']]);
  const sheets = { Transactions: ledger, _Reconcile: staging, '-': reference };
  const ss = { archives: [], getSheetByName: name => sheets[name] || null, getSheets: () => Object.values(sheets),
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
test('ordinary explicit writes work while reconciliation defaults to dry-run', c => {
  const { ledger, ss, lock } = storage(c);
  const txn = { date: '16.08.2026', account: 'DBS CC SGD', amount: 30, where: 'New Merchant', category: 'Другое' };
  assert.equal(c.appendTransactions([txn], ss).dryRun, true); assert.equal(ledger.data.length, 2);
  assert.equal(c.appendTransactions([txn], ss, false).writtenCount, 1); assert.equal(ledger.data.length, 3);
  assert.equal(lock.acquired, lock.released);
});
test('multi-row submissions fill every balance formula with references to that row', c => {
  const { ledger, ss, lock } = storage(c);
  const txns = [12, 24, 36, 48].map((amount, i) => ({ date: '25.10.2026', account: 'DBS CC SGD',
    amount, where: `Rita purchase ${i}`, category: 'Другое' }));
  assert.equal(c.appendTransactions(txns, ss, false).writtenCount, 4);
  for (let row = 3; row <= 6; row++) {
    assert.equal(ledger.data[row - 1][5], `=IFERROR(LOOKUP(2;1/($B$1:B${row - 1}=B${row});$G$1:G${row - 1});0)`);
    assert.equal(ledger.data[row - 1][6], `=F${row}-D${row}`);
  }
  const before = structuredClone(ledger.data);
  assert.equal(c.appendTransactions(txns, ss, false).writtenCount, 0);
  assert.deepEqual(ledger.data, before);
  assert.equal(lock.acquired, lock.released);
});
test('blank tail cells and literal opening balances cannot become formula templates', c => {
  const { ledger, ss } = storage(c);
  ledger.data.push(['24.10.2026', 'Cash', 'Расходы', 10, 10, 0, '=F3-D3', 'Другое', 'Opening']);
  ledger.data.push(['24.10.2026', 'DBS CC SGD', 'Расходы', 10, 10, '', '', 'Другое', 'Missing']);
  const txns = ['DBS CC SGD', 'New account', 'New account', 'Cash'].map((account, i) => ({
    date: '25.10.2026', account, amount: 20 + i, where: `Mixed purchase ${i}`, category: 'Другое' }));
  c.appendTransactions(txns, ss, false);
  assert.equal(ledger.data[4][5], '=IFERROR(LOOKUP(2;1/($B$1:B4=B5);$G$1:G4);0)');
  assert.equal(ledger.data[5][5], 0);
  assert.equal(ledger.data[6][5], '=IFERROR(LOOKUP(2;1/($B$1:B6=B7);$G$1:G6);0)');
  assert.ok(ledger.data[7][5].startsWith('='));
  for (let row = 5; row <= 8; row++) assert.equal(ledger.data[row - 1][6], `=F${row}-D${row}`);
});
test('missing formula templates fail before appending and retain the write lock discipline', c => {
  for (const col of [5, 6]) {
    const { ledger, ss, lock } = storage(c);
    ledger.data[1][col] = 0;
    const before = structuredClone(ledger.data);
    const txns = [{ date: '25.10.2026', account: 'DBS CC SGD', amount: 25, where: 'No template' }];
    assert.throws(() => c.appendTransactions(txns, ss, false), /No transactions were written/);
    assert.deepEqual(ledger.data, before);
    assert.equal(c.appendTransactions(txns, ss, true).dryRun, true);
    assert.deepEqual(ledger.data, before);
    assert.equal(lock.acquired, lock.released);
  }
});
test('missing-balance repair preserves inputs, populated formulas, manual balances and opening seeds', c => {
  const { ledger, ss, lock } = storage(c);
  ledger.data.push(['24.10.2026', 'Cash', 'Расходы', 11, 11, '', '', 'Другое', 'Cash opening']);
  ledger.data.push(['25.10.2026', 'Cash', 'Расходы', 12, 12, '', '', 'Другое', 'Cash next']);
  ledger.data.push(['25.10.2026', 'DBS CC SGD', 'Расходы', 13, 13, '', 125, 'Другое', 'Manual closing']);
  ledger.data.push(['25.10.2026', 'Reserve', 'Расходы', 14, 14, 500, '=F6-D6', 'Другое', 'Manual opening']);
  ledger.data.push(['', '', '', '', '', '', '']);
  const before = structuredClone(ledger.data);
  assert.equal(c.repairMissingTransactionBalances(ss).updatedCells, 5);
  assert.equal(ledger.data[2][5], 0);
  assert.equal(ledger.data[2][6], '=F3-D3');
  assert.equal(ledger.data[3][5], '=IFERROR(LOOKUP(2;1/($B$1:B3=B4);$G$1:G3);0)');
  assert.equal(ledger.data[3][6], '=F4-D4');
  assert.equal(ledger.data[4][6], 125);
  assert.deepEqual(ledger.data[5], before[5]);
  assert.deepEqual(ledger.data[6], before[6]);
  for (let r = 0; r < before.length; r++) {
    assert.deepEqual(ledger.data[r].slice(0, 5), before[r].slice(0, 5));
    assert.deepEqual(ledger.data[r].slice(7), before[r].slice(7));
  }
  assert.equal(c.repairMissingTransactionBalances(ss).updatedCells, 0);
  assert.equal(lock.acquired, lock.released);
});
test('balance repair validates all formulas and headers before changing any cell', c => {
  for (const problem of ['header', 'template']) {
    const { ledger, ss, lock } = storage(c);
    ledger.data.push(['25.10.2026', 'Cash', 'Расходы', 12, 12, '', '', 'Другое', 'Missing']);
    if (problem === 'header') ledger.data[0][5] = 'Unexpected';
    else ledger.data[1][6] = '';
    const before = structuredClone(ledger.data);
    assert.throws(() => c.repairMissingTransactionBalances(ss), /No balances were changed/);
    assert.deepEqual(ledger.data, before);
    assert.equal(lock.acquired, lock.released);
  }
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
    c.finishTelegramProposalComment = () => {};
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
test('slim Budget menu exposes 4 top-level actions and a Maintenance submenu with zero reconciler items', c => {
  const menus = {};
  const makeMenu = name => {
    const entry = { name, items: [], submenus: [] };
    menus[name] = entry;
    const api = {
      addItem: (label, fn) => { entry.items.push({ label, fn }); return api; },
      addSeparator: () => api,
      addSubMenu: sub => { entry.submenus.push(sub._entry); return api; },
      addToUi: () => { entry.added = true; },
      _entry: entry
    };
    return api;
  };
  c.buildBudgetMenu({ createMenu: makeMenu });
  assert.equal(menus['💰 Budget'].added, true);
  assert.deepEqual(menus['💰 Budget'].items.map(i => i.fn), [
    'createNextMonthFromMenu', 'checkMandatoryPaymentsNow', 'sendMorningCoach', 'updatePapaMonthlyRatesFromMenu'
  ]);
  assert.equal(menus['💰 Budget'].submenus.length, 1);
  assert.deepEqual(menus['🔧 Maintenance'].items.map(i => i.fn), [
    'showMonthCreationPreview', 'showMonthlyCoachPreview', 'showBasketReviewPreview', 'repairTransactionDerivedFormulas'
  ]);
});
test('prompts.gs and nudge.gs use dynamic year instead of hardcoded 2026', c => {
  const prompt2027 = c.getSystemPrompt({ todayDate: '05.01.2027' });
  assert.match(prompt2027, /17\.07\.2027/);
  assert.match(prompt2027, /assume current year 2027/);
  assert.doesNotMatch(prompt2027, /2026/);
  c.getTodaysTransactions = () => [{ description: 'Coffee', amount: 5.5, category: 'Рестораны', account: 'DBS CC SGD' }];
  c.getTodaySpend = () => 5.5;
  c.getDailyPacing = () => ({ K_cumulative_today: 100, L_saldo_today: 94.5, L_saldo_yesterday: 90 });
  const recap2027 = c.generateDailyTransactionsRecap({}, vm.runInContext("new Date('2027-01-05T14:00:00Z')", c));
  assert.match(recap2027, /Budget 2027/);
  assert.doesNotMatch(recap2027, /Budget 2026/);
});
test('receiptItems initializes LineItems and Products as hidden tabs', c => {
  const { ss } = storage(c);
  const sheets = c.initializeReceiptItemStore(ss);
  assert.equal(sheets.LineItems.isSheetHidden(), true);
  assert.equal(sheets.Products.isSheetHidden(), true);
});
test('hideOlderMonthTabs hides months older than target - 1 while keeping target and prior month visible', c => {
  const make = name => new Sheet(name);
  const tabs = [make('Summary'), make("Я'26"), make("Октябрь'26"), make("Ноябрь'26"), make('Декабрь')];
  const hidden = c.hideOlderMonthTabs({ getSheets: () => tabs }, 2026, 12);
  assert.deepEqual(Array.from(hidden), ["Я'26", "Октябрь'26"]);
  assert.equal(tabs[0].isSheetHidden(), false);
  assert.equal(tabs[1].isSheetHidden(), true);
  assert.equal(tabs[2].isSheetHidden(), true);
  assert.equal(tabs[3].isSheetHidden(), false);
  assert.equal(tabs[4].isSheetHidden(), false);
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
test('caption corrections retain previous proposal context without holding proposal lock during extraction', c => {
  const f = photoWebhookFixture(c);
  c.extractTransactions = (_, context) => {
    assert.equal(f.held(), false);
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
test('captioned album photo retains correction context without collecting other images or holding lock during extraction', c => {
  const f = photoWebhookFixture(c);
  c.Utilities.sleep = () => { throw new Error('Albums must not wait for more photos'); };
  c.extractTransactions = (inputs, context) => {
    assert.equal(f.held(), false);
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
    assert.ok(!key.startsWith('album_progress_') || Buffer.byteLength(value) <= 10);
    assert.ok(key === 'album_progress_three-photos' || !key.startsWith('album_'));
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
test('auto-generated screenshot captions and image documents extract independently without resending old rows or holding locks', c => {
  for (const caption of [
    'Screenshot (22 Nov 2026 4:30:42 am)',
    'Screenshot (22 Nov 2026 4:31:00 am)',
    'Screenshot 2026-11-22 at 4.34.36 AM',
    'Screen Shot 2026-11-22 at 16.34.36.png',
    'Screenshot_20261122-043042_com.dbs.sit.dbsmbanking.jpg',
    'Снимок экрана (22 нояб. 2026 г., 04:30:42)',
    'IMG_20261122_043042.JPG'
  ]) {
    assert.equal(c.isBoilerplateMediaCaption(caption), true, caption);
  }
  for (const realCaption of [
    'Screenshot of lunch 12.50',
    'Screenshot (papa 15.50)',
    'Correct the previous amount to 15',
    'Fuel purchase'
  ]) {
    assert.equal(c.isBoilerplateMediaCaption(realCaption), false, realCaption);
  }

  const f = photoWebhookFixture(c);
  let callCount = 0;
  c.extractTransactions = (inputs, context) => {
    callCount++;
    assert.equal(f.held(), false);
    assert.equal(context.previous_proposal, undefined);
    assert.equal(inputs.some(inp => inp && inp.text), false);
    return [{ ...f.incoming, where: 'Screenshot Shop ' + callCount }];
  };
  assert.equal(f.run({ caption: 'Screenshot (22 Nov 2026 4:30:42 am)' }, 501), 'OK');
  assert.equal(f.run({ photo: undefined, document: { file_id: 'img-doc', mime_type: 'image/png', file_name: 'Screenshot.png' }, caption: 'Screenshot (22 Nov 2026 4:31:00 am)' }, 502), 'OK');
  assert.equal(callCount, 2);
  assert.deepEqual(Array.from(f.stored(), r => r.where), ['Old Shop', 'Screenshot Shop 1', 'Screenshot Shop 2']);
});
test('concurrent comment edit succeeds without lock timeout while slow captioned screenshot is extracting', c => {
  vm.runInContext(fs.readFileSync(path.join(root, 'telegramUI.gs'), 'utf8'), c);
  const scriptProps = c.PropertiesService.getScriptProperties();
  scriptProps.setProperty('WEBHOOK_SECRET', 'offline-webhook-secret');
  scriptProps.setProperty('AUTHORIZED_CHAT_IDS', '42');
  scriptProps.setProperty('TELEGRAM_BOT_TOKEN', 'offline-token');
  vm.runInContext('SHEET_FACTS.USERS = { OFFLINE: { chat_id: "42", active: true } }', c);
  const cache = new Map(), userProps = new Map();
  let held = false;
  c.CacheService = { getScriptCache: () => ({ get: k => cache.get(k) || null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) };
  c.PropertiesService.getUserProperties = () => ({ getProperty: k => userProps.get(k) || null, setProperty: (k, v) => userProps.set(k, v) });
  c.LockService = { getUserLock: () => ({
    waitLock: () => { if (held) throw new Error('Lock timeout: another process was holding the lock for too long.'); held = true; },
    releaseLock: () => { held = false; }
  }) };
  c.HtmlService = { createHtmlOutput: text => text };
  c.getTelegramFilePath = () => 'photo.jpg';
  c.fetchTelegramFileAsBase64 = () => ({ inlineData: { mimeType: 'image/jpeg', data: 'fake-photo' } });
  c.getCategoryBucketMap = () => ({ 'Подписки': 'Wants', 'Счётчики': 'Needs', 'Другое': 'Wants' });
  c.flagExistingDuplicates = rows => rows;
  const messages = [];
  c.sendTelegramMessage = text => { messages.push(text); return [{ chat_id: '42', message_id: 900 }]; };
  c.editTelegramMessage = () => ({ ok: true });
  c.sendConfirmationMessage = (_, token) => { userProps.set('latest_message_id_42', '55'); userProps.set('latest_token_42', token); return { ok: true }; };
  c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{"ok":true}' }) };

  const initialRows = [
    c.enrichTransaction({ date: '22.11.2026', account: 'DBS CC SGD', type: 'Расходы', amount: 29.98, currency: 'SGD', where: 'Netflix', category: 'Подписки' }),
    c.enrichTransaction({ date: '20.11.2026', account: 'DBS CC SGD', type: 'Получение денег', amount: 67.92, currency: 'SGD', where: 'Apple.com', category: 'Подписки' }),
    c.enrichTransaction({ date: '18.11.2026', account: 'DBS CC SGD', type: 'Расходы', amount: 31.98, currency: 'SGD', where: 'YouTube Premium', category: 'Подписки' })
  ];
  c.savePendingTransactions(initialRows, 'tok1');
  userProps.set('latest_token_42', 'tok1');
  userProps.set('latest_message_id_42', '55');

  c.generateProposalEditPlan = comment => {
    assert.equal(held, false);
    assert.match(comment, /Лёгкие деньги/);
    return { clarification: '', operations: [{ item: 2, action: 'update', changes: { type: 'Доходы - лёгкие деньги' } }] };
  };

  c.extractTransactions = () => {
    // While Screenshot 2 (MyRepublic) is mid-extraction, user sends the comment edit!
    assert.equal(held, false, 'Screenshot extraction must never hold UserLock');
    const commentRes = c.doPost({
      parameter: { secret: 'offline-webhook-secret' },
      postData: { contents: JSON.stringify({
        update_id: 602,
        message: { chat: { id: 42 }, text: 'item 2 make it Лёгкие деньги', reply_to_message: { message_id: 55 } }
      }) }
    });
    assert.equal(commentRes, 'OK');
    return [c.enrichTransaction({ date: '15.11.2026', account: 'DBS CC SGD', type: 'Расходы', amount: 8.71, currency: 'SGD', where: 'MyRepublic', category: 'Счётчики' })];
  };

  const photoRes = c.doPost({
    parameter: { secret: 'offline-webhook-secret' },
    postData: { contents: JSON.stringify({
      update_id: 601,
      message: { chat: { id: 42 }, photo: [{ file_id: 'myrep' }], caption: 'Screenshot (22 Nov 2026 4:31:00 am)' }
    }) }
  });
  assert.equal(photoRes, 'OK');
  assert.equal(messages.some(m => /Lock timeout/i.test(m)), false);
  const finalRows = c.getPendingTransactions('tok1');
  assert.equal(finalRows.length, 4);
  assert.equal(finalRows[1].where, 'Apple.com');
  assert.equal(finalRows[1].type, 'Доходы - лёгкие деньги');
  assert.equal(finalRows[3].where, 'MyRepublic');
});
test('rolling extraction reconciles concurrent approval or modification and callback lock timeout answers query cleanly', c => {
  const f = photoWebhookFixture(c);
  const messages = [], toasts = [];
  c.sendTelegramMessage = text => { messages.push(text); };
  c.answerCallbackQuery = (id, text, alert) => toasts.push({ id, text, alert });
  const errors = [];
  c.fetchWithRetry = (_, opts) => { errors.push(JSON.parse(opts.payload).text); return {}; };

  // 1. New spend arriving in rolling mode while previous proposal was approved keeps only the new spend.
  const coffee = { date: '22.11.2026', account: 'DBS CC SGD', amount: 5.5, currency: 'SGD', where: 'Coffee Shop' };
  c.extractTransactions = (_, ctx) => {
    assert.equal(ctx.previous_proposal.length, 1);
    c.getPendingTransactions = token => token === 'active' ? 'PROCESSED' : null;
    return [f.previous, coffee];
  };
  assert.equal(f.run({ photo: undefined, text: 'coffee 5.50' }, 701), 'OK');
  assert.equal(f.stored().length, 1);
  assert.equal(f.stored()[0].where, 'Coffee Shop');

  // 2. Pure rolling echo of an already-approved proposal does not resurrect it.
  c.getPendingTransactions = () => [f.previous];
  c.extractTransactions = () => {
    c.getPendingTransactions = () => 'PROCESSED';
    return [f.previous];
  };
  assert.equal(f.run({ photo: undefined, text: 'noop' }, 702), 'OK');
  assert.ok(messages.some(m => /already completed while processing/.test(m)));

  // 3. Callback lock timeout dismisses button spinner with toast instead of spamming Bot Error.
  c.LockService.getUserLock = () => ({
    waitLock: () => { throw new Error('Lock timeout: another process was holding the lock for too long.'); },
    releaseLock: () => {}
  });
  const cbRes = c.doPost({
    parameter: { secret: 'offline-webhook-secret' },
    postData: { contents: JSON.stringify({
      update_id: 703,
      callback_query: { id: 'cb-busy', data: 'approve:active', message: { chat: { id: 42 }, message_id: 10 } }
    }) }
  });
  assert.equal(cbRes, 'OK');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].id, 'cb-busy');
  assert.equal(toasts[0].alert, true);
  assert.match(toasts[0].text, /Still updating/);
  assert.equal(errors.length, 0);
});
test('upload progress bar tracks completed, active, upcoming, and failed steps across PDF, photo, voice, text, and CSV', c => {
  const scriptProps = c.PropertiesService.getScriptProperties();
  scriptProps.setProperty('WEBHOOK_SECRET', 'offline-webhook-secret');
  scriptProps.setProperty('AUTHORIZED_CHAT_IDS', '42');
  scriptProps.setProperty('TELEGRAM_BOT_TOKEN', 'offline-token');
  vm.runInContext('SHEET_FACTS.USERS = { OFFLINE: { chat_id: "42", active: true } }', c);
  const cache = new Map(), userProps = new Map();
  c.CacheService = { getScriptCache: () => ({ get: k => cache.get(k) || null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) };
  c.PropertiesService.getUserProperties = () => ({ getProperty: k => userProps.get(k) || null, setProperty: (k, v) => userProps.set(k, v) });
  c.LockService = { getUserLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
  c.HtmlService = { createHtmlOutput: text => text };
  c.getTelegramFilePath = () => 'file.dat';
  c.fetchTelegramFileAsBase64 = (_, __, mime) => ({ inlineData: { mimeType: mime || 'image/jpeg', data: 'mock' } });
  c.Utilities.base64Decode = v => v;
  c.Utilities.newBlob = (...args) => args;
  c.enqueueStatementFile = () => {};
  c.sendConfirmationMessage = () => ({ ok: true });

  let nextMsgId = 800, allowDelete = true;
  const sent = [], edits = [], deletes = [], botErrors = [];
  c.sendTelegramMessage = text => {
    const id = ++nextMsgId;
    sent.push({ id, text });
    return [{ chat_id: '42', message_id: id }];
  };
  c.UrlFetchApp = { fetch: (url, opts) => {
    const body = JSON.parse(opts.payload);
    if (url.endsWith('/editMessageText')) {
      edits.push({ id: body.message_id, text: body.text });
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    }
    if (url.endsWith('/deleteMessage')) {
      deletes.push(body.message_id);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: allowDelete }) };
    }
    return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
  } };
  c.fetchWithRetry = (_, opts) => { botErrors.push(JSON.parse(opts.payload).text); return {}; };

  let updateSeq = 800;
  const post = message => c.doPost({
    parameter: { secret: 'offline-webhook-secret' },
    postData: { contents: JSON.stringify({ update_id: ++updateSeq, message: { chat: { id: 42 }, ...message } }) }
  });
  const sampleRow = { date: '22.11.2026', account: 'DBS CC SGD', amount: 12.5, currency: 'SGD', where: 'Cafe', type: 'Расходы' };

  // 1. Receipt PDF: 5-step progress bar (15% -> 35% -> 60% -> 80% -> 95% -> delete cleanup)
  c.classifyPdfDocument = () => 'receipt';
  c.extractTransactions = (_, ctx) => {
    ctx.onProgress('extract_transactions_start');
    ctx.onProgress('extract_transactions_done', { count: 1 });
    ctx.onProgress('receipt_items_start');
    ctx.onProgress('receipt_items_done', { itemCount: 4 });
    ctx.onProgress('duplicates_start');
    return [sampleRow];
  };
  post({ document: { file_id: 'pdf1', mime_type: 'application/pdf', file_name: 'receipt.pdf' } });
  const pdfProgressId = sent[0].id;
  assert.match(sent[0].text, /PDF received — processing[\s\S]*Step 1 of 5[\s\S]*15%[\s\S]*🔄 <b>1\. Downloading PDF[\s\S]*⬜ 2\. Classify PDF[\s\S]*⬜ 5\. Check duplicates/);
  const pdfEdits = edits.filter(e => e.id === pdfProgressId).map(e => e.text);
  assert.equal(pdfEdits.length, 4);
  assert.match(pdfEdits[0], /Step 2 of 5[\s\S]*35%[\s\S]*✅ 1\. Downloaded PDF[\s\S]*🔄 <b>2\. Classifying PDF/);
  assert.match(pdfEdits[1], /Step 3 of 5[\s\S]*60%[\s\S]*✅ 2\. Classified as merchant receipt[\s\S]*🔄 <b>3\. Extracting transactions/);
  assert.match(pdfEdits[2], /Step 4 of 5[\s\S]*80%[\s\S]*✅ 3\. Extracted 1 transaction[\s\S]*🔄 <b>4\. Extracting receipt line items/);
  assert.match(pdfEdits[3], /Step 5 of 5[\s\S]*95%[\s\S]*✅ 4\. Captured 4 receipt items[\s\S]*🔄 <b>5\. Checking duplicates/);
  assert.ok(deletes.includes(pdfProgressId));

  // 2. Bank statement PDF: notifies that inbox reconciliation is retired + 100% fallback when deleteMessage returns ok:false
  sent.length = 0; edits.length = 0; deletes.length = 0;
  allowDelete = false;
  c.classifyPdfDocument = () => 'bank_statement';
  post({ document: { file_id: 'pdf2', mime_type: 'application/pdf', file_name: 'stmt.pdf' } });
  const stmtProgressId = sent[0].id;
  const stmtEdits = edits.filter(e => e.id === stmtProgressId).map(e => e.text);
  assert.match(sent[1].text, /retired.*AI chat/i);
  assert.match(stmtEdits.at(-1), /✅ <b>PDF received — processing<\/b> · Complete[\s\S]*\[██████████\] 100%/);
  allowDelete = true;

  // 3. Voice & Text uploads track their dedicated pipelines, and album photos suppress duplicate bars
  sent.length = 0; edits.length = 0; deletes.length = 0;
  c.extractTransactions = (_, ctx) => {
    ctx.onProgress('extract_transactions_start');
    ctx.onProgress('extract_transactions_done', { count: 2 });
    ctx.onProgress('duplicates_start');
    return [sampleRow];
  };
  post({ voice: { file_id: 'v1' } });
  assert.match(sent[0].text, /🎙️ <b>Processing voice note<\/b> · Step 1 of 3[\s\S]*20%/);
  assert.ok(edits.some(e => /60%[\s\S]*Transcribing &amp; extracting/.test(e.text)));
  assert.ok(edits.some(e => /90%[\s\S]*✅ 2\. Extracted 2 transactions/.test(e.text)));

  sent.length = 0; edits.length = 0;
  post({ text: 'lunch 12.50' });
  assert.match(sent[0].text, /✍️ <b>Processing transaction text<\/b> · Step 1 of 2[\s\S]*50%/);
  assert.ok(edits.some(e => /90%[\s\S]*✅ 1\. Extracted 2 transactions/.test(e.text)));

  sent.length = 0;
  post({ photo: [{ file_id: 'a1' }], media_group_id: 'alb-1' });
  post({ photo: [{ file_id: 'a2' }], media_group_id: 'alb-1' });
  assert.equal(sent.length, 1, 'Sibling album photos share a single progress bar');
  assert.match(sent[0].text, /Processing album photos/);

  // 4. Failure marks completed steps ✅, failing step ❌, and keeps upcoming steps ⬜
  sent.length = 0; edits.length = 0;
  c.extractTransactions = (_, ctx) => {
    ctx.onProgress('extract_transactions_start');
    throw new Error('Gemini 503 capacity exhausted');
  };
  post({ photo: [{ file_id: 'fail-photo' }] });
  const failEdits = edits.filter(e => e.id === sent[0].id).map(e => e.text);
  assert.match(failEdits.at(-1), /⚠️ <b>Processing image — stopped<\/b> · Step 2 of 4[\s\S]*✅ 1\. Downloaded image[\s\S]*❌ <b>2\. Extract transactions with AI — failed<\/b>[\s\S]*⬜ 3\. Check receipt line items/);
  assert.match(botErrors.at(-1), /Gemini 503 capacity exhausted/);
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
require('./dbs-sgd-regressions.cjs')(test);
require('./cc-payment-regressions.cjs')(test, storage);
require('./proposal-comment-regressions.cjs')(test);
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
require('./cash-coverage-regressions.cjs')(test);
require('./receipt-items-regressions.cjs')(test, storage);
require('./papa-debt-regressions.cjs')(test);
console.log(`${passed} tests passed; ${assertions} existing assertions checked; all .gs files parsed.`);
