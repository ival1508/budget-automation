/** Stage 4B: deterministic monthly label → ledger category matching. */
const MANDATORY_CATEGORY_MAP = Object.freeze({
  'Квартира': 'Квартира',
  'Авто': 'Авто',
  'Родители': null, // Zero plan is excluded; a positive plan needs explicit mapping.
  'НКО': 'НКО',
  'Лин': 'Лин',
  'Налоги': 'Налоги',
  'Школа & Детский сад': 'Школа & Детский сад',
  'Extra fund': 'Extra fund',
  'Отдых': 'Отдых',
  'Отложения': 'Отложения',
  'CPF': null
});

function mandatoryLabelKey(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isNonLedgerMandatory(label) {
  return (SHEET_FACTS.NON_LEDGER_MANDATORY || []).some(value => mandatoryLabelKey(value) === mandatoryLabelKey(label));
}

/** Explicit map first; custom labels may match an identical category, never prose. */
function mandatoryCategoryForLabel(label) {
  const key = mandatoryLabelKey(label);
  const mappedLabel = Object.keys(MANDATORY_CATEGORY_MAP).find(name => mandatoryLabelKey(name) === key);
  return mappedLabel === undefined ? key : mandatoryLabelKey(MANDATORY_CATEGORY_MAP[mappedLabel]);
}

/** Blank/error amounts are unavailable, not zero-valued plans. */
function mandatoryAmount(item, primary, legacy) {
  const value = item[primary] !== undefined ? item[primary] : item[legacy];
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') {
    throw new Error('Missing mandatory amount.');
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error('Invalid mandatory amount.');
  return Math.round(amount * 100) / 100;
}

/**
 * Match monthly D3:G13 plans to already month/type-filtered ledger groups.
 * Sum all merchants within the exact category, including refunds. Never use
 * bucket, description or fuzzy text to infer a category. One category may fund
 * only one plan; duplicate canonical plans fail instead of double-counting.
 *
 * CPF and zero plans stay visible in excludedItems, but cannot appear unpaid or
 * unplanned. G flags are ignored unless a caller explicitly opts into the
 * existing monthly-summary contract. No sheet writes or model calls occur.
 */
function matchMandatoryPayments(expected, logged, options) {
  const trustPaidFlags = options && options.trustPaidFlags === true;
  const totals = new Map();
  const result = { paid: 0, unpaid: 0, excluded: 0, items: [], excludedItems: [], unplanned: [] };
  logged.forEach(item => {
    if (isNonLedgerMandatory(item.category)) return;
    const amount = mandatoryAmount(item, 'amount', 'actual_amount');
    const category = mandatoryLabelKey(item.category);
    if (!category) throw new Error('Logged mandatory payment has no category; review the ledger.');
    totals.set(category, (totals.get(category) || 0) + Math.round(amount * 100));
  });
  const usedCategories = new Set();
  const excludedCategories = new Set();
  expected.forEach(item => {
    const name = String(item.label || item.name || '').trim();
    if (!name) throw new Error('Mandatory plan has no label.');
    const category = mandatoryCategoryForLabel(name);
    // Non-ledger lines are excluded even if their planning amount is unavailable.
    if (isNonLedgerMandatory(name)) {
      result.excludedItems.push({ name: name, status: 'excluded', reason: 'non_ledger', satisfied: true });
      return;
    }
    const planned = mandatoryAmount(item, 'amount', 'planned_amount');
    if (planned < 0) throw new Error('Invalid planned mandatory amount.');
    if (planned === 0) {
      if (category) excludedCategories.add(category);
      excludedCategories.add(mandatoryLabelKey(name));
      result.excludedItems.push({ name: name, planned: planned, status: 'excluded', reason: 'zero_plan', satisfied: true });
      return;
    }
    if (category && usedCategories.has(category)) throw new Error('Duplicate mandatory plan category: ' + name);
    if (category) usedCategories.add(category);
    const actual = category ? (totals.get(category) || 0) / 100 : 0;
    const paidByFlag = trustPaidFlags && (item.paidFlag === true || item.is_checked === true);
    const paid = paidByFlag || Math.round(actual * 100) >= Math.round(planned * 100);
    result[paid ? 'paid' : 'unpaid']++;
    result.items.push({ name: name, planned: planned, actual: actual,
      status: paid ? 'paid' : (actual > 0 ? 'partial' : 'unpaid'),
      needs_review: !category, matched_by: paidByFlag ? 'paid_flag' : (category ? 'category' : 'unmapped') });
  });
  result.excluded = result.excludedItems.length;
  logged.forEach(item => {
    const category = mandatoryLabelKey(item.category);
    if (!isNonLedgerMandatory(item.category) && !usedCategories.has(category) && !excludedCategories.has(category)) {
      result.unplanned.push(item);
    }
  });
  return result;
}

/** Stable HTML report: paid/unpaid only. Date-based warnings belong to Part C. */
function formatMandatoryPaymentReport(result) {
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = ['<b>📋 Mandatory payments this month</b>'];
  const section = (heading, rows, format) => {
    lines.push('\n<b>' + heading + '</b>');
    lines.push(rows.length ? rows.map(format).join('\n') : 'None.');
  };
  const paymentLine = item => '• ' + escape(item.name) + ' — S$' + item.actual.toFixed(2) +
    ' / S$' + item.planned.toFixed(2) + (item.status === 'partial' ? ' (partial)' : '') +
    (item.needs_review ? ' (category mapping needs review)' : '');
  section('✅ Paid', result.items.filter(item => item.status === 'paid'), paymentLine);
  section('⏳ Unpaid / partial', result.items.filter(item => item.status !== 'paid'), paymentLine);
  section('💡 Unplanned fixed spend', result.unplanned, item => '• ' +
    escape(item.label || item.description || item.category) + ' — S$' + mandatoryAmount(item, 'amount', 'actual_amount').toFixed(2));
  if (result.excluded) lines.push('\n<i>Planning only (excluded): ' + result.excludedItems.map(item => escape(item.name)).join(', ') + '.</i>');
  return lines.join('\n');
}
