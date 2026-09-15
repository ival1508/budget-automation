/** In-memory Stage 3G tests, discovered by runAllTests. No Drive/ledger mutations. */
function test_refreshPendingReviewMatching() {
  const pending = { date: '20.08.2026', account: 'DBS CC SGD', amount: 31, merchant: 'Shop', cardholder: 'Val', review_row: 2 };
  const ledger = { date: pending.date, account: pending.account, amount: 31, where: 'Shop', notes: 'Val', row_index: 10 };
  const first = planPendingReconcileRefresh([pending, { ...pending, review_row: 3 }], [], [ledger], {});
  assertEq(first.matched.length, 1, 'One ledger occurrence clears at most one pending occurrence');
  assertEq(first.missing.length + first.ambiguous.length, 1, 'Additional occurrence remains for review');
  const repeated = planPendingReconcileRefresh([pending], [pending], [ledger], {});
  assertEq(repeated.matched.length, 0, 'Previously reconciled history reserves its ledger occurrence');
  const added = planPendingReconcileRefresh([pending], [pending], [ledger, { ...ledger, row_index: 11 }], {});
  assertEq(added.matched.length, 1, 'A newly added ledger occurrence clears the remaining purchase');
  const different = planPendingReconcileRefresh([
    { ...pending, cardholder: 'Rita' }, { ...pending, account: 'Another account' },
    { ...pending, amount: -31 }, { ...pending, merchant: 'Unrelated merchant' }
  ], [], [ledger], {});
  assertEq(different.matched.length, 0, 'Different cards, accounts, directions and uncertain identities are retained');
  const food = planPendingReconcileRefresh([{ ...pending, merchant: 'Western Boy', raw_merchant: 'FR VIVO WESTERN BOY SINGAPORE SG' }],
    [], [{ ...ledger, where: 'Food republic' }], {});
  assertEq(food.matched.length, 1, 'User-confirmed statement and ledger merchant relationship still matches');
  const incomplete = planPendingReconcileRefresh([{ ...pending, account: '' }, { ...pending, amount: NaN },
    { ...pending, date: '31.02.2026' }], [], [ledger], {});
  assertEq(incomplete.matched.length, 0, 'Incomplete review edits are never treated as confirmed ledger matches');
  assertEq(incomplete.missing.length, 3, 'Incomplete review edits stay in the queue');
}

function test_reviewQueueArchiveRecovery() {
  const f = makeStage3GFixture();
  const sheet = f.ss.insertSheet('_Reconcile');
  sheet.data.push(['✓', 'date', 'account', 'Cardholder', 'Тип', 'amount', 'merchant', 'proposed category', 'proposed bucket', 'confidence', 'source_row', 'status']);
  const row = status => [false, '15.08.2026', 'DBS CC SGD', 'Rita', 'Расходы', 8.9, 'Edited merchant', 'Рестораны', 'Wants', 0.9,
    '[Drive:test-file] Statement: "FR VIVO WESTERN BOY SINGAPORE SG" (PURCHASE)', status, 'Already covered'];
  sheet.data.push(row('imported'), row('proposed'), row('dismissed'), row('duplicate_review'));
  const originalDelete = sheet.deleteRows;
  sheet.deleteRows = () => { throw new Error('Simulated interruption after archive'); };
  let failed = false;
  try { archiveCompletedReconcileRowsUnlocked(f.ss); } catch (error) { failed = true; }
  assertEq(failed, true, 'Archive interruption is surfaced');
  assertEq(sheet.data.length, 5, 'No active rows lost on deletion failure');
  const history = f.ss.getSheetByName('_ReconcileHistory');
  assertEq(history.data.length, 3, 'Completed rows are saved before deletion');
  assertEq(history.data[2][12], 'Already covered', 'Dismissal reason retained');
  assertEq(history.data[2][6], 'Edited merchant', 'Review edits retained');
  assertEq(history.data[2][15] instanceof Date, true, 'History records review time');
  sheet.deleteRows = originalDelete;
  assertEq(archiveCompletedReconcileRowsUnlocked(f.ss), 2, 'Retry removes completed rows');
  assertEq(history.data.length, 3, 'Retry does not duplicate archive entries');
  assertEq(sheet.data.map(r => r[11]), ['status', 'proposed', 'duplicate_review'], 'Pending reviews and duplicates remain in order');
  assertEq(archiveCompletedReconcileRowsUnlocked(f.ss), 0, 'Completed cleanup is repeatable');
  assertEq(stagingHasDriveFile(f.ss, 'test-file'), true, 'History retains Drive recovery evidence');
}

