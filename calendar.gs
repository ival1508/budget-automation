/** Stage 4A: an editable, human-confirmed calendar derived from ledger history. */
const CALENDAR_HEADERS = ['item', 'category', 'expected_day_of_month', 'typical_amount', 'account', 'active'];

/** Create the visible config tab once. Never replace an existing calendar. */
function initializeCalendar(ss) {
  return withBudgetWriteLock(() => {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    let sheet = spreadsheet.getSheetByName(SHEET_FACTS.CORE_TABS.CALENDAR);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_FACTS.CORE_TABS.CALENDAR);
      sheet.getRange(1, 1, 1, CALENDAR_HEADERS.length).setValues([CALENDAR_HEADERS]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      sheet.getRange(1, 3).setNote('Day 1–31 or EOM (last day of the month). Review the history-derived proposal.');
      sheet.getRange(1, 4).setNote('Typical monthly payment in SGD; median across observed months.');
      sheet.getRange(1, 6).setNote('Draft rows start unchecked. Val: review/edit each row, then check to confirm.');
    }
    assertCalendarHeaders(sheet);
    return sheet;
  });
}

function assertCalendarHeaders(sheet) {
  const headers = sheet.getRange(1, 1, 1, CALENDAR_HEADERS.length).getValues()[0];
  if (CALENDAR_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new Error('Calendar headers do not match the six-column schema. Existing data was preserved.');
  }
}

function calendarText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

/** Exact normalized identity; do not guess merchant aliases or merge categories. */
function calendarItemKey(item, category, account) {
  return JSON.stringify([item, category, account].map(value => calendarText(value).toLowerCase()));
}

/** Parse sheet Dates in SGT, or explicit dd.MM.yyyy / yyyy-MM-dd text. */
function calendarDateParts(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    value = Utilities.formatDate(value, 'Asia/Singapore', 'yyyy-MM-dd');
  }
  const text = calendarText(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const local = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (!iso && !local) throw new Error('Invalid calendar history date: ' + text);
  const year = Number(iso ? iso[1] : local[3]);
  const month = Number(iso ? iso[2] : local[2]);
  const day = Number(iso ? iso[3] : local[1]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > lastDay) {
    throw new Error('Invalid calendar history date: ' + text);
  }
  return { year: year, month: month, day: day, lastDay: lastDay, monthIndex: year * 12 + month - 1 };
}

function calendarMedian(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Pure proposal builder. Each observed month has one vote, so split payments do
 * not outweigh other months. Defaults: last six completed months, at least three
 * observed months. Sparse items and malformed rows remain visible in diagnostics.
 * EOM means at least two thirds of monthly median dates fall on the last two days.
 * This is a suggestion only: timing, split payments and identity need human review.
 * @param {Array<Array<*>>} rows Transactions A:K, without headers.
 * @param {Date|string} asOf Reporting anchor; the current incomplete month is excluded.
 * @param {Object} [options] Optional lookbackMonths and minimumMonths.
 * @return {Object} Draft items with source rows/months, plus skipped-row reasons.
 */
function proposeCalendarFromHistory(rows, asOf, options) {
  const settings = Object.assign({ lookbackMonths: 6, minimumMonths: 3 }, options || {});
  if (!Number.isInteger(settings.lookbackMonths) || settings.lookbackMonths < 1 ||
      !Number.isInteger(settings.minimumMonths) || settings.minimumMonths < 2 ||
      settings.minimumMonths > settings.lookbackMonths) throw new Error('Invalid calendar history window.');
  const anchor = calendarDateParts(asOf);
  const groups = new Map();
  const skipped = [];
  rows.forEach((row, index) => {
    if (calendarText(row[2]) !== TRANSACTION_TYPES.FIXED_EXPENSE) return;
    const sourceRow = index + SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE.DATA_START_ROW;
    try {
      const date = calendarDateParts(row[0]);
      if (date.monthIndex >= anchor.monthIndex || date.monthIndex < anchor.monthIndex - settings.lookbackMonths) return;
      const category = calendarText(row[7]);
      const item = calendarText(row[8]) || category;
      const account = calendarText(row[1]);
      if (!category || !item || !account) throw new Error('Missing item, category or account');
      if (SHEET_FACTS.NON_LEDGER_MANDATORY.some(label => calendarText(label).toLowerCase() === category.toLowerCase())) return;
      // Only E is SGD. Never silently substitute the original-currency amount in D.
      const amount = readMonthlyAmount(row[4], '');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('SGD amount must be positive (refunds and zero rows excluded)');
      const key = calendarItemKey(item, category, account);
      if (!groups.has(key)) groups.set(key, { item: item, category: category, account: account, months: new Map() });
      const group = groups.get(key);
      if (!group.months.has(date.monthIndex)) group.months.set(date.monthIndex, { days: [], amount: 0, lastDay: date.lastDay, rows: [] });
      const month = group.months.get(date.monthIndex);
      month.days.push(date.day);
      month.amount += amount;
      month.rows.push(sourceRow);
    } catch (error) {
      skipped.push({ row: sourceRow, reason: error.message });
    }
  });
  const items = [], insufficientHistory = [];
  groups.forEach(group => {
    const months = Array.from(group.months.values());
    if (months.length < settings.minimumMonths) {
      insufficientHistory.push({ item: group.item, category: group.category, account: group.account, observedMonths: months.length });
      return;
    }
    const days = months.map(month => calendarMedian(month.days));
    const eomMonths = months.filter((month, index) => month.lastDay - days[index] <= 1).length;
    items.push({
      item: group.item, category: group.category,
      expected_day_of_month: eomMonths / months.length >= 2 / 3 ? 'EOM' : Math.round(calendarMedian(days)),
      typical_amount: Math.round(calendarMedian(months.map(month => month.amount)) * 100) / 100,
      account: group.account, active: false,
      evidence: { observedMonths: months.length, sourceRows: months.reduce((all, month) => all.concat(month.rows), []),
        multiplePaymentsInMonth: months.some(month => month.rows.length > 1), earliestDay: Math.min.apply(null, days), latestDay: Math.max.apply(null, days) }
    });
  });
  items.sort((a, b) => (a.expected_day_of_month === 'EOM' ? 32 : a.expected_day_of_month) -
    (b.expected_day_of_month === 'EOM' ? 32 : b.expected_day_of_month) || calendarItemKey(a.item, a.category, a.account).localeCompare(calendarItemKey(b.item, b.category, b.account)));
  return { items: items, skipped: skipped, insufficientHistory: insufficientHistory, settings: settings };
}

/** Read-only proposal runner: inspect execution logs before seeding if desired. */
function previewCalendarSeed(ss, asOf, options) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getTransactionsSheet(spreadsheet);
  const start = SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE.DATA_START_ROW;
  const rows = sheet.getLastRow() < start ? [] : sheet.getRange(start, 1, sheet.getLastRow() - start + 1, 11).getValues();
  const proposal = proposeCalendarFromHistory(rows, asOf || new Date(), options);
  Logger.log(JSON.stringify(proposal, null, 2));
  return proposal;
}

