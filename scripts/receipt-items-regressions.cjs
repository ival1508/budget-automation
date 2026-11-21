// Stage 7A: synthetic receipts, model/Telegram/Sheets services mocked. No network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const item = overrides => ({ raw_text: 'BRC CHKN BRST 500G', item_name: 'Chicken breast', product_key: 'chicken_breast',
  brand: null, brand_tier: 'unknown', qty: 2, unit: 'g', size: 500, unit_price: 999,
  line_total: 12, discount: 2, item_category: 'meat', is_discretionary: false, ...overrides });
const receipt = overrides => ({ merchant: 'Fair Price', date: '28.10.2026', currency: 'SGD', receipt_total: 10,
  receipt_discount: 0, receipt_charges: 0, confidence: 0.95, line_items: [item()], ...overrides });
function txn(c, overrides) {
  return c.enrichTransaction({ date: '28.10.2026', account: 'DBS CC SGD', amount: 10, currency: 'SGD',
    where: 'Fair Price', source: 'receipt', category: 'Другое', ...overrides }, { 'Другое': 'Wants' });
}
function capture(c, raw) { return c.normalizeReceiptCapture(raw || receipt(), []); }
function provider(c) {
  ['provider.gs', 'prompts.gs', 'gemini.gs'].forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), c));
  c.PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', 'offline-key');
  c.getLearnedMerchantsContext = () => [];
  c.getCategoryBucketMap = () => ({ 'Другое': 'Wants' });
  c.flagExistingDuplicates = rows => rows;
  c.readReceiptProducts = () => [];
}
function modelReply(value) {
  return { text: JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }) };
}
const pdfClassification = overrides => ({ document_type: 'receipt', is_merchant_purchase: true,
  bank_name: '', account_reference: '', statement_period: '', has_transaction_history: false,
  confidence: 0.98, ...overrides });
const bankClassification = overrides => pdfClassification({ document_type: 'bank_statement',
  is_merchant_purchase: false, bank_name: 'DBS', account_reference: 'card ending 1234',
  statement_period: '1–31 October 2026', has_transaction_history: true, ...overrides });
const pdfMedia = () => ({ inlineData: { mimeType: 'application/pdf', data: 'synthetic-pdf' } });
function cacheFixture(c) {
  const values = new Map();
  c.CacheService = { getScriptCache: () => ({ get: key => values.get(key) ?? null,
    put: (key, value) => { assert.ok(Buffer.byteLength(value) < 100000); values.set(key, value); }, remove: key => values.delete(key) }) };
  return values;
}

function telegramFixture(c) {
  cacheFixture(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'telegramUI.gs'), 'utf8'), c);
  const getLedger = c.getTransactionsSheet, getCategories = c.getCategoryBucketMap;
  c.getTransactionsSheet = selected => getLedger(selected || c.SpreadsheetApp.getActiveSpreadsheet());
  c.getCategoryBucketMap = selected => getCategories(selected || c.SpreadsheetApp.getActiveSpreadsheet());
  const userProps = new Map(), messages = [], markups = [], documents = [], cards = [];
  c.PropertiesService.getUserProperties = () => ({ getProperty: key => userProps.get(key) || null,
    setProperty: (key, value) => userProps.set(key, value) });
  c.PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', 'offline-key');
  c.getWebhookAccessPolicy = () => ({ secret: 'offline-secret', chatIds: new Set(['123']) });
  c.LockService.getUserLock = () => ({ waitLock() {}, releaseLock() {} });
  c.HtmlService = { createHtmlOutput: value => value };
  c.getTelegramFilePath = () => 'offline-file';
  c.fetchTelegramFileAsBase64 = (_, __, mimeType) => ({ inlineData: { mimeType: mimeType || 'image/jpeg', data: 'mock' } });
  c.Utilities.base64Decode = value => value; c.Utilities.newBlob = (...args) => args;
  c.enqueueStatementFile = blob => documents.push(blob);
  c.sendTelegramMessage = text => messages.push(text);
  c.sendConfirmationMessage = (_, token, rows) => cards.push({ token, rows });
  c.answerCallbackQuery = () => {}; c.editTelegramMessage = (_, __, text, markup) => { messages.push(text); markups.push(markup); };
  c.sendDiscardedMessage = (_, __, text) => messages.push(text);
  c.updateMerchantLearningStore = () => {}; c.flagExistingDuplicates = rows => rows;
  c.formatTransactionConfirmationHtml = () => 'Transaction summary';
  let updateId = 4000;
  const post = message => c.doPost({ parameter: { secret: 'offline-secret' },
    postData: { contents: JSON.stringify({ update_id: ++updateId, message: { chat: { id: 123 }, ...message } }) } });
  const callback = data => c.handleCallbackQuery({ id: 'query', data, message: { chat: { id: 123 }, message_id: 12 } });
  return { post, callback, messages, markups, cards, documents, userProps };
}

function pdfFixture(c, storage, options = {}) {
  const sheet = storage(c);
  provider(c);
  const chat = telegramFixture(c);
  const calls = [];
  c.callGeminiApiWithRetry = payload => {
    const schema = payload.generationConfig.responseSchema;
    if (schema.type === 'ARRAY') {
      calls.push('transaction');
      return modelReply(options.transactions || [txn(c, { source: 'screenshot' })]);
    }
    if (schema.properties.receipts) {
      calls.push('items');
      if (options.itemError) throw new Error('Optional item capture unavailable');
      return modelReply(options.items || { document_type: 'other', receipts: [] });
    }
    calls.push('classification');
    assert.equal(payload.contents[0].parts[0].inlineData.mimeType, 'application/pdf');
    return modelReply(options.classification || pdfClassification());
  };
  const upload = extra => chat.post({ document: { file_id: 'pdf', mime_type: 'application/pdf',
    file_name: 'upload.pdf' }, ...extra });
  return { ...sheet, ...chat, calls, upload };
}

