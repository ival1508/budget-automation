/** Monthly coaching explains outcomes and evidence, rather than reciting every bucket. */
const MONTHLY_REVIEW_LOOKBACK = 6; // Reporting month plus five earlier months.

function monthlyMoney(value) {
  return (value < 0 ? '-' : '') + 'S$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function monthlyCents(value) {
  return Math.round(value * 100) / 100;
}

/** Optional context stays unavailable when a source is blank; never infer a zero. */
function readMonthlyContextAmount(sheet, address) {
  try {
    const range = sheet.getRange(address);
    return { amount: readMonthlyAmount(range.getValue(), range.getDisplayValue()), source: address };
  } catch (error) { return { amount: null, source: address, error: error.message }; }
}

/** Keep individual ordinary/mandatory rows, including refunds, for attribution. */
function readMonthlyReviewTransactions(ss, reportDate) {
  const anchor = calendarDateParts(reportDate);
  const sheet = getTransactionsSheet(ss);
  const start = SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE.DATA_START_ROW;
  if (sheet.getLastRow() < start) return [];
  const rows = sheet.getRange(start, 1, sheet.getLastRow() - start + 1, 11).getValues();
  return rows.reduce((selected, row, index) => {
    const type = calendarText(row[2]);
    if (type !== TRANSACTION_TYPES.EXPENSE && type !== TRANSACTION_TYPES.FIXED_EXPENSE) return selected;
    const date = calendarDateParts(row[0]);
    if (date.monthIndex > anchor.monthIndex || date.monthIndex <= anchor.monthIndex - MONTHLY_REVIEW_LOOKBACK) return selected;
    const category = calendarText(row[7]);
    if (!category) throw new Error('Missing category in monthly transaction history.');
    selected.push({ row: start + index, monthIndex: date.monthIndex,
      date: date.year + '-' + String(date.month).padStart(2, '0') + '-' + String(date.day).padStart(2, '0'),
      category: category, merchant: calendarText(row[8]) || 'merchant not recorded',
      account: calendarText(row[1]), amount: monthlyCents(readMonthlyAmount(row[4], '')), type: type });
    return selected;
  }, []);
}

/** Historical totals use each month's own sheet column, compared with today's target basis. */
function readMonthlyReviewHistory(ss, reportDate, transactions) {
  const anchor = calendarDateParts(reportDate), history = [], unavailable = [];
  for (let offset = 1; offset < MONTHLY_REVIEW_LOOKBACK; offset++) {
    const date = new Date(Date.UTC(anchor.year, anchor.month - 1 - offset, 15, 12));
    const month = calendarDateParts(date);
    const label = Utilities.formatDate(date, 'Asia/Singapore', 'yyyy-MM');
    const rows = transactions.filter(row => row.monthIndex === month.monthIndex);
    if (!ss.getSheetByName(getCurrentMonthTabName(date)) || !rows.length) {
      unavailable.push(label); continue; // Absent history is not a zero-spend month.
    }
    const budget = get503020Status(ss, false, date, true);
    if (budget.error) { unavailable.push(label); continue; }
    history.push({ month: label, monthIndex: month.monthIndex,
      ordinary: monthlyCents(rows.filter(row => row.type === TRANSACTION_TYPES.EXPENSE).reduce((total, row) => total + row.amount, 0)),
      categories: [...budget.needs.sub_categories, ...budget.wants.sub_categories] });
  }
  return { months: history.reverse(), unavailable: unavailable.reverse() };
}

/** Overall allocations come from the sheet's own unlabeled Total row, not a bucket sum. */
function readMonthlyAllocationTotal(ss, reportDate) {
  try {
    const sheet = ss.getSheetByName('50/30/20');
    const range = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn());
    const raw = range.getValues(), display = range.getDisplayValues();
    const month = Utilities.formatDate(reportDate, 'Asia/Singapore', 'MM/yyyy');
    const column = display[0].findIndex(value => String(value).trim() === month);
    const targetColumn = display[0].findIndex(value => /target|цел|план/i.test(String(value)));
    const row = display.findIndex(cells => !calendarText(cells[0]) && /^(total|итого|всего)$/i.test(calendarText(cells[1])));
    if (column < 0 || targetColumn < 0 || row < 0) return null;
    return { actual: monthlyCents(readMonthlyAmount(raw[row][column], display[row][column])),
      target: monthlyCents(readMonthlyAmount(raw[row][targetColumn], display[row][targetColumn])), sourceRow: row + 1 };
  } catch (_) { return null; }
}

