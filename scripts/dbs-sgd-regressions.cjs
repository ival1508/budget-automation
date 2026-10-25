const assert = require('node:assert/strict');
const vm = require('node:vm');

// Transcribed row-level evidence from the two user-supplied October screenshots.
const cases = [
  ['02.10.2026', 20, 'ICT PayNow Transfer 5676456 To: STRIPE PAYMENTS SINGAPORE PTE. OTHR 3UM6OXEQIdXcoHQu136hxUst', 'GOE.sg', 'Школа & Детский сад', 'Расходы', 'Needs'],
  ['02.10.2026', 400, 'ICT PayNow Transfer 5018143 To: GROUND UP CLIMBING PTE. LTD. OTHR Aglaia Ivanova', 'Ground Up Climbing', 'Школа & Детский сад', 'Обязательные расходы', 'Needs'],
  ['02.10.2026', 1000, 'IDT REVDDT26100217031816614 IIRGPC2751851137drlv672 OTHR', 'Extra Fund', 'Extra fund', 'Обязательные расходы', 'Wants'],
  ['02.10.2026', 2299.90, 'ICT UOB:1203122050:I-BANK Artemi Ivanov OTHR 17908938566669754612', 'Maplebear', 'Школа & Детский сад', 'Обязательные расходы', 'Needs'],
  ['02.10.2026', 465.98, 'ITT QAA1C320602F03DG 0016IT4980042', 'Allianz', 'Медицина', 'Получение денег', 'Needs'],
  ['01.10.2026', 22.66, 'ICT PayNow Transfer 8891122 To: ONX FUXX LOONGXXXXX FANGLXXX OTHR PayNow Transfer', 'Ivan Ong', 'Рестораны', 'Расходы', 'Wants'],
  ['01.10.2026', 9.50, 'POS NETS QR PAYMENT 627407494336497 TO: WANG', 'Heavenly Wang', 'Рестораны', 'Расходы', 'Wants'],
  ['01.10.2026', 1000, 'IDT REVDDT26093017007900429 IIRGPC274075517f5mbc203 OTHR', 'Extra Fund', 'Extra fund', 'Обязательные расходы', 'Wants'],
  ['01.10.2026', 6196.04, 'ICT SCL:0118025813:I-BANK October mortgage OTHR 17908123210615594367', 'Standard Chartered Mortgage', 'Квартира', 'Обязательные расходы', 'Needs']
];
const row = item => ({ date: item[0], amount: item[1], raw_snippet: item[2], where: item[2],
  account: 'DBS SGD', currency: 'SGD', type: item[5] === 'Получение денег' ? item[5] : 'Расходы',
  category: 'Другое', confidence: { amount: 0.98, date: 0.97, category: 0.5 }, flags: [] });

module.exports = test => {
  test('DBS SGD: all nine screenshot corrections enrich with canonical names, categories, types and buckets', c => {
    const map = vm.runInContext('CATEGORY_TO_BUCKET', c);
    // An old learned alias must not undo the user's new confirmed corrections.
    c.getMerchantAliases = () => ({ [c.normaliseWhere(cases[1][2])]: { canonical: 'Wrong', category: 'Развлечения' } });
    for (const item of cases) {
      const input = row(item), before = JSON.stringify(input);
      const result = c.enrichTransaction(input, map);
      assert.equal(result.where, item[3]);
      assert.equal(result.category, item[4]);
      assert.equal(result.type, item[5]);
      assert.equal(result.bucket, item[6]);
      assert.equal(result.amount, item[1]);
      assert.equal(result.raw_snippet, item[2]);
      assert.equal(result.confidence.category, 1);
      assert.equal(result.confidence.amount, 0.98);
      assert.equal(result.confidence.date, 0.97);
      assert.equal(result.dedupe_key, c.generateDedupeKey(item[0], 'DBS SGD', item[1], item[3]));
      assert.equal(JSON.stringify(input), before);
    }
  });
  test('DBS SGD: statement normalization resolves the same nine rows and preserves the credit sign', c => {
    for (const item of cases) {
      const input = row(item);
      const result = c.normalizeRows([{ ...input, merchant: input.raw_snippet }])[0];
      assert.equal(result.merchant, item[3]);
      assert.equal(result.raw_merchant, item[2]);
      assert.equal(result.type, item[5]);
      assert.equal(result.amount, item[5] === 'Получение денег' ? -item[1] : item[1]);
    }
  });
  test('DBS SGD: opaque references, generic gateways, other accounts, currency and manual edits remain scoped', c => {
    for (const changes of [
      { account: 'DBS CC SGD' }, { currency: 'USD' }, { manual_merchant_category: true },
      { date: '03.10.2026' }, { amount: 21 },
      { raw_snippet: 'STRIPE PAYMENTS SINGAPORE PTE', where: 'STRIPE PAYMENTS SINGAPORE PTE' }
    ]) assert.equal(c.getDbsSgdCorrection({ ...row(cases[0]), ...changes }), null);
    for (const descriptor of ['DBS eMulti-Currency Autosave', 'ITT QAA999999 0016IT9999999',
      'STRIPE PAYMENTS SINGAPORE PTE', 'WANG', 'ICT UOB:999999:I-BANK Artemi Ivanov',
      'ICT SCL:0118025813:I-BANK unrelated transfer']) {
      assert.equal(c.getDbsSgdCorrection({ ...row(cases[0]), raw_snippet: descriptor, where: descriptor }), null);
    }
    assert.equal(c.getDbsSgdCorrection({ ...row(cases[4]), type: 'Расходы' }), null);
    assert.equal(c.getDbsSgdCorrection({ ...row(cases[1]), type: 'Получение денег' }), null);
    const edited = { ...row(cases[1]), manual_merchant_category: true, where: 'My edit', category: 'Дом' };
    const result = c.enrichTransaction(edited, vm.runInContext('CATEGORY_TO_BUCKET', c));
    assert.equal(result.where, 'My edit');
    assert.equal(result.category, 'Дом');
  });
  test('DBS SGD: corrections retain unrelated review flags and extraction uncertainty', c => {
    const result = c.enrichTransaction({ ...row(cases[5]), needs_review: true, flags: ['check_amount'],
      confidence: { amount: 0.3, date: 0.4, category: 0.5 } }, vm.runInContext('CATEGORY_TO_BUCKET', c));
    assert.equal(result.needs_review, true);
    assert.equal(result.flags[0], 'check_amount');
    assert.equal(result.confidence.amount, 0.3);
    assert.equal(result.confidence.date, 0.4);
  });
  test('statement Gemini fallbacks do not turn STRIPE PAYMENTS and QR PAYMENT debits into credits', c => {
    const txns = [cases[0], cases[6]].map(item => ({ ...row(item), merchant: item[2] }));
    c.callGeminiApiWithRetry = () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ account: 'DBS SGD', transactions: txns }) }] } }] });
    c.PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', 'offline');
    for (const result of [c.parseCsvWithGeminiFallback('offline CSV', 'offline.csv'),
      c.parsePdfStatement({ bytes: Array.from(Buffer.from('%PDF-1.4 offline')), text: '%PDF-1.4 offline' })]) {
      assert.equal(result.rows.length, 2);
      assert.equal(result.rows[0].amount, 20);
      assert.equal(result.rows[1].amount, 9.50);
      assert.ok(result.rows.every(item => item.type === 'Расходы'));
    }
  });
};
