// Offline regression tests for Step 5: Automated Kids Model 2A Core vs Hobby Split,
// Unclassified School Audit, IBKR VT Sufficiency & Buy-Trigger Alerts, /kids command, and Coach/Rollover wiring.
const assert = require('node:assert/strict');

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

function makeWorkbook(sheetsSpec, id = 'wb-step5') {
  const sheets = {};
  Object.entries(sheetsSpec).forEach(([name, initialRows]) => {
    const values = initialRows.map(r => r.slice());
    sheets[name] = {
      _values: values,
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
          getFormulas: () => Array.from({ length: h }, () => Array(w).fill('')),
          getValue: () => rng.getValues()[0][0],
          setValues: mat => {
            mat.forEach((rowVals, ri) => rowVals.forEach((val, ci) => {
              values[r - 1 + ri] ||= [];
              values[r - 1 + ri][c - 1 + ci] = val;
            }));
            return rng;
          },
          setValue: val => rng.setValues([[val]]),
          clearContent: () => rng
        };
        return rng;
      }
    };
  });
  return {
    getId: () => id,
    getName: () => 'Budget Workbook',
    getSpreadsheetTimeZone: () => 'Asia/Singapore',
    getSheetByName: n => sheets[n] || null,
    getSheets: () => Object.values(sheets)
  };
}

function buildKidsSheetRows({ vtEarmarked = 439.21, vtHeld = 531, unclassifiedNote = '' } = {}) {
  const rows = Array.from({ length: 51 }, () => Array(11).fill(''));
  rows[0] = ['KIDS EDUCATION FUND — MODEL 2A (NLCS BENCHMARK)', '', '', '', '', '', '', 'VWRA (USD):', 180.99, 'USD/SGD:', 1.29];
  rows[1] = ['', '', '', '', '', '', '', 'VT (USD):', 150.18, 'As of:', 46355];
  rows[5] = ['LON:VWRA Shares', 610, 0, 610, 0.626];
  rows[6] = ['NYSEARCA:VT Shares', vtEarmarked - 109.73, 109.73, vtEarmarked, 0.374];
  rows[9] = ['TOTAL FUND VALUE (Live SGD)', 206252, 21259, 227511, 1];
  rows[10] = ['Cumulative Principal', 157017, 21336, 178353];
  rows[11] = ['Unrealized Market Gain (SGD)', 49235, -77, 49158, 0.276];
  rows[16] = ['янв. 2026', 909, 4200, 3291, 17.76, 2060.10, 4069, 2009, 10.84, 185.29, unclassifiedNote || 'Excl. Hobbies/Rus: S$645'];
  rows[28] = ['Total 2026', 14681.50, 50986.25, 36304.75, 186.59, 27796.70, 49133.08, 21336.38, 109.69, 194.82, '✓ 100% Auto-Split · Excl. 2026 Hobbies/Rus: S$10,091'];
  rows[47] = ['5. IBKR / SAXO ETF SUFFICIENCY & VT BUY-TRIGGER MONITOR'];
  rows[49] = ['LON:VWRA (Glasha Pre-2026)', 610, 799, 189, 0, '✓ Covered (+189,0 sh)'];
  rows[50] = ['NYSEARCA:VT (Glasha + Тёма)', vtEarmarked, vtHeld, vtHeld - vtEarmarked, Math.max(0, vtEarmarked - vtHeld) * 193.73, ''];
  return rows;
}

