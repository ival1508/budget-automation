/** Settlement cash coverage: checked Sheet calculation and deterministic daily output. */
const CASH_COVERAGE_SHEET = 'CashCoverage';
const CASH_COVERAGE_VERSION = 'cash_coverage_v2';
const CASH_COVERAGE_FIRST_RULE = 14;
const CASH_COVERAGE_LAST_RULE = 24;

function cashCoverageSheetRef(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "'" + String(name).replace(/'/g, "''") + "'";
}

/** Apps Script may normalize separators/case; preserve quoted formula text exactly. */
function cashCoverageFormulaIdentity(formula) {
  let quoted = false, result = '';
  const text = String(formula || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!quoted && ch === "'") {
      const ref = text.slice(i).match(/^'([A-Za-z_][A-Za-z0-9_]*)'!/);
      if (ref) { result += ref[1].toLowerCase() + '!'; i += ref[0].length - 1; continue; }
    }
    if (ch === '"') {
      result += ch;
      if (quoted && text[i + 1] === '"') { result += '"'; i++; }
      else quoted = !quoted;
    } else if (quoted) result += ch;
    else if (!/\s/.test(ch)) result += ch === ',' ? ';' : ch.toLowerCase();
  }
  return result;
}

/** Native month selection follows TODAY in the workbook's verified SGT-equivalent timezone. */
function buildCashCoverageMonthFormula() {
  const quote = value => '"' + value.replace(/"/g, '""') + '"';
  const fullNames = MONTH_CREATION_NAMES.map(quote).join(';');
  const legacyNames = MONTH_CREATION_NAMES.map((name, i) => quote(i < 4 ? ['Я', 'Ф', 'М', 'А'][i] : name)).join(';');
  const ref = name => '"\'"&SUBSTITUTE(' + name + ';"\'";"\'\'")&"\'!B1"';
  return '=LET(first;$B$3;modern;CHOOSE(MONTH(first);' + fullNames + ');' +
    'legacy;CHOOSE(MONTH(first);' + legacyNames + ')&"\'"&TEXT(first;"yy");' +
    'oldexists;IFERROR(ISREF(INDIRECT(' + ref('legacy') + '));FALSE);' +
    'newexists;IFERROR(ISREF(INDIRECT(' + ref('modern') + '));FALSE);' +
    'source;IF(oldexists;legacy;modern);' +
    'IF(oldexists+newexists<>1;NA();IF(INDIRECT(' + ref('source') + ')=first;source;NA())))';
}

function buildCashCoverageFormula() {
  const config = cashCoverageSheetRef(CASH_COVERAGE_SHEET);
  return '=LET(' + CASH_COVERAGE_VERSION + ';1;values;' + config + '!B4:B7;' +
    'IF(AND(' + config + '!B10="' + CASH_COVERAGE_VERSION + '";COUNT(values)=4;' + config + '!B6>=0);' +
    'ROUND(' + config + '!B7-' + config + '!B6;2);NA()))';
}

function cashCoverageRuleFormulas(row) {
  const planRow = row - CASH_COVERAGE_FIRST_RULE + 3;
  const source = '"\'"&SUBSTITUTE($B$2;"\'";"\'\'")&"\'!"';
  const labels = 'INDIRECT(' + source + '&"D3:D13")';
  const label = '=INDIRECT(' + source + '&"D' + planRow + '")';
  const basis = '=IF(A' + row + '="CPF";"Non-cash / excluded";IF(A' + row + '="Родители";"Category or [Родители] tag";"Exact category"))';
  const planned = '=IF(OR(A' + row + '="";COUNTIF(' + labels + ';A' + row + ')<>1);NA();' +
    'LET(amount;INDIRECT(' + source + '&"E' + planRow + '");IF(AND(ISNUMBER(amount);amount>=0);amount;NA())))';
  const column = name => 'Transactions!$' + name + '$2:INDEX(Transactions!$' + name + ':$' + name + ';ROWS(Transactions!$A:$A))';
  const logged = '=IF(A' + row + '="CPF";0;LET(dates;' + column('A') + ';types;' + column('C') +
    ';amounts;' + column('E') + ';categories;' + column('H') + ';merchants;' + column('I') + ';' +
    'parents;ARRAYFORMULA(REGEXMATCH(merchants&"";"(?i)^\\[Родители\\](\\s|$)"));' +
    'matches;ARRAYFORMULA(IF(A' + row + '="Родители";((categories=A' + row + ')+parents)>0;(categories=A' + row + ')*(1-parents)));' +
    'identity;ARRAYFORMULA((types="Обязательные расходы")*matches);' +
    'selected;ARRAYFORMULA(identity*(dates>=$B$3)*(dates<EDATE($B$3;1))*(dates<TODAY()+1));' +
    'bad;SUM(ARRAYFORMULA(identity*(1-ISNUMBER(dates))))+SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))));' +
    'IF(bad>0;NA();ROUND(SUM(ARRAYFORMULA(IF(selected;amounts;0)));2))))';
  const unpaid = '=IF(A' + row + '="CPF";0;IF(COUNT(C' + row + ':D' + row + ')=2;MAX(0;ROUND(C' + row + '-D' + row + ';2));NA()))';
  return [label, basis, planned, logged, unpaid, ''];
}

/** Received regular payroll funds the following budget month, matching Stage 6. */
function buildCashCoverageNextMonthIncomeFormula() {
  const column = name => 'Transactions!$' + name + '$2:INDEX(Transactions!$' + name + ':$' + name + ';ROWS(Transactions!$A:$A))';
  return '=LET(dates;' + column('A') + ';accounts;' + column('B') + ';types;' + column('C') +
    ';amounts;' + column('E') + ';sources;' + column('I') + ';' +
    'google;ARRAYFORMULA(REGEXMATCH(LOWER(sources&"");"\\bgoogle\\b"));' +
    'kaspersky;ARRAYFORMULA(REGEXMATCH(LOWER(sources&"");"\\bkaspersky\\b"));' +
    'identity;ARRAYFORMULA((LOWER(TRIM(types))="доходы")*(LOWER(TRIM(accounts))="dbs sgd")*((google+kaspersky)>0));' +
    'selected;ARRAYFORMULA(identity*(dates>=$B$3)*(dates<EDATE($B$3;1))*(dates<TODAY()+1));' +
    'bad;SUM(ARRAYFORMULA(identity*(1-ISNUMBER(dates))))+SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))))+' +
    'SUM(ARRAYFORMULA(selected*google*kaspersky));' +
    'total;SUM(ARRAYFORMULA(IF(selected;amounts;0)));IF(OR(bad>0;total<0);NA();ROUND(total;2)))';
}

function calculateNextMonthIncomeReserve(ledger, asOf) {
  const anchor = calendarDateParts(asOf);
  let cents = 0;
  ledger.forEach(row => {
    if (calendarText(row[2]).toLowerCase() !== 'доходы' || calendarText(row[1]).toLowerCase() !== 'dbs sgd') return;
    const source = calendarText(row[8]);
    const google = /\bgoogle\b/i.test(source), kaspersky = /\bkaspersky\b/i.test(source);
    if (!google && !kaspersky) return;
    const date = calendarDateParts(row[0]);
    if (date.monthIndex !== anchor.monthIndex || date.day > anchor.day) return;
    if (google && kaspersky) throw new Error('Ambiguous payroll source.');
    const amount = row[4];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100))) throw new Error('Unreadable received payroll amount.');
    cents += Math.round(amount * 100);
  });
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Invalid next-month income reserve.');
  return cents / 100;
}