/**
 * Pure analysis. Attribution requires the ledger total to reconcile to the sheet
 * category total. Large is not inherently wasteful: all flags are review prompts.
 * Historical targets are not archived; comparisons explicitly use current targets.
 */
function analyzeMonthlyReview(transactions, reportDate, budget, history, ordinaryPlan, plans) {
  const reservedCategories = new Set((plans || []).filter(plan => plan.amount > 0).map(plan => mandatoryCategoryForLabel(plan.label || plan.name)));
  const anchor = calendarDateParts(reportDate);
  const current = transactions.filter(row => row.monthIndex === anchor.monthIndex);
  const ordinary = current.filter(row => row.type === TRANSACTION_TYPES.EXPENSE);
  const ordinaryTotal = monthlyCents(ordinary.reduce((sum, row) => sum + row.amount, 0));
  const categories = [...budget.needs.sub_categories, ...budget.wants.sub_categories]
    .filter(category => category.actual_available !== false && category.target_available !== false).map(category => {
    const matches = current.filter(row => mandatoryLabelKey(row.category) === mandatoryLabelKey(category.name));
    const ordinaryAmount = monthlyCents(matches.filter(row => row.type === TRANSACTION_TYPES.EXPENSE).reduce((sum, row) => sum + row.amount, 0));
    const ledgerTotal = monthlyCents(matches.reduce((sum, row) => sum + row.amount, 0));
    const actual = monthlyCents(category.actual), target = monthlyCents(category.target);
    return { name: category.name, actual: actual, target: target, variance: monthlyCents(actual - target),
      ordinary: ordinaryAmount, committed: monthlyCents(ledgerTotal - ordinaryAmount),
      reconciled: Math.abs(ledgerTotal - actual) <= 0.02 };
  });
  categories.forEach(category => Object.assign(category, classifyMonthlyOverrun(category)));
  const overs = categories.filter(row => row.variance > 0).sort((a, b) => b.variance - a.variance);
  // A funded saving or an unpaid commitment is not evidence of everyday restraint.
  const unders = categories.filter(row => row.variance < 0 && row.target > 0 && row.ordinary > 0 && row.committed === 0 && row.reconciled && !reservedCategories.has(mandatoryLabelKey(row.name)) && Math.abs(row.variance) >= Math.max(50, row.target * 0.1))
    .sort((a, b) => a.variance - b.variance);
  const past = transactions.filter(row => row.monthIndex < anchor.monthIndex && row.type === TRANSACTION_TYPES.EXPENSE && row.amount > 0);
  // A refund at the same merchant makes an individual purchase's net cost unclear.
  const merchantKey = row => calendarItemKey(row.merchant, row.category, row.account);
  const refundedMerchants = new Set(ordinary.filter(row => row.amount < 0).map(merchantKey));
  const candidates = ordinary.filter(row => row.amount > 0 && !refundedMerchants.has(merchantKey(row))).map(row => {
    const category = categories.find(item => mandatoryLabelKey(item.name) === mandatoryLabelKey(row.category));
    const sample = past.filter(item => mandatoryLabelKey(item.category) === mandatoryLabelKey(row.category));
    const median = sample.length >= 5 ? calendarMedian(sample.map(item => item.amount)) : null;
    const without = category && category.reconciled ? monthlyCents(category.actual - row.amount) : null;
    const explainsOverrun = !!(category && category.variance > 0 && without !== null && without <= category.target);
    const unusuallyLarge = median !== null && row.amount >= 100 && row.amount >= 3 * median;
    return Object.assign({}, row, { typical_purchase: median === null ? null : monthlyCents(median), history_count: sample.length,
      without_purchase: without, category_target: category ? category.target : null,
      explains_overrun: explainsOverrun, unusually_large: unusuallyLarge,
      contributes_overrun: !!(category && category.reconciled && category.variance > 0 && row.amount >= 100),
      category_overrun: category ? Math.max(0, category.variance) : 0 });
  }).filter(row => row.explains_overrun || row.unusually_large || row.contributes_overrun)
    .sort((a, b) => Math.min(b.amount, b.category_overrun) - Math.min(a.amount, a.category_overrun) || b.amount - a.amount || a.row - b.row);
  const leadingCategory = overs.length ? overs[0].name : null;
  const primary = candidates.find(row => row.category === leadingCategory) || candidates[0];
  const second = candidates.find(row => row !== primary && row.explains_overrun) || candidates.find(row => row !== primary);
  const purchases = [primary, second].filter(Boolean);
  overs.forEach(category => { category.threshold_transactions = monthlyThresholdTransactions(category, current); });
  const recommendations = buildMonthlyTargetRecommendations(categories, transactions, history);
  return { version: 2, ordinary_total: ordinaryTotal, ordinary_plan: ordinaryPlan,
    ordinary_variance: ordinaryPlan.amount === null ? null : monthlyCents(ordinaryTotal - ordinaryPlan.amount),
    over_drivers: overs, discipline: unders.slice(0, 1), purchases: purchases,
    history: { months: history.months.map(month => month.month), unavailable: history.unavailable,
      ordinary_median: history.months.length >= 3 ? monthlyCents(calendarMedian(history.months.map(month => month.ordinary))) : null },
    recommendations: recommendations };
}

