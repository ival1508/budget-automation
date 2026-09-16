/** Stage 4C: Calendar payment status, dates and user-facing reminders. */

/** Read only confirmed rows. Never bootstrap or change a user's calendar here. */
function readMandatoryCalendar(ss) {
  const sheet = ss.getSheetByName(SHEET_FACTS.CORE_TABS.CALENDAR);
  if (!sheet) throw new Error('Calendar is missing. Seed or create it, then confirm active items.');
  assertCalendarHeaders(sheet);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().reduce((items, row, index) => {
    const active = String(row[5]).trim().toUpperCase();
    if (!active || active === 'FALSE') return items;
    if (active !== 'TRUE') throw new Error('Calendar row ' + (index + 2) + ': active must be a checkbox.');
    items.push({ item: calendarText(row[0]), category: calendarText(row[1]),
      expected_day_of_month: row[2], typical_amount: row[3], account: calendarText(row[4]), row: index + 2 });
    return items;
  }, []);
}

/** Read individual ledger rows so different accounts/items cannot share credit. */
function readCalendarPayments(ss, asOf) {
  const anchor = calendarDateParts(asOf);
  const sheet = getTransactionsSheet(ss);
  const start = SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE.DATA_START_ROW;
  if (sheet.getLastRow() < start) return [];
  const rows = sheet.getRange(start, 1, sheet.getLastRow() - start + 1, 11).getValues();
  const payments = [];
  rows.forEach((row, index) => {
    if (calendarText(row[2]) !== TRANSACTION_TYPES.FIXED_EXPENSE) return;
    if (isNonLedgerMandatory(row[7])) return;
    const date = calendarDateParts(row[0]);
    if (date.monthIndex !== anchor.monthIndex || date.day > anchor.day) return;
    const category = calendarText(row[7]), account = calendarText(row[1]);
    if (!category || !account) throw new Error('Transactions row ' + (index + start) + ': category/account is missing.');
    const amount = readMonthlyAmount(row[4], '');
    if (!Number.isFinite(amount)) throw new Error('Transactions SGD amount is unavailable.');
    payments.push({ item: calendarText(row[8]), category: category, account: account, amount: amount });
  });
  return payments;
}

/** Numeric dates clamp to shorter months; EOM always means the last calendar day. */
function mandatoryDueDay(value, lastDay) {
  if (String(value).trim().toUpperCase() === 'EOM') return lastDay;
  if (!/^\d{1,2}$/.test(String(value).trim())) throw new Error('Calendar day must be 1–31 or EOM.');
  const day = Number(value);
  if (day < 1 || day > 31) throw new Error('Calendar day must be 1–31 or EOM.');
  return Math.min(day, lastDay);
}

/**
 * Pure evaluator for one reporting month. The upcoming window is today plus six
 * days, capped at month-end: this brief reports unpaid payments for this month.
 * Monthly zero plans override Calendar rows, and G is deliberately not consulted.
 *
 * Unique category/account pairs match directly. Multiple items in a pair require
 * exact normalized item/merchant names. Unassigned money makes unpaid candidates
 * ambiguous; show them for review, never falsely settle or accuse one of them.
 */
function evaluateMandatoryCalendar(calendar, payments, plans, asOf) {
  const date = calendarDateParts(asOf);
  const zeroCategories = new Set();
  const zeroLabels = new Set();
  plans.forEach(plan => {
    const label = plan.label || plan.name;
    if (isNonLedgerMandatory(label)) return;
    const amount = mandatoryAmount(plan, 'amount', 'planned_amount');
    if (amount < 0) throw new Error('Negative mandatory plan.');
    if (amount === 0) {
      zeroLabels.add(mandatoryLabelKey(label));
      const category = mandatoryCategoryForLabel(label);
      if (category) zeroCategories.add(category);
    }
  });
  const groups = new Map(), identities = new Set();
  const result = { month: date.year + '-' + String(date.month).padStart(2, '0'), day: date.day,
    activeCount: calendar.length, excluded: 0, paid: [], overdue: [], dueThisWeek: [], dueToday: [], later: [], review: [] };
  const pairKey = (category, account) => JSON.stringify([mandatoryLabelKey(category), mandatoryLabelKey(account)]);
  calendar.forEach(entry => {
    if (isNonLedgerMandatory(entry.category) || isNonLedgerMandatory(entry.item) ||
        zeroLabels.has(mandatoryLabelKey(entry.item)) || zeroLabels.has(mandatoryLabelKey(entry.category)) ||
        zeroCategories.has(mandatoryLabelKey(entry.category))) { result.excluded++; return; }
    const planned = mandatoryAmount(entry, 'typical_amount', 'amount');
    if (planned === 0) { result.excluded++; return; }
    if (planned < 0 || !entry.item || !entry.category || !entry.account) throw new Error('Calendar item, category, account and positive amount are required.');
    const identity = calendarItemKey(entry.item, entry.category, entry.account);
    if (identities.has(identity)) throw new Error('Duplicate active Calendar item: ' + entry.item);
    identities.add(identity);
    const dueDay = mandatoryDueDay(entry.expected_day_of_month, date.lastDay);
    const item = Object.assign({}, entry, { planned: planned, actual: 0, dueDay: dueDay,
      dueDate: result.month + '-' + String(dueDay).padStart(2, '0') });
    const key = pairKey(entry.category, entry.account);
    if (!groups.has(key)) groups.set(key, { items: [], ambiguous: false });
    groups.get(key).items.push(item);
  });
  payments.forEach(payment => {
    const group = groups.get(pairKey(payment.category, payment.account));
    if (!group) return;
    const cents = Math.round(mandatoryAmount(payment, 'amount', 'actual_amount') * 100);
    if (!cents) return;
    const candidates = group.items.length === 1 ? group.items : group.items.filter(item =>
      mandatoryLabelKey(item.item) === mandatoryLabelKey(payment.item));
    if (candidates.length === 1) candidates[0].actual += cents;
    else group.ambiguous = true;
  });
  groups.forEach(group => group.items.forEach(item => {
    item.actual /= 100;
    item.remaining = Math.max(0, Math.round((item.planned - item.actual) * 100) / 100);
    // Ambiguous refunds can undo a paid result too: the whole group needs review.
    if (group.ambiguous) { result.review.push(item); return; }
    if (item.remaining === 0) { result.paid.push(item); return; }
    if (item.dueDay === date.day) result.dueToday.push(item);
    if (item.dueDay < date.day) result.overdue.push(item);
    else if (item.dueDay <= date.day + 6) result.dueThisWeek.push(item);
    else result.later.push(item);
  }));
  const compare = (a, b) => a.dueDay - b.dueDay || a.item.localeCompare(b.item) || a.account.localeCompare(b.account);
  ['paid', 'overdue', 'dueThisWeek', 'dueToday', 'later', 'review'].forEach(key => result[key].sort(compare));
  return result;
}