/** Values beginning with '=' are intentional native formulas; rollback is inert JSON. */
function buildCashCoverageRows(previousFormula) {
  const row = (key, value, note) => [key, value, note || '', '', '', ''];
  const rows = [row('Settlement coverage', 'Value', 'What it covers'),
    row('Budget month', buildCashCoverageMonthFormula(), 'Uses the current Singapore calendar month, even when next month is prepared early.'),
    row('Month begins', '=DATE(YEAR(TODAY());MONTH(TODAY());1)', 'Singapore calendar date.'),
    row('Pending mandatory costs', '=IF(COUNT(E14:E24)=11;SUM(E14:E24);NA())', 'All current-month mandatory plans less net logged payments. CPF is excluded from cash commitments.'),
    row('Remaining Расходы budget', '=LET(value;INDIRECT("\'"&SUBSTITUTE(B2;"\'";"\'\'")&"\'!L33");IF(ISNUMBER(value);MAX(0;value);NA()))', 'Remaining ordinary spending reserve. Overspend is already reflected in bank/card balances; it cannot create available cash.'),
    row('Total cash required / reserved', '=IF(COUNT(B4:B5;B25)=3;SUM(B4:B5;B25);NA())', 'Pending current-month costs plus salary already assigned to next month.'),
    row('Recorded cash after cards', '=IF(AND(Summary!A2="Citibank CC";Summary!A3="DBS CC SGD";Summary!A4="DBS SGD";COUNT(Summary!D2:D4)=3);SUM(Summary!D2:D4);NA())', 'Latest DBS cash plus signed card balances. Received payroll reserved below is not free current-month funding.'),
    row('As of', '=TODAY()', 'Recalculates when recorded balances, plans and payments change.'),
    row('Coverage period', 'Current month; next-month funding protected', 'Regular payroll received this month funds next month, matching the monthly salary policy. Unreceived income is excluded.'),
    row('contract', CASH_COVERAGE_VERSION, 'Managed formula contract.'),
    row('previous_e4', JSON.stringify({ formula: previousFormula }), 'Original E4 formula; rollback evidence only.'),
    row('Coverage after commitments', '=Summary!E4', 'Positive: buffer after commitments. Negative: funding or a transfer is needed.'),
    ['Обязательные расходы', 'Payment basis', 'Planned SGD', 'Logged SGD', 'Unpaid SGD', 'Notes']];
  for (let r = CASH_COVERAGE_FIRST_RULE; r <= CASH_COVERAGE_LAST_RULE; r++) {
    rows.push(cashCoverageRuleFormulas(r));
  }
  rows.push(row('Salary reserved for next month', buildCashCoverageNextMonthIncomeFormula(),
    'Actual regular Google/Kaspersky payroll credited to DBS this month, through today. Becomes available at next month rollover. No employer CPF or forecast income.'));
  return rows;
}

