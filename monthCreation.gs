/** Stage 6B–6C: month creation plans, preview and controlled sandbox-safe creator. */
const MONTH_CREATION_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// Banked salaries are net of CPF; restore both shares before E13 deducts CPF.
const MONTH_CREATION_CPF = Object.freeze({
  Google: { wageBase: 8000, employerPercent: 17, employeePercent: 20 },
  Kaspersky: { wageBase: 8000, employerPercent: 9, employeePercent: 15 }
});
const MONTH_CREATION_CPF_YEAR3 = Object.freeze({
  Google: { wageBase: 8000, employerPercent: 17, employeePercent: 20 },
  Kaspersky: { wageBase: 8000, employerPercent: 17, employeePercent: 20 }
});
const MONTH_CREATION_CPF_FORMULA_YEAR2 = '=(0.09*8000+0.15*8000)+(0.17*8000+0.2*8000)';
const MONTH_CREATION_CPF_FORMULA_YEAR3 = '=(0.17*8000+0.2*8000)+(0.17*8000+0.2*8000)';

/**
 * Rita steps from Year-2 PR (15% emp + 9% er) to Year-3 PR (20% emp + 17% er)
 * starting with her January 2027 payslip, which funds target months >= 2027-02.
 */
function getMonthCreationCpfConfig(year, month) {
  const isYear3 = Number.isInteger(year) && Number.isInteger(month) &&
    (year > 2027 || (year === 2027 && month >= 2));
  return isYear3 ? MONTH_CREATION_CPF_YEAR3 : MONTH_CREATION_CPF;
}

function getMonthCreationCpfTotalAndFormula(year, month) {
  const isYear3 = Number.isInteger(year) && Number.isInteger(month) &&
    (year > 2027 || (year === 2027 && month >= 2));
  return isYear3
    ? { total: 5920, formula: MONTH_CREATION_CPF_FORMULA_YEAR3, isYear3: true }
    : { total: 4880, formula: MONTH_CREATION_CPF_FORMULA_YEAR2, isYear3: false };
}