function buildMonthlyReview(ss, reportDate, budget, plans) {
  const transactions = readMonthlyReviewTransactions(ss, reportDate);
  const history = readMonthlyReviewHistory(ss, reportDate, transactions);
  const sheet = ss.getSheetByName(getCurrentMonthTabName(reportDate));
  const plan = readMonthlyContextAmount(sheet, SHEET_FACTS.MONTHLY_TAB_STRUCTURE.ORDINARY_MONTHLY_BUDGET_CELL);
  const review = analyzeMonthlyReview(transactions, reportDate, budget, history, plan, plans);
  review.allocations = readMonthlyAllocationTotal(ss, reportDate);
  review.income = readMonthlyContextAmount(sheet, SHEET_FACTS.MONTHLY_TAB_STRUCTURE.MONTHLY_INCOME_CELL);
  review.reserved = readMonthlyContextAmount(sheet, SHEET_FACTS.MONTHLY_TAB_STRUCTURE.MANDATORY_TOTAL_CELL);
  return review;
}

/** A readable review assembled from checked evidence, with no invented model claims. */
function renderMonthlyReview(payload) {
  const review = payload.monthly_review, money = monthlyMoney, html = escapeCoachHtml;
  const paragraphs = [];
  const variance = review.ordinary_variance;
  let opening = '<b>' + html(payload.month_tab) + '</b> — Расходы finished at <b>' + money(review.ordinary_total) + '</b>';
  if (variance !== null) {
    opening += ' against the ' + money(review.ordinary_plan.amount) + ' available after planned commitments: ' +
      (variance === 0 ? 'right on plan.' : '<b>' + money(Math.abs(variance)) + ' ' + (variance > 0 ? 'over' : 'under') + '</b>.');
  } else opening += '; the monthly spending pot could not be read, so I can’t judge the overall spending variance.';
  paragraphs.push(opening);
  paragraphs.push('• Transaction lists reserve the month’s mandatory payments first, then follow Расходы by date (ledger order within a day). Refunds reduce the running total; listed charges may be partly offset later.');
  const savings = payload.buckets.savings;
  let overall = review.allocations ? 'Across the whole 50/30/20 plan, recorded allocations were ' + money(review.allocations.actual) +
    ' against ' + money(review.allocations.target) + '. ' : 'The sheet’s overall allocation total is unavailable. ';
  overall += 'Savings landed at ' + money(savings.actual) + ' against ' + money(savings.target) +
    (savings.actual < savings.target ? '—so lower allocations elsewhere aren’t automatically a win: the saving goal wasn’t met.' : ', meeting the saving target.');
  paragraphs.push('• ' + overall);
  if (review.over_drivers.length) {
    paragraphs.push('<b>What drove the overruns:</b>\n' + review.over_drivers.map(renderMonthlyOverrun).join('\n\n'));
  } else paragraphs.push('No category exceeded the available category targets; that alone does not prove the overall spending pot was respected.');
  if (review.discipline.length) {
    const item = review.discipline[0];
    paragraphs.push('• A good sign of restraint: <b>' + html(item.name) + '</b> stayed at ' + money(item.actual) + ' against ' + money(item.target) +
      ', leaving ' + money(Math.abs(item.variance)) + ' of headroom in the recorded spending.');
  }
  if (review.recommendations.length) {
    paragraphs.push('<b>Category targets for next month:</b>\n' + review.recommendations.map(renderMonthlyTargetRecommendation).join('\n'));
    paragraphs.push('• Fund any increase by reducing another allocation or confirming more available income; these are suggested targets, not changes to the sheet.');
  } else paragraphs.push('<b>For next month:</b> fewer than three reconciled earlier months support a material target change. Keep commitments separate from ordinary spending while checking the history.');
  if (review.history.ordinary_median !== null) paragraphs.push('• For context, Расходы had a median of ' + money(review.history.ordinary_median) +
    ' across ' + review.history.months.length + ' earlier recorded months (' + review.history.months[0] + '–' + review.history.months[review.history.months.length - 1] +
    ').');
  else paragraphs.push('Fewer than three usable earlier months are available; no longer-term spending trend is claimed.');
  paragraphs.push('<i>Target basis: ' + html(payload.target_header) + '; historical comparisons use this current basis, not archived targets. Mandatory plan: ' + payload.mandatory_summary.paid + ' paid, ' + payload.mandatory_summary.unpaid + ' unpaid; unpaid commitments are not savings.</i>');
  return paragraphs.join('\n\n');
}

