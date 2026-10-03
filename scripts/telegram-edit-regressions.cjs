// Offline end-to-end Telegram edit regressions. No network or live sheet writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
function fixture() {
  const props = new Map(), cache = new Map(), messages = [], learned = [];
  const c = {
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k,v) => props.set(k,v) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) || null, put: (k,v) => cache.set(k,v), remove: k => cache.delete(k) }) },
    Utilities: { getUuid: () => crypto.randomUUID(), computeDigest: (_,s) => Array.from(crypto.createHash('sha256').update(s).digest()), DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' } },
    HtmlService: { createHtmlOutput: s => s }
  };
  vm.createContext(c);
  for (const file of ['constants.gs', 'enricher.gs', 'state.gs', 'callbacks.gs', 'webhook.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), c, { filename: file });
  }
  c.getWebhookAccessPolicy = () => ({ secret: 'test', chatIds: new Set(['123']) });
  c.getCategoryBucketMap = () => ({ 'Продукты': 'Needs', 'Медицина': 'Needs', 'Другое': 'Wants' });
  c.flagExistingDuplicates = rows => rows.map(row => ({ ...row }));
  c.sendTelegramMessage = text => messages.push(text);
  c.answerCallbackQuery = () => {};
  c.refreshProposalCard = () => {};
  c.saveMerchantAlias = (...args) => learned.push(args);
  c.extractTransactions = () => { throw new Error('Rename must never reach extraction'); };
  const rows = [16.10, 46.86].map((amount, i) => c.enrichTransaction({
    amount, currency: 'SGD', date: '03.10.2026', account: 'DBS CC SGD',
    where: 'FairPrice', raw_where: i ? 'NTUC FairPrice App Paymen63805858 SG' : 'NTUC FairPrice Scan & Go +6564560233 SG', category: 'Продукты'
  }));
  c.savePendingTransactions(rows, 'session');
  const callback = data => c.handleCallbackQuery({ id: 'query', data, message: { chat: { id: 123 }, message_id: 10 } });
  const rename = () => c.doPost({ parameter: { secret: 'test' }, postData: { contents: JSON.stringify({ message: { chat: { id: 123 }, text: 'Unity' } }) } });
  return { c, props, cache, messages, learned, rows, callback, rename, pending: () => c.getPendingTransactions('session') };
}
for (const categoryFirst of [false, true]) {
  const f = fixture();
  const categoryIndex = vm.runInContext("CATEGORIES.indexOf('Медицина')", f.c);
  assert.ok(categoryIndex >= 0);
  if (categoryFirst) f.callback(`set_cat:session:1:${categoryIndex}`);
  f.callback('pick_merch:session:1');
  assert.match(f.messages[0], /SGD 46.86/);
  assert.equal(f.rename(), 'OK');
  if (!categoryFirst) f.callback(`set_cat:session:1:${categoryIndex}`);
  const result = f.pending();
  assert.equal(JSON.stringify(result[0]), JSON.stringify(f.rows[0]));
  assert.equal(result[1].where, 'Unity');
  assert.equal(result[1].category, 'Медицина');
  assert.equal(result[1].amount, 46.86);
  assert.equal(result[1].bucket, 'Needs');
  assert.equal(result[1].dedupe_key, f.c.generateDedupeKey(result[1].date, result[1].account, 46.86, 'Unity'));
  assert.equal(f.learned.length, 0, 'Edits must not teach global aliases');
  f.c.updateMerchantLearningStore(result);
  assert.equal(f.learned.length, 1, 'Approval must not teach the one-off Unity exception');
  assert.equal(f.learned[0][1], 'FairPrice');
  f.props.set('MERCHANT_ALIASES', JSON.stringify({ unity: { canonical: 'Wrong merchant', category: 'Продукты' } }));
  const again = f.c.enrichTransaction(result[1]);
  assert.equal(again.where, 'Unity');
  assert.equal(again.category, 'Медицина');
  console.log(`PASS isolated FairPrice correction (${categoryFirst ? 'category' : 'merchant'} first)`);
}
for (const mode of ['shifted', 'expired', 'processed', 'failure']) {
  const f = fixture();
  f.callback('pick_merch:session:1');
  if (mode === 'shifted') f.c.savePendingTransactions([f.rows[1], f.rows[0]], 'session');
  if (mode === 'expired') f.cache.delete('session');
  if (mode === 'processed') f.c.clearPendingTransactions('session');
  if (mode === 'failure') f.c.flagExistingDuplicates = () => { throw new Error('Injected failure'); };
  const before = JSON.stringify(f.pending());
  let extracted = false;
  f.c.extractTransactions = () => { extracted = true; return []; };
  assert.equal(f.rename(), 'OK');
  assert.equal(extracted, false);
  assert.equal(JSON.stringify(f.pending()), before);
  assert.equal(f.learned.length, 0);
  assert.match(f.messages.at(-1), /changed or expired|Could not complete/);
  console.log(`PASS rename ${mode} never edits another row or falls through to AI`);
}