function monthCreationPeriod(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Target requires an integer year and month (1–12).');
  }
  const stem = MONTH_CREATION_NAMES[month - 1];
  const name = year >= 2027 ? (stem + "'" + String(year).slice(-2)) : stem;
  return { year: year, month: month, name: name,
    days: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

function monthCreationIdentity(name) {
  const match = /^(.*?)(?:'(\d{2}))?$/.exec(name);
  const stem = match[1];
  let index = MONTH_CREATION_NAMES.indexOf(stem);
  if (index < 0 && match[2]) index = ['Я', 'Ф', 'М', 'А'].indexOf(stem);
  return index < 0 ? null : { month: index + 1, year: match[2] ? 2000 + Number(match[2]) : null };
}

/** Date serials are accepted for connector-backed previews, Dates for Apps Script. */
function monthCreationAnchor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  return calendarDateParts(value);
}

function monthCreationCell(snapshot, row, col, formulas) {
  return ((formulas ? snapshot.formulas : snapshot.values)[row - 1] || [])[col - 1] ?? '';
}

function monthCreationNormalFormula(formula) {
  return String(formula || '').replace(/\s/g, '').replace(/,/g, ';').toUpperCase();
}

function validateMonthCreationTemplate(source) {
  const v = (r, c) => monthCreationCell(source, r, c, false);
  const f = (r, c) => monthCreationCell(source, r, c, true);
  const normal = monthCreationNormalFormula;
  const requireFormula = (r, c, expected) => {
    if (normal(f(r, c)) !== normal(expected)) throw new Error('Unsupported template formula at ' + String.fromCharCode(64 + c) + r);
  };
  if (v(3, 1) !== 'Зарплата В' || v(4, 1) !== 'Зарплата Р' || v(37, 8) !== 'Date Increment' || v(37, 9) !== 'Date in Month') {
    throw new Error('Unsupported month template labels.');
  }
  requireFormula(1, 4, '=EOMONTH(B1;0)');
  requireFormula(38, 8, '=B1');
  requireFormula(2, 11, '=D17');
  requireFormula(14, 2, '=SUM(INDIRECT(ADDRESS(2;COLUMN())&":"&ADDRESS(ROW()-1;COLUMN())))');
  requireFormula(14, 5, '=SUM(INDIRECT(ADDRESS(3;COLUMN())&":"&ADDRESS(ROW()-1;COLUMN())))');
  requireFormula(15, 4, '=B14-E14');
  requireFormula(17, 4, '=D15/(DAYS360(B1;D1)+1)');
  requireFormula(19, 4, '=(L33/(D1-TODAY()+1))');
  requireFormula(33, 10, '=SUM(J2:J32)');
  requireFormula(33, 11, '=K32');
  requireFormula(33, 12, '=L32');
  const cpfFormula = String(f(13, 5)).replace(/\s/g, '').replace(/(\d),(\d)/g, '$1.$2');
  const validYear2Cpf = cpfFormula === MONTH_CREATION_CPF_FORMULA_YEAR2 && v(13, 5) === 4880;
  const validYear3Cpf = cpfFormula === MONTH_CREATION_CPF_FORMULA_YEAR3 && v(13, 5) === 5920;
  if (v(13, 4) !== 'CPF' || (!validYear2Cpf && !validYear3Cpf)) {
    throw new Error('Unsupported CPF plan at E13; review the contribution rates and wage base.');
  }
  let hasDescriptionFormulas = false;
  for (let row = 2; row <= 32; row++) {
    if (f(row, 9)) hasDescriptionFormulas = true;
  }
  const isGeneratedTemplate = hasDescriptionFormulas;
  if (isGeneratedTemplate) {
    requireFormula(38, 9, '=H38<=$D$1');
    requireFormula(6, 2, monthCreationLightIncomeFormula());
  }
  for (let row = 2; row <= 32; row++) {
    requireFormula(row, 8, '=IF(INDIRECT(ADDRESS(ROW()+36; COLUMN()+1));INDIRECT(ADDRESS(ROW()+36; COLUMN())); )');
    requireFormula(row, 10, '=SUMIFS(Transactions!E:E;Transactions!A:A;H' + row + ';Transactions!C:C;"Расходы";Transactions!H:H;"<>Отложения";Transactions!H:H;"<>Аренда")');
    requireFormula(row, 12, '=INDIRECT(ADDRESS(ROW(); COLUMN()-1))-INDIRECT(ADDRESS(ROW(); COLUMN()-2))');
    if (row > 2) requireFormula(row, 11, '=IF(INDIRECT(ADDRESS(ROW()+36; COLUMN()-2)); INDIRECT(ADDRESS(ROW()-1; COLUMN()+1))+D$17; INDIRECT(ADDRESS(ROW()-1; COLUMN()+1)))');
    if (isGeneratedTemplate) {
      if (normal(f(row, 9)) !== normal(monthCreationDescriptionFormula(row)) &&
          normal(f(row, 9)) !== normal(monthCreationLegacyDescriptionFormula(row))) {
        throw new Error('Description formula already exists at I' + row + '; review template version.');
      }
    } else if (f(row, 9)) {
      throw new Error('Description formula already exists at I' + row + '; review template version.');
    }
  }
  for (let row = 39; row <= 68; row++) {
    requireFormula(row, 8, '=INDIRECT(ADDRESS(ROW()-1; COLUMN()))+1');
    requireFormula(row, 9, '=IF(INDIRECT(ADDRESS(ROW(); COLUMN()-1))<=D1; true; false)');
  }
  const categories = new Set();
  for (let row = 3; row <= 13; row++) {
    const label = v(row, 4), amount = v(row, 5), flag = v(row, 7);
    if (!label || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('Invalid mandatory plan at row ' + row);
    const category = mandatoryCategoryForLabel(label);
    if (amount > 0 && category) {
      if (categories.has(category)) throw new Error('Duplicate mandatory category: ' + label);
      categories.add(category);
    }
    if (f(row, 7) || (flag !== '' && typeof flag !== 'boolean')) {
      throw new Error('Unsupported existing G status at row ' + row);
    }
  }
  return true;
}

/** Salary baseline is the preceding calendar month's regular employer income in SGD. */
function buildMonthCreationSalaries(transactions, year, month, template) {
  if (!Array.isArray(transactions)) throw new Error('Transactions salary history is required.');
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const period = monthCreationPeriod(previous.getUTCFullYear(), previous.getUTCMonth() + 1);
  const periodLabel = period.year + '-' + String(period.month).padStart(2, '0');
  const entries = [
    { cell: 'B3', person: 'Валера', employer: 'Google', pattern: /\bgoogle\b/i },
    { cell: 'B4', person: 'Рита', employer: 'Kaspersky', pattern: /\bkaspersky\b/i }
  ].map(entry => ({ ...entry, amount: null, basis: null, transactions: [], errors: [] }));
  transactions.forEach(transaction => {
    if (calendarText(transaction.type).toLowerCase() !== 'доходы') return;
    const source = calendarText(transaction.source);
    const matching = entries.filter(entry => entry.pattern.test(source));
    if (!matching.length) return;
    const fail = message => matching.forEach(entry => entry.errors.push(message + ' at Transactions row ' + transaction.row));
    if (typeof transaction.date !== 'number' && !(transaction.date instanceof Date)) {
      fail('Invalid salary date'); return;
    }
    let date;
    try { date = monthCreationAnchor(transaction.date); }
    catch (_) { fail('Invalid salary date'); return; }
    if (date.year !== period.year || date.month !== period.month) return;
    if (matching.length !== 1) { fail('Ambiguous salary employer'); return; }
    const amount = transaction.amountSgd;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100))) {
      fail('Invalid salary SGD amount'); return;
    }
    matching[0].transactions.push({ row: transaction.row,
      date: periodLabel + '-' + String(date.day).padStart(2, '0'), source: source, amount: amount });
  });
  const blockers = [], warnings = [];
  const cpfConfig = getMonthCreationCpfConfig(year, month);
  const sourceCpfTotal = template ? monthCreationCell(template, 13, 5, false) : null;
  entries.forEach(entry => {
    delete entry.pattern;
    entry.cpf = { ...cpfConfig[entry.employer] };
    entry.cpf.amount = entry.cpf.wageBase * (entry.cpf.employerPercent + entry.cpf.employeePercent) / 100;
    entry.cashAmount = null;
    const templateAmount = template && monthCreationCell(template, Number(entry.cell.slice(1)), 2);
    if (typeof templateAmount === 'number' && Number.isFinite(templateAmount) && templateAmount >= 0 && Number.isSafeInteger(Math.round(templateAmount * 100))) {
      const erStepDelta = (entry.employer === 'Kaspersky' && entry.cpf.employerPercent === 17 && sourceCpfTotal === 4880)
        ? entry.cpf.wageBase * (17 - 9) / 100
        : 0;
      entry.fallback = { sheet: template.name, cell: entry.cell, amount: Math.round((templateAmount + erStepDelta) * 100) / 100 };
    }
    const cents = entry.transactions.reduce((total, transaction) =>
      total + Math.sign(transaction.amount) * Math.round(Math.abs(transaction.amount) * 100), 0);
    if (entry.errors.length) {
      entry.status = 'invalid'; blockers.push(...entry.errors);
    } else if (!entry.transactions.length) {
      if (entry.fallback) {
        entry.status = 'provisional'; entry.basis = 'template'; entry.amount = entry.fallback.amount;
        warnings.push('No regular Доходы salary for ' + entry.employer + ' in ' + periodLabel +
          '; provisional S$' + entry.amount.toFixed(2) + ' from ' + template.name + '!' + entry.cell + '. The new salary formula updates when the transaction is logged.');
      } else {
        entry.status = 'missing'; blockers.push('No regular Доходы salary for ' + entry.employer + ' in ' + periodLabel + '; a valid template amount is required.');
      }
    } else if (!Number.isSafeInteger(cents) || cents <= 0) {
      entry.status = 'invalid'; blockers.push('Salary total for ' + entry.employer + ' in ' + periodLabel + ' must be positive.');
    } else {
      entry.status = 'ready'; entry.basis = 'ledger'; entry.cashAmount = cents / 100;
      entry.amount = (cents + Math.round(entry.cpf.amount * 100)) / 100;
    }
  });
  return { period: period, entries: entries, ready: blockers.length === 0,
    provisional: entries.some(entry => entry.basis === 'template'), blockers: blockers, warnings: warnings };
}

/** Light income follows the tab's own month, independently of the salary lookup. */
function buildMonthCreationLightIncome(transactions, year, month, asOf) {
  if (!Array.isArray(transactions)) throw new Error('Transactions income history is required.');
  monthCreationPeriod(year, month);
  const start = Math.round((Date.UTC(year, month - 1, 1) - Date.UTC(1899, 11, 30)) / 86400000);
  const end = Math.round((Date.UTC(year, month, 1) - Date.UTC(1899, 11, 30)) / 86400000);
  const today = monthCreationAnchor(asOf === undefined ? new Date() : asOf);
  const through = Math.min(end - 1, Math.round((Date.UTC(today.year, today.month - 1, today.day) - Date.UTC(1899, 11, 30)) / 86400000));
  const evidence = [], blockers = [];
  transactions.forEach(transaction => {
    const type = calendarText(transaction.type).toLowerCase().replace(/ё/g, 'е');
    if (!/^доходы?\s*[-–—]\s*легкие\s+деньги$/.test(type)) return;
    const fail = message => blockers.push(message + ' at Transactions row ' + transaction.row);
    if (typeof transaction.date !== 'number' && !(transaction.date instanceof Date)) { fail('Invalid light-income date'); return; }
    let date;
    try { date = monthCreationAnchor(transaction.date); }
    catch (_) { fail('Invalid light-income date'); return; }
    const day = Math.round((Date.UTC(date.year, date.month - 1, date.day) - Date.UTC(1899, 11, 30)) / 86400000);
    if (day < start || day > through) return;
    const amount = transaction.amountSgd;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100))) { fail('Invalid light-income SGD amount'); return; }
    evidence.push({ row: transaction.row, date: date.year + '-' + String(date.month).padStart(2, '0') + '-' + String(date.day).padStart(2, '0'),
      source: calendarText(transaction.source), amount: amount });
  });
  const cents = evidence.reduce((total, transaction) => total + Math.sign(transaction.amount) * Math.round(Math.abs(transaction.amount) * 100), 0);
  if (!Number.isSafeInteger(cents)) blockers.push('Light-income total exceeds the supported amount range.');
  const cutoff = monthCreationAnchor(through);
  return { period: { year: year, month: month,
      through: through < start ? null : cutoff.year + '-' + String(cutoff.month).padStart(2, '0') + '-' + String(cutoff.day).padStart(2, '0') },
    amount: blockers.length ? null : cents / 100, ready: blockers.length === 0, transactions: evidence, blockers: blockers };
}

