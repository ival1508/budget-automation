/**
 * Automated monthly money-market benchmark sync and deterministic helpers for the
 * "[Automated] Папа debt" tab.
 * File: papaDebt.gs
 *
 * Runs automatically whenever createMonthTab() creates the next month tab (on the last day
 * of the month at 00:00 SGT or via Budget -> Create next month tab now), with a once-per-month
 * fallback in dispatch() for cross-year or pre-existing month tabs.
 *
 * Benchmarks (free official central-bank APIs, no keys required):
 * - USD: NY Fed SOFR (30-observation trailing average)
 * - EUR: ECB Euro Short-Term Rate (€STR)
 * - SGD: MAS Domestic Interest Rates (1-month compounded SORA, fallback overnight SORA)
 */

const PAPA_DEBT_CONFIG = {
  SHEET_NAME: '[Automated] Папа debt',
  FIRST_AUTOMATED_ROW: 31, // Row 31 = окт. 2026; Row 32 = нояб. 2026 onward
  LAST_SCHEDULE_ROW: 49,
  LIVE_RATE_CELLS: { USD: 'K5', EUR: 'K6', SGD: 'K7', UPDATED: 'K8' },
  MONTH_RATE_COLS: { USD: 13, EUR: 14, SGD: 15 }, // M, N, O
  MIN_VALID_RATE: 0,
  MAX_VALID_RATE: 0.25,
  ENDPOINTS: {
    USD_SOFR: 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/30.json',
    EUR_ESTR: 'https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?lastNObservations=1&format=csvdata',
    SGD_SORA: 'https://eservices.mas.gov.sg/api/action/datastore/search.json?resource_id=9a0bf149-308c-4bd2-832d-76c8e6cb47ed&limit=5&sort=end_of_day%20desc'
  }
};

function isValidAnnualRate(rate) {
  return typeof rate === 'number' && Number.isFinite(rate) &&
    rate >= PAPA_DEBT_CONFIG.MIN_VALID_RATE && rate <= PAPA_DEBT_CONFIG.MAX_VALID_RATE;
}

function roundRate4(rate) {
  return Math.round(rate * 10000) / 10000;
}

function isDateValue(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime());
}

/** Parses NY Fed SOFR JSON (percentRate values in % -> decimal annual rate). */
function parseNyFedSofrRate(text) {
  const payload = JSON.parse(String(text || '{}'));
  const rates = Array.isArray(payload.refRates) ? payload.refRates : [];
  const valid = rates
    .map(item => Number(item && item.percentRate))
    .filter(num => Number.isFinite(num) && num >= 0 && num <= 25);
  if (!valid.length) return null;
  const avgPct = valid.reduce((sum, val) => sum + val, 0) / valid.length;
  const decimal = roundRate4(avgPct / 100);
  return isValidAnnualRate(decimal) ? decimal : null;
}

/** Parses ECB Data Portal SDMX CSV (OBS_VALUE column in % -> decimal annual rate). */
function parseEcbEstrCsvRate(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(',').map(col => col.replace(/^"|"$/g, '').trim());
  const obsIdx = header.indexOf('OBS_VALUE');
  if (obsIdx === -1) return null;
  for (let i = lines.length - 1; i >= 1; i--) {
    const cols = lines[i].split(',').map(col => col.replace(/^"|"$/g, '').trim());
    const pct = Number(cols[obsIdx]);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 25) {
      const decimal = roundRate4(pct / 100);
      if (isValidAnnualRate(decimal)) return decimal;
    }
  }
  return null;
}