/** Recognize only the audited legacy shape; never infer reserves from arbitrary owner formulas. */
function inspectLegacyCashCoverageFormula(formula, monthTab) {
  const ref = cashCoverageSheetRef(monthTab) + '!';
  const normalized = String(formula || '').split(ref).join('MONTH!').replace(/\s/g, '').replace(/,/g, '.');
  const number = '(\\d+(?:\\.\\d+)?)';
  const pattern = new RegExp('^=D4-\\(-D2-D3\\+\\(MONTH!E6-' + number + '\\)\\+MONTH!E7-' + number +
    '\\+' + number + '\\+' + number + '\\+MONTH!E12\\+MONTH!L33\\+' + number + '\\)$');
  const match = normalized.match(pattern);
  if (!match) throw new Error('Unrecognized E4 formula. Review its components before installing cash coverage.');
  return { extra_reserve_sgd: Number(match[5]), prior_paid_adjustments: [Number(match[1]), Number(match[2])],
    prior_school_reserves: [Number(match[3]), Number(match[4])] };
}

/** Pure comparison/preview arithmetic. Ledger rows are A:I values, plans are D:E. */
function calculateCashCoverage(snapshot) {
  const anchor = calendarDateParts(snapshot.asOf);
  const cents = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 100))) throw new Error('Unreadable cash-coverage input.');
    return Math.round(value * 100);
  };
  const categories = snapshot.plans.map(row => row[0]).filter(label => label !== 'CPF');
  const selected = new Set(categories);
  if (selected.size !== categories.length || selected.has('')) throw new Error('Missing or duplicate monthly plan label.');
  const components = Array.from(selected, category => {
    const plans = snapshot.plans.filter(row => row[0] === category);
    if (plans.length !== 1) throw new Error('Missing or duplicate monthly plan for ' + category);
    const planned = cents(plans[0][1]);
    if (planned < 0) throw new Error('Negative monthly plan.');
    let paid = 0;
    snapshot.ledger.forEach(row => {
      const parents = /^\[Родители\](\s|$)/i.test(String(row[8] || ''));
      const matches = category === 'Родители' ? row[7] === category || parents : row[7] === category && !parents;
      if (row[2] !== 'Обязательные расходы' || !matches) return;
      const date = calendarDateParts(row[0]);
      if (date.monthIndex === anchor.monthIndex && date.day <= anchor.day) paid += cents(row[4]);
    });
    return { category: category, planned_sgd: planned / 100, logged_sgd: paid / 100, unpaid_sgd: Math.max(0, planned - paid) / 100 };
  });
  const cash = snapshot.balances.reduce((sum, value) => sum + cents(value), 0);
  const ordinary = Math.max(0, cents(snapshot.ordinarySgd));
  const unpaid = components.reduce((sum, entry) => sum + cents(entry.unpaid_sgd), 0);
  const nextMonth = cents(calculateNextMonthIncomeReserve(snapshot.ledger, snapshot.asOf));
  const amount = cash - ordinary - unpaid - nextMonth;
  if (!Number.isSafeInteger(amount)) throw new Error('Cash coverage exceeds the supported amount range.');
  return { amount_sgd: amount / 100, components: components, required_cash_sgd: (ordinary + unpaid + nextMonth) / 100,
    reserved_next_month_income_sgd: nextMonth / 100,
    remaining_ordinary_budget_sgd: ordinary / 100, cash_after_cards_sgd: cash / 100 };
}