/**
 * Append only missing draft identities under the shared writer lock. Existing
 * rows (including inactive/rejected rows) are never overwritten or reactivated.
 * Edit item names/accounts with care: an edited identity becomes a different item.
 */
function seedCalendar(ss, asOf, options) {
  return withBudgetWriteLock(() => {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    const proposal = previewCalendarSeed(spreadsheet, asOf, options);
    const sheet = initializeCalendar(spreadsheet);
    const existing = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
    const keys = new Set(existing.map(row => calendarItemKey(row[0], row[1], row[4])));
    const additions = proposal.items.filter(item => !keys.has(calendarItemKey(item.item, item.category, item.account)));
    if (additions.length) {
      const start = sheet.getLastRow() + 1;
      const last = start + additions.length - 1;
      if (last > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), last - sheet.getMaxRows());
      // Escape ledger text so an item beginning with '=' remains text in Sheets.
      const literal = value => /^[=+\-@']/.test(value) ? "'" + value : value;
      sheet.getRange(start, 1, additions.length, 6).setValues(additions.map(item => [
        literal(item.item), literal(item.category), item.expected_day_of_month, item.typical_amount, literal(item.account), false
      ]));
      sheet.getRange(start, 4, additions.length, 1).setNumberFormat('0.00');
      sheet.getRange(start, 6, additions.length, 1).insertCheckboxes();
      sheet.getRange(start, 3, additions.length, 1).setNotes(additions.map(item => [
        'Draft from ' + item.evidence.observedMonths + ' months; Transactions rows: ' + item.evidence.sourceRows.join(', ') +
        '. Observed median days: ' + item.evidence.earliestDay + '–' + item.evidence.latestDay +
        (item.evidence.multiplePaymentsInMonth ? '. Multiple payments in a month: review whether these need separate calendar items.' : '')
      ]));
    }
    SpreadsheetApp.flush();
    return Object.assign(proposal, { added: additions.length, preserved: existing.length });
  });
}

/** Menu entry kept separate from the reusable seed API. */
function seedCalendarFromMenu() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = seedCalendar(ss);
  ss.setActiveSheet(ss.getSheetByName(SHEET_FACTS.CORE_TABS.CALENDAR));
  SpreadsheetApp.getUi().alert('Calendar draft: ' + result.added + ' new inactive rows. Review dates, amounts and accounts, then check active to confirm. ' +
    result.skipped.length + ' invalid/refund rows and ' + result.insufficientHistory.length + ' items with insufficient history are listed in execution logs.');
}
