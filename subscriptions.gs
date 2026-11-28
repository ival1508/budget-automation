/**
 * Step 4: Automated Subscription Radar ("Подписки") — Live Run-Rate, Price-Hike (>3%),
 * Overlap/Duplicate, Zombie-Charge & Annual Renewal Detection + Auto-Registration Hook.
 * File: subscriptions.gs
 */

const SUBSCRIPTIONS_SHEET = 'Подписки';
const SUBSCRIPTIONS_CORE_START_ROW = 10;
const SUBSCRIPTIONS_CORE_END_ROW = 31;
const SUBSCRIPTIONS_TOTAL_ROW = 32;
const SUBSCRIPTIONS_WATCHLIST_START_ROW = 36;
const SUBSCRIPTIONS_WATCHLIST_END_ROW = 38;
const SUBSCRIPTIONS_UNMAPPED_START_ROW = 43;
const SUBSCRIPTIONS_UNMAPPED_END_ROW = 47;

const SUBSCRIPTION_MONTH_MAP_ = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
});

function parseSubMoney_(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (val === null || val === undefined || val === '') return 0;
  const cleaned = String(val)
    .replace(/\u00a0/g, '')
    .replace(/S\$/gi, '')
    .replace(/\$/g, '')
    .replace(/\s+/g, '')
    .replace(/,(\d{1,2})$/, '.$1')
    .replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function formatSubDate_(val, tz) {
  if (!val || val === '—') return '—';
  if (val instanceof Date || (typeof val === 'object' && typeof val.getTime === 'function')) {
    const d = new Date(val.getTime());
    return Utilities.formatDate(d, tz || 'Asia/Singapore', 'dd.MM.yyyy');
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(val) * 86400000);
    return Utilities.formatDate(d, 'UTC', 'dd.MM.yyyy');
  }
  return String(val).trim() || '—';
}

function escapeSubRegex_(str) {
  return String(str || '').trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ordinalDayLabel_(dayNum) {
  const d = Number(dayNum) || 1;
  const mod100 = d % 100;
  if (mod100 >= 11 && mod100 <= 13) return d + 'th';
  if (d % 10 === 1) return d + 'st';
  if (d % 10 === 2) return d + 'nd';
  if (d % 10 === 3) return d + 'rd';
  return d + 'th';
}

function parseRenewalMonth_(billingLabel) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(String(billingLabel || ''));
  if (!m) return null;
  return SUBSCRIPTION_MONTH_MAP_[m[1].slice(0, 3).toLowerCase()] || null;
}

/**
 * Reads live 'Подписки' Subscription Radar metrics, anomalies, upcoming annual renewals,
 * cross-category recurring watchlist, and auto-discovered unmapped merchants.
 * Returns null when 'Подписки' tab is absent.
 */