function previewCashCoverageSetup(optSs, optAsOf) {
  const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
  const now = optAsOf instanceof Date ? optAsOf : new Date();
  if (!ss || !['Asia/Singapore', 'Asia/Kuala_Lumpur'].includes(ss.getSpreadsheetTimeZone())) throw new Error('Cash coverage requires an SGT-equivalent workbook timezone.');
  const month = resolveMonthSheet(ss, now);
  if (!month.sheet) throw new Error('Current month is missing.');
  const start = monthCreationAnchor(month.sheet.getRange('B1').getValue());
  if (start.day !== 1 || start.year !== Number(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy')) ||
      start.month !== Number(Utilities.formatDate(now, 'Asia/Singapore', 'M'))) throw new Error('Current month B1 mismatch.');
  const summary = ss.getSheetByName('Summary');
  if (!summary) throw new Error('Summary is missing.');
  const previousFormula = summary.getRange('E4').getFormula();
  if (cashCoverageFormulaIdentity(previousFormula) === cashCoverageFormulaIdentity(buildCashCoverageFormula())) return { status: 'installed', coverage: readCashCoverage(ss, now) };
  if (ss.getSheetByName(CASH_COVERAGE_SHEET)) throw new Error('CashCoverage already exists; existing content was preserved.');
  if (JSON.stringify(summary.getRange('A2:A4').getValues().map(row => row[0])) !== JSON.stringify(['Citibank CC', 'DBS CC SGD', 'DBS SGD'])) {
    throw new Error('Summary account rows changed; review their identities before installation.');
  }
  const audit = inspectLegacyCashCoverageFormula(previousFormula, month.tabName);
  const ledger = ss.getSheetByName('Transactions');
  if (!ledger) throw new Error('Transactions is missing.');
  const result = calculateCashCoverage({ asOf: now, balances: summary.getRange('D2:D4').getValues().map(row => row[0]),
    ordinarySgd: month.sheet.getRange('L33').getValue(),
    plans: month.sheet.getRange('D3:E13').getValues(),
    ledger: ledger.getLastRow() < 2 ? [] : ledger.getRange(2, 1, ledger.getLastRow() - 1, 9).getValues() });
  const previous = summary.getRange('E4').getValue();
  if (typeof previous !== 'number' || !Number.isFinite(previous)) throw new Error('Existing E4 is unavailable; resolve it before migration.');
  return { status: 'preview', month_tab: month.tabName, previous_formula: previousFormula, previous_amount_sgd: Number(previous.toFixed(2)),
    proposed: result, difference_sgd: Number((result.amount_sgd - previous).toFixed(2)), audit: audit,
    formula: buildCashCoverageFormula(), rows: buildCashCoverageRows(previousFormula) };
}

/** Explicit installation only; daily and historical reads never write. */
function installCashCoverage(optSs) {
  return withBudgetWriteLock(() => {
    const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
    const plan = previewCashCoverageSetup(ss);
    if (plan.status === 'installed') return plan;
    const summary = ss.getSheetByName('Summary');
    let config = null, changed = false;
    try {
      config = ss.insertSheet(CASH_COVERAGE_SHEET);
      config.getRange(1, 1, plan.rows.length, 6).setValues(plan.rows);
      config.getRange('B3').setNumberFormat('dd.mm.yyyy');
      config.getRange('B8').setNumberFormat('dd.mm.yyyy');
      config.getRange('B4:B7').setNumberFormat('"S$"#,##0.00;"-S$"#,##0.00');
      config.getRange('C14:E24').setNumberFormat('"S$"#,##0.00;"-S$"#,##0.00');
      config.setFrozenRows(1);
      config.setColumnWidth(1, 245); config.setColumnWidth(2, 165);
      config.setColumnWidths(3, 3, 155); config.setColumnWidth(6, 360);
      config.getRange('A1:F25').setWrap(true);
      config.getRange('C1:F12').mergeAcross();
      config.getRange('C25:F25').mergeAcross();
      config.getRange('B25').setNumberFormat('"S$"#,##0.00;"-S$"#,##0.00');
      config.hideRows(10, 2);
      config.getRange('B12').setNumberFormat('"S$"#,##0.00;"-S$"#,##0.00');
      config.getRange('A12:F12').setFontWeight('bold');
      config.getRange('A1:F1').setFontWeight('bold'); config.getRange('A13:F13').setFontWeight('bold');
      SpreadsheetApp.flush();
      if (summary.getRange('E4').getFormula() !== plan.previous_formula) throw new Error('E4 changed during installation.');
      summary.getRange('E4').setFormula(plan.formula); changed = true;
      SpreadsheetApp.flush();
      const coverage = readCashCoverage(ss);
      if (coverage.status !== 'available' || Math.abs(coverage.amount_sgd - plan.proposed.amount_sgd) > 0.01) throw new Error('Native coverage verification failed; original formula restored.');
      return { status: 'installed', coverage: coverage, difference_sgd: plan.difference_sgd };
    } catch (error) {
      const managed = cashCoverageFormulaIdentity(summary.getRange('E4').getFormula()) === cashCoverageFormulaIdentity(plan.formula);
      if (changed && managed) summary.getRange('E4').setFormula(plan.previous_formula);
      if (config && (!changed || managed)) ss.deleteSheet(config);
      throw error;
    }
  });
}

function showCashCoveragePreview() {
  const plan = previewCashCoverageSetup();
  const text = plan.status === 'installed' ? JSON.stringify(plan.coverage, null, 2) :
    'Current: S$' + plan.previous_amount_sgd.toFixed(2) + '\nProposed: S$' + plan.proposed.amount_sgd.toFixed(2) +
    '\nChange: S$' + plan.difference_sgd.toFixed(2) + '\n\n' +
    plan.proposed.components.map(item => item.category + ': planned S$' + item.planned_sgd.toFixed(2) +
      ', logged S$' + item.logged_sgd.toFixed(2) + ', unpaid S$' + item.unpaid_sgd.toFixed(2)).join('\n') +
    '\n\nRequired settlement cash: S$' + plan.proposed.required_cash_sgd.toFixed(2) +
    '\nReceived payroll reserved for next month: S$' + plan.proposed.reserved_next_month_income_sgd.toFixed(2) +
    '. Unreceived income is excluded.';
  SpreadsheetApp.getUi().alert('Settlement coverage — read-only preview', text, SpreadsheetApp.getUi().ButtonSet.OK);
  return plan;
}

function installCashCoverageFromMenu() {
  const result = installCashCoverage();
  SpreadsheetApp.getUi().alert('Settlement coverage', JSON.stringify(result.coverage, null, 2), SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}

/** Read-only. Never install formulas, create months, or turn unavailable cash into zero. */
function readCashCoverage(optSs, optAsOf) {
  const asOf = optAsOf instanceof Date ? optAsOf : new Date();
  const result = { amount_sgd: null, as_of: asOf.toISOString(), month_tab: null,
    source: 'Summary!E4', status: 'unavailable', reserved_next_month_income_sgd: null };
  try {
    const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('No spreadsheet is available.');
    const month = resolveMonthSheet(ss, asOf);
    if (!month.sheet) throw new Error('The current month tab is missing.');
    result.month_tab = month.tabName;
    const start = monthCreationAnchor(month.sheet.getRange('B1').getValue());
    if (start.day !== 1 || start.year !== Number(Utilities.formatDate(asOf, 'Asia/Singapore', 'yyyy')) ||
        start.month !== Number(Utilities.formatDate(asOf, 'Asia/Singapore', 'M'))) {
      throw new Error('The current month tab date does not match.');
    }
    const summary = ss.getSheetByName('Summary');
    const config = ss.getSheetByName(CASH_COVERAGE_SHEET);
    if (!summary || !config) throw new Error('Cash coverage has not been configured.');
    if (!['Asia/Singapore', 'Asia/Kuala_Lumpur'].includes(ss.getSpreadsheetTimeZone())) throw new Error('Cash coverage timezone is not SGT-equivalent.');
    const expectedRows = buildCashCoverageRows('');
    const actualFormulas = config.getRange('A1:F25').getFormulas();
    expectedRows.forEach((row, r) => row.forEach((value, col) => {
      if (typeof value === 'string' && value[0] === '=' && cashCoverageFormulaIdentity((actualFormulas[r] || [])[col]) !== cashCoverageFormulaIdentity(value)) {
        throw new Error('A managed cash-coverage formula changed; review the calculation.');
      }
    }));
    const formula = summary.getRange('E4').getFormula();
    if (cashCoverageFormulaIdentity(formula) !== cashCoverageFormulaIdentity(buildCashCoverageFormula())) throw new Error('Summary!E4 does not use the verified coverage formula.');
    const selected = config.getRange('B2').getValue();
    if (selected !== month.tabName) throw new Error('Cash coverage is not using the current month.');
    const readDay = monthCreationAnchor(config.getRange('B8').getValue());
    const currentDay = calendarDateParts(asOf);
    if (readDay.year !== currentDay.year || readDay.month !== currentDay.month || readDay.day !== currentDay.day) throw new Error('Cash coverage has not recalculated for today.');
    const value = summary.getRange('E4').getValue();
    const reserved = config.getRange('B25').getValue();
    if (typeof reserved !== 'number' || !Number.isFinite(reserved) || reserved < 0) throw new Error('Next-month income reserve is unavailable.');
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 100))) {
      throw new Error('Summary!E4 is blank or contains an unreadable amount.');
    }
    result.amount_sgd = Number(value.toFixed(2));
    result.reserved_next_month_income_sgd = Number(reserved.toFixed(2));
    result.status = 'available';
  } catch (error) {
    result.reason = error.message;
  }
  return result;
}