function test_reviewQueueDismissalMatching() {
  const f = makeStage3GFixture();
  const history = f.ss.insertSheet('_ReconcileHistory');
  history.data.push(['✓', 'date', 'account', 'Cardholder', 'Тип', 'amount', 'merchant', 'proposed category', 'proposed bucket', 'confidence', 'source_row', 'status', 'review_reason', 'review_id', 'statement_key', 'reviewed_at']);
  const key = reconcileReviewKey('15.08.2026', 'DBS CC SGD', 'Rita', 8.9, 'FR VIVO WESTERN BOY SINGAPORE SG');
  history.data.push([false, '15.08.2026', 'DBS CC SGD', 'Rita', 'Расходы', 8.9, 'Food republic', '', '', 1, '', 'dismissed', 'Already accounted for', 'unique-review', key, new Date()]);
  // Simulate archive written but active row not yet removed: count only once.
  const staging = f.ss.insertSheet('_Reconcile');
  staging.data.push(history.data[0].slice(0, 15), history.data[1].slice(0, 15));
  const txn = { date: '15.08.2026', account: 'DBS CC SGD', cardholder: 'Rita', amount: 8.9, raw_merchant: 'FR VIVO WESTERN BOY SINGAPORE SG' };
  const input = [txn, { ...txn }, { ...txn, cardholder: 'Val' }, { ...txn, date: '16.08.2026' },
    { ...txn, amount: -8.9 }, { ...txn, raw_merchant: 'FR VIVO RUI FENG' }, { ...txn, account: 'Other card' }];
  const result = filterDismissedReconcileRows(input, f.ss);
  assertEq(result.excludedCount, 1, 'One dismissal consumes exactly one occurrence');
  assertEq(result.rows.length, 6, 'Other occurrences, cards, dates, signs and merchants survive');
  assertEq(filterDismissedReconcileRows([txn], f.ss).excludedCount, 1, 'Repeat upload remains dismissed');
  assertEq(history.data[1][11], 'dismissed', 'Reading exclusions preserves history');
}

function makeStage3GFixture() {
  const sheets = {};
  function sheet(name) {
    const data = [];
    const result = { data: data, getName: () => name, getLastRow: () => data.length,
      getMaxRows: () => 1000, deleteRows: (row, count) => { data.splice(row - 1, count); },
      setFrozenRows: () => {}, getRange: (r, c, h, w) => ({
        setNumberFormat: () => {},
        getValues: () => Array.from({ length: h || 1 }, (_, i) => Array.from({ length: w || 1 }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] || '')),
        setValues: values => { values.forEach((row, i) => row.forEach((value, j) => {
          if (!data[r - 1 + i]) data[r - 1 + i] = [];
          data[r - 1 + i][c - 1 + j] = value;
        })); }
      }) };
    sheets[name] = result; return result;
  }
  const ss = { getSheetByName: name => sheets[name] || null, insertSheet: name => sheet(name) };
  function file(id, name) {
    return { moved: 0, failMove: false, getId: () => id, getName: () => name,
      getMimeType: () => name.endsWith('.pdf') ? 'application/pdf' : 'text/csv',
      getLastUpdated: () => new Date(1000), getBlob: () => ({ id: id }),
      moveTo: function() { if (this.failMove) throw new Error('move failed'); this.moved++; } };
  }
  function folder(files) { return { getFiles: () => {
    let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] };
  } }; }
  return { ss: ss, sheet: sheet, file: file, folder: folder };
}