function readSubscriptionRadarStatus(optSs, optAsOf) {
  try {
    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (!ss || typeof ss.getSheetByName !== 'function') return null;
    const sheet = ss.getSheetByName(SUBSCRIPTIONS_SHEET);
    if (!sheet || sheet.getLastRow() < SUBSCRIPTIONS_TOTAL_ROW) return null;

    const tz = (typeof ss.getSpreadsheetTimeZone === 'function' && ss.getSpreadsheetTimeZone()) || 'Asia/Singapore';
    const rawAsOf = (optAsOf && typeof optAsOf.getTime === 'function') ? new Date(optAsOf.getTime()) : new Date();
    const asOfParts = calendarDateParts(rawAsOf);
    const nextMonthNum = (asOfParts.month % 12) + 1;

    const maxRow = Math.min(50, Math.max(SUBSCRIPTIONS_TOTAL_ROW, sheet.getLastRow()));
    const grid = sheet.getRange(1, 1, maxRow, 12).getValues();
    const rowAt = r => grid[r - 1] || [];

    const titleBanner = String(rowAt(1)[0] || '');
    const yrMatch = /\b(202[6-9]|203\d)\b/.exec(titleBanner);
    const planYear = yrMatch ? Number(yrMatch[1]) : asOfParts.year;

    const targetMonthlySgd = Number((parseSubMoney_(rowAt(1)[11]) || 250).toFixed(2));
    const monthlyBaseSgd = Number(parseSubMoney_(rowAt(5)[0]).toFixed(2));
    const annualAmortizedSgd = Number(parseSubMoney_(rowAt(5)[2]).toFixed(2));
    const allInRunRateSgd = Number((parseSubMoney_(rowAt(5)[4]) || (monthlyBaseSgd + annualAmortizedSgd)).toFixed(2));
    const ytdNetSpendSgd = Number(parseSubMoney_(rowAt(5)[6]).toFixed(2));
    const householdRecurringSgd = Number(parseSubMoney_(rowAt(5)[10]).toFixed(2));
    const headroomMonthlySgd = Number((targetMonthlySgd - allInRunRateSgd).toFixed(2));

    const items = [];
    const priceHikes = [];
    const overlapsAndDuplicates = [];
    const zombieCharges = [];
    const upcomingRenewals = [];

    for (let r = SUBSCRIPTIONS_CORE_START_ROW; r <= Math.min(SUBSCRIPTIONS_CORE_END_ROW, maxRow); r++) {
      const cells = rowAt(r);
      const name = String(cells[0] || '').trim();
      if (!name) continue;
      const item = {
        row: r,
        name: name,
        regex: String(cells[1] || '').trim(),
        cycle: String(cells[2] || '').trim(),
        account: String(cells[3] || '').trim(),
        billing_schedule: String(cells[4] || '').trim(),
        baseline_sgd: Number(parseSubMoney_(cells[5]).toFixed(2)),
        latest_sgd: Number(parseSubMoney_(cells[6]).toFixed(2)),
        last_charged: formatSubDate_(cells[7], tz),
        ytd_charges: Math.round(parseSubMoney_(cells[8])),
        ytd_net_spend_sgd: Number(parseSubMoney_(cells[9]).toFixed(2)),
        monthly_equiv_sgd: Number(parseSubMoney_(cells[10]).toFixed(2)),
        signal: String(cells[11] || '').trim()
      };
      items.push(item);

      const isPriceHike = /price\s*hike/i.test(item.signal) ||
        (item.cycle !== 'Cancelled' && item.cycle !== 'One-off' && item.baseline_sgd > 0 && item.latest_sgd > item.baseline_sgd * 1.03);
      const isZombie = /zombie/i.test(item.signal);
      const isOverlapOrDup = !isPriceHike && !isZombie && /^⚠/.test(item.signal);

      if (isZombie) {
        zombieCharges.push(item);
      } else if (isPriceHike) {
        const pct = item.baseline_sgd > 0 ? Number(((item.latest_sgd / item.baseline_sgd - 1) * 100).toFixed(1)) : 0;
        priceHikes.push(Object.assign({}, item, { hike_pct: pct, delta_sgd: Number((item.latest_sgd - item.baseline_sgd).toFixed(2)) }));
      } else if (isOverlapOrDup) {
        overlapsAndDuplicates.push(item);
      }

      if (item.cycle === 'Annual') {
        const renMonth = parseRenewalMonth_(item.billing_schedule);
        if (renMonth === asOfParts.month || renMonth === nextMonthNum) {
          upcomingRenewals.push(Object.assign({}, item, {
            renewal_month: renMonth,
            is_next_month: renMonth === nextMonthNum
          }));
        }
      }
    }

    const watchlist = [];
    for (let r = SUBSCRIPTIONS_WATCHLIST_START_ROW; r <= Math.min(SUBSCRIPTIONS_WATCHLIST_END_ROW, maxRow); r++) {
      const cells = rowAt(r);
      const name = String(cells[0] || '').trim();
      if (!name) continue;
      watchlist.push({
        name: name,
        category: String(cells[2] || '').trim(),
        monthly_equiv_sgd: Number(parseSubMoney_(cells[10]).toFixed(2)),
        ytd_spend_sgd: Number(parseSubMoney_(cells[9]).toFixed(2))
      });
    }

    const unmappedMerchants = [];
    for (let r = SUBSCRIPTIONS_UNMAPPED_START_ROW; r <= Math.min(SUBSCRIPTIONS_UNMAPPED_END_ROW, maxRow); r++) {
      const cells = rowAt(r);
      const merchant = String(cells[0] || '').trim();
      if (!merchant) continue;
      unmappedMerchants.push({
        merchant: merchant,
        latest_sgd: Number(parseSubMoney_(cells[6]).toFixed(2)),
        last_seen: formatSubDate_(cells[7], tz),
        ytd_charges: Math.round(parseSubMoney_(cells[8])),
        ytd_spend_sgd: Number(parseSubMoney_(cells[9]).toFixed(2))
      });
    }

    const activeItems = items.filter(it => it.cycle === 'Monthly' || it.cycle === 'Annual');
    const totalAlerts = zombieCharges.length + priceHikes.length + overlapsAndDuplicates.length + unmappedMerchants.length;

    return {
      plan_year: planYear,
      monthly_base_sgd: monthlyBaseSgd,
      annual_amortized_sgd: annualAmortizedSgd,
      all_in_run_rate_sgd: allInRunRateSgd,
      annualized_run_rate_sgd: Number((allInRunRateSgd * 12).toFixed(2)),
      target_monthly_sgd: targetMonthlySgd,
      target_annual_sgd: Number((targetMonthlySgd * 12).toFixed(2)),
      headroom_monthly_sgd: headroomMonthlySgd,
      ytd_net_spend_sgd: ytdNetSpendSgd,
      watchlist_monthly_sgd: Number(watchlist.reduce((s, w) => s + w.monthly_equiv_sgd, 0).toFixed(2)),
      household_recurring_monthly_sgd: householdRecurringSgd || Number((allInRunRateSgd + watchlist.reduce((s, w) => s + w.monthly_equiv_sgd, 0)).toFixed(2)),
      active_count: activeItems.length,
      alert_count: totalAlerts,
      items: items,
      watchlist: watchlist,
      price_hikes: priceHikes,
      overlaps_and_duplicates: overlapsAndDuplicates,
      zombie_charges: zombieCharges,
      upcoming_renewals: upcomingRenewals,
      unmapped_merchants: unmappedMerchants
    };
  } catch (err) {
    Logger.log('readSubscriptionRadarStatus error: ' + err.message);
    return null;
  }
}