/** Reserve the target for mandatory payments first; assign the remaining gap to ordinary spend. */
function classifyMonthlyOverrun(category) {
  if (!category.reconciled || category.target < 0 || category.committed < 0 || category.ordinary < 0) {
    return { driver: 'unresolved', structural_gap: null, ordinary_gap: null };
  }
  const over = Math.max(0, category.variance);
  const structural = Math.min(over, Math.max(0, category.committed - category.target));
  return { driver: structural > 0 ? (category.ordinary > 0 ? 'mixed_structural' : 'structural') : 'ordinary',
    structural_gap: monthlyCents(structural), ordinary_gap: monthlyCents(over - structural) };
}

/** Each crossing and subsequent positive charge is included; no size floor or top-N cap. */
function monthlyThresholdTransactions(category, transactions) {
  if (category.driver === 'unresolved') return [];
  const allowance = Math.round(Math.max(0, category.target - category.committed) * 100);
  let running = 0;
  return transactions.filter(row => row.type === TRANSACTION_TYPES.EXPENSE &&
    mandatoryLabelKey(row.category) === mandatoryLabelKey(category.name))
    .slice().sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row).reduce((selected, row) => {
      const before = running;
      running += Math.round(row.amount * 100);
      if (row.amount > 0 && running > allowance) selected.push(Object.assign({}, row, {
        crossing: before <= allowance, running_total: running / 100,
        over_target_portion: (Math.max(0, running - allowance) - Math.max(0, before - allowance)) / 100
      }));
      return selected;
    }, []);
}

function renderMonthlyOverrun(item) {
  const money = monthlyMoney;
  const lines = ['<b>' + escapeCoachHtml(item.name) + '</b> — ' + money(item.variance) + ' over the ' + money(item.target) + ' target.'];
  if (item.driver === 'unresolved') return lines[0] + '\n• Ledger split unavailable; reconcile this category before attributing transactions.';
  lines.push('• Обязательные расходы: ' + money(item.committed) + (item.structural_gap > 0 ? ' — already ' + money(item.structural_gap) + ' above the target; structural shortfall.' : '.'));
  lines.push('• Расходы: ' + money(item.ordinary) + ' (' + money(Math.max(0, item.target - item.committed)) +
    ' available after mandatory payments; ' + money(item.ordinary_gap) + ' over that allowance).');
  if (item.threshold_transactions.length) {
    lines.push('• <b>Worth a second look — transactions crossing or adding to the overrun:</b>');
    const transactions = item.threshold_transactions;
    const detailed = transactions.length > 3 ? transactions.slice(0, 1) : transactions;
    detailed.forEach(row => lines.push('  ◦ ' + escapeCoachHtml(row.merchant) + ' on ' + row.date +
      ' (' + escapeCoachHtml(row.account) + '), ' + money(row.amount) +
      (row.crossing ? ' — crossed the allowance; ' + money(row.over_target_portion) + ' of this charge was over it.' : '.')));
    if (transactions.length > 3) {
      const remaining = transactions.slice(1);
      const total = monthlyCents(remaining.reduce((sum, row) => sum + row.amount, 0));
      const firstDate = remaining[0].date;
      const lastDate = remaining[remaining.length - 1].date;
      lines.push('  ◦ After that: ' + remaining.length + ' further charges totaling ' + money(total) +
        ' (' + (firstDate === lastDate ? firstDate : firstDate + '–' + lastDate) +
        ') crossed or added to the overrun. This is the full charge total before refunds, not the net budget gap.');
    }
  } else lines.push('• No ordinary transaction crossed the allowance; the gap is driven by mandatory payments.');
  return lines.join('\n');
}

