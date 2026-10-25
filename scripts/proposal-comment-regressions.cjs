// Offline Telegram comment flow: all model, delivery and ledger access is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(c) {
  for (const file of ['provider.gs', 'prompts.gs', 'gemini.gs', 'telegramUI.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), c, { filename: file });
  }
  const cache = new Map(), userProps = new Map(), messages = [], cards = [], modelCalls = [], writes = [];
  let held = false, updateId = 1000;
  const props = c.PropertiesService.getScriptProperties();
  props.setProperty('GEMINI_API_KEY', 'offline-key');
  c.PropertiesService.getUserProperties = () => ({ getProperty: key => userProps.get(key) || null,
    setProperty: (key, value) => userProps.set(key, value) });
  c.CacheService = { getScriptCache: () => ({ get: key => cache.get(key) || null,
    put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) };
  c.LockService = { getUserLock: () => ({ waitLock() { assert.equal(held, false); held = true; },
    releaseLock() { assert.equal(held, true); held = false; } }) };
  c.HtmlService = { createHtmlOutput: text => text };
  c.getWebhookAccessPolicy = () => ({ secret: 'offline-secret', chatIds: new Set(['123']) });
  c.getCategoryBucketMap = () => ({ 'Продукты': 'Needs', 'Медицина': 'Needs', 'Дом': 'Wants', 'Другое': 'Wants' });
  c.flagExistingDuplicates = rows => rows;
  c.sendTelegramMessage = text => { messages.push(text); };
  c.refreshProposalCard = (_, messageId, token, rows) => {
    assert.equal(held, true);
    cards.push({ messageId, token, rows, html: c.formatTransactionConfirmationHtml(rows) });
  };
  c.sendDiscardedMessage = (_, messageId, text) => cards.push({ messageId, text });
  const editMessageWithApi = c.editTelegramMessage;
  c.editTelegramMessage = (_, messageId, text) => cards.push({ messageId, text });
  c.answerCallbackQuery = () => {};
  c.saveMerchantAlias = () => {};
  c.extractTransactions = () => { throw new Error('Comment must never reach new transaction extraction'); };
  c.appendTransactions = rows => {
    writes.push(rows);
    return { writtenCount: rows.length, skippedCount: 0,
      rowOutcomes: rows.map((_, inputIndex) => ({ inputIndex, status: 'imported' })) };
  };
  const generateWithModel = c.generateProposalEditPlan;
  let plan = { clarification: '', operations: [] };
  c.generateProposalEditPlan = (comment, rows, context) => {
    assert.equal(held, false, 'Model request must not hold the proposal lock');
    modelCalls.push({ comment, rows, context });
    return typeof plan === 'function' ? plan(rows, comment, context) : plan;
  };
  const rows = [16.10, 46.86, 25].map((amount, index) => c.enrichTransaction({
    amount, currency: 'SGD', date: '03.10.2026', account: 'DBS CC SGD', type: 'Расходы',
    where: index < 2 ? 'FairPrice' : 'Other Shop', raw_where: 'Original receipt ' + index,
    category: 'Продукты', raw_snippet: 'original evidence ' + index, flags: []
  }));
  c.savePendingTransactions(rows, 'active');
  userProps.set('latest_token_123', 'active');
  userProps.set('latest_message_id_123', '42');
  const run = event => c.doPost({ parameter: { secret: 'offline-secret' },
    postData: { contents: JSON.stringify({ update_id: ++updateId, ...event }) } });
  const callback = data => run({ callback_query: { id: 'q' + updateId, data,
    message: { chat: { id: 123 }, message_id: 42 } } });
  const text = (value, extra = {}) => run({ message: { chat: { id: 123 }, text: value, ...extra } });
  return { cache, userProps, props, messages, cards, modelCalls, writes, rows, callback, text,
    plan: value => { plan = value; }, generateWithModel, editMessageWithApi, held: () => held,
    pending: () => c.getPendingTransactions('active') };
}
const update = (item, changes) => ({ item, action: 'update', changes });
const remove = item => ({ item, action: 'remove', changes: {} });
const plan = operations => ({ clarification: '', operations });
const plain = value => JSON.parse(JSON.stringify(value));

module.exports = test => {
  test('comment button updates specific fields, preserves other rows and learns only after approval', c => {
    const f = fixture(c);
    f.callback('comment:active');
    assert.match(f.messages.at(-1), /Describe changes/);
    f.plan(plan([update(2, { where: 'Unity', category: 'Медицина', amount: 40, notes: 'A & B <medical>' })]));
    f.text('Item 2 is Unity, medicine, 40 dollars. Note A & B <medical>.');
    const result = f.pending();
    assert.deepEqual(plain(result[0]), plain(f.rows[0]));
    assert.deepEqual(plain(result[2]), plain(f.rows[2]));
    assert.equal(result[1].where, 'Unity'); assert.equal(result[1].category, 'Медицина');
    assert.equal(result[1].amount_sgd, 40); assert.equal(result[1].bucket, 'Needs');
    assert.equal(result[1].raw_snippet, f.rows[1].raw_snippet);
    assert.equal(result[1].telegram_rule_baseline.source, 'Original receipt 1');
    assert.equal(result[1].dedupe_key, c.generateDedupeKey(result[1].date, result[1].account, 40, 'Unity'));
    assert.match(f.cards.at(-1).html, /A &amp; B &lt;medical&gt;/);
    assert.match(f.messages.at(-1), /amount: 46.86 → 40/);
    assert.equal(f.writes.length, 0);
    const key = c.telegramCorrectionRuleKey('Original receipt 1', 'DBS CC SGD', 'SGD');
    assert.equal(f.props.getProperty(key), null);
    f.callback('approve:active');
    assert.equal(f.writes.length, 1);
    const saved = JSON.parse(f.props.getProperty(key));
    assert.deepEqual(saved.changes, { where: 'Unity', category: 'Медицина' });
    assert.ok(f.messages.some(text => /Rules recorded/.test(text)));
    assert.equal(f.held(), false);
  });
  test('edit command uses original item numbering across removals and several updates', c => {
    const f = fixture(c);
    f.plan(plan([remove(1), update(3, { amount: 30, date: '2026-10-24', account: 'DBS SGD' })]));
    f.text('/edit Remove item 1; item 3 should be 30 on 24 October, DBS SGD.');
    assert.equal(f.pending().length, 2);
    assert.deepEqual(plain(f.pending()[0]), plain(f.rows[1]));
    assert.equal(f.pending()[1].where, 'Other Shop');
    assert.equal(f.pending()[1].amount, 30);
    assert.equal(f.pending()[1].date, '24.10.2026');
    assert.equal(f.pending()[1].account, 'DBS SGD');
    assert.equal(f.modelCalls[0].comment.startsWith('Remove'), true);
  });
  test('replying to the current proposal edits it and /edit without text arms the comment flow', c => {
    const f = fixture(c);
    f.plan(plan([update(1, { amount: 18 })]));
    f.text('Item 1 is 18', { reply_to_message: { message_id: 42 } });
    assert.equal(f.pending()[0].amount, 18);
    f.text('/edit@budget_bot');
    assert.match(f.messages.at(-1), /Type your changes/);
    f.plan(plan([update(2, { amount: 42 })]));
    f.text('Set item 2 to 42');
    assert.equal(f.pending()[1].amount, 42);
    assert.equal(f.modelCalls.length, 2);
  });
  test('ambiguous comments ask a question without edits, then accept a specific follow-up', c => {
    const f = fixture(c);
    const before = JSON.stringify(f.pending());
    f.plan({ clarification: 'Which FairPrice item: 1 or 2?', operations: [] });
    f.text('/edit FairPrice should be 20');
    assert.equal(JSON.stringify(f.pending()), before);
    assert.match(f.messages.at(-1), /Which FairPrice/);
    assert.equal(f.cards.length, 0);
    f.plan(plan([update(2, { amount: 20 })]));
    f.text('Item 2');
    assert.equal(f.pending()[1].amount, 20);
    assert.equal(f.pending()[0].amount, 16.1);
  });
  test('merchant edits retain conversation and focus for a plain make-it-back follow-up', c => {
    const f = fixture(c);
    const rows = f.pending(); rows[2].where = 'Cold Storage - Great World';
    c.savePendingTransactions(rows, 'active');
    f.plan((proposal, comment, context) => {
      if (!context.turns.length) {
        assert.equal(comment, 'change cold storge category to Дом');
        return plan([update(3, { category: 'Дом' })]);
      }
      assert.equal(comment, 'just kidding, make it back Продукты');
      assert.deepEqual(plain(context.lastEditedItems), [3]);
      assert.equal(context.turns[0].text, 'change cold storge category to Дом');
      assert.match(context.turns[1].text, /Cold Storage.*category: Продукты → Дом/);
      assert.equal(proposal[2].category, 'Дом');
      return plan([update(3, { category: 'Продукты' })]);
    });
    f.text('change cold storge category to Дом', { reply_to_message: { message_id: 42 } });
    assert.equal(f.pending()[2].category, 'Дом');
    assert.match(f.messages.at(-1), /Cold Storage - Great World \(item 3\)/);
    f.text('just kidding, make it back Продукты');
    assert.equal(f.pending()[2].category, 'Продукты');
    assert.equal(f.modelCalls.length, 2);
    assert.equal(f.writes.length, 0);
  });
  test('a merchant-only clarification reply retains the original requested category', c => {
    const f = fixture(c);
    const rows = f.pending(); rows[2].where = 'Cold Storage'; rows[2].category = 'Дом';
    c.savePendingTransactions(rows, 'active');
    f.plan((proposal, comment, context) => {
      if (!context.turns.length) return { clarification: 'Which merchant should go back to Продукты?', operations: [] };
      assert.equal(comment, 'Cold Storage');
      assert.equal(context.turns[0].text, 'just kidding, make it back Продукты');
      assert.match(context.turns[1].text, /Which merchant/);
      assert.equal(proposal[2].where, 'Cold Storage');
      return plan([update(3, { category: 'Продукты' })]);
    });
    f.text('/edit just kidding, make it back Продукты');
    assert.equal(f.pending()[2].category, 'Дом');
    f.text('Cold Storage');
    assert.equal(f.pending()[2].category, 'Продукты');
    assert.equal(f.modelCalls.length, 2);
    assert.match(f.messages.at(-1), /category: Дом → Продукты/);
  });
  test('duplicate merchant clarification can use an amount across several conversational turns', c => {
    const f = fixture(c);
    f.plan((proposal, comment, context) => {
      if (comment.includes('category')) return { clarification: 'FairPrice: S$16.10 or S$46.86?', operations: [] };
      assert.equal(context.turns[0].text, 'change FairPrice category to Дом');
      if (comment === 'Fair Price') return { clarification: 'Which FairPrice purchase, S$16.10 or S$46.86?', operations: [] };
      assert.equal(comment, 'the 46.86 one');
      assert.equal(context.turns.length, 4);
      return plan([update(2, { category: 'Дом' })]);
    });
    f.text('/edit change FairPrice category to Дом');
    f.text('Fair Price');
    assert.deepEqual(plain(f.pending()), plain(f.rows));
    f.text('the 46.86 one');
    assert.equal(f.pending()[1].category, 'Дом');
    assert.deepEqual(plain(f.pending()[0]), plain(f.rows[0]));
    assert.match(f.messages.at(-1), /FairPrice/);
  });
  test('focus uses current positions after removals and never transfers from a removed target', c => {
    const f = fixture(c);
    f.plan(plan([remove(1), update(3, { category: 'Дом' })]));
    f.text('/edit remove item 1 and change Other Shop to Дом');
    f.plan((proposal, comment, context) => {
      assert.deepEqual(plain(context.lastEditedItems), [2]);
      assert.equal(proposal[1].where, 'Other Shop');
      return plan([update(2, { category: 'Продукты' })]);
    });
    f.text('make it back Продукты');
    assert.equal(f.pending()[1].category, 'Продукты');
    f.plan(plan([remove(2)]));
    f.text('remove Other Shop');
    f.plan((proposal, comment, context) => {
      assert.deepEqual(plain(context.lastEditedItems), []);
      return { clarification: 'That purchase was removed. Which remaining merchant do you mean?', operations: [] };
    });
    f.text('change it to medicine');
    assert.equal(f.pending().length, 1);
    assert.equal(f.pending()[0].category, 'Продукты');
  });
  test('old conversation is not sent after a changed revision, cancellation or a new proposal', c => {
    const f = fixture(c);
    f.plan(plan([update(3, { category: 'Дом' })]));
    f.text('/edit change Other Shop to Дом');
    const changed = f.pending().reverse(); c.savePendingTransactions(changed, 'active');
    f.plan((proposal, comment, context) => {
      assert.deepEqual(plain(context.turns), []);
      assert.deepEqual(plain(context.lastEditedItems), []);
      return { clarification: 'Which merchant?', operations: [] };
    });
    f.text('/edit make it back');
    f.text('/cancel');
    assert.equal(f.cache.has('proposal_comment_context:123:active'), false);
    f.text('/edit make it back');
    c.savePendingTransactions(f.rows, 'new');
    f.userProps.set('latest_token_123', 'new');
    f.text('/edit make it back');
  });
  for (const action of ['approve', 'discard']) {
    test(action + ' clears conversation and exits comment mode for the completed proposal', c => {
      const f = fixture(c);
      f.plan(plan([update(3, { category: 'Дом' })]));
      f.text('/edit change Other Shop to Дом');
      assert.ok(f.cache.has('proposal_comment_context:123:active'));
      f.callback(action + ':active');
      assert.equal(f.cache.has('proposal_comment_context:123:active'), false);
      assert.equal(f.cache.has('awaiting_proposal_comment:123'), false);
      assert.equal(c.handleTelegramProposalComment({ chat: { id: 123 }, text: 'new lunch 12' }), false);
    });
  }
  test('conversation storage is bounded and isolated by chat and proposal', c => {
    const f = fixture(c);
    for (let i = 0; i < 10; i++) {
      const context = c.getTelegramProposalCommentContext(123, 'active', f.rows);
      c.saveTelegramProposalCommentContext(123, 'active', f.rows, context, 'a'.repeat(3000), 'b'.repeat(3000), [3]);
    }
    const context = c.getTelegramProposalCommentContext(123, 'active', f.rows);
    assert.equal(context.turns.length, 12);
    assert.ok(context.turns.every(turn => turn.text.length === 1500));
    assert.deepEqual(plain(c.getTelegramProposalCommentContext(456, 'active', f.rows).turns), []);
    assert.deepEqual(plain(c.getTelegramProposalCommentContext(123, 'other', f.rows).turns), []);
    c.rememberTelegramProposalComment(123, 43, 'other', f.rows);
    c.finishTelegramProposalComment(123, 'active');
    assert.equal(JSON.parse(f.cache.get('awaiting_proposal_comment:123')).token, 'other');
  });
  test('cancel abandons comment mode and switching editors clears the other pending input', c => {
    const f = fixture(c);
    f.callback('pick_merch:active:1');
    assert.ok(f.cache.has('awaiting_merchant:123'));
    f.callback('comment:active');
    assert.equal(f.cache.has('awaiting_merchant:123'), false);
    f.callback('pick_merch:active:1');
    assert.equal(f.cache.has('awaiting_proposal_comment:123'), false);
    f.text('/cancel');
    assert.equal(f.cache.has('awaiting_merchant:123'), false);
    assert.equal(f.modelCalls.length, 0);
    assert.deepEqual(plain(f.pending()), plain(f.rows));
  });
  for (const mode of ['expired', 'changed', 'processed']) {
    test('comment reply to ' + mode + ' proposal never reaches extraction or overwrites rows', c => {
      const f = fixture(c);
      f.callback('comment:active');
      if (mode === 'expired') {
        const state = JSON.parse(f.cache.get('awaiting_proposal_comment:123')); state.expiresAt = 0;
        f.cache.set('awaiting_proposal_comment:123', JSON.stringify(state));
      }
      if (mode === 'changed') c.savePendingTransactions([f.rows[1], f.rows[0]], 'active');
      if (mode === 'processed') c.clearPendingTransactions('active');
      const before = JSON.stringify(f.pending());
      f.text('Change item 2 to 10');
      assert.equal(JSON.stringify(f.pending()), before);
      assert.equal(f.modelCalls.length, 0);
      assert.match(f.messages.at(-1), /changed or this edit request expired/);
      assert.equal(f.writes.length, 0);
    });
  }
  for (const mode of ['modified', 'approved', 'cancelled', 'superseded']) {
    test('comment model response cannot overwrite a proposal ' + mode + ' during generation', c => {
      const f = fixture(c);
      f.plan(() => {
        if (mode === 'modified') c.withTelegramProposalLock(() => c.savePendingTransactions([f.rows[1]], 'active'));
        if (mode === 'approved') c.withTelegramProposalLock(() => c.clearPendingTransactions('active'));
        if (mode === 'cancelled') f.cache.delete('awaiting_proposal_comment:123');
        if (mode === 'superseded') c.rememberTelegramProposalComment(123, 42, 'active', f.rows);
        return plan([update(1, { amount: 999 })]);
      });
      f.text('/edit Item 1 is 999');
      assert.match(f.messages.at(-1), /changed while I was interpreting/);
      assert.equal(f.cards.length, 0);
      assert.equal(f.writes.length, 0);
      if (mode === 'modified') assert.deepEqual(plain(f.pending()), [plain(f.rows[1])]);
      else if (mode === 'approved') assert.equal(f.pending(), 'PROCESSED');
      else assert.deepEqual(plain(f.pending()), plain(f.rows));
    });
  }
  test('model and validation failures preserve the proposal and allow another comment', c => {
    const f = fixture(c), before = JSON.stringify(f.pending());
    f.plan(() => { throw new Error('Simulated model failure'); });
    f.text('/edit Item 1 is 20');
    assert.equal(JSON.stringify(f.pending()), before);
    assert.match(f.messages.at(-1), /Simulated model failure/);
    f.plan(plan([update(1, { amount: 20 }), update(2, { category: 'Invented' })]));
    f.text('Retry');
    assert.equal(JSON.stringify(f.pending()), before, 'No partial edit is cached');
    assert.match(f.messages.at(-1), /Unknown category/);
    f.plan(plan([update(1, { amount: 20 })]));
    f.text('Item 1 only');
    assert.equal(f.pending()[0].amount, 20);
  });
  test('patch validator rejects internal fields, invalid numbers, dates, vocabularies and contradictory plans', c => {
    const f = fixture(c), before = JSON.stringify(f.rows);
    const bad = [update(0, { amount: 1 }), update(4, { amount: 1 }), update(1.5, { amount: 1 }),
      update(1, { flags: ['force_add'] }), update(1, { raw_where: 'new evidence' }),
      update(1, { amount: -5 }), update(1, { amount: NaN }), update(1, { amount: '5' }),
      update(1, { date: '31.02.2026' }), update(1, { account: 'Unknown card' }),
      update(1, { type: 'Unknown type' }), update(1, { currency: 'US dollars' }),
      update(1, { amount_sgd: 999 }), update(1, { type: 'Обязательные расходы' })];
    for (const op of bad) assert.throws(() => c.applyProposalEditPlan(f.rows, plan([op])));
    assert.throws(() => c.applyProposalEditPlan(f.rows, plan([remove(1), update(1, { amount: 1 })])));
    assert.throws(() => c.applyProposalEditPlan(f.rows, { clarification: 'Which?', operations: [remove(1)] }));
    assert.equal(JSON.stringify(f.rows), before);
  });
  test('amount/currency changes discard obsolete duplicate overrides and SGD conversions', c => {
    const f = fixture(c);
    f.rows[0].flags = ['force_add', 'possible_duplicate', 'other_warning'];
    const result = c.applyProposalEditPlan(f.rows, plan([update(1, { amount: 50, currency: 'usd' })]));
    const row = result.transactions[0];
    assert.equal(row.currency, 'USD'); assert.equal(row.amount_sgd, null);
    assert.ok(row.flags.includes('foreign_currency')); assert.ok(row.flags.includes('other_warning'));
    assert.equal(row.flags.includes('force_add'), false);
    assert.equal(row.flags.includes('possible_duplicate'), false);
    assert.equal(row.telegram_rule_baseline, undefined, 'Amounts/currency do not become classification rules');
    assert.match(c.formatTransactionConfirmationHtml([row]), /50.00 USD/);
    row.amount_sgd = 65;
    assert.match(c.formatTransactionConfirmationHtml([row]), /SGD equivalent: S\$65.00/);
  });
  test('successive comments preserve the original rule baseline while updating the final values', c => {
    const f = fixture(c);
    f.plan(plan([update(2, { where: 'Unity', category: 'Медицина' })]));
    f.text('/edit Item 2 is Unity medicine');
    f.plan(plan([update(2, { where: 'Unity Pharmacy', amount: 35, account: 'DBS SGD' })]));
    f.text('/edit Item 2 is Unity Pharmacy for 35 from DBS SGD');
    const row = f.pending()[1];
    assert.equal(row.telegram_rule_baseline.where, 'FairPrice');
    assert.equal(row.telegram_rule_baseline.account, 'DBS CC SGD');
    f.callback('approve:active');
    const key = c.telegramCorrectionRuleKey('Original receipt 1', 'DBS CC SGD', 'SGD');
    assert.deepEqual(JSON.parse(f.props.getProperty(key)).changes,
      { where: 'Unity Pharmacy', category: 'Медицина', account: 'DBS SGD' });
  });
  test('revised card failures are surfaced and never reported as a successful edit recap', c => {
    const f = fixture(c);
    f.plan(plan([update(2, { amount: 20 })]));
    c.refreshProposalCard = () => { throw new Error('Simulated Telegram rejection'); };
    f.text('/edit Item 2 is 20');
    assert.match(f.messages.at(-1), /Could not complete.*Simulated Telegram rejection/);
    assert.equal(f.messages.some(text => /<b>Proposal changes<\/b>/.test(text)), false);
    assert.equal(f.writes.length, 0);
    assert.ok(f.cache.has('awaiting_proposal_comment:123'));
  });
  test('Telegram edit API rejection throws while an unchanged card is accepted', c => {
    const f = fixture(c);
    f.props.setProperty('TELEGRAM_BOT_TOKEN', 'offline-key');
    let description = 'Bad Request: message is too long';
    c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 400,
      getContentText: () => JSON.stringify({ ok: false, error_code: 400, description }) }) };
    assert.throws(() => f.editMessageWithApi(123, 42, 'Text', {}), /proposal update failed/);
    description = 'Bad Request: message is not modified';
    assert.doesNotThrow(() => f.editMessageWithApi(123, 42, 'Text', {}));
  });
  test('removing every item closes the proposal without ledger or learning writes', c => {
    const f = fixture(c);
    f.plan(plan([remove(1), remove(2), remove(3)]));
    f.text('/edit Remove all items');
    assert.equal(f.pending(), 'PROCESSED');
    assert.equal(f.writes.length, 0);
    assert.match(f.messages.at(-1), /no rules recorded/);
    assert.equal(f.cache.has('awaiting_proposal_comment:123'), false);
  });
  test('Gemini comment adapter supplies vocabularies, numbered data and patch schema without internal metadata', c => {
    const f = fixture(c);
    let payload;
    c.callGeminiApiWithRetry = input => {
      payload = input;
      return { text: JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'private thought' },
        { text: JSON.stringify(plan([update(2, { amount: 20 })])) }] } }] }) };
    };
    f.rows[1].telegram_rule_baseline = { source: 'internal', where: 'Previous pharmacy name' };
    const context = { turns: [{ role: 'user', text: 'make it back Продукты' },
      { role: 'assistant', text: 'Which merchant?' }], lastEditedItems: [2] };
    const result = f.generateWithModel('Set item 2 to 20', f.rows, context);
    assert.equal(result.operations[0].item, 2);
    const input = JSON.parse(payload.contents[0].parts[0].text);
    assert.equal(input.proposal[1].item, 2);
    assert.equal(input.comment, 'Set item 2 to 20');
    assert.equal(input.proposal[1].telegram_rule_baseline, undefined);
    assert.equal(input.proposal[1].dedupe_key, undefined);
    assert.deepEqual(input.proposal[1].merchant_references,
      ['FairPrice', 'Original receipt 1', 'Previous pharmacy name']);
    assert.deepEqual(input.recent_conversation, context.turns);
    assert.deepEqual(input.last_edited_items, [2]);
    assert.equal(payload.generationConfig.responseSchema.properties.operations.items.properties.action.enum[0], 'update');
    assert.match(payload.systemInstruction.parts[0].text, /FairPrice/);
    assert.match(payload.systemInstruction.parts[0].text, /Медицина/);
    assert.match(payload.systemInstruction.parts[0].text, /minor\s+typos/);
    assert.match(payload.systemInstruction.parts[0].text, /users do NOT need to supply item numbers/);
    c.callGeminiApiWithRetry = () => ({ text: 'invalid json' });
    assert.throws(() => f.generateWithModel('Change it', f.rows), /Could not interpret/);
  });
};