module.exports = test => {
  test('Step 5: classifyKidsSchoolTransaction & auditKidsTransactionsAfterWrite split Glasha Core, Tema Core, Hobbies, and flag unclassified', c => {
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Продукты', where: 'FairPrice' }), null);
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Agora за май' }), 'glasha_core');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'MOE за ноябрь' }), 'glasha_core');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Mr Tan Tiam Teng' }), 'glasha_core');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Экскурсия в Science centre' }), 'glasha_core');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'MapleBear за ноябрь' }), 'tema_core');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Экскурсия Темы' }), 'tema_core');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Bilingvi for Glasha' }), 'excluded_hobby');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Ground Up Climbing' }), 'excluded_hobby');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Singapore-Irish Rugby Club' }), 'excluded_hobby');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'Daria Rotast - Theater' }), 'excluded_hobby');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'New Mystery Academy', notes: '[Kid: Tema]' }), 'tema_core');
    assert.equal(c.classifyKidsSchoolTransaction({ category: 'Школа & Детский сад', where: 'New Mystery Academy' }), 'unclassified');

    const audited = c.auditKidsTransactionsAfterWrite([], {
      dryRun: false,
      writtenRows: [
        { date: '2026-11-26', type: 'Обязательные расходы', category: 'Школа & Детский сад', where: 'MOE за ноябрь', amount_sgd: 343 },
        { date: '2026-11-27', type: 'Расходы', category: 'Школа & Детский сад', where: 'Unknown Kids Workshop', amount_sgd: 88 }
      ]
    });
    assert.equal(audited.kidsAudit.glasha_core, 1);
    assert.equal(audited.kidsAudit.unclassified.length, 1);
    assert.equal(audited.kidsAudit.unclassified[0].where, 'Unknown Kids Workshop');
  });

  test('Step 5: readKidsStatus, /kids digest, and /kids +100 vt custody update handle covered, low-buffer, and deficit buy-trigger states', c => {
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };

    // 1. Covered state (+91.8 spare VT)
    const wbCovered = makeWorkbook({ Kids: buildKidsSheetRows({ vtEarmarked: 439.21, vtHeld: 531 }) });
    const stCov = c.readKidsStatus(wbCovered);
    assert.equal(stCov.custody.vt_deficit, false);
    assert.equal(stCov.custody.vt_low_buffer, false);
    assert.equal(stCov.custody.vt_buffer_shares, 91.79);
    const htmlCov = c.renderKidsTelegramSummary(stCov);
    assert.match(htmlCov, /IBKR VT Custody Covered/);
    assert.match(htmlCov, /\+91\.8 spare VT/);

    // 2. Deficit state (555 earmarked vs 531 held -> Buy 24.0 VT) + /kids +100 vt restores coverage!
    const wbDef = makeWorkbook({ Kids: buildKidsSheetRows({ vtEarmarked: 555, vtHeld: 531 }) });
    const stDef = c.readKidsStatus(wbDef);
    assert.equal(stDef.custody.vt_deficit, true);
    assert.equal(stDef.custody.vt_buy_needed_shares, 24);
    assert.match(c.renderKidsTelegramSummary(stDef), /IBKR VT Buy Needed.*Buy 24\.0 VT/);

    const upd = c.updateKidsVtInventory('+100 vt', wbDef);
    assert.equal(upd.status, 'updated');
    assert.equal(upd.prior_held, 531);
    assert.equal(upd.new_held, 631);
    assert.equal(upd.kids_status.custody.vt_deficit, false);
    assert.equal(upd.kids_status.custody.vt_buffer_shares, 76);
  });

  test('Step 5: Monthly Coach emits Kids VT buy/low-buffer & unclassified alerts, stays quiet when healthy on non-quarter months, and rollover carries VT custody', c => {
    // 1. Healthy non-quarter month -> empty string
    const stOk = c.readKidsStatus(makeWorkbook({ Kids: buildKidsSheetRows({ vtEarmarked: 439.21, vtHeld: 531 }) }));
    assert.equal(c.renderKidsCoachLine(stOk, '2027-02'), '');

    // 2. Healthy quarter-end month -> checkpoint line
    assert.match(c.renderKidsCoachLine(stOk, '2027-03'), /Kids Model 2A Checkpoint.*covered with \+91\.8 spare VT/);

    // 3. Low buffer (<30 VT) + unclassified school txn -> emits immediate alert inside renderMonthlyReview
    const stLow = c.readKidsStatus(makeWorkbook({
      Kids: buildKidsSheetRows({ vtEarmarked: 515, vtHeld: 531, unclassifiedNote: '⚠ Unclassified S$88 (tag [Kid: Glasha/Tema/Hobby])' })
    }));
    const rendered = c.renderMonthlyReview({
      month_tab: "Февраль'27",
      report_month: '2027-02',
      target_header: 'Target month',
      buckets: { savings: { actual: 4000, target: 3960 } },
      mandatory_summary: { paid: 10, unpaid: 0 },
      monthly_review: {
        ordinary_total: 8800,
        ordinary_plan: { amount: 9300 },
        ordinary_variance: -500,
        allocations: { actual: 35000, target: 35061 },
        over_drivers: [],
        discipline: [],
        recommendations: [],
        history: { months: ['2026-10', '2026-11', '2026-12'], ordinary_median: 9000, yoy_same_month: null },
        kids: stLow
      }
    });
    assert.match(rendered, /Kids Model 2A &amp; VT Custody:/);
    assert.match(rendered, /16\.0 spare VT/);
    assert.match(rendered, /unclassified Школа &amp; Детский сад/);

    // 4. Rollover carries IBKR VT custody held count from source Kids Section 5 -> target Kids Section 5
    c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock: () => {} }) };
    const sumRows = Array.from({ length: 15 }, () => Array(5).fill(''));
    sumRows[10] = ['DBS SGD', 'DBS', 80000];
    sumRows[11] = ['DBS CC SGD', 'DBS', -10000];
    sumRows[12] = ['Citibank CC', 'Citibank', -500];
    const srcWb = makeWorkbook({ Summary: sumRows, Kids: buildKidsSheetRows({ vtEarmarked: 439.21, vtHeld: 650 }) }, 'src-26');
    const dstWb = makeWorkbook({
      Transactions: [['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где', 'Заметки', '50/30/20']],
      Kids: buildKidsSheetRows({ vtEarmarked: 439.21, vtHeld: 531 })
    }, 'dst-27');
    const roll = c.syncYearEndRollover(srcWb, dstWb, { dryRun: false, activate: false, targetYear: 2027 });
    assert.equal(roll.status, 'synced');
    assert.equal(dstWb.getSheetByName('Kids').getRange('C51').getValue(), 650);
  });
};