/** Separate medians use the same reconciled historical months, including genuine zero components. */
function buildMonthlyTargetRecommendations(categories, transactions, history) {
  return categories.filter(category => category.reconciled && category.target >= 0 && category.variance > 0 && category.committed >= 0 && category.ordinary >= 0).map(category => {
    const observations = history.months.map(month => {
      const source = month.categories.find(item => mandatoryLabelKey(item.name) === mandatoryLabelKey(category.name));
      if (!source || source.actual_available === false) return null;
      const rows = transactions.filter(row => row.monthIndex === month.monthIndex && mandatoryLabelKey(row.category) === mandatoryLabelKey(category.name));
      const ordinary = monthlyCents(rows.filter(row => row.type === TRANSACTION_TYPES.EXPENSE).reduce((total, row) => total + row.amount, 0));
      const committed = monthlyCents(rows.filter(row => row.type === TRANSACTION_TYPES.FIXED_EXPENSE).reduce((total, row) => total + row.amount, 0));
      if (ordinary < 0 || committed < 0 || Math.abs(ordinary + committed - source.actual) > 0.02) return null;
      return { ordinary: ordinary, committed: committed, total: monthlyCents(source.actual), month: month.month };
    }).filter(Boolean);
    if (observations.length < 3) return null;
    const mandatoryBaseline = monthlyCents(calendarMedian(observations.map(row => row.committed)));
    const ordinaryBaseline = monthlyCents(calendarMedian(observations.map(row => row.ordinary)));
    // This is a sum of component medians, not a claim about the median total.
    const baseline = monthlyCents(mandatoryBaseline + ordinaryBaseline);
    const above = observations.filter(row => row.total > category.target).length;
    const material = baseline - category.target >= Math.max(100, category.target * 0.2);
    const recurring = above / observations.length >= 2 / 3 && material;
    const commitmentChanged = Math.abs(category.committed - mandatoryBaseline) >= Math.max(100, mandatoryBaseline * 0.25);
    if (!recurring && above !== 0 && !commitmentChanged) return null;
    return { name: category.name, current_target: category.target, current_variance: category.variance,
      kind: commitmentChanged ? 'changed_commitment' : recurring ? 'recurring' : 'one_off', months: observations.map(row => row.month),
      above_current_target: above, mandatory_baseline: mandatoryBaseline, ordinary_baseline: ordinaryBaseline,
      current_mandatory: category.committed,
      suggested_target: commitmentChanged ? monthlyCents(category.committed + ordinaryBaseline) : recurring ? baseline : category.target,
      structural: mandatoryBaseline > category.target || category.committed > category.target };
  }).filter(Boolean).sort((a, b) => Number(b.structural) - Number(a.structural) ||
    Number(b.kind !== 'one_off') - Number(a.kind !== 'one_off') || b.current_variance - a.current_variance).slice(0, 3);
}

function renderMonthlyTargetRecommendation(item) {
  const money = monthlyMoney;
  const lines = ['<b>' + escapeCoachHtml(item.name) + '</b>',
    '• History: ' + item.months.length + ' reconciled months (' + item.months[0] + '–' + item.months[item.months.length - 1] + ').',
    '• Typical Обязательные расходы: ' + money(item.mandatory_baseline) + '; Расходы: ' + money(item.ordinary_baseline) + ' (separate medians).'];
  if (item.kind === 'changed_commitment') {
    lines.push('• If this new level is confirmed: ' + money(item.suggested_target) + ' target = ' + money(item.current_mandatory) + ' current commitments + ' + money(item.ordinary_baseline) + ' ordinary allowance.');
    lines.push('• Mandatory payments changed from the historical baseline; confirm upcoming bills and payment timing first.');
  } else if (item.kind === 'one_off') {
    lines.push('• Keep the ' + money(item.current_target) + ' target for now; earlier months fit it. Check this month’s exceptions.');
  } else {
    lines.push('• Suggested target: ' + money(item.current_target) + ' → ' + money(item.suggested_target) + ' = ' + money(item.mandatory_baseline) + ' commitments + ' + money(item.ordinary_baseline) + ' ordinary allowance.');
    lines.push('• ' + (item.structural ? 'Confirm the higher commitment floor before changing the plan.' : 'Review the ordinary allowance for spending adjustments.'));
  }
  return lines.join('\n');
}

/** Split a complete review without dropping categories or transactions. Every line has closed HTML tags. */
function splitMonthlyReview(text) {
  const limit = 2500, parts = [];
  let current = '';
  String(text).split('\n').forEach(line => {
    const lines = line.length <= limit ? [line] : Array.from(monthlyCoachPlainText(line) || line)
      .reduce((chunks, character, index) => { if (index % 500 === 0) chunks.push(''); chunks[chunks.length - 1] += character; return chunks; }, [])
      .map(escapeCoachHtml);
    lines.forEach(piece => {
      if (current.length + piece.length + 1 > limit) { parts.push(current); current = ''; }
      current += (current ? '\n' : '') + piece;
    });
  });
  if (current) parts.push(current);
  return parts;
}
