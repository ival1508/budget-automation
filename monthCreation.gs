/** Stage 6B: read-only month creation plans. No creator or automatic reader hook. */
const MONTH_CREATION_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

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
  [3, 4].forEach(row => { if (typeof v(row, 2) !== 'number' || !Number.isFinite(v(row, 2)) || v(row, 2) < 0) throw new Error('Invalid salary at B' + row); });
  return true;
}

/** Dynamic endpoints follow the allocated ledger grid, including subsequently added rows. */
function monthCreationLedgerColumn(col) {
  return 'Transactions!$' + col + '$2:INDEX(Transactions!$' + col + ':$' + col + ';ROWS(Transactions!$A:$A))';
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
  const edits = [
    { range: 'B1', value: Math.round((Date.UTC(year, month - 1, 1) - Date.UTC(1899, 11, 30)) / 86400000), purpose: 'First day; existing date formatting retained' },
    { range: 'B3:B4', values: [[monthCreationCell(source, 3, 2)], [monthCreationCell(source, 4, 2)]], purpose: 'Fixed salary baseline from template; review before use' },
    { range: 'B5:B6', values: [[0], [0]], purpose: 'Reset balance and extra income' },
    { range: 'I38', formula: '=H38<=$D$1', purpose: 'Correct date-in-month helper' },
    { range: 'G3:G13', formulas: Array.from({ length: 11 }, (_, index) => [monthCreationStatusFormula(index + 3, monthCreationCell(source, index + 3, 4))]), purpose: 'Live mandatory payment status; replace inherited checkbox validation' },
    { range: 'I2:I32', formulas: Array.from({ length: 31 }, (_, index) => [monthCreationDescriptionFormula(index + 2)]), purpose: 'Live descriptions matching daily spending filters' }
  ];
  return { status: 'preview', target: target, source: source.name, sourceId: source.id,
    edits: edits, preserve: ['D1', 'D3:F13', 'B14', 'E14', 'D15', 'D17', 'D19', 'H2:H32', 'J2:L33', 'H38:H68', 'I39:I68'],
    warnings: ['Read-only plan; formulas have not been evaluated by Google Sheets.',
      'Creation, live reader integration and deployment are separate steps.',
      'Review carried salary and mandatory amounts; annual workbook boundary is enforced.',
      'Native sandbox must verify formula recalculation, Russian number formatting, long descriptions and wrapped status layout.',
      'Summary and 50/30/20 are not modified.'] };
}

/** Explicit read adapter; never calls active-month readers that may acquire creation hooks. */
function readMonthCreationSnapshot(ss) {
  const config = SHEET_FACTS.monthTemplate;
  if (!config || !Number.isInteger(config.workbookYear)) throw new Error('Month template workbook year is not configured.');
  const ledger = ss.getSheetByName('Transactions');
  if (!ledger || ledger.getMaxRows() < 2) throw new Error('Transactions ledger is missing.');
  const sheets = ss.getSheets().filter(sheet => monthCreationIdentity(sheet.getName())).map(sheet => {
    const grid = sheet.getRange('A1:L70');
    const values = grid.getValues();
    return { id: sheet.getSheetId(), name: sheet.getName(), anchor: values[0][1], values: values, formulas: grid.getFormulas() };
  });
  return { year: config.workbookYear, sheets: sheets };
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
  const title = plan.status === 'exists' ? 'Already exists — no changes: ' + plan.existing : plan.source + ' → ' + plan.target.name;
  return '<!doctype html><html><body style="font:14px sans-serif;padding:16px"><h2>' + escape(title) + '</h2><p>Read-only preview. No cells or tabs are changed.</p>' +
    '<p>' + escape(plan.target.year + '-' + String(plan.target.month).padStart(2, '0') + ' · ' + plan.target.days + ' days') + '</p>' +
    plan.edits.map(edit => '<h3>' + escape(edit.range) + '</h3><p>' + escape(edit.purpose) + '</p><details><summary>Exact proposed values / formulas</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">' + escape(JSON.stringify(edit, null, 2)) + '</pre></details>').join('') +
    '<ul>' + plan.warnings.map(w => '<li>' + escape(w) + '</li>').join('') + '</ul></body></html>';
}

function showMonthCreationPreview() {
  const plan = previewMonthCreation();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(buildMonthCreationPreviewHtml(plan)).setWidth(900).setHeight(650), 'Preview next month');
  return plan;
}
