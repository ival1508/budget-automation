/** Stage 6B: read-only month creation plans. No creator or automatic reader hook. */
const MONTH_CREATION_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// Employer-only salary top-up. Employee rates describe the preserved E13 deduction.
const MONTH_CREATION_CPF = Object.freeze({
  Google: { wageBase: 8000, employerPercent: 17, employeePercent: 20 },
  Kaspersky: { wageBase: 8000, employerPercent: 9, employeePercent: 15 }
});

function monthCreationPeriod(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Target requires an integer year and month (1–12).');
  }
  return { year: year, month: month, name: MONTH_CREATION_NAMES[month - 1],
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

function validateMonthCreationTemplate(source) {
  const v = (r, c) => monthCreationCell(source, r, c, false);
  const f = (r, c) => monthCreationCell(source, r, c, true);
  const normal = formula => String(formula).replace(/\s/g, '').replace(/,/g, ';').toUpperCase();
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
  if (v(13, 4) !== 'CPF' || cpfFormula !== '=(0.09*8000+0.15*8000)+(0.17*8000+0.2*8000)' || v(13, 5) !== 4880) {
    throw new Error('Unsupported CPF plan at E13; review the contribution rates and wage base.');
  }
  for (let row = 2; row <= 32; row++) {
    requireFormula(row, 8, '=IF(INDIRECT(ADDRESS(ROW()+36; COLUMN()+1));INDIRECT(ADDRESS(ROW()+36; COLUMN())); )');
    requireFormula(row, 10, '=SUMIFS(Transactions!E:E;Transactions!A:A;H' + row + ';Transactions!C:C;"Расходы";Transactions!H:H;"<>Отложения";Transactions!H:H;"<>Аренда")');
    requireFormula(row, 12, '=INDIRECT(ADDRESS(ROW(); COLUMN()-1))-INDIRECT(ADDRESS(ROW(); COLUMN()-2))');
    if (row > 2) requireFormula(row, 11, '=IF(INDIRECT(ADDRESS(ROW()+36; COLUMN()-2)); INDIRECT(ADDRESS(ROW()-1; COLUMN()+1))+D$17; INDIRECT(ADDRESS(ROW()-1; COLUMN()+1)))');
    if (f(row, 9)) throw new Error('Description formula already exists at I' + row + '; review template version.');
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
    if (f(row, 7) || (flag !== '' && typeof flag !== 'boolean')) throw new Error('Unsupported existing G status at row ' + row);
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
  entries.forEach(entry => {
    delete entry.pattern;
    entry.cpf = { ...MONTH_CREATION_CPF[entry.employer] };
    entry.cpf.amount = entry.cpf.wageBase * entry.cpf.employerPercent / 100;
    entry.cashAmount = null;
    const templateAmount = template && monthCreationCell(template, Number(entry.cell.slice(1)), 2);
    if (typeof templateAmount === 'number' && Number.isFinite(templateAmount) && templateAmount >= 0 && Number.isSafeInteger(Math.round(templateAmount * 100))) {
      entry.fallback = { sheet: template.name, cell: entry.cell, amount: Math.round(templateAmount * 100) / 100 };
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

/** Quarter-to-date light income is independent of the previous-month salary lookup. */
function buildMonthCreationLightIncome(transactions, year, month, asOf) {
  if (!Array.isArray(transactions)) throw new Error('Transactions income history is required.');
  monthCreationPeriod(year, month);
  const firstMonth = Math.floor((month - 1) / 3) * 3 + 1;
  const start = Math.round((Date.UTC(year, firstMonth - 1, 1) - Date.UTC(1899, 11, 30)) / 86400000);
  const end = Math.round((Date.UTC(year, firstMonth + 2, 1) - Date.UTC(1899, 11, 30)) / 86400000);
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
  return { period: { year: year, quarter: Math.floor((month - 1) / 3) + 1,
      through: cutoff.year + '-' + String(cutoff.month).padStart(2, '0') + '-' + String(cutoff.day).padStart(2, '0') },
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
  const cpf = MONTH_CREATION_CPF[entry.employer];
  const cpfCents = cpf.wageBase * cpf.employerPercent;
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
    ';amounts;' + monthCreationLedgerColumn('E') + ';start;DATE(YEAR($B$1);INT((MONTH($B$1)-1)/3)*3+1;1);' +
    'end;MIN(EDATE(start;3);TODAY()+1);' +
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

function monthCreationDescriptionFormula(row) {
  const a = monthCreationLedgerColumn('A'), c = monthCreationLedgerColumn('C');
  const e = monthCreationLedgerColumn('E'), h = monthCreationLedgerColumn('H'), i = monthCreationLedgerColumn('I');
  return '=IFERROR(IF(OR(H' + row + '="";H' + row + '>TODAY());"";LET(dates;' + a + ';types;' + c + ';amounts;' + e + ';cats;' + h + ';merchants;' + i +
    ';selected;ARRAYFORMULA((dates=H' + row + ')*(types="Расходы")*(cats<>"Отложения")*(cats<>"Аренда"));' +
    'count;SUM(selected);bad;SUM(ARRAYFORMULA(selected*(1-ISNUMBER(amounts))));' +
    'IF(bad>0;"Данные недоступны";IF(count=0;"Нет расходов";' +
    'TEXTJOIN("; ";TRUE;FILTER(ARRAYFORMULA(IF(merchants<>"";merchants;IF(cats<>"";cats;"Без описания"))&" — S$"&TEXT(amounts;"0.00"));selected))))));"Данные недоступны")';
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
  const warnings = ['Read-only plan; formulas have not been evaluated by Google Sheets.',
    'Creation, live reader integration and deployment are separate steps.',
    'Salary B3:B4 adds employer CPF only: Google 17% and Kaspersky 9% on the existing wage base. E13 is preserved. Provisional template compensation is carried unchanged.',
    'B6 tracks quarter-to-date light income through today, including signed corrections; B5 starts at zero.',
    'Native sandbox must verify formula recalculation, Russian number formatting, long descriptions and wrapped status layout.',
    'Summary and 50/30/20 are not modified.'].concat(salary.warnings);
  if (!salary.ready || !lightIncome.ready) return { status: 'blocked', target: target, source: source.name, sourceId: source.id,
    salary: salary, lightIncome: lightIncome, edits: [], warnings: warnings.concat(salary.blockers, lightIncome.blockers,
      ['Resolve the income data or template baseline, then preview again.']) };
  const edits = [
    { range: 'B1', value: Math.round((Date.UTC(year, month - 1, 1) - Date.UTC(1899, 11, 30)) / 86400000), purpose: 'First day; existing date formatting retained' },
    { range: 'B3:B4', formulas: salary.entries.map(entry => [monthCreationSalaryFormula(entry)]), purpose: 'Previous-month banked salaries plus employer CPF only; missing salaries use provisional template compensation unchanged' },
    { range: 'B5', value: 0, purpose: 'Reset carried balance' },
    { range: 'B6', formula: monthCreationLightIncomeFormula(), purpose: 'Live quarter-to-date light income in SGD, through today' },
    { range: 'I38', formula: '=H38<=$D$1', purpose: 'Correct date-in-month helper' },
    { range: 'G3:G13', formulas: Array.from({ length: 11 }, (_, index) => [monthCreationStatusFormula(index + 3, monthCreationCell(source, index + 3, 4))]), purpose: 'Live mandatory payment status; replace inherited checkbox validation' },
    { range: 'I2:I32', formulas: Array.from({ length: 31 }, (_, index) => [monthCreationDescriptionFormula(index + 2)]), purpose: 'Live descriptions matching daily spending filters' }
  ];
  return { status: 'preview', target: target, source: source.name, sourceId: source.id,
    salary: salary,
    lightIncome: lightIncome,
    edits: edits, preserve: ['D1', 'D3:F13', 'B14', 'E14', 'D15', 'D17', 'D19', 'H2:H32', 'J2:L33', 'H38:H68', 'I39:I68'],
    warnings: warnings };
}

/** Explicit read adapter; never calls active-month readers that may acquire creation hooks. */
function readMonthCreationSnapshot(ss) {
  const config = SHEET_FACTS.monthTemplate;
  if (!config || !Number.isInteger(config.workbookYear)) throw new Error('Month template workbook year is not configured.');
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
  return { year: config.workbookYear, sheets: sheets, transactions: transactions, asOf: new Date() };
}

/** Default previews next month; explicit (year, month, ss) supports current-month inspection. */
function previewMonthCreation(year, month, ss) {
  if (year === undefined && month === undefined) {
    const now = calendarDateParts(new Date());
    year = now.year + (now.month === 12 ? 1 : 0);
    month = now.month === 12 ? 1 : now.month + 1;
  }
  const plan = buildMonthCreationPlan(readMonthCreationSnapshot(ss || SpreadsheetApp.getActiveSpreadsheet()), year, month);
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
      escape((entry.cashAmount !== null ? 'Banked S$' + entry.cashAmount.toFixed(2) + ' + employer CPF S$' + entry.cpf.amount.toFixed(2) + '\n' : '') +
        (entry.transactions.map(transaction => 'Transactions row ' + transaction.row + ' · ' + transaction.date + ' · ' + transaction.source + ' · S$' + transaction.amount.toFixed(2)).join('\n') ||
        (entry.fallback ? 'Provisional template amount: ' + entry.fallback.sheet + '!' + entry.fallback.cell + '. Review when the salary transaction is logged.' : 'No matching salary transaction.'))) +
      '</td></tr>').join('') + '</tbody></table>';
  const lightIncome = !plan.lightIncome ? '' : '<h3>Light income: ' + escape(plan.lightIncome.period.year + ' Q' + plan.lightIncome.period.quarter) +
    '</h3><p>' + escape((plan.lightIncome.ready ? 'S$' + plan.lightIncome.amount.toFixed(2) : 'Unavailable') + ' through ' + plan.lightIncome.period.through) + '</p><details><summary>Matched transactions</summary><pre style="white-space:pre-wrap">' +
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