/**
 * Formats a concise Telegram HTML digest for /subs (or /subscriptions).
 */
function renderSubscriptionRadarTelegramSummary(status) {
  if (!status) {
    return 'ℹ️ <b>Подписки</b> (Subscription Radar) tab is not present in the active workbook.';
  }
  const html = typeof escapeCoachHtml === 'function' ? escapeCoachHtml : s => String(s);
  const money2 = v => (Number(v) < 0 ? '-' : '') + 'S$' + Math.abs(Number(v) || 0).toFixed(2);
  const money0 = v => (Number(v) < 0 ? '-' : '') + 'S$' + Math.round(Math.abs(Number(v) || 0)).toLocaleString('en-US');

  const headroomText = status.headroom_monthly_sgd >= 0
    ? (money0(status.headroom_monthly_sgd) + '/mo headroom vs ' + money0(status.target_monthly_sgd) + '/mo target')
    : ('🚨 ' + money0(Math.abs(status.headroom_monthly_sgd)) + '/mo OVER ' + money0(status.target_monthly_sgd) + '/mo target');

  const lines = [
    '📡 <b>Subscription Radar (Подписки ' + status.plan_year + ')</b>',
    '• <b>All-In Run-Rate:</b> <b>' + money2(status.all_in_run_rate_sgd) + '/mo</b> (' +
      money0(status.annualized_run_rate_sgd) + '/yr · ' + headroomText + ').',
    '• <b>Split:</b> ' + money2(status.monthly_base_sgd) + '/mo monthly plans + ' +
      money2(status.annual_amortized_sgd) + '/mo amortized annuals (' + status.active_count + ' active).',
    '• <b>' + status.plan_year + ' YTD Net Spend:</b> ' + money2(status.ytd_net_spend_sgd) +
      ' (plus ' + money0(status.watchlist_monthly_sgd) + '/mo Gym &amp; Telecoms memo → ' +
      money0(status.household_recurring_monthly_sgd) + '/mo household fixed).'
  ];

  if (status.zombie_charges.length || status.price_hikes.length || status.overlaps_and_duplicates.length || status.unmapped_merchants.length) {
    lines.push('', '<b>⚠️ Active Radar Alerts (' + status.alert_count + '):</b>');
    status.zombie_charges.forEach(z => {
      lines.push('◦ 🚨 <b>' + html(z.name) + ':</b> ' + html(z.signal));
    });
    status.price_hikes.forEach(h => {
      lines.push('◦ 📈 <b>' + html(h.name) + ':</b> ' + money2(h.baseline_sgd) + ' → <b>' +
        money2(h.latest_sgd) + '</b> (+' + h.hike_pct + '% · +' + money0(h.delta_sgd * 12) + '/yr)');
    });
    status.overlaps_and_duplicates.forEach(o => {
      lines.push('◦ ⚠️ <b>' + html(o.name) + ':</b> ' + html(o.signal.replace(/^⚠\s*/, '')));
    });
    status.unmapped_merchants.forEach(u => {
      lines.push('◦ 🆕 <b>Unmapped Подписки:</b> ' + html(u.merchant) + ' (' + money2(u.latest_sgd) + ' on ' + html(u.last_seen) + ')');
    });
  } else {
    lines.push('• ✅ <b>Radar Clean:</b> Zero price hikes, overlaps, zombie charges, or unmapped merchants.');
  }

  if (status.upcoming_renewals.length) {
    lines.push('', '<b>⏳ Upcoming Annual Renewals:</b>');
    status.upcoming_renewals.forEach(r => {
      lines.push('◦ <b>' + html(r.name) + '</b> (' + html(r.billing_schedule) + '): ' + money2(r.latest_sgd) + '/yr');
    });
  }

  const topMonthly = status.items
    .filter(it => it.cycle === 'Monthly' && it.monthly_equiv_sgd > 0)
    .sort((a, b) => b.monthly_equiv_sgd - a.monthly_equiv_sgd)
    .slice(0, 5);
  if (topMonthly.length) {
    lines.push('', '<b>Top Monthly Plans:</b> ' +
      topMonthly.map(it => html(it.name) + ' (' + money2(it.monthly_equiv_sgd) + ')').join(' · '));
  }

  return lines.join('\n');
}

