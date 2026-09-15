// Actual webhook gates with observed side effects; no credentials or live requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VAL = '96069960', RITA = '402188776', OUTSIDER = '123456789';
function fixture(c) {
  const effects = [], notifications = [], cache = new Map();
  const props = c.PropertiesService.getScriptProperties();
  props.setProperty('WEBHOOK_SECRET', 'offline-secret');
  props.setProperty('AUTHORIZED_CHAT_IDS', VAL + ',' + RITA);
  props.setProperty('TELEGRAM_BOT_TOKEN', 'offline-token');
  c.PropertiesService.getScriptProperties = () => ({
    getProperty: key => props.getProperty(key), deleteProperty: key => { effects.push('property_delete'); props.deleteProperty(key); },
    setProperty: (key, value) => { effects.push('property_write:' + key); props.setProperty(key, value); }
  });
  c.PropertiesService.getUserProperties = () => { effects.push('user_properties'); return { getProperty: () => null }; };
  c.HtmlService = { createHtmlOutput: text => text };
  c.CacheService = { getScriptCache: () => { effects.push('cache_access'); return {
    get: key => { effects.push('cache_read'); return cache.get(key) || null; },
    put: (key, value) => { effects.push('cache_write'); cache.set(key, value); },
    remove: key => { effects.push('cache_remove'); cache.delete(key); }
  }; } };
  c.LockService = { getUserLock: () => { effects.push('lock'); return { waitLock: () => {}, releaseLock: () => {} }; } };
  c.SpreadsheetApp.getActiveSpreadsheet = () => { effects.push('sheet_access'); throw new Error('Unexpected sheet access'); };
  c.handleCallbackQuery = () => effects.push('callback');
  c.sendWeeklyMandatoryAudit = () => effects.push('weekly');
  c.getTelegramFilePath = () => { effects.push('download'); return 'offline.jpg'; };
  c.fetchTelegramFileAsBase64 = () => { effects.push('media'); return {}; };
  c.enqueueStatementFile = () => effects.push('statement');
  c.extractTransactions = () => { effects.push('extraction'); return []; };
  c.getPendingTransactions = () => { effects.push('pending_read'); return []; };
  c.savePendingTransactions = () => effects.push('pending_write');
  c.saveMerchantAlias = () => effects.push('merchant_write');
  c.UrlFetchApp = { fetch: () => { effects.push('http'); return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' }; } };
  c.fetchWithRetry = (_, options) => { effects.push('notification'); notifications.push(JSON.parse(options.payload)); };
  const callback = (id = VAL) => ({ update_id: 1, callback_query: { id: 'offline-query', data: 'approve:offline-token', message: { chat: { id }, message_id: 1 } } });
  const message = (id = VAL, extra = {}) => ({ update_id: 1, message: { chat: { id }, text: '/mandatory', ...extra } });
  const event = (update, secret = 'offline-secret') => ({ parameter: { secret }, postData: { contents: JSON.stringify(update) } });
  const run = (update, secret) => c.doPost(event(update, secret));
  const reject = (update = callback(OUTSIDER), secret) => {
    effects.length = 0;
    assert.equal(run(update, secret), 'Unauthorized');
    assert.deepEqual(effects, []);
    assert.equal(props.getProperty('TELEGRAM_CHAT_ID'), null);
    assert.equal(notifications.length, 0);
  };
  return { props, effects, notifications, cache, callback, message, event, run, reject };
}
function loadRegistration(c) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'setup.gs'), 'utf8')
    .replace("const WEB_APP_URL = 'PASTE_YOUR_DEPLOYED_EXEC_URL_HERE';", "const WEB_APP_URL = 'https://script.google.com/macros/s/offline-fixture/exec';");
  vm.runInContext(source, c, { filename: 'setup.gs' });
}

