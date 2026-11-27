// Offline regression tests for Step 2: Live Отдых 2027 Plan [Trip] Wiring & CapitalPlan Sinking-Fund Runway.
const assert = require('node:assert/strict');
const vm = require('node:vm');

function parseA1(a1) {
  const match = String(a1).match(/^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/);
  assert.ok(match, 'Unsupported A1 range: ' + a1);
  const toCol = s => [...s].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0);
  const col = toCol(match[1]);
  const row = Number(match[2]);
  const endCol = match[3] ? toCol(match[3]) : col;
  const endRow = match[4] ? Number(match[4]) : row;
  return { row, col, height: endRow - row + 1, width: endCol - col + 1 };
}

function a1ToR1C1(formula, row, col) {
  const ref = (absolute, number, current) => absolute ? String(number) : number === current ? '' : `[${number - current}]`;
  return String(formula || '').split(/("(?:[^"]|"")*")/g)
    .map((part, index) => index % 2 ? part : part.replace(/(?<![A-Z0-9_])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Z0-9_])/g, (_, absCol, letters, absRow, digits) => {
      const number = [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      return `R${ref(absRow, Number(digits), row)}C${ref(absCol, number, col)}`;
    })).join('');
}

function r1c1ToA1(formula, row, col) {
  const ref = (part, current) => !part ? [current, ''] : part.startsWith('[') ? [current + Number(part.slice(1, -1)), ''] : [Number(part), '$'];
  return String(formula || '').split(/("(?:[^"]|"")*")/g)
    .map((part, index) => index % 2 ? part : part.replace(/(?<![A-Z0-9_])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Z0-9_\[\]])/g, (_, r, c) => {
      const [rowNumber, absRow] = ref(r, row), [colNumber, absCol] = ref(c, col);
      let letters = '', value = colNumber;
      while (value > 0) { letters = String.fromCharCode(65 + (value - 1) % 26) + letters; value = Math.floor((value - 1) / 26); }
      return `${absCol}${letters}${absRow}${rowNumber}`;
    })).join('');
}

function makeWorkbook(sheetsSpec) {
  const sheets = {};
  Object.entries(sheetsSpec).forEach(([name, initialRows]) => {
    const values = initialRows.map(r => r.slice());
    const formulas = initialRows.map(r => r.map(cell => (typeof cell === 'string' && cell.startsWith('=')) ? cell : ''));
    sheets[name] = {
      _values: values,
      _formulas: formulas,
      getName: () => name,
      getLastRow: () => values.length,
      getLastColumn: () => Math.max(0, ...values.map(r => r.length)),
      getRange: (rowOrA1, col, height = 1, width = 1) => {
        let r = rowOrA1, c = col, h = height, w = width;
        if (typeof rowOrA1 === 'string') {
          const p = parseA1(rowOrA1);
          r = p.row; c = p.col; h = p.height; w = p.width;
        }
        const rng = {
          getValues: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => values[r - 1 + ri]?.[c - 1 + ci] ?? '')),
          getDisplayValues: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => {
              const v = values[r - 1 + ri]?.[c - 1 + ci] ?? '';
              return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
            })),
          getFormulas: () => Array.from({ length: h }, (_, ri) =>
            Array.from({ length: w }, (_, ci) => formulas[r - 1 + ri]?.[c - 1 + ci] ?? '')),
          getFormulasR1C1: () => rng.getFormulas().map((rf, ri) => rf.map((f, ci) => f ? a1ToR1C1(f, r + ri, c + ci) : '')),
          getValue: () => rng.getValues()[0][0],
          getDisplayValue: () => rng.getDisplayValues()[0][0],
          getFormula: () => rng.getFormulas()[0][0],
          setValues: mat => {
            mat.forEach((rowVals, ri) => rowVals.forEach((val, ci) => {
              values[r - 1 + ri] ||= [];
              formulas[r - 1 + ri] ||= [];
              if (typeof val === 'string' && val.startsWith('=')) {
                formulas[r - 1 + ri][c - 1 + ci] = val;
                values[r - 1 + ri][c - 1 + ci] = 0;
              } else {
                values[r - 1 + ri][c - 1 + ci] = val;
                formulas[r - 1 + ri][c - 1 + ci] = '';
              }
            }));
            return rng;
          },
          setValue: val => rng.setValues([[val]]),
          setFormulas: mat => rng.setValues(mat),
          setFormulasR1C1: mat => rng.setValues(mat.map((rf, ri) => rf.map((f, ci) => f ? r1c1ToA1(f, r + ri, c + ci) : '')))
        };
        return rng;
      }
    };
  });
  return {
    getId: () => 'wb-step2',
    getName: () => 'Budget 2027',
    getSpreadsheetTimeZone: () => 'Asia/Kuala_Lumpur',
    getSheetByName: n => sheets[n] || null,
    getSheets: () => Object.values(sheets)
  };
}

