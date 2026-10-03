// Read-only checkpoint against a bounded connector snapshot; no credentials or network.
// Usage: node scripts/verify-monthly-snapshot.cjs /tmp/monthly-snapshot.json
// Snapshots contain private ledger data: keep them outside the repository.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.resolve(__dirname, '..');
const context = {
  Logger: {log: () => {}},
  PropertiesService: {getScriptProperties: () => ({getProperty: () => null})},
  Utilities: {formatDate: (date, zone, format) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date).map(p => [p.type, p.value]));
    return {yyyy: parts.year, yy: parts.year.slice(-2), M: String(+parts.month),
      'yyyy-MM': `${parts.year}-${parts.month}`, 'yyyy-MM-dd': `${parts.year}-${parts.month}-${parts.day}`, 'MM.yyyy': `${parts.month}.${parts.year}`,
      'MM/yyyy': `${parts.month}/${parts.year}`, 'dd.MM.yyyy': `${parts.day}.${parts.month}.${parts.year}`}[format] || '';
  }}
};
vm.createContext(context);
for (const file of ['constants.gs', 'config.gs', 'bootstrap.gs', 'calendar.gs', 'mandatory.gs', 'monthlyInsights.gs', 'reader.gs', 'coach.gs']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
}
function sheet(raw, display) {
  const values = (matrix, r, col, height, width) => Array.from({length: height}, (_, i) =>
    Array.from({length: width}, (_, j) => matrix[r - 1 + i]?.[col - 1 + j] ?? ''));
  return {getLastRow: () => raw.length, getLastColumn: () => Math.max(...raw.map(row => row.length)),
    getRange: (r, col, height = 1, width = 1) => {
      if (r === 'D3:G13') { r = 3; col = 4; height = 11; width = 4; }
      if (typeof r === 'string' && /^[A-Z]\d+$/.test(r)) {
        col = r.charCodeAt(0) - 64; r = Number(r.slice(1));
      }
      assert.equal(typeof r, 'number');
      return {getValues: () => values(raw, r, col, height, width),
        getDisplayValues: () => values(display, r, col, height, width),
        getDisplayValue: () => values(display, r, col, height, width)[0][0],
        getValue: () => values(raw, r, col, height, width)[0][0]};
    }};
}
const planRows = values => [[], [], ...values.map(row => ['', '', '', ...row])];
const ledger = [Array(11).fill('header'), ...snapshot.ledgerDisplay];
const sheets = {
  '50/30/20': sheet(snapshot.budgetRaw, snapshot.budgetDisplay),
  [snapshot.monthTab]: sheet(snapshot.monthRaw || planRows(snapshot.planRaw), snapshot.monthDisplay || planRows(snapshot.planDisplay)),
  Transactions: sheet(ledger, ledger)
};
for (const name of snapshot.historyTabs || []) if (!sheets[name]) sheets[name] = sheet([], []);
const ss = {getSheetByName: name => sheets[name] || null};
context.reportDateText = snapshot.reportDate;
const anchor = vm.runInContext('new Date(reportDateText)', context);
const payload = context.buildCoachPayload('monthly', ss, anchor);
assert.equal(payload.error, undefined, payload.message);
const brief = context.generateMonthlyCoachBrief(payload);
assert.equal(context.monthlyCoachBriefIsGrounded(brief, payload), true);
assert.equal(context.coachMoneyIsGrounded(brief, payload), true);
// Independent direct-cell comparison: use the snapshot's visible summary rows.
const monthHeader = context.Utilities.formatDate(anchor, 'Asia/Singapore', 'MM/yyyy');
const column = snapshot.budgetDisplay[0].indexOf(monthHeader);
assert.ok(column >= 0);
for (const key of ['needs', 'wants', 'savings']) {
  const row = snapshot.budgetDisplay.findIndex(cells => String(cells[0]).toLowerCase().startsWith(key) &&
    (cells[1] === 'Total' || (key === 'savings' && cells[1] === 'Отложения')));
  assert.ok(row >= 0);
  assert.equal(payload.buckets[key].actual, Number(Number(snapshot.budgetRaw[row][column]).toFixed(2)));
  assert.equal(payload.buckets[key].target, Number(Number(snapshot.budgetRaw[row][30]).toFixed(2)));
  assert.equal(payload.buckets[key].actual_percent, snapshot.budgetDisplay[row][column + 1]);
  assert.equal(payload.buckets[key].target_percent, snapshot.budgetDisplay[row][31]);
}
// Independent ledger sums use the connector's displayed SGD values (ru_RU).
const parseSgd = value => Number(String(value).replace(/S\$|\s/g, '').replace(',', '.'));
const monthSuffix = '.' + monthHeader.replace('/', '.');
const selected = snapshot.ledgerDisplay.filter(row => String(row[0]).endsWith(monthSuffix));
for (const item of payload.volatile_categories) {
  const total = selected.filter(row => String(row[2]).trim() === 'Расходы' && row[7] === item.name)
    .reduce((sum, row) => sum + parseSgd(row[4]), 0);
  assert.equal(item.actual, Number(total.toFixed(2)));
}
const counts = {paid: 0, unpaid: 0, excluded: 0};
for (const row of snapshot.planRaw) {
  if (row[0] === 'CPF' || row[1] === 0) { counts.excluded++; continue; }
  const total = selected.filter(transaction => String(transaction[2]).trim() === 'Обязательные расходы' && transaction[7] === row[0])
    .reduce((sum, transaction) => sum + parseSgd(transaction[4]), 0);
  counts[row[3] === true || Math.round(total * 100) >= Math.round(row[1] * 100) ? 'paid' : 'unpaid']++;
}
for (const key of ['paid', 'unpaid', 'excluded']) assert.equal(payload.mandatory_summary[key], counts[key]);
const ordinaryTotal = selected.filter(row => String(row[2]).trim() === 'Расходы').reduce((sum, row) => sum + parseSgd(row[4]), 0);
assert.equal(payload.monthly_review.ordinary_total, Number(ordinaryTotal.toFixed(2)));
if (snapshot.monthRaw) {
  const cap = Number(snapshot.monthRaw[14][3]);
  assert.equal(payload.monthly_review.ordinary_plan.amount, cap);
  assert.equal(payload.monthly_review.ordinary_variance, Number((ordinaryTotal - cap).toFixed(2)));
}

console.log(JSON.stringify({report_month: payload.report_month, buckets: payload.buckets,
  volatile_categories: payload.volatile_categories, category_focus: payload.category_focus,
  payment_counts: {paid: payload.mandatory_summary.paid, unpaid: payload.mandatory_summary.unpaid, excluded: payload.mandatory_summary.excluded},
  monthly_review: payload.monthly_review, target_header: payload.target_header, brief, checkpoint: 'PASS: source code matches snapshot summary cells, ordinary-spend sums and payment counts'}, null, 2));