/** Parses MAS DataStore JSON (comp_sora_1m preferred, fallback to overnight sora). */
function parseMasSoraRate(text) {
  const payload = JSON.parse(String(text || '{}'));
  const records = payload && payload.result && Array.isArray(payload.result.records)
    ? payload.result.records : [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] || {};
    const candidate = rec.comp_sora_1m !== undefined && rec.comp_sora_1m !== null && rec.comp_sora_1m !== ''
      ? Number(rec.comp_sora_1m)
      : Number(rec.sora);
    if (Number.isFinite(candidate) && candidate >= 0 && candidate <= 25) {
      const decimal = roundRate4(candidate / 100);
      if (isValidAnnualRate(decimal)) return decimal;
    }
  }
  return null;
}

/**
 * Fetches latest official USD, EUR, SGD money-market annual rates.
 * Each currency fails independently so partial outages never corrupt the other rates.
 */
function fetchMonthlyMoneyMarketRates(optFetch) {
  const doFetch = typeof optFetch === 'function'
    ? optFetch
    : url => UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });

  const result = { USD: null, EUR: null, SGD: null, sources: {}, errors: {} };
  const specs = [
    { key: 'USD', url: PAPA_DEBT_CONFIG.ENDPOINTS.USD_SOFR, parse: parseNyFedSofrRate, label: 'NY Fed SOFR' },
    { key: 'EUR', url: PAPA_DEBT_CONFIG.ENDPOINTS.EUR_ESTR, parse: parseEcbEstrCsvRate, label: 'ECB €STR' },
    { key: 'SGD', url: PAPA_DEBT_CONFIG.ENDPOINTS.SGD_SORA, parse: parseMasSoraRate, label: 'MAS 1M SORA' }
  ];

  specs.forEach(spec => {
    try {
      const resp = doFetch(spec.url);
      const code = resp && typeof resp.getResponseCode === 'function' ? resp.getResponseCode() : 0;
      if (code !== 200) {
        result.errors[spec.key] = `HTTP ${code}`;
        return;
      }
      const rate = spec.parse(resp.getContentText());
      if (isValidAnnualRate(rate)) {
        result[spec.key] = rate;
        result.sources[spec.key] = spec.label;
      } else {
        result.errors[spec.key] = 'Unparseable or out-of-bounds rate';
      }
    } catch (err) {
      result.errors[spec.key] = err && err.message ? err.message : String(err);
    }
  });

  return result;
}

/**
 * Deterministic single-month step for Папа debt:
 * 1) Accrues monthly interest (rate / 12) on opening USD/EUR/SGD balances.
 * 2) Adds inflows (SGD/USD/EUR) and USD dividends.
 * 3) Applies SGD reimbursements via waterfall: SGD -> USD -> EUR.
 */
function computePapaMonthStep(prev, rates, fx, flows) {
  const prevUsd = Number(prev.usd) || 0;
  const prevEur = Number(prev.eur) || 0;
  const prevSgd = Number(prev.sgd) || 0;
  const rUsd = Number(rates.usd) || 0;
  const rEur = Number(rates.eur) || 0;
  const rSgd = Number(rates.sgd) || 0;
  const fxUsd = Number(fx.usdSgd);
  const fxEur = Number(fx.eurSgd);
  if (!(fxUsd > 0) || !(fxEur > 0)) throw new Error('Positive FX rates are required.');

  const reimbSgd = Math.max(0, Number(flows && flows.reimbSgd) || 0);
  const inSgd = Math.max(0, Number(flows && flows.inflowSgd) || 0);
  const inUsd = Math.max(0, Number(flows && flows.inflowUsd) || 0);
  const inEur = Math.max(0, Number(flows && flows.inflowEur) || 0);
  const divUsd = Math.max(0, Number(flows && flows.dividendsUsd) || 0);

  const monthInterestSgd = Math.round((prevUsd * (rUsd / 12) * fxUsd +
    prevEur * (rEur / 12) * fxEur + prevSgd * (rSgd / 12)) * 100) / 100;

  const preSgd = prevSgd * (1 + rSgd / 12) + inSgd;
  const usedOnSgd = Math.min(Math.max(preSgd, 0), reimbSgd);
  const remAfterSgd = reimbSgd - usedOnSgd;
  const nextSgd = Math.round((preSgd - usedOnSgd) * 100) / 100;

  const preUsd = prevUsd * (1 + rUsd / 12) + inUsd + divUsd;
  const usedOnUsd = Math.min(Math.max(preUsd, 0), remAfterSgd / fxUsd);
  const remAfterUsdSgd = remAfterSgd - usedOnUsd * fxUsd;
  const nextUsd = Math.round((preUsd - usedOnUsd) * 100) / 100;

  const preEur = prevEur * (1 + rEur / 12) + inEur;
  const nextEur = Math.round((preEur - remAfterUsdSgd / fxEur) * 100) / 100;

  const totalOwedSgd = Math.round((nextUsd * fxUsd + nextEur * fxEur + nextSgd) * 100) / 100;
  return {
    usd: nextUsd,
    eur: nextEur,
    sgd: nextSgd,
    monthInterestSgd: monthInterestSgd,
    totalOwedSgd: totalOwedSgd
  };
}