function test_stage3GInboxRetries() {
  const fixture = makeStage3GFixture();
  const a = fixture.file('csv-a', 'bank.csv'), b = fixture.file('pdf-b', 'bank.pdf');
  const inbox = fixture.folder([a, b]);
  const originalParse = parseStatement, originalReconcile = reconcileAndStage;
  let calls = 0;
  try {
    parseStatement = blob => ({ rows: [{ file: blob.id }] });
    reconcileAndStage = (parsed, ss, options) => {
      calls++; assertEq(options.append, true, 'Inbox appends rather than replaces the review');
      assertEq(Boolean(options.fileId), true, 'Every batch carries a recovery file ID');
      return { totalParsed: 1, matchedCount: 0, proposalsCount: 1, ambiguousCount: 0, excludedCount: 0, stagedCount: 1 };
    };
    const first = scanStatementInbox(fixture.ss, inbox, {});
    assertEq(first.processed, 2, 'Both CSV and PDF files processed');
    assertEq(calls, 2, 'Each file staged once');
    assertEq(a.moved, 1, 'CSV moved only after staging');
    assertEq(b.moved, 1, 'PDF moved only after staging');
    scanStatementInbox(fixture.ss, inbox, {}); // Simulates a retried listing.
    assertEq(calls, 2, 'Processed files are not staged again');
    const c = fixture.file('move-c', 'c.csv'); c.failMove = true;
    scanStatementInbox(fixture.ss, fixture.folder([c]), {});
    const before = calls; c.failMove = false;
    scanStatementInbox(fixture.ss, fixture.folder([c]), {});
    assertEq(calls, before, 'Move failure retries movement, not staging');
    assertEq(c.moved, 1, 'Move retry succeeds');
  } finally { parseStatement = originalParse; reconcileAndStage = originalReconcile; }
}

function test_stage3GInboxFailures() {
  const f = makeStage3GFixture(); const bad = f.file('bad', 'locked.pdf'), good = f.file('good', 'good.csv');
  const oldParse = parseStatement, oldReconcile = reconcileAndStage; let calls = 0;
  try {
    parseStatement = blob => blob.id === 'bad' ? { error: 'encrypted', rows: [] } : { rows: [{}] };
    reconcileAndStage = () => { calls++; return { stagedCount: 0 }; };
    const result = scanStatementInbox(f.ss, f.folder([bad, good]), {});
    assertEq(result.failed, 1, 'Encrypted file is recorded as a failure');
    assertEq(bad.moved, 0, 'Failed file stays in inbox');
    assertEq(good.moved, 1, 'A failing file does not block the next file');
    assertEq(calls, 1, 'Encrypted input never reaches staging');
    const again = scanStatementInbox(f.ss, f.folder([bad]), {});
    assertEq(again.skipped, 1, 'Unchanged failed file does not repeatedly consume model quota');
    const limited = scanStatementInbox(f.ss, f.folder([good]), {}, { maxRuntimeMs: 0 });
    assertEq(limited.deferred, true, 'Runtime budget defers work safely');
  } finally { parseStatement = oldParse; reconcileAndStage = oldReconcile; }
}

function test_stage3GRecoveryMarker() {
  const f = makeStage3GFixture(); const file = f.file('recovered', 'bank.csv');
  const stage = f.sheet('_Reconcile'); stage.data.push(['header']);
  stage.data.push([false, '01.09.2026', 'DBS CC SGD', 'Val', 'Расходы', 10, 'Merchant', 'Другое', 'Wants', 0.7, '[Drive:recovered] Statement', 'proposed']);
  const oldParse = parseStatement;
  try {
    parseStatement = () => { throw new Error('Must not parse already-staged file'); };
    const result = scanStatementInbox(f.ss, f.folder([file]), {});
    assertEq(result.processed, 1, 'Staged source marker recovers a missing journal write');
    assertEq(file.moved, 1, 'Recovered file moves to processed');
    assertEq(stage.data.length, 2, 'Recovery preserves the existing review');
  } finally { parseStatement = oldParse; }
}

