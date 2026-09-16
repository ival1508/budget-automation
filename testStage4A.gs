/** Deterministic history fixture; real-ledger acceptance still requires Val's review. */
function test_seedCalendar() {
  const rows = [];
  const add = (date, item, category, amount) => rows.push([
    date, 'DBS', TRANSACTION_TYPES.FIXED_EXPENSE, amount, amount, '', '', category, item, '', ''
  ]);
  ['05.03.2026', '06.04.2026', '07.05.2026'].forEach(date => add(date, 'IRAS', 'Налоги', 500));
  ['31.03.2026', '30.04.2026', '31.05.2026'].forEach(date => add(date, 'Лин', 'Лин', 900));
  ['03.03.2026', '04.04.2026', '05.05.2026'].forEach(date => add(date, 'Auto loan', 'Авто', 1200));
  const draft = proposeCalendarFromHistory(rows, '2026-06-01');
  const find = name => draft.items.find(item => item.item === name);
  if (draft.items.length !== 3 || Math.abs(find('IRAS').expected_day_of_month - 6) > 2 ||
      find('Лин').expected_day_of_month !== 'EOM' || Math.abs(find('Auto loan').expected_day_of_month - 4) > 2 ||
      draft.items.some(item => item.active)) throw new Error('Calendar fixture expectations failed');
  Logger.log('PASS test_seedCalendar: IRAS, Лин/EOM and auto loan fixture; all draft rows inactive.');
  return draft;
}