/**
 * Updates live benchmark cells (K5:K8) and stamps any un-stamped schedule rows up through
 * targetMonthKey (default: current SGT month) on "[Automated] Папа debt" without overwriting
 * manual overrides or already-stamped closed months.
 */
function updatePapaMonthlyRates(optSs, optNow, optFetch, optTargetMonthKey) {
  const ss = getActiveBudgetSpreadsheet(optSs);
  if (!ss) throw new Error('No active spreadsheet found.');
  const sheet = ss.getSheetByName(PAPA_DEBT_CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Tab "${PAPA_DEBT_CONFIG.SHEET_NAME}" not found.`);

  const now = isDateValue(optNow) ? optNow : new Date();
  const currentYear = Number(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy'));
  const currentMonth = Number(Utilities.formatDate(now, 'Asia/Singapore', 'M'));
  const targetMonthKey = optTargetMonthKey || `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

  const fetched = fetchMonthlyMoneyMarketRates(optFetch);
  const currentLive = {
    USD: Number(sheet.getRange(PAPA_DEBT_CONFIG.LIVE_RATE_CELLS.USD).getValue()),
    EUR: Number(sheet.getRange(PAPA_DEBT_CONFIG.LIVE_RATE_CELLS.EUR).getValue()),
    SGD: Number(sheet.getRange(PAPA_DEBT_CONFIG.LIVE_RATE_CELLS.SGD).getValue())
  };

  const effective = {
    USD: isValidAnnualRate(fetched.USD) ? fetched.USD : (isValidAnnualRate(currentLive.USD) ? currentLive.USD : null),
    EUR: isValidAnnualRate(fetched.EUR) ? fetched.EUR : (isValidAnnualRate(currentLive.EUR) ? currentLive.EUR : null),
    SGD: isValidAnnualRate(fetched.SGD) ? fetched.SGD : (isValidAnnualRate(currentLive.SGD) ? currentLive.SGD : null)
  };

  if (isValidAnnualRate(fetched.USD)) sheet.getRange(PAPA_DEBT_CONFIG.LIVE_RATE_CELLS.USD).setValue(fetched.USD);
  if (isValidAnnualRate(fetched.EUR)) sheet.getRange(PAPA_DEBT_CONFIG.LIVE_RATE_CELLS.EUR).setValue(fetched.EUR);
  if (isValidAnnualRate(fetched.SGD)) sheet.getRange(PAPA_DEBT_CONFIG.LIVE_RATE_CELLS.SGD).setValue(fetched.SGD);

  const anyFetched = isValidAnnualRate(fetched.USD) || isValidAnnualRate(fetched.EUR) || isValidAnnualRate(fetched.SGD);
  if (anyFetched) {
    const day = Number(Utilities.formatDate(now, 'Asia/Singapore', 'd'));
    sheet.getRange(PAPA_DEBT_CONFIG.LIVE_RATE_CELLS.UPDATED).setValue(new Date(currentYear, currentMonth - 1, day));
  }

  const startRow = PAPA_DEBT_CONFIG.FIRST_AUTOMATED_ROW + 1; // Row 32 (Nov 2026) onward
  const lastRow = Math.max(startRow, Math.min(sheet.getLastRow(), PAPA_DEBT_CONFIG.LAST_SCHEDULE_ROW));
  const rowCount = lastRow - startRow + 1;
  const monthDates = sheet.getRange(startRow, 1, rowCount, 1).getValues();
  const rateRange = sheet.getRange(startRow, PAPA_DEBT_CONFIG.MONTH_RATE_COLS.USD, rowCount, 3);
  const rateValues = rateRange.getValues();
  const rateFormulas = rateRange.getFormulas();
  const fxRange = sheet.getRange(startRow, PAPA_DEBT_CONFIG.MONTH_RATE_COLS.USD + 3, rowCount, 2); // P, Q
  const fxValues = fxRange.getValues();
  const fxFormulas = fxRange.getFormulas();
  const stampedRows = [];
  const frozenFxRows = [];

  for (let i = 0; i < rowCount; i++) {
    const cellDate = monthDates[i][0];
    if (!isDateValue(cellDate)) continue;
    const rowYm = Utilities.formatDate(cellDate, 'Asia/Singapore', 'yyyy-MM');
    if (rowYm > targetMonthKey) continue;

    const rowNum = startRow + i;
    const keys = ['USD', 'EUR', 'SGD'];
    let rowChanged = false;
    for (let c = 0; c < 3; c++) {
      const rate = effective[keys[c]];
      if (!isValidAnnualRate(rate)) continue;
      const hasFormula = Boolean(String(rateFormulas[i][c] || '').trim());
      const isBlank = rateValues[i][c] === '' || rateValues[i][c] === null || rateValues[i][c] === undefined;
      // Only stamp cells that are still formula-driven or blank; preserve static/manual values.
      if (hasFormula || isBlank) {
        sheet.getRange(rowNum, PAPA_DEBT_CONFIG.MONTH_RATE_COLS.USD + c).setValue(rate);
        rowChanged = true;
      }
    }
    if (rowChanged) stampedRows.push(rowNum);

    // Freeze FX on months strictly before targetMonthKey once evaluated to a positive number.
    if (rowYm < targetMonthKey) {
      let fxChanged = false;
      for (let f = 0; f < 2; f++) {
        const hasFormula = Boolean(String(fxFormulas[i][f] || '').trim());
        const fxNum = Number(fxValues[i][f]);
        if (hasFormula && Number.isFinite(fxNum) && fxNum > 0) {
          sheet.getRange(rowNum, PAPA_DEBT_CONFIG.MONTH_RATE_COLS.USD + 3 + f).setValue(roundRate4(fxNum));
          fxChanged = true;
        }
      }
      if (fxChanged) frozenFxRows.push(rowNum);
    }
  }

  return {
    monthKey: targetMonthKey,
    fetched: fetched,
    effective: effective,
    stampedRows: stampedRows,
    frozenFxRows: frozenFxRows
  };
}

/**
 * Called automatically when createMonthTab(year, month) creates a new monthly budget tab
 * (typically 00:00 SGT on the last day of the prior month). Pre-stamps the new month's
 * money-market rates and marks the month synced so dispatch() does not duplicate work.
 */
function syncPapaRatesForCreatedMonth(year, month, optSs, optFetch, optNow) {
  const ss = getActiveBudgetSpreadsheet(optSs);
  if (!ss || typeof ss.getSheetByName !== 'function') return { skipped: true, reason: 'no_spreadsheet' };
  if (typeof SHEET_FACTS !== 'undefined' && ss.getId && ss.getId() === SHEET_FACTS.TEST_SPREADSHEET_ID) {
    return { skipped: true, reason: 'sandbox' };
  }
  if (!ss.getSheetByName(PAPA_DEBT_CONFIG.SHEET_NAME)) {
    return { skipped: true, reason: 'tab_missing' };
  }
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const props = PropertiesService.getScriptProperties();
  const propKey = 'papa_rates_synced_' + monthKey;
  if (props.getProperty(propKey) === 'done') return { skipped: true, monthKey: monthKey };

  const result = updatePapaMonthlyRates(ss, optNow, optFetch, monthKey);
  const anyLive = isValidAnnualRate(result.fetched.USD) ||
    isValidAnnualRate(result.fetched.EUR) || isValidAnnualRate(result.fetched.SGD);
  if (anyLive) {
    props.setProperty(propKey, 'done');
  }
  Logger.log(`[Папа Rates / Month Rollover] ${monthKey}: USD=${result.effective.USD}, EUR=${result.effective.EUR}, SGD=${result.effective.SGD}, stamped=${JSON.stringify(result.stampedRows)}`);
  return result;
}

/**
 * Monthly heartbeat safety-net called from dispatch().
 * No-ops if createMonthTab() already synced this month on the prior month's last day;
 * catches up automatically on the 1st of the month for cross-year or pre-existing tabs.
 */
function runScheduledPapaRateSync(optNow, optSs, optFetch) {
  const now = isDateValue(optNow) ? optNow : new Date();
  const monthKey = Utilities.formatDate(now, 'Asia/Singapore', 'yyyy-MM');
  const props = PropertiesService.getScriptProperties();
  const propKey = 'papa_rates_synced_' + monthKey;
  if (props.getProperty(propKey) === 'done') return { skipped: true, monthKey: monthKey };

  let ss = null;
  try { ss = getActiveBudgetSpreadsheet(optSs); } catch (_) { ss = null; }
  if (!ss || !ss.getSheetByName(PAPA_DEBT_CONFIG.SHEET_NAME)) {
    return { skipped: true, reason: 'tab_missing', monthKey: monthKey };
  }

  const result = updatePapaMonthlyRates(ss, now, optFetch, monthKey);
  const anyLive = isValidAnnualRate(result.fetched.USD) ||
    isValidAnnualRate(result.fetched.EUR) || isValidAnnualRate(result.fetched.SGD);
  if (anyLive) {
    props.setProperty(propKey, 'done');
  }
  Logger.log(`[Папа Rates] ${monthKey}: USD=${result.effective.USD}, EUR=${result.effective.EUR}, SGD=${result.effective.SGD}, stamped=${JSON.stringify(result.stampedRows)}`);
  return result;
}

/** Sheets menu entry point: Budget -> Update Папа monthly rates. */
function updatePapaMonthlyRatesFromMenu() {
  const result = updatePapaMonthlyRates();
  const fmt = v => isValidAnnualRate(v) ? (v * 100).toFixed(2) + '%' : 'n/a';
  const lines = [
    `${PAPA_DEBT_CONFIG.SHEET_NAME} monthly benchmarks (${result.monthKey}):`,
    `• USD (SOFR): ${fmt(result.effective.USD)}` + (result.fetched.errors.USD ? ` [fallback: ${result.fetched.errors.USD}]` : ' [live]'),
    `• EUR (€STR): ${fmt(result.effective.EUR)}` + (result.fetched.errors.EUR ? ` [fallback: ${result.fetched.errors.EUR}]` : ' [live]'),
    `• SGD (1M SORA): ${fmt(result.effective.SGD)}` + (result.fetched.errors.SGD ? ` [fallback: ${result.fetched.errors.SGD}]` : ' [live]'),
    `Stamped rows: ${result.stampedRows.length ? result.stampedRows.join(', ') : 'none (existing month rates preserved)'}`
  ];
  SpreadsheetApp.getUi().alert('Папа Monthly Rates Updated', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}
