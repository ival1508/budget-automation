// Offline repayment coverage. No model requests, Telegram sends or live writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const payment = (extra = {}) => ({ date: '28.10.2026', account: 'DBS SGD',
  amount: 1234.56, currency: 'SGD', where: 'DBS credit card bill payment',
  category: 'Кредитка', type: 'Расходы', flags: [], ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(c, storage, typeAware = true) {
  const f = storage(c);
  c.getCategoryBucketMap = () => ({ 'Кредитка': '-', 'Другое': 'Wants' });
  if (typeAware) f.ledger.data[1][6] = '=IF(C2="Получение денег";F2+D2;F2-D2)';
  return f;
}

module.exports = (test, storage) => {
  test('DBS repayment enrichment uses transfer category and account-specific direction', c => {
    const map = { 'Кредитка': '-' };
    c.getMerchantAliases = () => ({ [c.normaliseWhere(payment().where)]: { canonical: 'Wrong', category: 'Дом' } });
    for (const account of ['DBS SGD', 'DBS CC SGD']) {
      for (const extra of [{}, { category: 'Другое', flags: ['cc_payoff', 'check_amount'], needs_review: true }]) {
        const input = payment({ account, amount: -1234.56, ...extra });
        const before = JSON.stringify(input);
        const row = c.enrichTransaction(input, map);
        assert.equal(row.category, 'Кредитка');
        assert.equal(row.bucket, '-');
        assert.equal(row.type, account === 'DBS SGD' ? 'Снятие денег' : 'Получение денег');
        assert.equal(row.amount, 1234.56);
        assert.equal(row.amount_sgd, 1234.56);
        assert.ok(row.flags.includes('cc_payoff'));
        assert.equal(row.where, input.where);
        assert.equal(JSON.stringify(input), before);
        if (extra.needs_review) { assert.equal(row.needs_review, true); assert.ok(row.flags.includes('check_amount')); }
      }
    }
  });
  for (const account of ['DBS SGD', 'DBS CC SGD']) {
    test(`one ${account} repayment creates exactly two ledger rows, formulas and an idempotent retry`, c => {
      const { ledger, ss, lock } = fixture(c, storage);
      const result = c.appendTransactions([payment({ account })], ss, false);
      const rows = ledger.data.slice(2);
      assert.equal(result.writtenCount, 2);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(row => row[1]).sort(), ['DBS CC SGD', 'DBS SGD']);
      for (const row of rows) {
        assert.equal(row[2], row[1] === 'DBS SGD' ? 'Снятие денег' : 'Получение денег');
        assert.equal(row[3], 1234.56);
        assert.equal(row[7], 'Кредитка');
        assert.ok(row[5] === 0 || String(row[5]).startsWith('='));
        assert.ok(row[6].startsWith('='));
        assert.equal(row.length, 11);
      }
      const cashChange = -rows.find(row => row[1] === 'DBS SGD')[3];
      const cardChange = rows.find(row => row[1] === 'DBS CC SGD')[3];
      assert.equal(cashChange + cardChange, 0);
      assert.deepEqual(plain(result.rowOutcomes), [{ inputIndex: 0, status: 'imported' }]);
      const retry = c.appendTransactions([payment({ account: account === 'DBS SGD' ? 'DBS CC SGD' : 'DBS SGD',
        where: 'BILL PAYMENT - DBS INTERNET/WIRELESS' })], ss, false);
      assert.equal(retry.writtenCount, 0);
      assert.equal(ledger.data.length, 4);
      assert.equal(lock.acquired, lock.released);
    });
  }
  test('repayment dry run previews both rows and leaves sheet and input unchanged', c => {
    const { ledger, ss } = fixture(c, storage);
    const input = [payment()], beforeInput = JSON.stringify(input), before = structuredClone(ledger.data);
    const result = c.appendTransactions(input, ss, true);
    assert.equal(result.writtenCount, 2);
    assert.equal(result.rows2D.length, 2);
    assert.deepEqual(plain(result.rowOutcomes), [{ inputIndex: 0, status: 'would_import' }]);
    assert.deepEqual(ledger.data, before);
    assert.equal(JSON.stringify(input), beforeInput);
  });
  for (const existingAccount of ['DBS SGD', 'DBS CC SGD']) {
    test(`one-sided legacy ${existingAccount} repayment adds only the missing leg`, c => {
      const { ledger, ss } = fixture(c, storage);
      const type = existingAccount === 'DBS SGD' ? 'Снятие денег' : 'Получение денег';
      ledger.data.push(['28.10.2026', existingAccount, type, 1234.56, 1234.56,
        '=F2', '=IF(C3="Получение денег";F3+D3;F3-D3)', 'Кредитка', 'Legacy bank descriptor', '', '-']);
      const rows = c.flagExistingDuplicates([c.enrichTransaction(payment(), c.getCategoryBucketMap())]);
      assert.ok(!rows[0].flags.includes('possible_duplicate'), 'A missing leg must remain approvable');
      const result = c.appendTransactions(rows, ss, false);
      assert.equal(result.writtenCount, 1);
      assert.equal(result.skippedCount, 1);
      assert.equal(ledger.data[3][1], existingAccount === 'DBS SGD' ? 'DBS CC SGD' : 'DBS SGD');
      assert.deepEqual(plain(result.rowOutcomes), [{ inputIndex: 0, status: 'imported' }]);
      const duplicate = c.flagExistingDuplicates([c.enrichTransaction(payment(), c.getCategoryBucketMap())]);
      assert.ok(duplicate[0].flags.includes('possible_duplicate'));
      assert.equal(c.appendTransactions(rows, ss, false).writtenCount, 0);
    });
  }
  test('two observed repayment legs create two rows and preserve original input outcomes', c => {
    const { ss } = fixture(c, storage);
    const result = c.appendTransactions([payment(), payment({ account: 'DBS CC SGD',
      where: 'BILL PAYMENT - DBS INTERNET/WIRELESS' })], ss, false);
    assert.equal(result.writtenCount, 2);
    assert.deepEqual(plain(result.rowOutcomes), [{ inputIndex: 0, status: 'imported' }, { inputIndex: 1, status: 'imported' }]);
  });
  test('mixed batches retain source indices and an explicit force-add repeats both legs', c => {
    const { ledger, ss } = fixture(c, storage);
    const result = c.appendTransactions([payment({ category: 'Другое', amount: 10, where: 'Ordinary purchase' }), payment()], ss, false);
    assert.equal(result.writtenCount, 3);
    assert.deepEqual(plain(result.rowOutcomes), [{ inputIndex: 0, status: 'imported' }, { inputIndex: 1, status: 'imported' }]);
    const forced = c.appendTransactions([payment({ flags: ['force_add'] })], ss, false);
    assert.equal(forced.writtenCount, 2);
    assert.equal(ledger.data.length, 7);
  });
  test('reviewed staging repayment imports both legs and marks its single source row imported', c => {
    const { ledger, staging, ss } = fixture(c, storage);
    staging.data.push([true, '28.10.2026', 'DBS CC SGD', 'Val', 'Получение денег',
      1234.56, 'BILL PAYMENT - DBS INTERNET/WIRELESS', 'Кредитка', '-', 1, 'Statement row', 'proposed']);
    const result = c.commitStaged(false, false, ss);
    assert.equal(result.committedCount, 2);
    assert.equal(ledger.data.length, 4);
    assert.equal(staging.data[1][11], 'imported');
    assert.deepEqual(plain(result.rowOutcomes.map(row => [row.stagingRow, row.status])), [[2, 'imported']]);
    assert.equal(c.commitStaged(false, false, ss).committedCount, 0);
  });
  test('repayment credits respect a subtract-only workbook balance formula', c => {
    const { ledger, ss } = fixture(c, storage, false);
    c.appendTransactions([payment()], ss, false);
    const rows = ledger.data.slice(2);
    assert.equal(rows.find(row => row[1] === 'DBS CC SGD')[3], -1234.56);
    assert.equal(rows.find(row => row[1] === 'DBS SGD')[3], 1234.56);
    assert.equal(rows.reduce((sum, row) => sum - row[3], 0), 0);
    assert.equal(c.appendTransactions([payment()], ss, false).writtenCount, 0);
  });
  test('ordinary card purchases, Citi payments, foreign currency and manual recategorization do not expand', c => {
    const { ss } = fixture(c, storage);
    for (const extra of [
      { account: 'DBS CC SGD', category: 'Другое', where: 'Payment for groceries' },
      { account: 'Citibank CC' }, { currency: 'USD', amount_sgd: 10 },
      { where: 'Citibank bill payment' },
      { category: 'Другое', manual_merchant_category: true, flags: ['cc_payoff'] }
    ]) {
      const row = payment(extra);
      assert.equal(c.isDbsCreditCardPayment(row), false);
      assert.equal(c.appendTransactions([row], ss, true).writtenCount, 1);
    }
  });
  test('invalid repayment inputs fail before any ledger mutation', c => {
    const { ledger, ss } = fixture(c, storage), before = structuredClone(ledger.data);
    for (const extra of [{ amount: 0 }, { amount: NaN }, { date: '' }]) {
      assert.throws(() => c.appendTransactions([payment(extra)], ss, false), /needs a date and a nonzero SGD amount/);
    }
    assert.deepEqual(ledger.data, before);
  });
  test('edited repayment amount controls both legs; deleting the item writes neither', c => {
    const { ledger, ss } = fixture(c, storage);
    const rows = [c.enrichTransaction(payment(), c.getCategoryBucketMap())];
    const edited = c.applyProposalEditPlan(rows, { clarification: '', operations: [
      { item: 1, action: 'update', changes: { amount: 321.09 } }
    ] });
    c.appendTransactions(edited.transactions, ss, false);
    assert.deepEqual(ledger.data.slice(2).map(row => row[3]), [321.09, 321.09]);
    const removed = c.applyProposalEditPlan(rows, { clarification: '', operations: [{ item: 1, action: 'remove', changes: {} }] });
    assert.equal(c.appendTransactions(removed.transactions, ss, false).writtenCount, 0);
  });
  test('proposal shows both transfer movements before approval and extraction distinguishes bills from purchases', c => {
    for (const file of ['telegramUI.gs', 'prompts.gs']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), c, { filename: file });
    }
    const html = c.formatTransactionConfirmationHtml([c.enrichTransaction(payment(), { 'Кредитка': '-' })]);
    assert.match(html, /DBS SGD −S\$1234\.56 → DBS CC SGD \+S\$1234\.56 \(two records\)/);
    const prompt = c.getSystemPrompt({});
    assert.match(prompt, /purchase paid USING a credit card is an ordinary expense/);
    assert.match(prompt, /writer creates the matching transfer leg/);
  });
  test('model extraction of one flagged repayment remains one editable item and saves two records', c => {
    const { ss } = fixture(c, storage);
    for (const file of ['provider.gs', 'prompts.gs', 'gemini.gs']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), c, { filename: file });
    }
    c.PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', 'offline-key');
    c.getLearnedMerchantsContext = () => [];
    c.callGeminiApiWithRetry = () => JSON.stringify({ candidates: [{ content: { parts: [{ text:
      JSON.stringify([payment({ category: 'Другое', flags: ['cc_payoff'] })]) }] } }] });
    const rows = c.extractTransactions([{ text: 'Paid DBS card bill S$1234.56' }], {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'Кредитка');
    assert.equal(rows[0].type, 'Снятие денег');
    assert.equal(c.appendTransactions(rows, ss, false).writtenCount, 2);
  });
  for (const action of ['approve:token', 'force_all:token', 'skip_dups:token', 'resolve_dup:token:0:force']) {
    test(`Telegram ${action.split(':')[0]} writes both repayment legs before acknowledging`, c => {
      const { ledger, ss } = fixture(c, storage);
      c.getPendingTransactions = () => [payment()];
      c.flagExistingDuplicates = rows => rows;
      c.savePendingTransactions = c.updateMerchantLearningStore = c.finishTelegramProposalComment = () => {};
      c.findNextUnresolvedDuplicate = () => -1;
      let cleared = false;
      c.clearPendingTransactions = () => { assert.equal(ledger.data.length, 4); cleared = true; };
      c.answerCallbackQuery = c.editTelegramMessage = c.sendDiscardedMessage = () => { assert.equal(ledger.data.length, 4); };
      c.formatTransactionConfirmationHtml = () => 'Saved';
      const original = c.appendTransactions;
      c.appendTransactions = (rows, selected, dry) => original(rows, ss, dry);
      c.handleCallbackQuery({ id: 'query', data: action, message: { message_id: 1, chat: { id: 1 } } });
      assert.equal(cleared, true);
    });
  }
};