/** Coverage is rendered in code; the language model never assigns it to a spending allowance. */
function appendDailyCashCoverage(brief, payload) {
  if (!payload || payload.period === 'monthly' || !Object.prototype.hasOwnProperty.call(payload, 'cash_coverage')) return brief;
  const coverage = payload.cash_coverage;
  const available = coverage && coverage.status === 'available' &&
    typeof coverage.amount_sgd === 'number' && Number.isFinite(coverage.amount_sgd);
  const amount = available ? coverage.amount_sgd : null;
  const money = available ? 'S$' + Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  const line = !available ? '• <b>Settlement:</b> Coverage unavailable; check Summary.' : amount < 0
    ? '• <b>Settlement:</b> <b>' + money + '</b> shortfall; ' +
      (coverage.reserved_next_month_income_sgd > 0 ? "next month's salary remains reserved." : 'funding or a transfer is needed.')
    : amount === 0 ? '• <b>Settlement:</b> Fully allocated, with <b>S$0.00</b> coverage buffer.'
      : '• <b>Settlement:</b> <b>' + money + '</b> available after reserved commitments.';
  const lines = String(brief || '').split('\n');
  const action = lines.findIndex(value => /^• <b>Action:<\/b>/.test(value));
  if (action < 0) lines.push(line);
  else {
    if (available && amount < 0) lines[action] = '• <b>Action:</b> Arrange funding or a transfer to cover the settlement shortfall.';
    lines.splice(action, 0, line);
  }
  return lines.filter(Boolean).join('\n');
}