function buildTravelSheetRows() {
  const rows = Array.from({ length: 250 }, () => Array(12).fill(''));
  rows[0][0] = '2027 ОТДЫХ PLAN — VIEW 0';
  rows[1] = ['Trip', 'Bucket', 'Dates', 'Target', 'Ceiling', '65% Gate (F+H)', 'Committed F+H', 'Gate Check', 'Actual Spent', 'Est. Remaining', 'Projected Total', 'Var vs Target'];
  const trips = [
    ['London (Valeriy)', 'Друзья / Solo', '20.02–28.02.2027', 3400, 4400, 2800, 0, '—', 0, 3400, 3400, -3400],
    ['Grandparents Apr–May (×2)', 'Юбилей / Родные', '13.04–29.05.2027', 2500, 3100, 2800, 0, '—', 0, 2500, 2500, -2500],
    ['Paris (Anniversary)', 'Юбилей / Родные', '16.04–25.04.2027', 8000, 9200, 6000, 6200, 'OVER GATE', 6200, 1800, 8000, -1800],
    ['Moscow (Kids + Rita)', 'Семья', '29.05–26.06.2027', 4000, 4800, 4000, 0, '—', 0, 4000, 4000, -4000],
    ['Tokyo (Family)', 'Семья', '03.09–11.09.2027', 7800, 9000, 5850, 0, '—', 0, 7800, 7800, -7800],
    ['Australia RWC (Valeriy)', 'Друзья / Solo', '23.10–31.10.2027', 4500, 5800, 3300, 0, '—', 0, 4500, 4500, -4500],
    ['China Winter Ski', 'Семья', '18.12–01.01.2028', 14500, 16000, 10400, 0, '—', 0, 14500, 14500, -14500],
    ["Tatiana V. Jan'28 (×1)", 'Юбилей / Родные', "01.2028 (buy Nov'27)", 1500, 1800, 1600, 0, '—', 0, 1500, 1500, -1500]
  ];
  trips.forEach((t, i) => { rows[2 + i] = t; });
  rows[14] = ['TOTAL ALL-IN (Max 2027)', '', '', 46200, 54100, 36750, 6200, 'OK', 6200, 40000, 46200, -40000];
  rows[19] = ['Dec 2026', 0, 8000, 8000, 4600, 3400, 'GSU start'];
  rows[20] = ['Jan 2027', 4000, 0, 4000, 6000, 1400, 'Grandparents + Moscow flights'];
  rows[21] = ['Feb 2027', 4000, 0, 4000, 4100, 1300, 'London hotel + Club Med 20%'];
  rows[30] = ['Nov 2027', 4000, 0, 4000, 8000, 8000, 'Club Med 80% balance'];
  rows[63] = [0, 3200, 0, 0, 3200, 'SWEEP S$3200 FROM WISE TO DBS'];
  rows[66] = ['Date', 'Trip', 'Category', 'Funding Source', 'Amount (SGD)', 'Orig. Amount', 'Currency', 'Merchant / Description', 'Notes / DBS Sweep Status'];
  return rows;
}

function buildCapitalPlanRows() {
  const rows = Array.from({ length: 40 }, () => Array(9).fill(''));
  rows[10] = ['CPF Cash Top-Up (RSTU)', 8000, 8000, 16000, 0, 16000];
  rows[11] = ['SRS Contribution', 15300, 15300, 30600, 5000, 25600];
  rows[15] = ['Remaining S$80k Cap Headroom', 27300, 35300, 62600];
  rows[16] = ['Optimal IPC Charity Cash (250%)', 10920, 14120, 25040, 1450, 23590];
  rows[18] = ['Estimated Tax Saved', 11529, 12742, 24271];
  rows[28] = ['Total Capital Inflows', 316000, 42000];
  rows[36] = ['Total Priority Capital Uses', 137280, 6450, 130830];
  rows[37] = ['Net Unallocated ETF Surplus', 178720, 35550];
  return rows;
}