/** Dynamic endpoints follow the allocated ledger grid, including subsequently added rows. */
function monthCreationLedgerColumn(col) {
  return 'Transactions!$' + col + '$2:INDEX(Transactions!$' + col + ':$' + col + ';ROWS(Transactions!$A:$A))';
}

/** Live salary lookup replaces a provisional baseline as soon as payroll is logged. */
function monthCreationSalaryFormula(entry) {
  if (!['Google', 'Kaspersky'].includes(entry.employer)) throw new Error('Unsupported salary employer.');
  const employer = entry.employer.toLowerCase(), other = employer === 'google' ? 'kaspersky' : 'google';
  const fallback = entry.fallback ? Math.round(entry.fallback.amount * 100) + '/100' : 'NA()';
  const cpf = entry.cpf || MONTH_CREATION_CPF[entry.employer];
  const cpfCents = cpf.wageBase * (cpf.employerPercent + cpf.employeePercent);
  return '=IFERROR(LET(dates;' + monthCreationLedgerColumn('A') + ';types;' + monthCreationLedgerColumn('C') +
    ';amounts;' + monthCreationLedgerColumn('E') + ';sources;' + monthCreationLedgerColumn('I') +
    ';employer;ARRAYFORMULA(REGEXMATCH(LOWER(sources);"\\b' + employer + '\\b"));' +
    'regular;ARRAYFORMULA(LOWER(TRIM(types))="доходы");' +
    'selected;ARRAYFORMULA((dates>=EDATE($B$1;-1))*(dates<$B$1)*regular*employer);' +
    'bad;SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))))+SUM(ARRAYFORMULA(regular*employer*(1-ISNUMBER(dates))))+' +
    'SUM(ARRAYFORMULA(selected*REGEXMATCH(LOWER(sources);"\\b' + other + '\\b")));' +
    'count;SUM(selected);cents;SUM(ARRAYFORMULA(IF(selected;ROUND(amounts*100;0);0)));' +
    'IF(bad>0;NA();IF(count=0;' + fallback + ';IF(cents<=0;NA();(cents+' + cpfCents + ')/100))));NA())';
}

function monthCreationLightIncomeFormula() {
  return '=IFERROR(LET(dates;' + monthCreationLedgerColumn('A') + ';types;' + monthCreationLedgerColumn('C') +
    ';amounts;' + monthCreationLedgerColumn('E') + ';start;$B$1;' +
    'end;MIN(EDATE(start;1);TODAY()+1);' +
    'easy;ARRAYFORMULA(REGEXMATCH(SUBSTITUTE(LOWER(TRIM(types));"ё";"е");"^доходы?\\s*[-–—]\\s*легкие\\s+деньги$"));' +
    'selected;ARRAYFORMULA((dates>=start)*(dates<end)*easy);' +
    'bad;SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))))+SUM(ARRAYFORMULA(easy*(1-ISNUMBER(dates))));' +
    'cents;SUM(ARRAYFORMULA(IF(selected;ROUND(amounts*100;0);0)));IF(bad>0;NA();cents/100));NA())';
}

function monthCreationStatusFormula(row) {
  const a = monthCreationLedgerColumn('A'), c = monthCreationLedgerColumn('C');
  const e = monthCreationLedgerColumn('E'), h = monthCreationLedgerColumn('H');
  return '=IFERROR(LET(plan;E' + row + ';label;LOWER(TRIM(D' + row + '));dates;' + a + ';types;' + c + ';amounts;' + e + ';cats;' + h +
    ';selected;ARRAYFORMULA((dates>=$B$1)*(dates<=MIN($D$1;TODAY()))*(types="Обязательные расходы")*(LOWER(TRIM(cats))=label));' +
    'bad;SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))))+SUM(ARRAYFORMULA((types="Обязательные расходы")*(1-ISNUMBER(dates))));' +
    'paid;ROUND(SUM(ARRAYFORMULA(IF(selected;amounts;0)))*100;0);remaining;MAX(0;ROUND(plan*100;0)-paid)/100;' +
    'duplicates;SUM(ARRAYFORMULA((LOWER(TRIM($D$3:$D$13))=label)*($E$3:$E$13>0)));' +
    'IF(label="cpf";"Не отслеживается";IF(OR(NOT(ISNUMBER(plan));plan<0);"Данные недоступны";' +
    'IF(plan=0;"Не требуется";IF(OR(label="";label="родители";duplicates>1);"Проверьте категорию";' +
    'IF(bad>0;"Данные недоступны";IF(remaining=0;"Оплачено";IF(paid>0;"Частично";"Не оплачено")&" · осталось S$"&TEXT(remaining;"0.00"))))))))' +
    ';"Данные недоступны")';
}

function monthCreationLegacyDescriptionFormula(row) {
  const a = monthCreationLedgerColumn('A'), c = monthCreationLedgerColumn('C');
  const e = monthCreationLedgerColumn('E'), h = monthCreationLedgerColumn('H'), i = monthCreationLedgerColumn('I');
  return '=IFERROR(IF(OR(H' + row + '="";H' + row + '>TODAY());"";LET(dates;' + a + ';types;' + c + ';amounts;' + e + ';cats;' + h + ';merchants;' + i +
    ';selected;ARRAYFORMULA((dates=H' + row + ')*(types="Расходы")*(cats<>"Отложения")*(cats<>"Аренда"));' +
    'count;SUM(selected);bad;SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))));' +
    'IF(bad>0;"Данные недоступны";IF(count=0;"Нет расходов";' +
    'TEXTJOIN("; ";TRUE;FILTER(ARRAYFORMULA(IF(merchants<>"";merchants;IF(cats<>"";cats;"Без описания"))&" — S$"&TEXT(amounts;"0.00"));selected))))));"Данные недоступны")';
}