/**
 * Renders the Quarterly Subscription Radar Brief (on Mar/Jun/Sep/Dec monthly reviews)
 * or a compact exception-only alert on non-quarter months when anomalies/renewals exist.
 */
function renderSubscriptionCoachLine(status, reportMonth) {
  if (!status) return '';
  const html = typeof escapeCoachHtml === 'function' ? escapeCoachHtml : s => String(s);
  const money0 = v => (Number(v) < 0 ? '-' : '') + 'S$' + Math.round(Math.abs(Number(v) || 0)).toLocaleString('en-US');
  const money2 = v => 'S$' + Math.abs(Number(v) || 0).toFixed(2);
  const isQuarterEnd = /^(?:\d{4})-(?:03|06|09|12)$/.test(String(reportMonth || ''));

  const alertSnippets = [];
  status.zombie_charges.forEach(z => alertSnippets.push('zombie charge on cancelled <b>' + html(z.name) + '</b>'));
  status.price_hikes.forEach(h => alertSnippets.push('price hike on <b>' + html(h.name) + '</b> (' + money2(h.baseline_sgd) + ' → ' + money2(h.latest_sgd) + ', +' + h.hike_pct + '%)'));
  status.overlaps_and_duplicates.forEach(o => alertSnippets.push(html(o.name) + ' (' + html(o.signal.replace(/^⚠\s*/, '')) + ')'));
  status.unmapped_merchants.forEach(u => alertSnippets.push('new unmapped <b>' + html(u.merchant) + '</b> (' + money2(u.latest_sgd) + ')'));

  const bigRenewals = status.upcoming_renewals.filter(r => r.latest_sgd >= 50);
  if (bigRenewals.length) {
    alertSnippets.push('annual renewal window: ' + bigRenewals.map(r => html(r.name) + ' ' + money0(r.latest_sgd) + ' (' + html(r.billing_schedule) + ')').join(', '));
  }

  if (isQuarterEnd) {
    const paceClause = status.headroom_monthly_sgd >= 0
      ? (money0(status.headroom_monthly_sgd) + '/mo under the ' + money0(status.target_monthly_sgd) + '/mo target')
      : ('<b>' + money0(Math.abs(status.headroom_monthly_sgd)) + '/mo over</b> the ' + money0(status.target_monthly_sgd) + '/mo target');
    const detailClause = alertSnippets.length
      ? (' Flagged: ' + alertSnippets.slice(0, 4).join('; ') + (alertSnippets.length > 4 ? '; see <code>/subs</code> for all ' + status.alert_count + ' items.' : '.'))
      : ' All active plans match baseline with zero overlaps.';
    return '• <b>Quarterly Subscription Radar (Подписки):</b> all-in run-rate is <b>' +
      money2(status.all_in_run_rate_sgd) + '/mo</b> (' + money0(status.annualized_run_rate_sgd) + '/yr across ' +
      status.active_count + ' active plans; ' + paceClause + ').' + detailClause;
  }

  if (!alertSnippets.length) return '';
  return '• <b>Subscription Radar Watch:</b> ' + alertSnippets.slice(0, 3).join('; ') +
    (alertSnippets.length > 3 ? ' (run <code>/subs</code> for full list).' : '.');
}