module.exports = test => {
  test('Step 2: [Trip] resolver handles English/Russian aliases, cleans merchant names, and normalizes notes', c => {
    assert.equal(c.resolveCanonicalTripName('London'), 'London (Valeriy)');
    assert.equal(c.resolveCanonicalTripName('Париж'), 'Paris (Anniversary)');
    assert.equal(c.resolveCanonicalTripName('Disneyland Hotel Tokyo'), 'Tokyo (Family)');
    assert.equal(c.resolveCanonicalTripName('Москва билеты'), 'Moscow (Kids + Rita)');
    assert.equal(c.resolveCanonicalTripName('RWC Sydney'), 'Australia RWC (Valeriy)');
    assert.equal(c.resolveCanonicalTripName('Club Med Beidahu'), 'China Winter Ski');
    assert.equal(c.resolveCanonicalTripName('бабушки апрель'), 'Grandparents Apr–May (×2)');
    assert.equal(c.resolveCanonicalTripName('Татьяна'), "Tatiana V. Jan'28 (×1)");

    const enriched = c.enrichTransaction({
      date: '15.01.2027',
      account: 'DBS CC SGD',
      type: 'Расходы',
      amount: 1600,
      currency: 'SGD',
      category: 'Отдых',
      where: 'British Airways [Trip: Лондон]',
      notes: 'EUR 1100'
    }, { 'Отдых': 'Wants' });

    assert.equal(enriched.where, 'British Airways');
    assert.equal(enriched.trip_name, 'London (Valeriy)');
    assert.match(enriched.notes, /\[Trip: London \(Valeriy\)\]/);
    assert.match(enriched.notes, /EUR 1100/);
  });

  test('Step 2: appendTransactions syncs [Trip] rows to Отдых 2027 Plan idempotently and reconciles Wise -> DBS sweeps', c => {
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };

    const txRows = [
      ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где', 'Заметки', '50/30/20'],
      ['31.12.2026', 'DBS SGD', 'Перевод', 0, '=IF(D2="";"";D2)', 50000, '=IF(OR(C2="Доходы";C2="Получение денег");F2+D2;F2-D2)', '', '[Rollover Seed]', '', ''],
      ['31.12.2026', 'DBS CC SGD', 'Перевод', 0, '=IF(D3="";"";D3)', -2000, '=IF(OR(C3="Доходы";C3="Получение денег");F3+D3;F3-D3)', '', '[Rollover Seed]', '', ''],
      ['31.12.2026', 'DBS SGD', 'Перевод', 0, '=IF(D4="";"";D4)', '=INDEX(Transactions!G:G;MAX((OFFSET(B4;-ROW()+1;0;ROW()-1;1)=B4)*ROW((OFFSET(B4;-ROW()+1;0;ROW()-1;1)));0))', '=IF(OR(C4="Доходы";C4="Получение денег");F4+D4;F4-D4)', '', '[Rollover Template]', '', '']
    ];

    const wb = makeWorkbook({
      Transactions: txRows,
      '-': [['Тип', 'Категория', 'Bucket'], ['Расходы', 'Отдых', 'Wants'], ['Получение денег', 'Отдых', 'Wants']],
      'Отдых 2027 Plan': buildTravelSheetRows()
    });
    c.SpreadsheetApp.getActiveSpreadsheet = () => wb;

    // 1. Dry-run never mutates Отдых 2027 Plan
    c.appendTransactions([{
      date: '10.01.2027',
      account: 'DBS CC SGD',
      type: 'Расходы',
      amount: 3000,
      currency: 'SGD',
      category: 'Отдых',
      where: 'Air France',
      notes: '[Trip: Paris]'
    }], wb, true);
    assert.equal(wb.getSheetByName('Отдых 2027 Plan').getRange('B68').getValue(), '');

    // 2. Live append writes Flights & Hotel into rows 68 & 69 as 'DBS (To Sweep)'
    const res1 = c.appendTransactions([
      {
        date: '10.01.2027',
        account: 'DBS CC SGD',
        type: 'Расходы',
        amount: 3000,
        currency: 'SGD',
        category: 'Отдых',
        where: 'Air France',
        notes: '[Trip: Париж] EUR 2050'
      },
      {
        date: '11.01.2027',
        account: 'DBS CC SGD',
        type: 'Расходы',
        amount: 3200,
        currency: 'SGD',
        category: 'Отдых',
        where: 'Booking.com Hotel Louvre',
        notes: '[Trip: Paris (Anniversary)]'
      }
    ], wb, false);

    assert.equal(res1.writtenCount, 2);
    assert.equal(res1.tripSync.appendedTripRows, 2);
    const travel = wb.getSheetByName('Отдых 2027 Plan');
    assert.equal(travel.getRange('B68').getValue(), 'Paris (Anniversary)');
    assert.equal(travel.getRange('C68').getValue(), 'Flights');
    assert.equal(travel.getRange('D68').getValue(), 'DBS (To Sweep)');
    assert.equal(travel.getRange('E68').getValue(), 3000);
    assert.equal(travel.getRange('F68').getValue(), 2050);
    assert.equal(travel.getRange('G68').getValue(), 'EUR');

    assert.equal(travel.getRange('C69').getValue(), 'Hotel');
    assert.equal(travel.getRange('D69').getValue(), 'DBS (To Sweep)');
    assert.equal(travel.getRange('E69').getValue(), 3200);

    // Idempotent replay with same dedupe_key adds 0 rows
    c.syncTripLedgerAfterWrite([], res1, wb);
    assert.equal(travel.getRange('B70').getValue(), '');

    // 3. Logging Wise -> DBS SGD sweep inflow ('Получение денег' S$3,000) flips row 68 to 'Wise (Allowance)'
    const sweepRes = c.appendTransactions([{
      date: '14.01.2027',
      account: 'DBS SGD',
      type: 'Получение денег',
      amount: 3000,
      currency: 'SGD',
      category: 'Отдых',
      where: 'Wise Transfer',
      notes: 'Sweep Air France from Wise'
    }], wb, false);
    assert.equal(sweepRes.tripSync.sweptRowsCount, 1);
    assert.equal(travel.getRange('D68').getValue(), 'Wise (Allowance)');
    assert.match(travel.getRange('I68').getValue(), /✓ Swept 14\.01\.2027/);
    assert.equal(travel.getRange('D69').getValue(), 'DBS (To Sweep)');
  });

  test('Step 2: /trips, /tax, and Monthly Coach surface OVER GATE, Wise pinch points, and Q3/Q4 IRAS S$80k cap countdown', c => {
    const make50Row = (g, cat, act, pct, tgt, tgtPct) => {
      const r = Array(32).fill('');
      r[0] = g; r[1] = cat;
      r[2] = act; r[3] = pct;     // 01/2027
      r[18] = act; r[19] = pct;   // 09/2027
      r[30] = tgt; r[31] = tgtPct;
      return r;
    };
    const bRows = [
      make50Row('Group', 'Category', '01/2027', '%', 'Target month 2026', 'Target %'),
      Array(32).fill(''),
      make50Row('Needs', 'Needs', 1500, 0.5, 1500, 0.5),
      make50Row('', 'Продукты', 1500, 0.5, 1500, 0.5),
      make50Row('Wants', 'Wants', 900, 0.3, 900, 0.3),
      make50Row('', 'Рестораны', 900, 0.3, 900, 0.3),
      make50Row('Savings', 'Savings', 1000, 0.2, 1000, 0.2),
      make50Row('', 'Отложения', 1000, 0.2, 1000, 0.2),
      make50Row('', 'Total', 3400, 1.0, 3400, 1.0)
    ];
    bRows[0][18] = '09/2027'; bRows[0][19] = '%';

    const makeMonthGrid = isoFirst => {
      const m = Array.from({ length: 33 }, () => Array(12).fill(''));
      const [yy, mm, dd] = isoFirst.split('-').map(Number);
      m[0][1] = Math.round((Date.UTC(yy, mm - 1, dd) - Date.UTC(1899, 11, 30)) / 86400000);
      m[2][3] = 'CPF'; m[2][4] = 4880; m[2][6] = '';
      m[13][1] = 20000; m[13][4] = 4880; m[14][3] = 15120;
      return m;
    };

    const wb = makeWorkbook({
      '50/30/20': bRows,
      "Январь'27": makeMonthGrid('2027-01-01'),
      "Сентябрь'27": makeMonthGrid('2027-09-01'),
      Transactions: [
        ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'До', 'После', 'Категория', 'Где', 'Заметки', '50/30/20'],
        [vm.runInContext("new Date('2027-01-12T04:00:00Z')", c), 'DBS CC SGD', 'Расходы', 1500, 1500, 0, -1500, 'Продукты', 'FairPrice', '', 'Needs'],
        [vm.runInContext("new Date('2027-01-18T04:00:00Z')", c), 'DBS CC SGD', 'Расходы', 900, 900, -1500, -2400, 'Рестораны', 'PS.Cafe', '', 'Wants'],
        [vm.runInContext("new Date('2027-09-12T04:00:00Z')", c), 'DBS CC SGD', 'Расходы', 1500, 1500, 0, -1500, 'Продукты', 'FairPrice', '', 'Needs'],
        [vm.runInContext("new Date('2027-09-18T04:00:00Z')", c), 'DBS CC SGD', 'Расходы', 900, 900, -1500, -2400, 'Рестораны', 'PS.Cafe', '', 'Wants']
      ],
      'Отдых 2027 Plan': buildTravelSheetRows(),
      CapitalPlan: buildCapitalPlanRows()
    });
    c.SpreadsheetApp.getActiveSpreadsheet = () => wb;

    // 1. /trips & /tax Telegram commands via webhook
    const sent = [];
    const props = c.PropertiesService.getScriptProperties();
    props.setProperty('WEBHOOK_SECRET', 'sec');
    props.setProperty('AUTHORIZED_CHAT_IDS', '96069960');
    props.setProperty('TELEGRAM_BOT_TOKEN', 'tok');
    c.HtmlService = { createHtmlOutput: s => s };
    c.CacheService = { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) };
    c.sendTelegramMessage = (text, chatId) => sent.push({ text, chatId });

    c.doPost({
      parameter: { secret: 'sec' },
      postData: { contents: JSON.stringify({ update_id: 1, message: { chat: { id: 96069960 }, text: '/trips' } }) }
    });
    c.doPost({
      parameter: { secret: 'sec' },
      postData: { contents: JSON.stringify({ update_id: 2, message: { chat: { id: 96069960 }, text: '/tax' } }) }
    });
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /DBS Sweep Needed:.*S\$3,200/);
    assert.match(sent[0].text, /65% Gate Alert \(Paris \(Anniversary\)\)/);
    assert.match(sent[1].text, /CapitalPlan — IRAS S\$80k Tax Caps/);
    assert.match(sent[1].text, /S\$23,590<\/b> left/);

    // 2. January Monthly Review includes travel gate/sweep/pinch watch, omits Q3/Q4 IRAS tax countdown
    const janPayload = c.buildCoachPayload('monthly', wb, vm.runInContext("new Date('2027-01-31T12:00:00Z')", c));
    const janReview = c.renderMonthlyReview(janPayload);
    assert.match(janReview, /Отдых 2027 Plan:.*sweep S\$3,200\.00 from Wise to DBS SGD/);
    assert.match(janReview, /65% Flights\+Hotel gate exceeded on Paris \(Anniversary\)/);
    assert.match(janReview, /Wise cashflow watch \(Jan 2027/);
    assert.doesNotMatch(janReview, /IRAS 31 Dec Tax-Relief Runway/);

    // 3. September (Q3) Monthly Review includes IRAS 31 Dec Tax-Relief Runway countdown
    const sepPayload = c.buildCoachPayload('monthly', wb, vm.runInContext("new Date('2027-09-30T12:00:00Z')", c));
    const sepReview = c.renderMonthlyReview(sepPayload);
    assert.match(sepReview, /IRAS 31 Dec Tax-Relief Runway:.*S\$65,190\.00 remaining across CPF RSTU \(S\$16,000\.00\), SRS \(S\$25,600\.00\), and 250% IPC Charity \(S\$23,590\.00 left; S\$1,450\.00 donated YTD\)/);
  });
};