/** One largest transaction, then up to three categories ranked by remaining net SGD spend. */
function monthCreationDescriptionFormula(row) {
  const a = monthCreationLedgerColumn('A'), c = monthCreationLedgerColumn('C');
  const e = monthCreationLedgerColumn('E'), h = monthCreationLedgerColumn('H'), i = monthCreationLedgerColumn('I');
  return '=IFERROR(IF(OR(H' + row + '="";H' + row + '>TODAY());"";LET(dates;' + a + ';types;' + c + ';amounts;' + e + ';cats;' + h + ';merchants;' + i +
    ';selected;ARRAYFORMULA((dates=H' + row + ')*(types="Расходы")*(cats<>"Отложения")*(cats<>"Аренда"));' +
    'count;SUM(selected);bad;SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))));' +
    'IF(bad>0;"Данные недоступны";IF(count=0;"Нет расходов";LET(' +
    'charges;FILTER(amounts;selected);labels;FILTER(ARRAYFORMULA(IF(merchants<>"";merchants;IF(cats<>"";cats;"Без описания")));selected);' +
    'categories;FILTER(ARRAYFORMULA(IF(cats<>"";cats;"Uncategorized"));selected);' +
    'largest;MATCH(MAX(charges);charges;0);headline;INDEX(labels;largest)&" (S$"&TEXT(INDEX(charges;largest);"0.00")&").";' +
    'IF(count=1;headline;LET(remaining;SEQUENCE(count)<>largest;' +
    'restcats;FILTER(categories;remaining);restamounts;FILTER(charges;remaining);distinctcats;UNIQUE(restcats);' +
    'totals;MAP(distinctcats;LAMBDA(category;SUM(FILTER(restamounts;restcats=category))));' +
    'ranked;SORT(HSTACK(distinctcats;totals);2;FALSE;1;TRUE);' +
    'topcats;ARRAY_CONSTRAIN(ranked;MIN(3;ROWS(distinctcats));1);' +
    'categorycount;ROWS(topcats);categorytext;IF(categorycount=1;INDEX(topcats;1);IF(categorycount=2;TEXTJOIN(" and ";TRUE;topcats);' +
    'INDEX(topcats;1)&", "&INDEX(topcats;2)&", and "&INDEX(topcats;3)));' +
    'headline&" The rest was mainly "&categorytext&".")))))));"Данные недоступны")';
}

/** Pure planner. Snapshot supplies read-only cell values/formulas and workbook year. */
function buildMonthCreationPlan(snapshot, year, month) {
  const target = monthCreationPeriod(year, month);
  if (year !== snapshot.year) throw new Error('Cross-year creation is disabled: configure the new annual workbook separately.');
  const seen = new Map();
  const candidates = snapshot.sheets.map(sheet => {
    const identity = monthCreationIdentity(sheet.name);
    if (!identity) return null;
    const anchor = monthCreationAnchor(sheet.anchor);
    if (anchor.day !== 1 || anchor.month !== identity.month || anchor.year !== year || (identity.year && identity.year !== anchor.year)) {
      throw new Error('Month tab name/date mismatch: ' + sheet.name);
    }
    if (seen.has(anchor.month)) throw new Error('Multiple tabs represent month ' + anchor.month);
    seen.set(anchor.month, sheet);
    return { sheet: sheet, month: anchor.month };
  }).filter(Boolean);
  if (seen.has(month)) return { status: 'exists', target: target, existing: seen.get(month).name, edits: [], warnings: [] };
  const prior = candidates.filter(item => item.month < month).sort((a, b) => b.month - a.month)[0];
  if (!prior) throw new Error('No earlier month template exists in this annual workbook.');
  const source = prior.sheet;
  validateMonthCreationTemplate(source);
  const salary = buildMonthCreationSalaries(snapshot.transactions, year, month, source);
  const lightIncome = buildMonthCreationLightIncome(snapshot.transactions, year, month, snapshot.asOf);
  const targetCpf = getMonthCreationCpfTotalAndFormula(year, month);
  const sourceCpfFormula = String(monthCreationCell(source, 13, 5, true)).replace(/\s/g, '').replace(/(\d),(\d)/g, '$1.$2');
  const needsCpfStepUp = sourceCpfFormula !== targetCpf.formula;
  const cpfWarning = targetCpf.isYear3
    ? 'Salary B3:B4 adds employee and employer CPF: Google 20% + 17%; Kaspersky year 3 PR 20% + 17%, on the existing wage base. E13 deducts full CPF (S$5,920) once.'
    : 'Salary B3:B4 adds employee and employer CPF: Google 20% + 17%; Kaspersky year 2 PR 15% + 9%, on the existing wage base. E13 deducts full CPF once. Provisional template compensation is carried unchanged.';
  const warnings = ['Read-only plan; formulas have not been evaluated by Google Sheets.',
    'Creation, live reader integration and deployment are separate steps.',
    cpfWarning,
    'B6 tracks this tab\'s month-to-date light income, including signed corrections; B5 starts at zero.',
    'Native sandbox must verify formula recalculation, Russian number formatting, long descriptions and wrapped status layout.',
    'Summary and 50/30/20 are not modified.'].concat(salary.warnings);
  if (!salary.ready || !lightIncome.ready) return { status: 'blocked', target: target, source: source.name, sourceId: source.id,
    salary: salary, lightIncome: lightIncome, edits: [], warnings: warnings.concat(salary.blockers, lightIncome.blockers,
      ['Resolve the income data or template baseline, then preview again.']) };
  const edits = [
    { range: 'B1', value: Math.round((Date.UTC(year, month - 1, 1) - Date.UTC(1899, 11, 30)) / 86400000), purpose: 'First day; existing date formatting retained' },
    { range: 'B3:B4', formulas: salary.entries.map(entry => [monthCreationSalaryFormula(entry)]), purpose: 'Previous-month banked salaries plus employee and employer CPF; missing salaries use provisional template compensation unchanged' },
    { range: 'B5', value: 0, purpose: 'Reset carried balance' },
    { range: 'B6', formula: monthCreationLightIncomeFormula(), purpose: 'Live light income in SGD for this tab\'s month, through today' },
    { range: 'I38', formula: '=H38<=$D$1', purpose: 'Correct date-in-month helper' },
    { range: 'G3:G13', values: Array.from({ length: 11 }, () => ['']), purpose: 'Clear mandatory payment status column G (leave blank)' },
    { range: 'I2:I32', formulas: Array.from({ length: 31 }, (_, index) => [monthCreationDescriptionFormula(index + 2)]), purpose: 'Live descriptions matching daily spending filters' }
  ];
  if (needsCpfStepUp) {
    edits.push({ range: 'E13', formula: targetCpf.formula, purpose: 'Update CPF plan at E13 to Year-3 PR rates (S$' + targetCpf.total + ')' });
  }
  return { status: 'preview', target: target, source: source.name, sourceId: source.id,
    salary: salary,
    lightIncome: lightIncome,
    edits: edits, preserve: ['D1', 'D3:F13', 'B14', 'E14', 'D15', 'D17', 'D19', 'H2:H32', 'J2:L33', 'H38:H68', 'I39:I68'],
    warnings: warnings };
}

