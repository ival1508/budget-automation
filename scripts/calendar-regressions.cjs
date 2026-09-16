const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
module.exports = function(test) {
  const row = (date, amount = 100, item = 'IRAS', category = 'Налоги', account = 'DBS') =>
    [date, account, 'Обязательные расходы', 99999, amount, '', '', category, item, '', ''];
  test('Stage 4A: known fixture days and EOM are derived and remain inactive', c => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../testStage4A.gs'), 'utf8'), c);
    assert.equal(c.test_seedCalendar().items.length, 3);
  });
  test('Stage 4A: completed-month window, recurrence and strict SGD filtering', c => {
    const rows = [row('06.12.2025'), row('06.01.2026'), row('06.02.2026'),
      row('06.03.2026', 800), row('06.08.2025', 800), row('06.02.2026', 100, 'One off'),
      row('31.02.2026'), row('06.02.2026', '#REF!'), row('06.02.2026', ''),
      row('06.02.2026', -100), row('06.02.2026', 0), row('06.02.2026', 100, 'CPF', 'CPF')];
    rows.push(Object.assign(row('06.02.2026'), { 2: 'Расходы' }));
    const draft = c.proposeCalendarFromHistory(rows, '2026-03-01');
    assert.equal(draft.items.length, 1);
    assert.equal(draft.items[0].typical_amount, 100);
    assert.equal(draft.items[0].evidence.observedMonths, 3);
    assert.equal(draft.skipped.length, 5);
    assert.equal(draft.insufficientHistory.length, 1);
    assert.throws(() => c.proposeCalendarFromHistory([], '2026-03-01', {minimumMonths: 1}), /Invalid/);
  });
  test('Stage 4A: monthly votes, monthly amount totals, normalization and account isolation', c => {
    const rows = [row('01.03.2026', 40), row('09.03.2026', 60), row('07.04.2026'), row('09.05.2026', 300, ' iras '),
      row('01.03.2026', 10, 'IRAS', 'Налоги', 'Citi')];
    const draft = c.proposeCalendarFromHistory(rows, '2026-06-01');
    assert.equal(draft.items[0].expected_day_of_month, 7);
    assert.equal(draft.items[0].typical_amount, 100);
    assert.equal(draft.items[0].evidence.multiplePaymentsInMonth, true);
    assert.equal(draft.insufficientHistory.length, 1);
  });
  test('Stage 4A: SGT boundaries and leap-year EOM', c => {
    assert.equal(vm.runInContext("calendarDateParts(new Date('2026-01-31T16:00:00Z')).month", c), 2);
    assert.equal(c.calendarDateParts('29.02.2024').lastDay, 29);
    assert.throws(() => c.calendarDateParts('29.02.2025'), /Invalid/);
    const draft = c.proposeCalendarFromHistory([row('31.01.2024'), row('29.02.2024'), row('31.03.2024')], '2024-04-01');
    assert.equal(draft.items[0].expected_day_of_month, 'EOM');
  });
  test('Stage 4A: bootstrap, append-only reruns, human edits and schema protection', c => {
    let cells = [], notes = [], inserts = 0, locks = 0, held = false;
    c.LockService = {getScriptLock: () => ({hasLock: () => held, tryLock: () => { held = true; locks++; return true; }, releaseLock: () => { held = false; }})};
    const sheet = {
      getLastRow: () => cells.length, getMaxRows: () => 100, setFrozenRows: () => {},
      getRange: (r, col, height = 1, width = 1) => {
        const range = {
          getValues: () => Array.from({length: height}, (_, i) => Array.from({length: width}, (_, j) => (cells[r-1+i] || [])[col-1+j] || '')),
          setValues: values => { values.forEach((valuesRow, i) => { cells[r-1+i] ||= []; valuesRow.forEach((value, j) => { cells[r-1+i][col-1+j] = value; }); }); return range; },
          setFontWeight: () => range, setNumberFormat: () => range, setNote: () => range,
          setNotes: values => { notes.push(...values); return range; }, insertCheckboxes: () => range
        }; return range;
      }
    };
    const history = [row('06.03.2026'), row('06.04.2026'), row('06.05.2026')];
    const ss = {getSheetByName: name => name === 'Transactions' ? {getLastRow: () => history.length + 1, getRange: () => ({getValues: () => history})} : inserts ? sheet : null,
      insertSheet: () => { inserts++; return sheet; }};
    assert.equal(c.seedCalendar(ss, '2026-06-01').added, 1);
    assert.equal(cells[1][5], false);
    assert.match(notes[0][0], /Transactions rows: 2, 3, 4/);
    cells[1][2] = 'EOM'; cells[1][3] = 123; cells[1][5] = true;
    assert.equal(c.seedCalendar(ss, '2026-06-01').added, 0);
    assert.equal(cells[1][2], 'EOM'); assert.equal(cells[1][3], 123); assert.equal(cells[1][5], true);
    assert.equal(inserts, 1); assert.equal(locks, 2); assert.equal(held, false);
    cells[0][0] = 'unexpected';
    assert.throws(() => c.seedCalendar(ss, '2026-06-01'), /headers/);
    assert.equal(cells.length, 2); assert.equal(held, false);
  });
};