/** Strict workbook adapter. Missing source data never means all clear. */
function getMandatoryCalendarStatus(ss, asOf) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const now = asOf || new Date();
  const calendar = readMandatoryCalendar(spreadsheet);
  const plans = getMandatoryExpenses(spreadsheet, now, true);
  if (!plans.length) throw new Error('Monthly mandatory plan is empty.');
  return evaluateMandatoryCalendar(calendar, readCalendarPayments(spreadsheet, now), plans, now);
}

function mandatoryCalendarLine(item) {
  return '• ' + item.dueDate + ' — <b>' + escapeCoachHtml(item.item) + '</b> (' +
    escapeCoachHtml(item.account) + '): S$' + item.remaining.toFixed(2) + ' remaining' +
    (item.actual > 0 ? ' (S$' + item.actual.toFixed(2) + ' paid)' : '');
}

function formatMandatoryCalendarBrief(status) {
  const lines = ['<b>📋 Mandatory payments — ' + status.month + '</b>'];
  if (!status.activeCount) return lines[0] + '\nNo confirmed Calendar items. Review the draft and check active for each confirmed payment.';
  const section = (title, items) => {
    if (items.length) lines.push('\n<b>' + title + '</b>\n' + items.map(mandatoryCalendarLine).join('\n'));
  };
  section('⚠️ Overdue / missed', status.overdue);
  section('Due this week (today + 6 days, within this month)', status.dueThisWeek);
  section('Needs review — transaction item names do not identify a unique payment', status.review);
  if (!status.overdue.length && !status.dueThisWeek.length && !status.review.length) {
    lines.push('\n✅ All clear — no unpaid payments overdue or due in the next seven days this month.');
  }
  if (status.later.length) lines.push('\n' + status.later.length + ' unpaid payment(s) due later this month.');
  return lines.join('\n');
}

/** Sheet menu is local preview only; Telegram uses /mandatory or the heartbeat. */
function checkMandatoryPaymentsNow() {
  try {
    const status = getMandatoryCalendarStatus();
    const text = formatMandatoryCalendarBrief(status).replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    SpreadsheetApp.getUi().alert(text);
    return status;
  } catch (error) {
    SpreadsheetApp.getUi().alert('Mandatory payments unavailable: ' + error.message);
    throw error;
  }
}

/** Called only inside the optional evening delivery window. At most one summary per day/user. */
function runMandatorySameDayAlerts(now, users) {
  const config = SHEET_FACTS.MANDATORY_REMINDERS;
  if (!config || config.SAME_DAY_ENABLED !== true) return;
  const slot = getDailyDeliverySlot(now, config.SAME_DAY_TIME, config.CATCH_UP_MINUTES);
  if (!slot) return;
  try {
    const status = getMandatoryCalendarStatus(undefined, now);
    const reviewToday = status.review.filter(item => item.dueDay === status.day);
    if (!status.dueToday.length && !reviewToday.length) return;
    const sections = ['<b>⚠️ Mandatory payments due today — still outstanding</b>'];
    if (status.dueToday.length) sections.push(status.dueToday.map(mandatoryCalendarLine).join('\n'));
    if (reviewToday.length) sections.push('<b>Needs review before payment</b>\n' + reviewToday.map(mandatoryCalendarLine).join('\n'));
    users.forEach(user => deliverScheduledMessage('mandatory_same_day_' + user.chat_id, slot, user.chat_id, () => sections.join('\n\n')));
  } catch (error) { Logger.log('Mandatory same-day check unavailable: ' + error.message); }
}

function getMandatoryWeeklySlot(now) {
  const config = SHEET_FACTS.MANDATORY_REMINDERS;
  if (!config || Utilities.formatDate(now, 'Asia/Singapore', 'E') !== config.WEEKLY_DAY) return null;
  return getDailyDeliverySlot(now, config.WEEKLY_TIME, config.CATCH_UP_MINUTES);
}