/** Explicit read adapter; never calls active-month readers that may acquire creation hooks. */
function readMonthCreationSnapshot(ss) {
  const workbookYear = getConfiguredWorkbookYear(ss);
  const ledger = ss.getSheetByName('Transactions');
  if (!ledger || ledger.getMaxRows() < 2) throw new Error('Transactions ledger is missing.');
  const headers = ledger.getRange('A1:I1').getValues()[0] || [];
  [[0, 'Дата'], [2, 'Тип'], [4, 'Сумма в SGD'], [8, 'Где']].forEach(([column, expected]) => {
    if (calendarText(headers[column]) !== expected) throw new Error('Unsupported Transactions header: expected ' + expected);
  });
  const lastRow = ledger.getLastRow();
  const transactions = lastRow < 2 ? [] : ledger.getRange(2, 1, lastRow - 1, 9).getValues().map((row, index) => ({
    row: index + 2, date: row[0], type: row[2], amountSgd: row[4], source: row[8]
  }));
  const sheets = ss.getSheets().filter(sheet => monthCreationIdentity(sheet.getName())).map(sheet => {
    const grid = sheet.getRange('A1:L70');
    const values = grid.getValues();
    return { id: sheet.getSheetId(), name: sheet.getName(), anchor: values[0][1], values: values, formulas: grid.getFormulas() };
  });
  return { year: workbookYear, sheets: sheets, transactions: transactions, asOf: new Date() };
}

/** Default previews next month; explicit (year, month, ss) supports current-month inspection. */
function previewMonthCreation(year, month, ss) {
  if (year === undefined && month === undefined) {
    const now = calendarDateParts(new Date());
    year = now.year + (now.month === 12 ? 1 : 0);
    month = now.month === 12 ? 1 : now.month + 1;
  }
  const plan = buildMonthCreationPlan(readMonthCreationSnapshot(getActiveBudgetSpreadsheet(ss)), year, month);
  Logger.log(JSON.stringify(plan, null, 2));
  return plan;
}

function buildMonthCreationPreviewHtml(plan) {
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const title = plan.status === 'exists' ? 'Already exists — no changes: ' + plan.existing :
    plan.source + ' → ' + plan.target.name + (plan.status === 'blocked' ? ' — income lookup incomplete' : '');
  const salary = !plan.salary ? '' : '<h3>Salary basis: ' + escape(plan.salary.period.year + '-' + String(plan.salary.period.month).padStart(2, '0')) +
    '</h3><table border="1" cellpadding="6" style="border-collapse:collapse"><thead><tr><th>Cell / person</th><th>Employer</th><th>SGD / status</th><th>Evidence</th></tr></thead><tbody>' +
    plan.salary.entries.map(entry => '<tr><td>' + escape(entry.cell + ' · ' + entry.person) + '</td><td>' + escape(entry.employer) +
      '</td><td>' + escape(entry.amount !== null ? 'S$' + entry.amount.toFixed(2) + ' · ' + entry.status : entry.status) + '</td><td style="white-space:pre-wrap">' +
      escape((entry.cashAmount !== null ? 'Banked S$' + entry.cashAmount.toFixed(2) + ' + employee and employer CPF S$' + entry.cpf.amount.toFixed(2) + '\n' : '') +
        (entry.transactions.map(transaction => 'Transactions row ' + transaction.row + ' · ' + transaction.date + ' · ' + transaction.source + ' · S$' + transaction.amount.toFixed(2)).join('\n') ||
        (entry.fallback ? 'Provisional template amount: ' + entry.fallback.sheet + '!' + entry.fallback.cell + '. Review when the salary transaction is logged.' : 'No matching salary transaction.'))) +
      '</td></tr>').join('') + '</tbody></table>';
  const lightIncome = !plan.lightIncome ? '' : '<h3>Light income: ' + escape(plan.lightIncome.period.year + '-' + String(plan.lightIncome.period.month).padStart(2, '0')) +
    '</h3><p>' + escape((plan.lightIncome.ready ? 'S$' + plan.lightIncome.amount.toFixed(2) : 'Unavailable') +
      (plan.lightIncome.period.through ? ' through ' + plan.lightIncome.period.through : ' · month has not started')) + '</p><details><summary>Matched transactions</summary><pre style="white-space:pre-wrap">' +
    escape(plan.lightIncome.transactions.map(transaction => 'Transactions row ' + transaction.row + ' · ' + transaction.date + ' · ' + transaction.source + ' · S$' + transaction.amount.toFixed(2)).join('\n') || 'No matching light-income transactions.') + '</pre></details>';
  return '<!doctype html><html><body style="font:14px sans-serif;padding:16px"><h2>' + escape(title) + '</h2><p>Read-only preview. No cells or tabs are changed.</p>' +
    '<p>' + escape(plan.target.year + '-' + String(plan.target.month).padStart(2, '0') + ' · ' + plan.target.days + ' days') + '</p>' +
    salary + lightIncome +
    plan.edits.map(edit => '<h3>' + escape(edit.range) + '</h3><p>' + escape(edit.purpose) + '</p><details><summary>Exact proposed values / formulas</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">' + escape(JSON.stringify(edit, null, 2)) + '</pre></details>').join('') +
    '<ul>' + plan.warnings.map(w => '<li>' + escape(w) + '</li>').join('') + '</ul></body></html>';
}

function showMonthCreationPreview() {
  const plan = previewMonthCreation();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(buildMonthCreationPreviewHtml(plan)).setWidth(900).setHeight(650), 'Preview next month');
  return plan;
}

