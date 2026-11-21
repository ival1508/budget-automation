const assert = require('node:assert/strict');

module.exports = function registerPapaDebtRegressions(test) {
  test('papa_charge expenses keep Расходы/Обязательные расходы and Получение денег inflows stay protected', c => {
    const exp = c.enrichTransaction({
      date: '19.11.2026', account: 'DBS CC SGD', type: 'Снятие денег',
      amount: 19.72, currency: 'SGD', category: 'Дом', where: 'Amazon',
      flags: ['papa_charge'], notes: ''
    });
    assert.equal(exp.type, 'Расходы');
    assert.ok(exp.flags.includes('papa_charge'));
    assert.ok(exp.flags.includes('reimbursable'));

    const fixed = c.enrichTransaction({
      date: '19.11.2026', account: 'DBS CC SGD', type: 'Обязательные расходы',
      amount: 181, currency: 'SGD', category: 'Отдых', where: 'Mercure Sapporo',
      flags: ['papa_charge', 'reimbursable'], notes: ''
    });
    assert.equal(fixed.type, 'Обязательные расходы');
    assert.ok(fixed.flags.includes('papa_charge'));
    assert.ok(fixed.flags.includes('reimbursable'));

    const inflow = c.enrichTransaction({
      date: '22.11.2026', account: 'DBS SGD', type: 'Получение денег',
      amount: 5000, currency: 'SGD', category: 'Дом', where: 'Transfer from dad',
      flags: ['papa_charge', 'reimbursable'], notes: 'от папы USD 3800'
    });
    assert.equal(inflow.type, 'Получение денег');
    assert.equal(inflow.flags.includes('papa_charge'), false);
    assert.equal(inflow.flags.includes('reimbursable'), false);
    assert.equal(inflow.notes, 'от папы USD 3800');
  });

  test('papaDebt rate parsers validate NY Fed SOFR, ECB ESTR CSV, and MAS SORA payloads', c => {
    const sofrJson = JSON.stringify({
      refRates: [{ percentRate: 3.91 }, { percentRate: 3.93 }]
    });
    assert.equal(c.parseNyFedSofrRate(sofrJson), 0.0392);
    assert.equal(c.parseNyFedSofrRate(JSON.stringify({ refRates: [{ percentRate: -1 }] })), null);

    const estrCsv = 'DATAFLOW,KEY,TIME_PERIOD,OBS_VALUE\nECB:EST,B.EU000A2X2A25.WT,2026-11-19,2.441\n';
    assert.equal(c.parseEcbEstrCsvRate(estrCsv), 0.0244);
    assert.equal(c.parseEcbEstrCsvRate('BAD,HEADER\n1,2\n'), null);

    const masJson = JSON.stringify({
      result: { records: [{ end_of_day: '2026-11-19', comp_sora_1m: '1.5531', sora: '1.5038' }] }
    });
    assert.equal(c.parseMasSoraRate(masJson), 0.0155);

    const masFallback = JSON.stringify({
      result: { records: [{ end_of_day: '2026-11-19', comp_sora_1m: '', sora: '1.5038' }] }
    });
    assert.equal(c.parseMasSoraRate(masFallback), 0.015);
  });

  test('computePapaMonthStep matches Nov 2026 live sheet math and SGD->USD->EUR waterfall', c => {
    const nov = c.computePapaMonthStep(
      { usd: 82436.08, eur: 69093.37, sgd: 0 },
      { usd: 0.0392, eur: 0.0244, sgd: 0.0155 },
      { usdSgd: 1.2894, eurSgd: 1.4156 },
      { reimbSgd: 1214.11, inflowSgd: 0, inflowUsd: 0, inflowEur: 0, dividendsUsd: 0 }
    );
    assert.equal(nov.usd, 81763.76);
    assert.equal(nov.eur, 69233.86);
    assert.equal(nov.sgd, 0);
    assert.equal(nov.monthInterestSgd, 546.1);
    assert.equal(nov.totalOwedSgd, 203433.64);

    // Partial SGD absorption + spillover into USD + spillover into EUR
    const waterfall = c.computePapaMonthStep(
      { usd: 100, eur: 500, sgd: 200 },
      { usd: 0, eur: 0, sgd: 0 },
      { usdSgd: 1.3, eurSgd: 1.5 },
      { reimbSgd: 480, inflowSgd: 0, inflowUsd: 0, inflowEur: 0, dividendsUsd: 0 }
    );
    assert.equal(waterfall.sgd, 0);
    assert.equal(waterfall.usd, 0);
    assert.equal(waterfall.eur, 400);

    // Dad inflows increase their respective currency balances
    const inflows = c.computePapaMonthStep(
      { usd: 1000, eur: 2000, sgd: 0 },
      { usd: 0, eur: 0, sgd: 0 },
      { usdSgd: 1.3, eurSgd: 1.5 },
      { reimbSgd: 100, inflowSgd: 500, inflowUsd: 250, inflowEur: 300, dividendsUsd: 50 }
    );
    assert.equal(inflows.sgd, 400);
    assert.equal(inflows.usd, 1300);
    assert.equal(inflows.eur, 2300);
  });

  test('syncPapaRatesForCreatedMonth pre-stamps next month on rollover, preserves overrides, and deduplicates dispatch()', c => {
    const cells = {
      K5: { v: 0.0392, f: '' }, K6: { v: 0.0244, f: '' }, K7: { v: 0.0155, f: '' }, K8: { v: null, f: '' },
      // Row 32 = Nov 2026 (closed/stamped -> rates must NOT be overwritten; live FX formulas P32/Q32 freeze)
      A32: { v: new Date(Date.UTC(2026, 10, 1)), f: '=DATE(2026;11;1)' },
      M32: { v: 0.0392, f: '' }, N32: { v: 0.0244, f: '' }, O32: { v: 0.0155, f: '' },
      P32: { v: 1.2894, f: '=$F$6' }, Q32: { v: 1.4156, f: '=$F$7' },
      // Row 33 = Dec 2026 (formula-driven -> stamped when Декабрь'26 is created on Nov 30; manual N33 preserved)
      A33: { v: new Date(Date.UTC(2026, 11, 1)), f: '=DATE(2026;12;1)' },
      M33: { v: '', f: '=IF($A33>DATE(YEAR(TODAY());MONTH(TODAY());1);"";$K$5)' },
      N33: { v: 0.0275, f: '' }, // manual override
      O33: { v: '', f: '' },     // blank
      P33: { v: 1.2894, f: '=$F$6' }, Q33: { v: 1.4156, f: '=$F$7' },
      // Row 34 = Jan 2027 (future -> must NOT be stamped)
      A34: { v: new Date(Date.UTC(2027, 0, 1)), f: '=DATE(2027;1;1)' },
      M34: { v: '', f: '=IF($A34>DATE(YEAR(TODAY());MONTH(TODAY());1);"";$K$5)' },
      N34: { v: '', f: '=IF($A34>DATE(YEAR(TODAY());MONTH(TODAY());1);"";$K$6)' },
      O34: { v: '', f: '=IF($A34>DATE(YEAR(TODAY());MONTH(TODAY());1);"";$K$7)' }
    };
    const colLetter = col => String.fromCharCode(64 + col);
    const getCell = a1 => (cells[a1] || (cells[a1] = { v: '', f: '' }));
    const sheet = {
      getLastRow: () => 34,
      getRange: (a, b, rows, cols) => {
        if (typeof a === 'string') {
          return {
            getValue: () => getCell(a).v,
            setValue: val => { cells[a] = { v: val, f: '' }; }
          };
        }
        const rCount = rows || 1, cCount = cols || 1;
        return {
          getValues: () => Array.from({ length: rCount }, (_, ri) =>
            Array.from({ length: cCount }, (_, ci) => getCell(colLetter(b + ci) + (a + ri)).v)),
          getFormulas: () => Array.from({ length: rCount }, (_, ri) =>
            Array.from({ length: cCount }, (_, ci) => getCell(colLetter(b + ci) + (a + ri)).f)),
          setValue: val => { cells[colLetter(b) + a] = { v: val, f: '' }; }
        };
      }
    };
    const ss = {
      getId: () => 'live-budget-2026',
      getSheetByName: name => name === '[Automated] Папа debt' ? sheet : null
    };
    const mockFetch = url => {
      if (url.includes('newyorkfed')) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ refRates: [{ percentRate: 3.75 }] }) };
      if (url.includes('ecb.europa.eu')) return { getResponseCode: () => 200, getContentText: () => 'OBS_VALUE\n2.65\n' };
      return { getResponseCode: () => 503, getContentText: () => 'down' }; // MAS 503 -> fallback to K7 (0.0155)
    };

    // Rollover runs on Nov 30 creating Dec 2026
    const rollover = c.syncPapaRatesForCreatedMonth(2026, 12, ss, mockFetch, new Date('2026-11-30T00:05:00+08:00'));
    assert.deepEqual(Array.from(rollover.stampedRows), [33]);
    assert.deepEqual(Array.from(rollover.frozenFxRows), [32]);
    assert.equal(cells.P32.f, '');     // Nov FX frozen as static value
    assert.equal(cells.P32.v, 1.2894);
    assert.equal(cells.P33.f, '=$F$6'); // Dec FX stays live formula
    assert.equal(cells.K5.v, 0.0375);
    assert.equal(cells.K6.v, 0.0265);
    assert.equal(cells.K7.v, 0.0155); // fallback preserved on 503
    assert.equal(cells.M32.v, 0.0392); // Nov closed month untouched
    assert.equal(cells.M33.v, 0.0375); // Dec formula cell stamped
    assert.equal(cells.N33.v, 0.0275); // Dec manual override untouched
    assert.equal(cells.O33.v, 0.0155); // Dec blank cell stamped with fallback
    assert.equal(cells.M34.v, '');     // Jan 2027 future month untouched

    // Dispatch heartbeat on Dec 1 sees 2026-12 already synced by rollover and skips
    const decHeartbeat = c.runScheduledPapaRateSync(new Date('2026-12-01T02:00:00Z'), ss, mockFetch);
    assert.equal(decHeartbeat.skipped, true);
  });
};