/**
 * Post-write hook invoked inside withBudgetWriteLock after appendTransactionsUnlocked succeeds.
 * Automatically registers any brand-new 'Подписки' expense merchant into an open pre-allocated
 * slot (rows 29..31) in 'Подписки', preserving the pre-installed live formulas in Columns G..L.
 */
function syncSubscriptionsAfterWrite(transactionsArray, writeResult, optSs) {
  if (!writeResult || writeResult.dryRun || !Array.isArray(writeResult.writtenRows) || !writeResult.writtenRows.length) {
    return writeResult;
  }
  try {
    const subRows = writeResult.writtenRows.filter(rawTxn =>
      String(rawTxn.category || '').trim() === 'Подписки' &&
      (rawTxn.type === TRANSACTION_TYPES.EXPENSE ||
       rawTxn.type === TRANSACTION_TYPES.MANDATORY_EXPENSE ||
       rawTxn.type === TRANSACTION_TYPES.BIG_EXPENSE) &&
      (Number(rawTxn.amount_sgd !== undefined ? rawTxn.amount_sgd : rawTxn.amount) || 0) > 0
    );
    if (!subRows.length) return writeResult;

    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (!ss || typeof ss.getSheetByName !== 'function') return writeResult;
    const sheet = ss.getSheetByName(SUBSCRIPTIONS_SHEET);
    if (!sheet || sheet.getLastRow() < SUBSCRIPTIONS_CORE_END_ROW) return writeResult;

    const coreHeight = SUBSCRIPTIONS_CORE_END_ROW - SUBSCRIPTIONS_CORE_START_ROW + 1;
    const coreGrid = sheet.getRange(SUBSCRIPTIONS_CORE_START_ROW, 1, coreHeight, 6).getValues();

    const compiledRegexes = [];
    const emptySlotOffsets = [];
    for (let i = 0; i < coreGrid.length; i++) {
      const svc = String(coreGrid[i][0] || '').trim();
      const rxText = String(coreGrid[i][1] || '').trim();
      if (!svc) {
        emptySlotOffsets.push(i);
      } else if (rxText) {
        try {
          compiledRegexes.push(new RegExp(rxText, 'i'));
        } catch (_) {}
      }
    }

    let registeredCount = 0;
    subRows.forEach(rawTxn => {
      const merchant = String(rawTxn.where || '').trim();
      if (!merchant) return;
      const alreadyTracked = compiledRegexes.some(rx => rx.test(merchant));
      if (alreadyTracked || !emptySlotOffsets.length) return;

      const slotOffset = emptySlotOffsets.shift();
      const targetRow = SUBSCRIPTIONS_CORE_START_ROW + slotOffset;
      const sgdAmt = Number((Number(rawTxn.amount_sgd !== undefined ? rawTxn.amount_sgd : rawTxn.amount) || 0).toFixed(2));
      const notesAndWhere = [merchant, rawTxn.notes].filter(Boolean).join(' ');
      const isAnnual = /\b(annual|yearly|год[а-яё]*)\b/i.test(notesAndWhere) || sgdAmt >= 50;

      let scheduleStr = 'Monthly';
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(rawTxn.date || ''));
      if (dateMatch) {
        const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(dateMatch[2]) - 1];
        scheduleStr = isAnnual ? (monthShort + ' ' + dateMatch[3]) : ordinalDayLabel_(Number(dateMatch[3]));
      }

      const escapedRx = '^' + escapeSubRegex_(merchant) + '$';
      const metaCells = [
        merchant,
        escapedRx,
        isAnnual ? 'Annual' : 'Monthly',
        String(rawTxn.account || 'DBS CC SGD').trim(),
        scheduleStr,
        sgdAmt
      ];
      sheet.getRange(targetRow, 1, 1, 6).setValues([metaCells]);
      try {
        compiledRegexes.push(new RegExp(escapedRx, 'i'));
      } catch (_) {}
      registeredCount++;
    });

    if (registeredCount > 0) {
      writeResult.subscriptionSync = { registeredCount: registeredCount };
    }
  } catch (err) {
    Logger.log('Warning: syncSubscriptionsAfterWrite skipped: ' + err.message);
  }
  return writeResult;
}