/** Verify applied values, formulas and structural integrity before publishing final tab name. */
function verifyCreatedMonthSheet(sheet, plan) {
  const grid = sheet.getRange('A1:L70');
  const values = grid.getValues();
  const formulas = grid.getFormulas();
  validateMonthCreationTemplate({ name: plan.target.name, values: values, formulas: formulas });
  const normal = monthCreationNormalFormula;
  const anchor = monthCreationAnchor(values[0][1]);
  if ( formulas[0][1] || anchor.year !== plan.target.year || anchor.month !== plan.target.month || anchor.day !== 1 ) {
    throw new Error('Created sheet B1 date verification failed.');
  }
  const salaryEdit = plan.edits.find(edit => edit.range === 'B3:B4');
  if (normal(formulas[2][1]) !== normal(salaryEdit.formulas[0][0]) ||
      normal(formulas[3][1]) !== normal(salaryEdit.formulas[1][0])) {
    throw new Error('Created sheet B3:B4 salary formula verification failed.');
  }
  if (values[4][1] !== 0 || formulas[4][1]) {
    throw new Error('Created sheet B5 reset verification failed.');
  }
  const lightEdit = plan.edits.find(edit => edit.range === 'B6');
  if (normal(formulas[5][1]) !== normal(lightEdit.formula)) {
    throw new Error('Created sheet B6 light-income formula verification failed.');
  }
  const cpfEdit = plan.edits.find(edit => edit.range === 'E13');
  if (cpfEdit && normal(formulas[12][4]) !== normal(cpfEdit.formula)) {
    throw new Error('Created sheet E13 CPF formula verification failed.');
  }
  const checkNoError = (r, c, label) => {
    const val = (values[r - 1] || [])[c - 1];
    if (typeof val === 'string' && /^(#|Err:)/i.test(val.trim())) {
      throw new Error('Formula evaluation error at ' + label + ': ' + val);
    }
  };
  [[1, 2, 'B1'], [1, 4, 'D1'], [3, 2, 'B3'], [4, 2, 'B4'], [5, 2, 'B5'], [6, 2, 'B6'],
   [14, 2, 'B14'], [14, 5, 'E14'], [15, 4, 'D15'], [17, 4, 'D17'], [19, 4, 'D19'], [38, 9, 'I38']].forEach(([r, c, label]) => checkNoError(r, c, label));
  for (let row = 3; row <= 13; row++) checkNoError(row, 7, 'G' + row);
  for (let row = 2; row <= 32; row++) checkNoError(row, 9, 'I' + row);
  return true;
}

/**
 * Stage 6C controlled creator. Enforces sandbox target while live creation is
 * disabled, rechecks existence under the writer lock, builds under a temporary
 * tab name, verifies all edits/formulas, and cleans up the temp tab on failure.
 */
function createMonthTab(year, month, options) {
  if (year === undefined && month === undefined) {
    const now = calendarDateParts(new Date());
    year = now.year + (now.month === 12 ? 1 : 0);
    month = now.month === 12 ? 1 : now.month + 1;
  }
  monthCreationPeriod(year, month);
  const opts = options && typeof options.getSheetByName === 'function'
    ? { spreadsheet: options }
    : Object.assign({}, options || {});
  const creationEnabled = Boolean(typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.monthTemplate && SHEET_FACTS.monthTemplate.creationEnabled);
  const allowManualLive = Boolean(opts.allowManualLive);
  if (!creationEnabled && !allowManualLive && opts.sandbox === false) {
    throw new Error('Live month creation is disabled until sandbox acceptance passes.');
  }
  const useSandbox = opts.sandbox !== undefined ? Boolean(opts.sandbox) : (!creationEnabled && !allowManualLive);
  const ss = getTargetSpreadsheet(useSandbox, opts.spreadsheet);
  const result = withBudgetWriteLock(() => {
    const snapshot = readMonthCreationSnapshot(ss);
    const plan = buildMonthCreationPlan(snapshot, year, month);
    if (plan.status === 'exists') {
      return { status: 'exists', created: false, sheetName: plan.existing, target: plan.target, plan: plan };
    }
    if (plan.status !== 'preview') {
      throw new Error('Month creation blocked: ' + (plan.warnings || []).join(' '));
    }
    if (ss.getSheetByName(plan.target.name)) {
      throw new Error('Target sheet name already exists: ' + plan.target.name);
    }
    const sourceSheet = ss.getSheetByName(plan.source);
    if (!sourceSheet || (plan.sourceId !== undefined && typeof sourceSheet.getSheetId === 'function' && sourceSheet.getSheetId() !== plan.sourceId)) {
      throw new Error('Source template sheet changed during creation: ' + plan.source);
    }
    const suffix = typeof Utilities !== 'undefined' && typeof Utilities.getUuid === 'function'
      ? Utilities.getUuid().replace(/-/g, '').slice(0, 8)
      : String(Date.now());
    const tempName = '_MonthCreate_' + plan.target.year + '_' + String(plan.target.month).padStart(2, '0') + '_' + suffix;
    if (ss.getSheetByName(tempName)) {
      throw new Error('Temporary creation sheet already exists: ' + tempName);
    }
    let tempSheet = null;
    let ownsTempSheet = false;
    try {
      tempSheet = sourceSheet.copyTo(ss);
      ownsTempSheet = true;
      tempSheet.setName(tempName);
      plan.edits.forEach(edit => {
        const range = tempSheet.getRange(edit.range);
        if (Object.prototype.hasOwnProperty.call(edit, 'value')) {
          range.setValue(edit.value);
        } else if (Object.prototype.hasOwnProperty.call(edit, 'values')) {
          range.setValues(edit.values);
        } else if (Object.prototype.hasOwnProperty.call(edit, 'formula')) {
          range.setFormula(edit.formula);
        } else if (Object.prototype.hasOwnProperty.call(edit, 'formulas')) {
          range.setFormulas(edit.formulas);
        } else {
          throw new Error('Unsupported month creation edit for ' + edit.range);
        }
      });
      const statusRange = tempSheet.getRange('G3:G13');
      if (typeof statusRange.clearDataValidations === 'function') statusRange.clearDataValidations();
      else if (typeof statusRange.setDataValidation === 'function') statusRange.setDataValidation(null);
      const descRange = tempSheet.getRange('I2:I32');
      if (typeof descRange.setWrap === 'function') descRange.setWrap(true);
      const periodLabel = plan.salary.period.year + '-' + String(plan.salary.period.month).padStart(2, '0');
      plan.salary.entries.forEach(entry => {
        const cellRange = tempSheet.getRange(entry.cell);
        if (entry.status === 'provisional' && entry.fallback) {
          if (typeof cellRange.setNote === 'function') {
            cellRange.setNote('Provisional salary baseline (S$' + entry.fallback.amount.toFixed(2) + ' from ' +
              entry.fallback.sheet + '!' + entry.fallback.cell + '). No regular Доходы salary for ' +
              entry.employer + ' in ' + periodLabel + ' was logged at creation; formula updates automatically when logged.');
          }
        } else if (typeof cellRange.clearNote === 'function') {
          cellRange.clearNote();
        } else if (typeof cellRange.setNote === 'function') {
          cellRange.setNote('');
        }
      });
      if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.flush === 'function') {
        SpreadsheetApp.flush();
      }
      verifyCreatedMonthSheet(tempSheet, plan);
      if (ss.getSheetByName(plan.target.name)) {
        throw new Error('Target sheet was created concurrently: ' + plan.target.name);
      }
      tempSheet.setName(plan.target.name);
      ownsTempSheet = false;
      const created = {
        status: 'created',
        created: true,
        sheetName: plan.target.name,
        sheetId: typeof tempSheet.getSheetId === 'function' ? tempSheet.getSheetId() : null,
        source: plan.source,
        target: plan.target,
        plan: plan
      };
      recordMonthCreationProperty(year, month, created, ss);
      return created;
    } catch (err) {
      if (tempSheet && ownsTempSheet && typeof ss.deleteSheet === 'function') {
        try { ss.deleteSheet(tempSheet); } catch (_) {}
      }
      throw err;
    }
  });
  // The notice is durable before releasing the writer lock. HTTP runs outside it;
  // a retained caller lock defers delivery to the next dispatch heartbeat.
  if (result.created) {
    try { hideOlderMonthTabs(ss, result.target.year, result.target.month); }
    catch (error) { Logger.log('Auto-hiding older month tabs skipped: ' + error.message); }
    try { runMonthCreationConfirmations(undefined, ss); }
    catch (error) { Logger.log('Month creation confirmation pending: ' + error.message); }
    if (typeof syncPapaRatesForCreatedMonth === 'function') {
      try { syncPapaRatesForCreatedMonth(result.target.year, result.target.month, ss); }
      catch (error) { Logger.log('Папа rate sync during month creation pending: ' + error.message); }
    }
  }
  return result;
}

