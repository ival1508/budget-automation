const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
module.exports = test => {
  test('Stage 4B: PRD paid/unpaid/CPF/zero-plan fixture', c => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../testStage4B.gs'), 'utf8'), c);
    assert.equal(c.test_mandatoryMatching().unpaid, 1);
  });
  test('Stage 4B: all nine canonical categories match without merchant semantics', c => {
    const labels = ['Квартира', 'Авто', 'НКО', 'Лин', 'Налоги', 'Школа & Детский сад', 'Extra fund', 'Отдых', 'Отложения'];
    const expected = labels.map(name => ({name, amount: 100}));
    const logged = labels.map(category => ({category: ` ${category.toUpperCase()} `, amount: 100, description: 'Unrelated prose'}));
    const result = c.matchMandatoryPayments(expected, logged);
    assert.equal(result.paid, 9); assert.equal(result.unpaid, 0); assert.equal(result.unplanned.length, 0);
  });
  test('Stage 4B: transport, legacy names and prose cannot satisfy another category', c => {
    const result = c.matchMandatoryPayments([{name: 'Авто', amount: 50}, {name: 'Квартира', amount: 100}], [
      {category: 'Транспорт', amount: 50, description: 'Авто'},
      {category: 'Аренда', amount: 100, description: 'Квартира'}
    ]);
    assert.equal(result.unpaid, 2); assert.equal(result.unplanned.length, 2);
  });
  test('Stage 4B: partial payments and refunds use net cents; G is explicit opt-in', c => {
    const expected = [{name: 'Налоги', amount: 100, paidFlag: true}];
    const logged = [{category: 'Налоги', amount: 60}, {category: 'Налоги', amount: 50}, {category: 'Налоги', amount: -20}];
    const result = c.matchMandatoryPayments(expected, logged);
    assert.equal(result.unpaid, 1); assert.equal(result.items[0].actual, 90); assert.equal(result.items[0].status, 'partial');
    assert.equal(c.summarizeMonthlyMandatory(expected, logged).paid, 1);
    assert.equal(c.matchMandatoryPayments([{name: 'Налоги', amount: 0.3}], [{category: 'Налоги', amount: 0.1 + 0.2}]).paid, 1);
  });
  test('Stage 4B: excluded plans stay out of alerts, positive unmapped Родители needs review', c => {
    const result = c.matchMandatoryPayments([{name: ' cpf ', amount: 500}, {name: 'Родители', amount: 0}, {name: 'Отдых', amount: 0}], [
      {category: 'CPF', amount: 500}, {category: 'Отдых', amount: 200}
    ]);
    assert.equal(result.excluded, 3); assert.equal(result.unpaid, 0); assert.equal(result.unplanned.length, 0);
    assert.ok(result.excludedItems.every(item => item.satisfied));
    const positive = c.matchMandatoryPayments([{name: 'Родители', amount: 100}], [{category: 'Другое', amount: 100}]);
    assert.equal(positive.unpaid, 1); assert.equal(positive.items[0].needs_review, true);
  });
  test('Stage 4B: invalid input and duplicate plans fail instead of inventing payment results', c => {
    for (const amount of ['', null, '#REF!', true, Infinity]) {
      assert.throws(() => c.matchMandatoryPayments([{name: 'Налоги', amount}], []), /amount/);
    }
    assert.throws(() => c.matchMandatoryPayments([{name: 'Налоги', amount: -1}], []), /amount/);
    assert.throws(() => c.matchMandatoryPayments([{name: 'Налоги', amount: 10}, {name: ' налоги ', amount: 20}], []), /Duplicate/);
    assert.throws(() => c.matchMandatoryPayments([], [{description: 'IRAS', amount: 50}]), /category/);
  });
  test('Stage 4B: weekly path needs no Gemini and escapes data; missing data is unavailable', c => {
    c.PropertiesService = {getScriptProperties: () => { throw new Error('No model configuration needed'); }};
    c.callGeminiApiWithRetry = () => { throw new Error('No LLM matching'); };
    const text = c.generateWeeklyMandatoryReport({mandatory_expenses: {
      expected: [{name: 'Школа & Детский сад', amount: 100}, {name: 'CPF', amount: 10}, {name: 'Родители', amount: 0}],
      logged: [{category: 'Школа & Детский сад', amount: 100}, {category: 'Other', description: '<script>', amount: 5}]
    }});
    assert.match(text, /Школа &amp; Детский сад/); assert.match(text, /&lt;script&gt;/);
    assert.doesNotMatch(text, /undefined|NaN/);
    assert.match(text, /Unpaid \/ partial<\/b>\nNone/);
    assert.match(c.generateWeeklyMandatoryReport({mandatory_expenses: {expected: [], logged: []}}), /unavailable/);
    assert.match(c.generateWeeklyMandatoryReport({mandatory_expenses: {error: 'Bad sheet'}}), /unavailable/);
  });
  test('Stage 4B: strict ledger reader filters month/type and rejects missing SGD or invalid dates', c => {
    const rows = [
      ['2026-09-06', 'DBS', 'Обязательные расходы', 999, 100, '', '', 'Налоги', 'IRAS'],
      ['06.08.2026', 'DBS', 'Обязательные расходы', 999, 50, '', '', 'Налоги', 'IRAS'],
      ['06.09.2026', 'DBS', 'Расходы', 999, 50, '', '', 'Налоги', 'IRAS']
    ];
    const ss = {getSheetByName: () => ({getLastRow: () => rows.length + 1, getLastColumn: () => 11,
      getRange: () => ({getValues: () => rows, getDisplayValues: () => rows.map(row => row.map(String))})})};
    const date = vm.runInContext("new Date('2026-09-16T00:00:00Z')", c);
    const logged = c.getLoggedMandatoryThisMonth(ss, date, true);
    assert.equal(logged.length, 1); assert.equal(logged[0].amount, 100);
    rows[0][4] = '';
    assert.throws(() => c.getLoggedMandatoryThisMonth(ss, date, true), /amount/);
    rows[0][4] = 100; rows[0][0] = '31.09.2026';
    assert.throws(() => c.getLoggedMandatoryThisMonth(ss, date, true), /date/);
  });
  test('Stage 4B: strict readers fail on absent sheets', c => {
    const ss = {getSheetByName: () => null};
    assert.throws(() => c.getMandatoryExpenses(ss, undefined, true), /unavailable/);
    assert.throws(() => c.getLoggedMandatoryThisMonth(ss, undefined, true), /unavailable/);
  });
};