module.exports = test => {
  test('missing webhook secret never disables the gate, even for a configured user', c => {
    const f = fixture(c);
    for (const value of [null, '', '   ']) {
      if (value === null) f.props.deleteProperty('WEBHOOK_SECRET'); else f.props.setProperty('WEBHOOK_SECRET', value);
      f.reject(f.callback(VAL)); f.reject(f.message(OUTSIDER));
    }
  });
  test('missing or malformed allowlist rejects before callbacks, cache or chat capture', c => {
    const f = fixture(c);
    for (const value of [null, '', '  ', ',,,', '*', 'not-a-chat', VAL + ',bad', VAL + '.1']) {
      if (value === null) f.props.deleteProperty('AUTHORIZED_CHAT_IDS'); else f.props.setProperty('AUTHORIZED_CHAT_IDS', value);
      f.reject(f.callback(VAL)); f.reject(f.message(OUTSIDER));
    }
  });
  test('missing, wrong or non-string incoming secret rejects an otherwise authorized chat', c => {
    const f = fixture(c);
    for (const secret of [null, '', 'wrong', ['offline-secret'], { secret: 'offline-secret' }]) f.reject(f.callback(VAL), secret);
    const event = f.event(f.callback(VAL)); delete event.parameter;
    assert.equal(c.doPost(event), 'Unauthorized'); assert.deepEqual(f.effects, []);
  });
  test('allowlist and active user configuration are independent mandatory gates', c => {
    const f = fixture(c);
    f.props.setProperty('AUTHORIZED_CHAT_IDS', RITA + ',' + OUTSIDER);
    f.reject(f.callback(VAL)); // Config membership cannot bypass the explicit allowlist.
    f.reject(f.callback(OUTSIDER)); // An allowlist-only outsider cannot bypass config membership.
    vm.runInContext('SHEET_FACTS.USERS.RITA.active = false', c);
    f.reject(f.callback(RITA));
    f.props.setProperty('AUTHORIZED_CHAT_IDS', VAL + ',' + RITA);
    f.reject(f.callback(RITA)); // Inactive still denies when another configured user is allowed.
    vm.runInContext('SHEET_FACTS.USERS = null', c);
    f.reject(f.callback(VAL));
  });
  test('authorized Val and Rita messages and callbacks process and capture only the first verified chat', c => {
    const f = fixture(c);
    for (const [i, id] of [VAL, RITA].entries()) {
      const update = f.callback(id); update.update_id = i + 1;
      assert.equal(f.run(update), 'OK');
    }
    assert.equal(f.effects.filter(effect => effect === 'callback').length, 2);
    assert.equal(f.props.getProperty('TELEGRAM_CHAT_ID'), VAL);
    for (const [i, id] of [VAL, RITA].entries()) {
      const update = f.message(id); update.update_id = i + 3;
      assert.equal(f.run(update), 'OK');
    }
    assert.equal(f.effects.filter(effect => effect === 'weekly').length, 2);
    assert.equal(f.effects.filter(effect => effect === 'property_write:TELEGRAM_CHAT_ID').length, 1);
  });
  test('allowlist whitespace, duplicates and numeric callback chat IDs retain exact secret comparison', c => {
    const f = fixture(c); const secret = ' offline /?&=% secret ';
    f.props.setProperty('WEBHOOK_SECRET', secret);
    f.props.setProperty('AUTHORIZED_CHAT_IDS', ' ' + VAL + ' , ' + RITA + ', ' + VAL + ', ');
    assert.equal(f.run(f.callback(Number(VAL)), secret), 'OK');
    assert.equal(f.props.getProperty('TELEGRAM_CHAT_ID'), VAL);
    assert.equal(f.run({ ...f.callback(Number(RITA)), update_id: 2 }, secret.trim()), 'Unauthorized');
    assert.equal(f.effects.filter(effect => effect === 'callback').length, 1);
  });
  test('all outsider input types are denied before their processing paths', c => {
    const f = fixture(c);
    for (const update of [f.callback(OUTSIDER), f.message(OUTSIDER),
      f.message(OUTSIDER, { text: 'Rename merchant' }),
      f.message(OUTSIDER, { text: null, photo: [{ file_id: 'offline-photo' }] }),
      f.message(OUTSIDER, { text: null, voice: { file_id: 'offline-voice' } }),
      f.message(OUTSIDER, { text: null, document: { file_id: 'offline-doc', file_name: 'statement.pdf' } })]) f.reject(update);
  });
  test('unknown, unsafe, absent or conflicting update identities never reach processing', c => {
    const f = fixture(c);
    for (const id of [null, undefined, true, {}, [], 0, 1.5, Number.MAX_SAFE_INTEGER + 1, ' ' + VAL]) {
      const update = f.callback(VAL); update.callback_query.message.chat.id = id; f.reject(update);
    }
    for (const update of [null, [], {}, { update_id: 1, callback_query: { data: 'approve:token', inline_message_id: 'inline' } },
      { ...f.callback(VAL), message: f.message(RITA).message }]) f.reject(update);
    const event = f.event(f.callback(VAL)); event.postData.contents = '{invalid-json';
    assert.equal(c.doPost(event), 'Unauthorized'); assert.deepEqual(f.effects, []);
  });
  test('unauthorized retries cannot poison duplicate cache or set a fallback recipient', c => {
    const f = fixture(c); f.reject(f.callback(OUTSIDER));
    assert.equal(f.cache.size, 0);
    assert.equal(f.run(f.callback(VAL)), 'OK');
    const before = f.effects.length;
    assert.equal(f.run(f.callback(VAL)), 'OK');
    assert.equal(f.effects.filter(effect => effect === 'callback').length, 1);
    assert.deepEqual(f.effects.slice(before), ['cache_access', 'cache_read']);
    f.effects.length = 0;
    assert.equal(f.run(f.callback(OUTSIDER)), 'Unauthorized'); assert.deepEqual(f.effects, []);
    assert.equal(f.props.getProperty('TELEGRAM_CHAT_ID'), VAL);
  });
  test('security configuration read failures never notify an unverified body-supplied chat', c => {
    const f = fixture(c);
    c.PropertiesService.getScriptProperties = () => ({ getProperty: () => { throw new Error('Property store unavailable'); } });
    assert.equal(f.run(f.callback(OUTSIDER)), 'Unauthorized');
    assert.deepEqual(f.effects, []); assert.deepEqual(f.notifications, []);
  });
  test('processing errors notify only the verified chat without reparsing a changed request body', c => {
    const f = fixture(c), event = f.event(f.callback(VAL));
    c.handleCallbackQuery = () => {
      event.postData.contents = JSON.stringify(f.callback(OUTSIDER));
      throw new Error('Authorized handler failed');
    };
    assert.equal(c.doPost(event), 'OK');
    assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].chat_id, VAL);
    assert.equal(f.props.getProperty('TELEGRAM_CHAT_ID'), VAL);
  });
  test('webhook registration refuses missing security configuration before any Telegram request', c => {
    const f = fixture(c); loadRegistration(c);
    for (const key of ['WEBHOOK_SECRET', 'AUTHORIZED_CHAT_IDS']) {
      const original = f.props.getProperty(key); f.props.deleteProperty(key);
      assert.throws(() => c.registerTelegramWebhook(), /required|valid Telegram chat IDs/);
      assert.deepEqual(f.effects, []); f.props.setProperty(key, original);
    }
  });
  test('webhook registration always embeds the encoded secret and keeps it out of registration logs', c => {
    const f = fixture(c); loadRegistration(c);
    const secret = 'offline secret?&=/%'; f.props.setProperty('WEBHOOK_SECRET', secret);
    let target;
    c.UrlFetchApp.fetch = url => {
      target = new URL(url).searchParams.get('url');
      return { getContentText: () => '{"ok":true}' };
    };
    c.registerTelegramWebhook();
    assert.equal(new URL(target).searchParams.get('secret'), secret);
    assert.ok(c.logs.every(log => !log.includes(secret) && !log.includes(encodeURIComponent(secret))));
  });
};