/**
 * Hides monthly tabs strictly older than the month immediately preceding (targetYear, targetMonth),
 * keeping at most the newly created month and prior month visible in the tab bar.
 */
function hideOlderMonthTabs(ss, targetYear, targetMonth) {
  if (!ss || typeof ss.getSheets !== 'function') return [];
  let defaultYear = targetYear;
  try {
    defaultYear = getConfiguredWorkbookYear(ss);
  } catch (_) {
    if (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.monthTemplate &&
        Number.isInteger(SHEET_FACTS.monthTemplate.workbookYear)) {
      defaultYear = SHEET_FACTS.monthTemplate.workbookYear;
    }
  }
  const targetOrdinal = targetYear * 12 + (targetMonth - 1);
  const hidden = [];
  ss.getSheets().forEach(sheet => {
    if (!sheet || typeof sheet.getName !== 'function' || typeof sheet.hideSheet !== 'function') return;
    const id = monthCreationIdentity(sheet.getName());
    if (!id) return;
    const tabYear = id.year || defaultYear;
    const ordinal = tabYear * 12 + (id.month - 1);
    if (ordinal < targetOrdinal - 1) {
      if (typeof sheet.isSheetHidden !== 'function' || !sheet.isSheetHidden()) {
        sheet.hideSheet();
        hidden.push(sheet.getName());
      }
    }
  });
  return hidden;
}

function recordMonthCreationProperty(year, month, result, optSs) {
  if (!result || result.created !== true) return;
  if (typeof PropertiesService === 'undefined' || typeof PropertiesService.getScriptProperties !== 'function') return;
  const props = PropertiesService.getScriptProperties();
  if (!props || typeof props.setProperty !== 'function') return;
  const ym = year + '-' + String(month).padStart(2, '0');
  if (result && result.sheetName) {
    props.setProperty('month_created_' + ym, String(result.sheetName));
    if (optSs) props.setProperty('month_created_workbook_' + ym, optSs.getId());
  }
  if (optSs) queueMonthCreationConfirmation(optSs, year, month, result.sheetName, result.sheetId);
  const reviewKey = 'month_income_review_' + ym;
  if (result && result.plan && result.plan.salary) {
    if (result.plan.salary.provisional) {
      props.setProperty(reviewKey, JSON.stringify({
        warnings: result.plan.salary.warnings || [],
        entries: (result.plan.salary.entries || [])
          .filter(entry => entry.status === 'provisional')
          .map(entry => ({ cell: entry.cell, employer: entry.employer, amount: entry.amount }))
      }));
    } else if (typeof props.deleteProperty === 'function') {
      props.deleteProperty(reviewKey);
    }
  }
}

/** Persist a live creation event, scoped to the explicitly opted-in recipients. */
function queueMonthCreationConfirmation(ss, year, month, sheetName, sheetId) {
  const config = SHEET_FACTS.monthTemplate;
  let workbookYear = config.workbookYear;
  try { workbookYear = getConfiguredWorkbookYear(ss); } catch (_) {}
  const period = year + '-' + String(month).padStart(2, '0');
  if (!config.confirmationStartPeriod || period < config.confirmationStartPeriod ||
      year !== workbookYear || ss.getId() === SHEET_FACTS.TEST_SPREADSHEET_ID) return;
  const users = getActiveTelegramUsers();
  const chatIds = (config.confirmationUserKeys || []).map(key => SHEET_FACTS.USERS[key])
    .filter(user => user && users.some(active => active.chat_id === String(user.chat_id)))
    .map(user => String(user.chat_id));
  if (!chatIds.length) return;
  const props = PropertiesService.getScriptProperties();
  const key = 'month_creation_notice_' + period;
  if (!props.getProperty(key)) props.setProperty(key, JSON.stringify({
    year: year, month: month, sheetName: sheetName, sheetId: sheetId,
    spreadsheetId: ss.getId(), chatIds: chatIds
  }));
}

/** Retry accepted-once creation confirmations independently of tab creation. */
function runMonthCreationConfirmations(optNow, optSs) {
  const config = SHEET_FACTS.monthTemplate;
  if (!config || !config.confirmationStartPeriod || !(config.confirmationUserKeys || []).length) return [];
  // A workbook ID also allows an authorized Apps Script API catch-up run.
  if (typeof optSs === 'string') optSs = SpreadsheetApp.openById(optSs);
  if (optSs && optSs.getId() === SHEET_FACTS.TEST_SPREADSHEET_ID) return [];
  const lock = LockService.getScriptLock();
  if (typeof lock.hasLock === 'function' && lock.hasLock()) return [];
  const props = PropertiesService.getScriptProperties();
  const state = props.getProperties();
  const now = calendarDateParts(optNow instanceof Date ? optNow : new Date());
  let workbookYear = config.workbookYear;
  try { workbookYear = getConfiguredWorkbookYear(optSs); } catch (_) {}
  // Catch up the already-created November tab when this feature is installed.
  // Historical tabs and mere existence are never treated as creation evidence.
  const candidates = [monthCreationPeriod(now.year, now.month),
    monthCreationPeriod(now.year + (now.month === 12 ? 1 : 0), now.month === 12 ? 1 : now.month + 1)];
  const legacy = candidates.filter(target => {
    const period = target.year + '-' + String(target.month).padStart(2, '0');
    return target.year === workbookYear && period >= config.confirmationStartPeriod &&
      state['month_created_' + period] && !state['month_creation_notice_' + period];
  });
  const prefix = 'month_creation_notice_';
  if (!legacy.length && !Object.keys(state).some(key => key.startsWith(prefix))) return [];
  const ss = optSs || getTargetSpreadsheet(false);
  if (!ss || ss.getId() === SHEET_FACTS.TEST_SPREADSHEET_ID) return [];
  legacy.forEach(target => withBudgetWriteLock(() => {
    const period = target.year + '-' + String(target.month).padStart(2, '0');
    const recordedWorkbook = state['month_created_workbook_' + period];
    if (recordedWorkbook && recordedWorkbook !== ss.getId()) return;
    const resolved = resolveMonthSheet(ss, new Date(Date.UTC(target.year, target.month - 1, 15, 12)));
    if (resolved.sheet && resolved.tabName === state['month_created_' + period]) {
      queueMonthCreationConfirmation(ss, target.year, target.month, resolved.tabName, resolved.sheet.getSheetId());
    }
  }));
  const activeIds = getActiveTelegramUsers().map(user => user.chat_id);
  const optedInIds = (config.confirmationUserKeys || []).map(key => SHEET_FACTS.USERS[key])
    .filter(Boolean).map(user => String(user.chat_id)).filter(id => activeIds.includes(id));
  const outcomes = [];
  const notices = props.getProperties();
  Object.keys(notices).filter(key => key.startsWith(prefix)).sort().forEach(key => {
    try {
      const notice = JSON.parse(notices[key]), period = key.slice(prefix.length);
      if (notice.spreadsheetId !== ss.getId() || period < config.confirmationStartPeriod) return;
      const resolved = resolveMonthSheet(ss, new Date(Date.UTC(notice.year, notice.month - 1, 15, 12)));
      if (!resolved.sheet || resolved.sheet.getSheetId() !== notice.sheetId || resolved.tabName !== notice.sheetName) return;
      const anchor = monthCreationAnchor(resolved.sheet.getRange('B1').getValue());
      if (anchor.year !== notice.year || anchor.month !== notice.month || anchor.day !== 1) return;
      const text = '✅ <b>New budget month created: ' + escapeCoachHtml(notice.sheetName) + ' ' + notice.year + '</b>\n' +
        '<a href="https://docs.google.com/spreadsheets/d/' + encodeURIComponent(notice.spreadsheetId) +
        '/edit#gid=' + encodeURIComponent(notice.sheetId) + '">Open month</a>';
      (notice.chatIds || []).filter(id => optedInIds.includes(id)).forEach(chatId => {
        const accepted = deliverScheduledMessage('month_creation_' + period + '_' + chatId,
          { period: period, dueAt: 0, expiresAt: Infinity }, chatId, () => text);
        outcomes.push({ period: period, chat_id: chatId, accepted: accepted });
      });
    } catch (error) { Logger.log('Month creation confirmation pending for ' + key + ': ' + error.message); }
  });
  return outcomes;
}