function test_stage3GMenuAndScheduler() {
  const items = []; let menuName = '';
  const menu = { addItem: (label, handler) => { items.push(handler); return menu; }, addSeparator: () => menu, addToUi: () => {} };
  buildBudgetMenu({ createMenu: name => { menuName = name; return menu; } });
  assertEq(menuName, '💰 Budget', 'Menu is available in Sheets');
  ['reconcileFromDrive', 'reviewReconcileStaging', 'importReviewedReconciliation', 'dismissSelectedReconcileRows',
    'archiveCompletedReconcileRows', 'openReconcileHistory', 'refreshPendingReconciliation',
    'repairTransactionDerivedFormulas'].forEach(name => assertEq(items.includes(name), true, 'Menu includes ' + name));
  let created = 0; const triggers = [];
  const chain = { timeBased: () => chain, everyMinutes: minutes => { assertEq(minutes, 15, 'Use existing 15-minute cadence'); return chain; },
    create: () => { created++; triggers.push({ getHandlerFunction: () => 'dispatch' }); } };
  const api = { getProjectTriggers: () => triggers, newTrigger: handler => { assertEq(handler, 'dispatch', 'Use the master dispatcher'); return chain; } };
  ensureStatementDispatcher(api); ensureStatementDispatcher(api);
  assertEq(created, 1, 'Repeated setup creates no duplicate dispatcher');
}

/** Verify both model parser adapters preserve card sections before normalization. */
function test_stage3GModelCardSections() {
  const scope = typeof globalThis !== 'undefined' ? globalThis : this;
  const oldCall = scope.callGeminiApiWithRetry;
  try {
    scope.callGeminiApiWithRetry = () => ({ text: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      account: 'DBS CC SGD', transactions: ['4320', '7509', '0465'].map((card, i) => ({
        date: (10 + i) + '.08.2026', amount: i + 1, merchant: 'Shop', type: 'Расходы', card_last4: card
      }))
    }) }] } }] }) });
    const parsed = parsePdfStatement({ bytes: [37, 80, 68, 70], text: '%PDF', name: 'fixture.pdf' }, 'mock-key');
    assertEq(parsed.rows.length, 3, 'PDF adapter preserves all card sections');
    const normalized = normalizeRows(parsed.rows);
    assertEq(normalized.map(row => row.card_last4), ['4320', '7509', '0465'], 'PDF card suffixes survive normalization');
    assertEq(normalized.map(row => row.cardholder), ['Val', 'Rita', 'Grandparents'], 'PDF cardholders resolve correctly');
    assertEq(parsed.period.from, '10.08.2026', 'PDF period derived from its own dates');
    assertEq(parsePdfStatement({ text: '%PDF /Encrypt ', bytes: [] }, null).error, 'encrypted', 'Encrypted PDF rejected before requesting credentials');
  } finally {
    if (oldCall) scope.callGeminiApiWithRetry = oldCall; else delete scope.callGeminiApiWithRetry;
  }
}

function test_stage3GChangedFile() {
  const f = makeStage3GFixture(); const file = f.file('changed', 'revised.csv');
  const log = getReconcileFileLog(f.ss);
  writeReconcileFileState(log, file, 'processed', 'Prior version staged');
  file.getLastUpdated = () => new Date(2000);
  const result = scanStatementInbox(f.ss, f.folder([file]), {});
  assertEq(result.failed, 1, 'An edited source cannot silently reuse the old processed status');
  assertEq(file.moved, 0, 'Edited file stays in inbox for correction');
  assertEq(readReconcileFileState(log, file.getId()).version, '1000', 'Earlier review provenance is preserved');
}