module.exports = (test, storage) => {
  test('PDF routing requires bank, customer account, period, history and confidence before classifying a statement', c => {
    provider(c);
    c.readReceiptProducts = () => { throw new Error('Routing must not depend on the product catalog'); };
    c.callGeminiApiWithRetry = () => modelReply(bankClassification());
    assert.equal(c.classifyPdfDocument(pdfMedia()), 'bank_statement');
    c.callGeminiApiWithRetry = () => modelReply(bankClassification({ statement_period: 'Statement date: 31 October 2026' }));
    assert.equal(c.classifyPdfDocument(pdfMedia()), 'bank_statement');
    for (const response of [
      { bank_name: '' }, { account_reference: '' }, { statement_period: '' },
      { has_transaction_history: false }, { confidence: 0.89 }
    ].map(bankClassification)) {
      c.callGeminiApiWithRetry = () => modelReply(response);
      assert.equal(c.classifyPdfDocument(pdfMedia()), 'other');
    }
  });
  test('merchant purchase evidence overrides a mistaken bank-statement label even with printed bank/card details', c => {
    provider(c);
    c.callGeminiApiWithRetry = () => modelReply(bankClassification({ is_merchant_purchase: true }));
    assert.equal(c.classifyPdfDocument(pdfMedia()), 'receipt');
    c.callGeminiApiWithRetry = () => modelReply(pdfClassification({ is_merchant_purchase: false }));
    assert.equal(c.classifyPdfDocument(pdfMedia()), 'receipt');
  });
  test('PDF classifier rejects malformed, truncated and non-PDF input before document routing', c => {
    provider(c);
    for (const response of [pdfClassification({ confidence: '0.99' }), pdfClassification({ confidence: 2 }),
      pdfClassification({ account_reference: null }), pdfClassification({ is_merchant_purchase: 'yes' }),
      pdfClassification({ document_type: 'itemized_receipt' })]) {
      c.callGeminiApiWithRetry = () => modelReply(response);
      assert.throws(() => c.classifyPdfDocument(pdfMedia()), /Could not identify this PDF/);
    }
    c.callGeminiApiWithRetry = () => ({ text: '{malformed' });
    assert.throws(() => c.classifyPdfDocument(pdfMedia()), /Could not identify/);
    c.callGeminiApiWithRetry = () => ({ text: JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) });
    assert.throws(() => c.classifyPdfDocument(pdfMedia()), /Could not identify/);
    assert.throws(() => c.classifyPdfDocument({ inlineData: { mimeType: 'image/png', data: 'mock' } }), /PDF is required/);
  });
  test('Shell-style summary PDF receipt proposes one transaction even when the product pass calls it a bank document', c => {
    const f = pdfFixture(c, storage, {
      classification: bankClassification({ is_merchant_purchase: true }),
      transactions: [txn(c, { where: 'Shell', amount: 68.20, source: 'screenshot' })],
      items: { document_type: 'bank_statement', receipts: [] }
    });
    f.upload({ document: { file_id: 'shell', mime_type: 'application/octet-stream', file_name: 'SHELL.PDF' } });
    assert.deepEqual(f.calls, ['classification', 'transaction', 'items']);
    assert.equal(f.documents.length, 0);
    assert.equal(f.cards.length, 1);
    assert.equal(f.cards[0].rows.length, 1);
    assert.equal(f.cards[0].rows[0].where, 'Shell');
    assert.equal(f.cards[0].rows[0].amount, 68.20);
    assert.equal(f.cards[0].rows[0].source, 'receipt');
    assert.equal(f.ledger.data.length, 2, 'Upload proposes without writing the ledger');
    f.callback('approve:' + f.cards[0].token);
    assert.equal(f.ledger.data.length, 3);
    assert.equal(f.ledger.data[2][8], 'Shell');
    assert.equal(f.ledger.data[2][3], 68.20);
    assert.equal(f.ss.getSheetByName('LineItems'), null);
  });
  for (const merchant of ['Restaurant', 'Medical clinic', 'Online shop']) {
    test(`summary-only ${merchant} PDF receipt stays approvable when optional item extraction fails`, c => {
      const f = pdfFixture(c, storage, { itemError: true,
        transactions: [txn(c, { where: merchant, source: 'screenshot' })] });
      f.upload();
      assert.equal(f.cards.length, 1); assert.equal(f.documents.length, 0);
      assert.equal(f.cards[0].rows.length, 1);
      assert.match(f.cards[0].rows[0].receipt_capture_warning, /not captured/);
      f.callback('approve:' + f.cards[0].token);
      assert.equal(f.ledger.data.length, 3);
      assert.equal(f.ledger.data[2][8], merchant);
    });
  }
  test('a genuine bank statement PDF declines retired inbox queueing without transaction or product extraction', c => {
    const f = pdfFixture(c, storage, { classification: bankClassification() });
    f.upload({ document: { file_id: 'bank', mime_type: 'application/pdf', file_name: 'Shell.pdf' } });
    assert.deepEqual(f.calls, ['classification']);
    assert.equal(f.cards.length, 0); assert.equal(f.documents.length, 0);
    assert.equal(f.ledger.data.length, 2);
    assert.match(f.messages.at(-1), /retired.*AI chat/i);
  });
  test('a PDF filename takes precedence over generic text/Excel MIME types and still proposes its receipt', c => {
    const f = pdfFixture(c, storage);
    for (const mime of ['', 'text/plain', 'application/vnd.ms-excel']) {
      f.upload({ document: { file_id: 'pdf-' + mime, mime_type: mime, file_name: 'receipt.PDF' } });
    }
    assert.equal(f.cards.length, 3); assert.equal(f.documents.length, 0);
    assert.equal(f.calls.filter(call => call === 'classification').length, 3);
  });
  test('an individual bank confirmation PDF uses transaction approval without product capture', c => {
    const f = pdfFixture(c, storage, { classification: pdfClassification({
      document_type: 'bank_transaction', is_merchant_purchase: false }) });
    f.upload();
    assert.deepEqual(f.calls, ['classification', 'transaction']);
    assert.equal(f.documents.length, 0); assert.equal(f.cards.length, 1);
    assert.equal(f.cards[0].rows[0].source, 'screenshot');
  });
  test('an unsubstantiated bank label does not queue a PDF or alter the pending proposal', c => {
    const f = pdfFixture(c, storage, { classification: bankClassification({ statement_period: '' }) });
    const previous = txn(c, { where: 'Reviewed purchase', manual_merchant_category: true });
    c.savePendingTransactions([previous], 'reviewed');
    f.userProps.set('latest_token_123', 'reviewed');
    f.upload();
    assert.deepEqual(f.calls, ['classification']);
    assert.equal(f.cards.length, 0); assert.equal(f.documents.length, 0);
    assert.deepEqual(plain(c.getPendingTransactions('reviewed')), plain([previous]));
  });
  test('new PDF proposals preserve prior reviewed items and overlapping PDF uploads add no duplicate', c => {
    const f = pdfFixture(c, storage, { transactions: [txn(c, { where: 'Shell', amount: 68.20 })] });
    const previous = txn(c, { where: 'Reviewed purchase', source: 'screenshot', manual_merchant_category: true });
    c.savePendingTransactions([previous], 'reviewed');
    f.userProps.set('latest_token_123', 'reviewed');
    f.upload({ caption: 'Fuel purchase' });
    let rows = c.getPendingTransactions('reviewed');
    assert.equal(rows.length, 2);
    assert.deepEqual(plain(rows[0]), plain(previous));
    assert.equal(rows[1].where, 'Shell'); assert.equal(rows[1].source, 'receipt');
    f.upload(); rows = c.getPendingTransactions('reviewed');
    assert.equal(rows.length, 2); assert.equal(f.documents.length, 0);
  });
  test('a PDF receipt with products captures items only after its one financial transaction is approved', c => {
    const f = pdfFixture(c, storage, { items: { document_type: 'itemized_receipt', receipts: [receipt()] } });
    f.upload();
    assert.equal(f.cards[0].rows.length, 1);
    assert.equal(f.cards[0].rows[0].receipt_capture.line_items.length, 1);
    assert.equal(f.ss.getSheetByName('LineItems'), null);
    f.callback('approve:' + f.cards[0].token);
    assert.equal(f.ledger.data.length, 3);
    assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
  });
  test('receipt capture normalizes units and product aliases without guessing brands or trusting AI prices', c => {
    const first = capture(c);
    assert.equal(first.line_items[0].unit, 'kg'); assert.equal(first.line_items[0].size, 0.5);
    assert.equal(first.line_items[0].brand, null); assert.equal(first.line_items[0].unit_price, null);
    const catalog = [{ product_key: 'chicken_breast', canonical_name: 'Chicken breast', raw_aliases: ['BRC CHKN BRST 500G'] }];
    const matched = c.normalizeReceiptCapture(receipt({ line_items: [item({ product_key: 'chicken_meat', item_name: 'Chicken Breast' })] }), catalog);
    assert.equal(matched.line_items[0].product_key, 'chicken_breast');
    const liquid = capture(c, receipt({ line_items: [item({ unit: 'ml', size: 750 })] }));
    assert.equal(liquid.line_items[0].unit, 'l'); assert.equal(liquid.line_items[0].size, 0.75);
    assert.equal(capture(c, receipt({ line_items: [item({ qty: null, size: null, unit: 'unknown' })] })).line_items[0].size, null);
  });
  test('receipt capture refuses malformed financial fields and dates instead of creating plausible zeros', c => {
    for (const raw of [receipt({ receipt_total: '' }), receipt({ confidence: 2 }), receipt({ date: '31.02.2026' }),
      receipt({ line_items: [] }), receipt({ line_items: [item({ qty: 0 })] }), receipt({ line_items: [item({ discount: 20 })] }),
      receipt({ line_items: [item({ line_total: NaN })] })]) assert.throws(() => capture(c, raw));
  });
  test('receipt reconciliation subtracts each discount once and handles printed basket tax/fees and 2 percent tolerance', c => {
    const parent = txn(c);
    assert.equal(c.receiptReconciliation(capture(c), parent).reconciled, true);
    assert.equal(c.receiptReconciliation(capture(c, receipt({ receipt_discount: 1, receipt_charges: 1 })), parent).reconciled, true);
    assert.equal(c.receiptReconciliation(capture(c, receipt({ line_items: [item({ line_total: 12.2 })] })), parent).reconciled, true);
    assert.equal(c.receiptReconciliation(capture(c, receipt({ line_items: [item({ line_total: 12.21 })] })), parent).reconciled, false);
    assert.equal(c.receiptReconciliation(capture(c), { ...parent, amount: 11 }).reconciled, false);
    assert.equal(c.receiptReconciliation(capture(c), { ...parent, currency: 'USD' }).reconciled, false);
  });
  test('receipt linkage requires a unique merchant/date/amount/currency match and never assigns by array position', c => {
    const raw = capture(c), parent = txn(c), other = txn(c, { amount: 20, where: 'Other' });
    c.attachReceiptCaptures([other, parent], { document_type: 'itemized_receipt', receipts: [raw] });
    assert.equal(parent.receipt_capture.receipt_id, raw.receipt_id); assert.equal(other.receipt_capture, undefined);
    for (const changed of [{ source: 'screenshot' }, { date: '27.10.2026' }, { currency: 'USD' }, { where: 'Other' }]) {
      const row = txn(c, changed); c.attachReceiptCaptures([row], { document_type: 'itemized_receipt', receipts: [raw] });
      assert.equal(row.receipt_capture, undefined);
    }
    const ambiguous = [txn(c), txn(c)];
    c.attachReceiptCaptures(ambiguous, { document_type: 'itemized_receipt', receipts: [raw] });
    assert.ok(ambiguous.every(row => !row.receipt_capture));
    const sameParent = txn(c);
    c.attachReceiptCaptures([sameParent], { document_type: 'itemized_receipt', receipts: [raw, raw] });
    assert.equal(sameParent.receipt_capture, undefined);
  });
  test('only visual itemized receipts can yield items; bank screenshots and typed shopping text cannot', c => {
    provider(c); let calls = 0;
    c.callGeminiApiWithRetry = payload => {
      calls++; assert.ok(payload.contents[0].parts.every(part => part.inlineData));
      return modelReply({ document_type: 'bank_screenshot', receipts: [receipt()] });
    };
    assert.equal(c.extractReceiptItems([{ text: 'Chicken 10 dollars' }]).receipts.length, 0);
    assert.equal(c.extractReceiptItems([{ inlineData: { mimeType: 'audio/ogg', data: 'mock' } }]).receipts.length, 0);
    assert.equal(calls, 0);
    const media = [{ inlineData: { mimeType: 'image/jpeg', data: 'mock' } }];
    assert.equal(c.extractReceiptItems(media).receipts.length, 0); assert.equal(calls, 1);
    c.callGeminiApiWithRetry = () => modelReply({ document_type: 'itemized_receipt', receipts: [receipt()] });
    assert.equal(c.extractReceiptItems(media).receipts[0].line_items.length, 1);
    c.callGeminiApiWithRetry = () => ({ text: JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) });
    assert.throws(() => c.extractReceiptItems(media), /incomplete/);
  });
  test('transaction extraction attaches a separate receipt pass, preserves ordinary captures on failure and skips bank item calls', c => {
    provider(c); const parent = txn(c); let calls = 0;
    c.callGeminiApiWithRetry = () => { calls++; return calls === 1 ? modelReply([parent]) :
      modelReply({ document_type: 'itemized_receipt', receipts: [receipt()] }); };
    const media = [{ inlineData: { mimeType: 'image/jpeg', data: 'mock' } }];
    const extracted = c.extractTransactions(media);
    assert.equal(calls, 2); assert.equal(extracted[0].receipt_capture.line_items.length, 1);
    c.callGeminiApiWithRetry = () => modelReply([{ ...parent, source: 'screenshot', receipt_capture: receipt() }]);
    const bank = c.extractTransactions(media); assert.equal(bank[0].receipt_capture, undefined);
    calls = 0; c.callGeminiApiWithRetry = () => { if (++calls === 1) return modelReply([parent]); throw new Error('offline failure'); };
    const failed = c.extractTransactions(media);
    assert.equal(failed.length, 1); assert.match(failed[0].receipt_capture_warning, /not captured/);
  });
  test('receipt transaction edits keep items and re-evaluate totals against the final approved parent', c => {
    const parent = txn(c, { receipt_capture: capture(c) });
    const edited = c.applyProposalEditPlan([parent], { clarification: '', operations: [{ item: 1, action: 'update',
      changes: { amount: 15, where: 'Corrected Shop', account: 'DBS SGD' } }] }).transactions[0];
    assert.equal(edited.receipt_capture.receipt_id, parent.receipt_capture.receipt_id);
    assert.notEqual(edited.dedupe_key, parent.dedupe_key);
    assert.equal(c.receiptReconciliation(edited.receipt_capture, edited).reconciled, false);
  });
  test('receipt append uses the unchanged eleven-column ledger and a separate, idempotent item store under the same lock', c => {
    const f = storage(c), parent = txn(c, { receipt_capture: capture(c) });
    const initial = structuredClone(f.ledger.data);
    assert.equal(c.appendTransactions([parent], f.ss, true).dryRun, true);
    assert.equal(f.ss.getSheetByName('LineItems'), null); assert.deepEqual(f.ledger.data, initial);
    const result = c.appendTransactions([parent], f.ss, false);
    assert.equal(result.writtenCount, 1); assert.equal(result.receiptCapture.items, 1);
    assert.equal(f.ledger.data.at(-1).length, 11);
    const row = f.ss.getSheetByName('LineItems').data[1];
    assert.equal(row[0], parent.dedupe_key); assert.equal(row[12], 10); assert.equal(row[24], true); assert.equal(row[28], true);
    const products = f.ss.getSheetByName('Products').data;
    assert.equal(products.length, 2); assert.equal(products[1][6], 10);
    const repeat = c.withBudgetWriteLock(() => c.persistApprovedReceiptItems([parent], f.ss));
    assert.equal(repeat.already_saved, 1); assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
    products[1][7] = vm.runInContext("new Date('2026-10-27T16:00:00Z')", c); products[1][8] = products[1][7];
    const nativeDates = c.readReceiptProducts(f.ss);
    assert.equal(nativeDates[0].baseline_set_date, '28.10.2026'); assert.equal(nativeDates[0].last_seen, '28.10.2026');
    assert.equal(f.lock.acquired, f.lock.released);
  });
  test('mismatched or low-confidence receipt rows are retained without establishing a price baseline', c => {
    for (const raw of [receipt({ line_items: [item({ line_total: 8 })] }), receipt({ confidence: 0.7 })]) {
      const f = storage(c), parent = txn(c, { receipt_capture: capture(c, raw) });
      const result = c.appendTransactions([parent], f.ss, false);
      const row = f.ss.getSheetByName('LineItems').data[1];
      assert.equal(result.receiptCapture.items, 1); assert.equal(row[28], false);
      assert.equal(f.ss.getSheetByName('Products').data[1][6], '');
      if (raw.confidence > 0.8) { assert.equal(row[24], false); assert.match(c.receiptCaptureSummary(result), /excluded from price analysis/); }
    }
  });
  test('converted foreign receipt links to the ledger SGD key while retaining source currency and excluding SGD baselines', c => {
    const f = storage(c), parent = txn(c, { amount: 10, amount_sgd: 13.5, currency: 'USD',
      receipt_capture: capture(c, receipt({ currency: 'USD' })) });
    const result = c.appendTransactions([parent], f.ss, false);
    assert.equal(result.receiptCapture.items, 1);
    const row = f.ss.getSheetByName('LineItems').data[1];
    assert.equal(row[0], c.generateDedupeKey(parent.date, parent.account, 13.5, parent.where));
    assert.equal(row[20], 'USD'); assert.equal(f.ss.getSheetByName('Products').data[1][6], '');
  });
  test('unconfirmed, discarded and ordinary inputs create no item stores; storage failure never rewrites or loses the saved ledger transaction', c => {
    const f = storage(c), parent = txn(c, { receipt_capture: capture(c) });
    cacheFixture(c); c.savePendingTransactions([parent], 'pending');
    assert.equal(f.ss.getSheetByName('LineItems'), null);
    c.clearPendingTransactions('pending'); assert.equal(f.ss.getSheetByName('LineItems'), null);
    f.ss.insertSheet = () => { throw new Error('Injected storage failure'); };
    const result = c.appendTransactions([parent], f.ss, false);
    assert.equal(result.writtenCount, 1); assert.equal(f.ledger.data.length, 3);
    assert.match(c.receiptCaptureSummary(result), /storage needs a retry/);
    assert.equal(f.lock.acquired, f.lock.released);
  });
  test('attaching receipt items to an existing transaction saves items or repairs catalog without a second ledger write', c => {
    const f = storage(c), parent = txn(c);
    c.appendTransactions([parent], f.ss, false);
    parent.receipt_capture = capture(c);
    parent.receipt_attachment_revision = c.receiptAttachmentRevision(parent);
    const candidates = c.findReceiptAttachmentCandidates(parent, f.ss);
    assert.equal(candidates.length, 1);
    const result = c.saveReceiptItemsToExisting(parent, candidates[0], f.ss);
    assert.equal(result.receiptCapture.items, 1); assert.equal(f.ledger.data.length, 3);
    f.ss.getSheetByName('Products').data.length = 1;
    const replay = c.saveReceiptItemsToExisting(parent, candidates[0], f.ss);
    assert.equal(replay.receiptCapture.already_saved, 1); assert.equal(f.ss.getSheetByName('Products').data.length, 2);
    assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
    const forced = { ...parent, flags: ['force_add'], receipt_capture: capture(c) };
    const forcedResult = c.appendTransactions([forced], f.ss, false);
    assert.match(c.receiptCaptureSummary(forcedResult), /unique recorded parent/);
    assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
  });
  test('item history is append-only, repairs missing rows, and rejects a different receipt for an existing parent', c => {
    const f = storage(c), raw = receipt({ line_items: [item({ line_total: 7 }), item({ raw_text: 'CHICKEN 500G', line_total: 7 })] });
    const parent = txn(c, { receipt_capture: capture(c, raw) });
    c.appendTransactions([parent], f.ss, false);
    const sheet = f.ss.getSheetByName('LineItems'); assert.equal(sheet.data.length, 3);
    sheet.data.pop();
    const repaired = c.withBudgetWriteLock(() => c.persistApprovedReceiptItems([parent], f.ss));
    assert.equal(repaired.items, 1); assert.equal(sheet.data.length, 3);
    parent.receipt_capture = capture(c);
    const rejected = c.withBudgetWriteLock(() => c.persistApprovedReceiptItems([parent], f.ss));
    assert.match(rejected.warnings[0], /different receipt/); assert.equal(sheet.data.length, 3);
  });
  test('catalog header drift is preserved and OCR strings cannot inject sheet formulas', c => {
    const f = storage(c);
    f.ss.insertSheet('Products').data = [['owner data']];
    assert.throws(() => c.initializeReceiptItemStore(f.ss), /existing data was preserved/);
    assert.equal(f.ss.getSheetByName('LineItems'), null);
    assert.deepEqual(f.ss.getSheetByName('Products').data, [['owner data']]);
    for (const value of ['=IMPORTDATA("x")', '+1', '-2', '@name']) assert.equal(c.receiptItemSafeCell(value), "'" + value);
    assert.equal(c.receiptItemSafeCell(10), 10); assert.equal(c.receiptItemSafeCell(false), false);
  });
  test('large receipt proposals survive CacheService limits and fail safely when a chunk expires', c => {
    const cache = cacheFixture(c), parent = txn(c, { receipt_capture: capture(c) });
    parent.receipt_capture.line_items = Array.from({ length: 250 }, () => item({ raw_text: '鸡肉🍗'.repeat(40) }));
    c.savePendingTransactions([parent], 'large');
    assert.deepEqual(plain(c.getPendingTransactions('large')), plain([parent]));
    const manifest = JSON.parse(cache.get('large')); assert.ok(manifest.pending_chunks > 1);
    cache.delete('large:' + manifest.revision + ':0'); assert.equal(c.getPendingTransactions('large'), null);
    c.clearPendingTransactions('large'); assert.equal(c.getPendingTransactions('large'), 'PROCESSED');
  });
  test('an overlapping bank screenshot proposal receives receipt detail without losing reviewed fields or creating a duplicate', c => {
    const old = txn(c, { source: 'screenshot', category: 'Дом' }), incoming = txn(c, { receipt_capture: capture(c) });
    const result = c.mergeScreenshotProposals([old], [incoming]);
    assert.equal(result.length, 1); assert.equal(result[0].category, 'Дом'); assert.equal(result[0].receipt_capture.line_items.length, 1);
  });
  test('capture status is read-only and points to /items for Basket Review', c => {
    const f = storage(c);
    assert.match(c.previewReceiptCapture(f.ss).message, /No receipt items/); assert.equal(f.ss.getSheetByName('Products'), null);
    c.appendTransactions([txn(c, { receipt_capture: capture(c) })], f.ss, false);
    const status = c.previewReceiptCapture(f.ss);
    assert.equal(status.items, 1); assert.equal(status.receipts, 1); assert.match(status.message, /Use \/items for Basket Review/);
  });
  test('Telegram receipt photo approval saves item history, reports capture and leaves the ledger schema intact', c => {
    const f = storage(c), chat = telegramFixture(c);
    const parent = txn(c, { receipt_capture: capture(c) });
    c.extractTransactions = () => [parent];
    chat.post({ photo: [{ file_id: 'photo' }] });
    assert.equal(chat.cards.length, 1); assert.equal(f.ledger.data.length, 2);
    assert.equal(f.ss.getSheetByName('LineItems'), null);
    chat.callback('approve:' + chat.cards[0].token);
    assert.equal(f.ledger.data.length, 3); assert.equal(f.ledger.data[2].length, 11);
    assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
    assert.ok(chat.messages.some(message => /1 receipt items saved/.test(message)));
    chat.callback('approve:' + chat.cards[0].token);
    assert.equal(f.ledger.data.length, 3); assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
  });
  test('Telegram Add line items attaches a receipt to an existing parent while duplicate skip and discard never capture items', c => {
    const f = storage(c), chat = telegramFixture(c), parent = txn(c);
    c.appendTransactions([parent], f.ss, false);
    parent.receipt_capture = capture(c); parent.flags = ['possible_duplicate']; parent.receipt_existing_purchase = true;
    c.savePendingTransactions([parent], 'duplicate');
    chat.callback('resolve_dup:duplicate:0:skip');
    assert.equal(f.ledger.data.length, 3); assert.equal(f.ss.getSheetByName('LineItems'), null);
    c.savePendingTransactions([parent], 'attach');
    chat.callback('receipt_menu:attach:0');
    const saveBtn = chat.markups.at(-1).inline_keyboard.flat().find(btn => /^receipt_save:/.test(btn.callback_data));
    assert.ok(saveBtn);
    chat.callback(saveBtn.callback_data);
    assert.equal(f.ledger.data.length, 3); assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
    assert.ok(chat.messages.some(message => /Receipt attached to the existing transaction/.test(message)));
    const other = txn(c, { where: 'Other', receipt_capture: capture(c) });
    c.savePendingTransactions([other], 'discard'); chat.callback('discard:discard');
    assert.equal(f.ss.getSheetByName('LineItems').data.length, 2);
  });
  test('Telegram routes receipt PDFs with immediate acknowledgement and declines retired bank PDF/CSV inbox uploads', c => {
    storage(c); const chat = telegramFixture(c); let classifications = 0;
    c.classifyPdfDocument = () => { classifications++; return 'receipt'; };
    c.extractTransactions = (_, context) => {
      assert.equal(context.pdf_document_type, 'receipt');
      assert.equal(context.previous_proposal, undefined);
      return [txn(c, { receipt_capture: capture(c) })];
    };
    chat.post({ document: { file_id: 'receipt-pdf', mime_type: 'application/pdf', file_name: 'receipt.pdf' } });
    assert.ok(chat.messages.some(m => /PDF received/.test(m)));
    assert.equal(chat.cards.length, 1); assert.equal(chat.documents.length, 0); assert.equal(classifications, 1);
    c.classifyPdfDocument = () => 'bank_statement';
    chat.post({ document: { file_id: 'bank-pdf', mime_type: 'application/pdf', file_name: 'bank.pdf' } });
    assert.equal(chat.documents.length, 0);
    assert.match(chat.messages.at(-1), /retired.*AI chat/i);
    c.classifyPdfDocument = () => { throw new Error('CSV/image must not use the PDF classification path'); };
    chat.post({ document: { file_id: 'csv', mime_type: 'text/csv', file_name: 'bank.csv' } });
    assert.equal(chat.documents.length, 0);
    assert.match(chat.messages.at(-1), /retired.*AI chat/i);
    c.extractTransactions = () => [txn(c)];
    chat.post({ document: { file_id: 'image', mime_type: 'image/png', file_name: 'receipt.png' } });
    assert.equal(chat.cards.length, 2); assert.equal(chat.documents.length, 0);
  });
  test('unreadable and unrelated PDFs cannot silently enter the bank importer; /items runs Basket Review and /items status reads diagnostics', c => {
    const f = storage(c), chat = telegramFixture(c);
    c.classifyPdfDocument = () => 'other';
    chat.post({ document: { file_id: 'other', mime_type: 'application/pdf', file_name: 'other.pdf' } });
    assert.equal(chat.documents.length, 0); assert.match(chat.messages.at(-1), /could not be identified/);
    c.classifyPdfDocument = () => { throw new Error('PDF classification unavailable'); };
    c.fetchWithRetry = (_, options) => { chat.messages.push(JSON.parse(options.payload).text); return {}; };
    chat.post({ document: { file_id: 'broken', mime_type: 'application/pdf', file_name: 'broken.pdf' } });
    assert.equal(chat.documents.length, 0); assert.match(chat.messages.at(-1), /unavailable/);
    chat.post({ text: '/items@budget_bot status' });
    assert.match(chat.messages.at(-1), /No receipt items captured/);
    assert.equal(f.ss.getSheetByName('LineItems'), null);
    chat.post({ text: '/items@budget_bot' });
    assert.match(chat.messages.at(-1), /Basket Review/);
    assert.equal(f.ss.getSheetByName('LineItems'), null);
  });
  test('package weights counted as each normalize 340g and 555g packs to kg using printed price evidence', c => {
    const p340 = capture(c, receipt({ receipt_total: 19.90, line_items: [item({
      raw_text: 'DR OETKER PIZZA 340G', item_name: 'Pizza', product_key: 'pizza',
      qty: 340, unit: 'each', size: 1, printed_unit_price: 9.95, printed_price_unit: 'each', line_total: 19.90, discount: 0
    })] })).line_items[0];
    assert.equal(p340.unit, 'kg'); assert.equal(p340.size, 0.34); assert.equal(p340.qty, 2);
    assert.equal(p340.printed_unit_price, 9.95); assert.equal(p340.printed_price_unit, 'each');
    const ambiguous = capture(c, receipt({ receipt_total: 12.50, line_items: [item({
      raw_text: 'PIZZA 555G', item_name: 'Pizza', product_key: 'pizza',
      qty: 555, unit: 'each', size: 1, unit_price: null, line_total: 12.50, discount: 0
    })] })).line_items[0];
    assert.equal(ambiguous.unit, 'kg'); assert.equal(ambiguous.size, 0.555); assert.equal(ambiguous.qty, null);
    assert.equal(ambiguous.unit_price, null);
  });
  test('evening recap reports opening allowance K, closing saldo L, and daily movement without D19', c => {
    const lines = c.buildEveningPacingLines({ K_cumulative_today: 120, L_saldo_today: 80, L_saldo_yesterday: 50 });
    assert.match(lines[0], /Available Today:.*S\$120\.00/);
    assert.match(lines[1], /Result:.*S\$80\.00 underspent/);
    assert.match(lines[2], /Improved by S\$30\.00 today/);
    const over = c.buildEveningPacingLines({ K_cumulative_today: -25, L_saldo_today: -40, L_saldo_yesterday: -10 });
    assert.match(over[0], /No spending room — S\$25\.00 behind pace/);
    assert.match(over[1], /S\$40\.00 overspent/);
    assert.match(over[2], /Worsened by S\$30\.00 today/);
    assert.match(c.buildEveningPacingLines({ error: 'missing' })[0], /unavailable/);
  });
  test('transaction intake uses 4-pool distinct fallback with jittered backoff on 503/network errors and fast-fails 400 client errors', c => {
    provider(c);
    const seen = [], sleeps = [];
    c.Utilities.sleep = ms => sleeps.push(ms);
    c.UrlFetchApp = { fetch: (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.payload) });
      if (seen.length === 1) return { getResponseCode: () => 503, getContentText: () => 'UNAVAILABLE' };
      if (seen.length === 2) throw new Error('Transient socket timeout');
      if (seen.length === 3) return { getResponseCode: () => 503, getContentText: () => 'UNAVAILABLE' };
      if (seen.length === 4) return { getResponseCode: () => 429, getContentText: () => 'RESOURCE_EXHAUSTED' };
      return { getResponseCode: () => 200, getContentText: () => modelReply([]).text };
    } };
    const res = c.callGeminiForTransactionIntake({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { temperature: 0.2 } }, 'k');
    assert.equal(res.modelUsed, 'gemini-3.5-flash-lite');
    assert.equal(seen.length, 5);
    assert.match(seen[0].url, /gemini-4-hydrogen/);
    assert.match(seen[1].url, /gemini-3\.6-flash/);
    assert.match(seen[2].url, /gemini-3\.5-flash-lite/);
    assert.match(seen[3].url, /gemini-3\.8-flash/);
    assert.match(seen[4].url, /gemini-3\.5-flash-lite/);
    seen.forEach(req => {
      assert.deepEqual(req.body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
      assert.equal(req.body.generationConfig.temperature, undefined);
    });
    assert.equal(sleeps.length, 4);
    assert.ok(sleeps[0] >= 750 && sleeps[1] >= 1500 && sleeps[2] >= 2500 && sleeps[3] >= 3000);

    // Non-transient client errors (400) fail fast without burning backup models or sleeping
    seen.length = 0; sleeps.length = 0;
    c.UrlFetchApp = { fetch: (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.payload) });
      return { getResponseCode: () => 400, getContentText: () => 'INVALID_ARGUMENT' };
    } };
    assert.throws(() => c.callGeminiForTransactionIntake({ contents: [] }, 'k'), /error code 400/);
    assert.equal(seen.length, 1);
    assert.equal(sleeps.length, 0);
  });
  test('PDF routing starts on 10M-TPM 3.5-flash-lite with MINIMAL thinking, clamps MINIMAL->LOW on 4-hydrogen/3.8-flash, and auto-downgrades rejected priority tier', c => {
    provider(c);
    c.PropertiesService.getScriptProperties().setProperty('GEMINI_SERVICE_TIER', 'priority');
    const seen = [];
    c.Utilities.sleep = () => {};
    c.UrlFetchApp = { fetch: (url, opts) => {
      const body = JSON.parse(opts.payload);
      seen.push({ url, body });
      if (seen.length === 1) return { getResponseCode: () => 400, getContentText: () => 'serviceTier priority is not supported on free tier' };
      if (seen.length <= 3) return { getResponseCode: () => 503, getContentText: () => 'overloaded' };
      return { getResponseCode: () => 200, getContentText: () => modelReply(pdfClassification()).text };
    } };
    assert.equal(c.classifyPdfDocument(pdfMedia()), 'receipt');
    assert.equal(seen[0].body.serviceTier, 'priority');
    assert.equal(seen[1].body.serviceTier, undefined);
    assert.match(seen[1].url, /gemini-3\.5-flash-lite/);
    assert.equal(seen[1].body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.match(seen[2].url, /gemini-3\.6-flash/);
    assert.equal(seen[2].body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.match(seen[3].url, /gemini-4-hydrogen/);
    assert.equal(seen[3].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  });
  test('Stage 7B Basket Review validates SGD parents, computes merchant price gaps, and excludes unreconciled or foreign rows', c => {
    const ledger = [
      ['01.10.2026', 'DBS CC SGD', 'Расходы', 24, 24, '', '', 'Продукты', 'Cold Storage', '', 'Needs'],
      ['05.10.2026', 'DBS CC SGD', 'Расходы', 24, 24, '', '', 'Продукты', 'Cold Storage', '', 'Needs'],
      ['10.10.2026', 'DBS CC SGD', 'Расходы', 24, 24, '', '', 'Продукты', 'Cold Storage', '', 'Needs'],
      ['02.11.2026', 'DBS CC SGD', 'Расходы', 36, 36, '', '', 'Продукты', 'FairPrice', '', 'Needs'],
      ['09.11.2026', 'DBS CC SGD', 'Расходы', 36, 36, '', '', 'Продукты', 'FairPrice', '', 'Needs'],
      ['16.11.2026', 'DBS CC SGD', 'Расходы', 36, 36, '', '', 'Продукты', 'FairPrice', '', 'Needs'],
      ['18.11.2026', 'DBS CC SGD', 'Расходы', 15, 15, '', '', 'Продукты', 'BadShop', '', 'Needs']
    ];
    const mkLine = (dt, merch, amt, price, rid, rec = true, curr = 'SGD') => [
      c.generateDedupeKey(dt, 'DBS CC SGD', amt, merch), dt, merch, 'DBS CC SGD',
      'MEIJI MILK 2L', 'Fresh milk', 'fresh_milk', 'Meiji', 'mainstream',
      3, 'l', 2, price, amt, 0, 'dairy', false,
      rid, 1, 1, curr, amt, 0, 0, rec, 0, 0.95, '2026-11-20T00:00:00Z', rec, amt / 3, 'each'
    ];
    const items = [
      mkLine('01.10.2026', 'Cold Storage', 24, 4, 'r1'),
      mkLine('05.10.2026', 'Cold Storage', 24, 4, 'r2'),
      mkLine('10.10.2026', 'Cold Storage', 24, 4, 'r3'),
      mkLine('02.11.2026', 'FairPrice', 36, 6, 'r4'),
      mkLine('09.11.2026', 'FairPrice', 36, 6, 'r5'),
      mkLine('16.11.2026', 'FairPrice', 36, 6, 'r6'),
      mkLine('18.11.2026', 'BadShop', 15, 2.5, 'r7', false)
    ];
    const now = vm.runInContext("new Date('2026-11-21T04:00:00Z')", c);
    const report = c.analyzeBasketRows(items, ledger, [], '2026-11', { now });
    assert.equal(report.status, 'ready');
    assert.equal(report.coverage.analyzedReceipts, 3);
    assert.equal(report.coverage.excludedReceipts, 1);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].kind, 'merchant_gap');
    assert.equal(report.findings[0].monthlySaving, 36);
    const rendered = c.renderBasketReview(report);
    assert.match(rendered, /Basket Review — 2026-11 to date/);
    assert.match(rendered, /S\$6\.00\/l at FairPrice versus S\$4\.00\/l at Cold Storage/);
    assert.match(c.renderBasketReviewDetails(report), /Excluded receipt groups[\s\S]*unreconciled/);
  });
  test('large receipts expand item storage beyond the initial sheet grid and preserve every product row', c => {
    const f = storage(c);
    const parent = txn(c, { amount: 250, receipt_capture: capture(c, receipt({ receipt_total: 250,
      line_items: Array.from({ length: 250 }, (_, i) => item({ raw_text: 'SKU ' + i, item_name: 'Product ' + i,
        product_key: 'product_' + i, qty: 1, unit: 'each', size: 1, line_total: 1, discount: 0 })) })) });
    const insert = f.ss.insertSheet; let expanded = 0;
    f.ss.insertSheet = name => { const sheet = insert(name); sheet.insertRowsAfter = (_, count) => { expanded += count; }; return sheet; };
    const result = c.appendTransactions([parent], f.ss, false);
    assert.equal(result.receiptCapture.items, 250); assert.ok(expanded > 0);
    assert.equal(f.ss.getSheetByName('LineItems').data.length, 251); assert.equal(f.ss.getSheetByName('Products').data.length, 251);
  });
  test('multi-row and non-purchase bank screenshots skip second vision pass while single-row screenshot checks start on 3.6-flash', c => {
    provider(c);
    const media = [{ inlineData: { mimeType: 'image/jpeg', data: 'mock-bank' } }];
    let urls = [];
    // 1. Multi-row bank unbilled screenshot (Netflix + Apple refund + YouTube) -> 1 Gemini call total
    c.UrlFetchApp = { fetch: url => {
      urls.push(url);
      return { getResponseCode: () => 200, getContentText: () => modelReply([
        txn(c, { where: 'Netflix', amount: 29.98, source: 'screenshot' }),
        txn(c, { where: 'Apple.com', amount: 67.92, type: 'Получение денег', source: 'screenshot' }),
        txn(c, { where: 'YouTube Premium', amount: 31.98, source: 'screenshot' })
      ]).text };
    } };
    const multi = c.extractTransactions(media);
    assert.equal(urls.length, 1);
    assert.equal(multi.length, 3);
    assert.ok(multi.every(row => /bank document; no product lines/.test(row.receipt_capture_status.reason)));

    // 2. Single-row inflow/refund screenshot -> 1 Gemini call total
    urls = [];
    c.UrlFetchApp = { fetch: url => {
      urls.push(url);
      return { getResponseCode: () => 200, getContentText: () => modelReply([
        txn(c, { where: 'Apple.com', amount: 67.92, type: 'Получение денег', source: 'screenshot' })
      ]).text };
    } };
    const inflow = c.extractTransactions(media);
    assert.equal(urls.length, 1);
    assert.match(inflow[0].receipt_capture_status.reason, /bank document/);

    // 3. Single-row expense labelled screenshot (e.g. MyRepublic or mislabelled receipt) -> 2nd pass starts on gemini-3.6-flash, not 4-hydrogen
    urls = [];
    c.UrlFetchApp = { fetch: url => {
      urls.push(url);
      if (urls.length === 1) {
        return { getResponseCode: () => 200, getContentText: () => modelReply([
          txn(c, { where: 'MyRepublic', amount: 8.71, source: 'screenshot' })
        ]).text };
      }
      return { getResponseCode: () => 200, getContentText: () => modelReply({ document_type: 'bank_screenshot', receipts: [] }).text };
    } };
    const single = c.extractTransactions(media);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /gemini-4-hydrogen/);
    assert.match(urls[1], /gemini-3\.6-flash/);
    assert.match(single[0].receipt_capture_status.reason, /bank document/);
  });
};