/**
 * Stage 6D operational self-healing hook for getActiveMonthTab().
 * Only creates the current SGT calendar month when creationEnabled is true.
 * Never creates historical or future months.
 */
function ensureMonthTab(spreadsheet, tabName, optDate) {
  if (typeof SHEET_FACTS === 'undefined' || !SHEET_FACTS.monthTemplate || SHEET_FACTS.monthTemplate.creationEnabled !== true) {
    return null;
  }
  const targetDate = optDate instanceof Date ? optDate : new Date();
  const targetParts = calendarDateParts(targetDate);
  const nowParts = calendarDateParts(new Date());
  if (targetParts.year !== nowParts.year || targetParts.month !== nowParts.month) {
    return null;
  }
  if (typeof tabName === 'string' && tabName.trim()) {
    const id = monthCreationIdentity(tabName);
    if (!id || id.month !== targetParts.month || (id.year && id.year !== targetParts.year)) {
      return null;
    }
  }
  const ss = spreadsheet || getTargetSpreadsheet(false);
  if (!ss) return null;
  let workbookYear = SHEET_FACTS.monthTemplate.workbookYear;
  try { workbookYear = getConfiguredWorkbookYear(ss); } catch (_) {}
  if (targetParts.year !== workbookYear) {
    return null;
  }
  if (typeof resolveMonthSheet === 'function') {
    const existing = resolveMonthSheet(ss, targetDate);
    if (existing && existing.sheet) return existing.sheet;
  }
  const res = createMonthTab(targetParts.year, targetParts.month, { spreadsheet: ss, sandbox: false });
  return ss.getSheetByName(res.sheetName);
}

/**
 * Stage 6D scheduled month creator invoked from the 15-minute dispatch() heartbeat.
 * 1. Recovers the current SGT calendar month if missing (e.g. if last-day rollover was missed).
 * 2. On the last day of the month (from 00:00 SGT onwards), creates the next month's tab
 *    so it is ready before the new month starts.
 */
function runScheduledMonthCreation(optNow, optSs) {
  if (typeof SHEET_FACTS === 'undefined' || !SHEET_FACTS.monthTemplate || SHEET_FACTS.monthTemplate.creationEnabled !== true) {
    return { status: 'disabled', actions: [] };
  }
  const now = optNow instanceof Date ? optNow : new Date();
  const parts = calendarDateParts(now);
  const ss = optSs || getTargetSpreadsheet(false);
  if (!ss) return { status: 'no_spreadsheet', actions: [] };
  let workbookYear = SHEET_FACTS.monthTemplate.workbookYear;
  try { workbookYear = getConfiguredWorkbookYear(ss); } catch (_) {}
  const actions = [];

  if (parts.year === workbookYear) {
    const currentAnchorDate = new Date(Date.UTC(parts.year, parts.month - 1, 15, 12));
    const currentResolved = typeof resolveMonthSheet === 'function'
      ? resolveMonthSheet(ss, currentAnchorDate)
      : { sheet: ss.getSheetByName(monthCreationPeriod(parts.year, parts.month).name) };
    if (!currentResolved.sheet) {
      const res = createMonthTab(parts.year, parts.month, { spreadsheet: ss, sandbox: false });
      actions.push(Object.assign({ trigger: 'current_month_recovery' }, res));
    }
  }

  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  if (parts.day === lastDay) {
    const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
    const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
    if (nextYear !== workbookYear) {
      actions.push({
        trigger: 'last_day_rollover',
        status: 'cross_year_skipped',
        created: false,
        target: { year: nextYear, month: nextMonth }
      });
    } else {
      const nextAnchorDate = new Date(Date.UTC(nextYear, nextMonth - 1, 15, 12));
      const nextResolved = typeof resolveMonthSheet === 'function'
        ? resolveMonthSheet(ss, nextAnchorDate)
        : { sheet: ss.getSheetByName(monthCreationPeriod(nextYear, nextMonth).name) };
      if (nextResolved.sheet) {
        actions.push({
          trigger: 'last_day_rollover',
          status: 'exists',
          created: false,
          sheetName: nextResolved.tabName,
          target: { year: nextYear, month: nextMonth, name: nextResolved.tabName }
        });
      } else {
        const res = createMonthTab(nextYear, nextMonth, { spreadsheet: ss, sandbox: false });
        actions.push(Object.assign({ trigger: 'last_day_rollover' }, res));
      }
    }
  }

  return { status: 'ok', actions: actions };
}

function createNextMonthFromMenu() {
  const ss = typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.getActiveSpreadsheet === 'function'
    ? SpreadsheetApp.getActiveSpreadsheet()
    : null;
  const res = createMonthTab(undefined, undefined, { spreadsheet: ss, sandbox: false, allowManualLive: true });
  if (ss && res && res.sheetName && typeof ss.getSheetByName === 'function' && typeof ss.setActiveSheet === 'function') {
    const createdSheet = ss.getSheetByName(res.sheetName);
    if (createdSheet) ss.setActiveSheet(createdSheet);
  }
  const lines = [
    res.created
      ? ('Created tab "' + res.sheetName + '" from "' + res.source + '".')
      : ('Tab "' + res.sheetName + '" already exists.')
  ];
  if (res && res.plan && res.plan.salary && Array.isArray(res.plan.salary.warnings) && res.plan.salary.warnings.length) {
    lines.push('', 'Income notes:', ...res.plan.salary.warnings);
  }
  if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.getUi === 'function') {
    try { SpreadsheetApp.getUi().alert(lines.join('\n')); } catch (_) {}
  }
  return res;
}
