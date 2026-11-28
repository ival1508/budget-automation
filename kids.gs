/**
 * Step 5: Automated Kids Model 2A Core vs Hobby Split, Unclassified School Audit,
 * IBKR VT Sufficiency & Buy-Trigger Monitor, and Telegram /kids Command.
 * File: kids.gs
 */

const KIDS_SHEET = 'Kids';
const KIDS_LOW_VT_BUFFER_THRESHOLD = 30; // ~1 month of combined Glasha + Tema Model 2A VT accrual

const KIDS_HOBBY_REGEX = /bilingvi|climb|ground\s*up|rugby|tennis|alok|theater|daria|darya|club\s*zoom|swim|ballet|chess|piano|music|karate|gymnast|soccer|football|\[hobby\]|\[kid:\s*hobby\]/i;
const KIDS_GLASHA_CORE_REGEX = /brps|agora|\bmoe\b|goe(?:\.sg)?|mr\.?\s*tan|student\s*card|grandparents\s*day|glasha|глаш|science\s*centre|\[kid:\s*glasha\]|\[core:\s*glasha\]/i;
const KIDS_TEMA_CORE_REGEX = /maple\s*bear|maplebear|экскурси|tema|tyoma|teoma|т[её]м[аыуе]|\[kid:\s*(?:tema|tyoma|teoma|т[её]ма)\]|\[core:\s*(?:tema|tyoma|teoma|т[её]ма)\]/i;

function parseKidsNum_(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (val === null || val === undefined || val === '') return 0;
  const cleaned = String(val)
    .replace(/\u00a0/g, '')
    .replace(/S\$/gi, '')
    .replace(/\$/g, '')
    .replace(/%/g, '')
    .replace(/\s+/g, '')
    .replace(/,(\d{1,4})$/, '.$1')
    .replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Classifies a 'Школа & Детский сад' transaction into Model 2A buckets:
 *   'glasha_core' | 'tema_core' | 'excluded_hobby' | 'unclassified' | null (non-school)
 */
function classifyKidsSchoolTransaction(txn) {
  if (!txn || typeof txn !== 'object') return null;
  if (String(txn.category || '').trim() !== 'Школа & Детский сад') return null;
  const text = [txn.where, txn.notes, txn.raw_where].filter(Boolean).join(' ').trim();
  if (!text) return 'unclassified';
  if (KIDS_HOBBY_REGEX.test(text)) return 'excluded_hobby';
  if (KIDS_GLASHA_CORE_REGEX.test(text)) return 'glasha_core';
  if (KIDS_TEMA_CORE_REGEX.test(text)) return 'tema_core';
  return 'unclassified';
}

/**
 * Post-write audit hook chained in writer.gs (read-only on Kids; never fails a write).
 * Surfaces any brand-new unclassified 'Школа & Детский сад' expense rows so they can be tagged
 * [Kid: Glasha], [Kid: Tema], or [Kid: Hobby].
 */
function auditKidsTransactionsAfterWrite(transactionsArray, writeResult) {
  if (!writeResult || writeResult.dryRun || !Array.isArray(writeResult.writtenRows) || !writeResult.writtenRows.length) {
    return writeResult;
  }
  try {
    const schoolRows = writeResult.writtenRows.filter(rawTxn =>
      String(rawTxn.category || '').trim() === 'Школа & Детский сад' &&
      (rawTxn.type === TRANSACTION_TYPES.EXPENSE ||
       rawTxn.type === TRANSACTION_TYPES.FIXED_EXPENSE ||
       rawTxn.type === 'Большие расходы')
    );
    if (!schoolRows.length) return writeResult;

    const classified = { glasha_core: 0, tema_core: 0, excluded_hobby: 0, unclassified: [] };
    schoolRows.forEach(row => {
      const bucket = classifyKidsSchoolTransaction(row);
      if (bucket === 'unclassified') {
        classified.unclassified.push({
          date: String(row.date || ''),
          where: String(row.where || ''),
          amount_sgd: Number((Number(row.amount_sgd !== undefined ? row.amount_sgd : row.amount) || 0).toFixed(2))
        });
      } else if (bucket && classified[bucket] !== undefined) {
        classified[bucket]++;
      }
    });
    writeResult.kidsAudit = classified;
  } catch (err) {
    Logger.log('Warning: auditKidsTransactionsAfterWrite skipped: ' + err.message);
  }
  return writeResult;
}

/**
 * Locates Section 5 custody rows (LON:VWRA & NYSEARCA:VT) dynamically in Kids!A40:G55.
 */
function findKidsCustodyRows_(grid) {
  let vwraRow = -1;
  let vtRow = -1;
  for (let i = 35; i < grid.length; i++) {
    const label = String((grid[i] && grid[i][0]) || '').trim();
    if (/^LON:VWRA/i.test(label)) vwraRow = i + 1;
    else if (/^NYSEARCA:VT/i.test(label)) vtRow = i + 1;
  }
  return { vwraRow: vwraRow, vtRow: vtRow };
}

/**
 * Reads live 'Kids' Model 2A metrics, YTD Core vs Hobby audit, unclassified alerts,
 * and IBKR VT / VWRA custody sufficiency status. Returns null if 'Kids' tab is absent.
 */
function readKidsStatus(optSs, optAsOf) {
  try {
    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (!ss || typeof ss.getSheetByName !== 'function') return null;
    const sheet = ss.getSheetByName(KIDS_SHEET);
    if (!sheet || sheet.getLastRow() < 29) return null;

    const maxRow = Math.min(55, Math.max(29, sheet.getLastRow()));
    const grid = sheet.getRange(1, 1, maxRow, 11).getValues();
    const rowAt = r => grid[r - 1] || [];

    const titleBanner = String(rowAt(1)[0] || '');
    const totalLabel = String(rowAt(29)[0] || '');
    const yrMatch = /\b(202[6-9]|203\d)\b/.exec(totalLabel) || /\b(202[6-9]|203\d)\b/.exec(titleBanner);
    const asOf = (optAsOf && typeof optAsOf.getTime === 'function') ? new Date(optAsOf.getTime()) : new Date();
    const planYear = yrMatch ? Number(yrMatch[1]) : calendarDateParts(asOf).year;

    const vwraUsd = parseKidsNum_(rowAt(1)[8]);
    const vtUsd = parseKidsNum_(rowAt(2)[8]);
    const usdSgd = parseKidsNum_(rowAt(1)[10]) || 1.29;
    const vtSgdPrice = Number((vtUsd * usdSgd).toFixed(2)) || 193.73;

    const glashaVwra = Number(parseKidsNum_(rowAt(6)[1]).toFixed(2));
    const glashaVt = Number(parseKidsNum_(rowAt(7)[1]).toFixed(2));
    const temaVt = Number(parseKidsNum_(rowAt(7)[2]).toFixed(2));
    const combinedVwra = Number(parseKidsNum_(rowAt(6)[3]).toFixed(2));
    const combinedVt = Number(parseKidsNum_(rowAt(7)[3]).toFixed(2));

    const glashaValueSgd = Number(parseKidsNum_(rowAt(10)[1]).toFixed(2));
    const temaValueSgd = Number(parseKidsNum_(rowAt(10)[2]).toFixed(2));
    const combinedValueSgd = Number(parseKidsNum_(rowAt(10)[3]).toFixed(2));
    const combinedPrincipalSgd = Number(parseKidsNum_(rowAt(11)[3]).toFixed(2));
    const combinedGainSgd = Number(parseKidsNum_(rowAt(12)[3]).toFixed(2));
    const combinedRoiPct = combinedPrincipalSgd > 0
      ? Number(((combinedGainSgd / combinedPrincipalSgd) * 100).toFixed(1))
      : 0;

    // Section 2 YTD Accrual (Row 29)
    const glashaYtdCoreSgd = Number(parseKidsNum_(rowAt(29)[1]).toFixed(2));
    const glashaYtdNlcsSgd = Number(parseKidsNum_(rowAt(29)[2]).toFixed(2));
    const glashaYtdDeltaSgd = Number(parseKidsNum_(rowAt(29)[3]).toFixed(2));
    const glashaYtdVt = Number(parseKidsNum_(rowAt(29)[4]).toFixed(2));
    const temaYtdCoreSgd = Number(parseKidsNum_(rowAt(29)[5]).toFixed(2));
    const temaYtdNlcsSgd = Number(parseKidsNum_(rowAt(29)[6]).toFixed(2));
    const temaYtdDeltaSgd = Number(parseKidsNum_(rowAt(29)[7]).toFixed(2));
    const temaYtdVt = Number(parseKidsNum_(rowAt(29)[8]).toFixed(2));
    const ytdAuditNote = String(rowAt(29)[10] || '').trim();

    // Detect unclassified school months in Section 2 Col K
    const unclassifiedMonths = [];
    for (let r = 17; r <= 28; r++) {
      const note = String(rowAt(r)[10] || '').trim();
      if (/^⚠\s*Unclassified/i.test(note)) {
        unclassifiedMonths.push({ row: r, label: String(rowAt(r)[0] || '').trim(), note: note });
      }
    }

    // Section 5 IBKR / Saxo Custody & VT Sufficiency Monitor
    const custodyLoc = findKidsCustodyRows_(grid);
    let vwraHeld = 799;
    let vtHeld = 531;
    let vtStatusText = '';
    if (custodyLoc.vwraRow > 0) {
      vwraHeld = Number(parseKidsNum_(rowAt(custodyLoc.vwraRow)[2]).toFixed(2));
    }
    if (custodyLoc.vtRow > 0) {
      vtHeld = Number(parseKidsNum_(rowAt(custodyLoc.vtRow)[2]).toFixed(2));
      vtStatusText = String(rowAt(custodyLoc.vtRow)[5] || '').trim();
    }
    const vwraBuffer = Number((vwraHeld - combinedVwra).toFixed(2));
    const vtBuffer = Number((vtHeld - combinedVt).toFixed(2));
    const vtBuyNeededShares = vtBuffer < 0 ? Number(Math.abs(vtBuffer).toFixed(2)) : 0;
    const vtBuyNeededSgd = vtBuyNeededShares > 0 ? Number((vtBuyNeededShares * vtSgdPrice).toFixed(2)) : 0;

    return {
      plan_year: planYear,
      vt_sgd_price: vtSgdPrice,
      vwra_usd: vwraUsd,
      vt_usd: vtUsd,
      glasha: {
        vwra_shares: glashaVwra,
        vt_shares: glashaVt,
        value_sgd: glashaValueSgd,
        ytd_core_sgd: glashaYtdCoreSgd,
        ytd_nlcs_sgd: glashaYtdNlcsSgd,
        ytd_delta_sgd: glashaYtdDeltaSgd,
        ytd_vt_earned: glashaYtdVt
      },
      tema: {
        vt_shares: temaVt,
        value_sgd: temaValueSgd,
        ytd_core_sgd: temaYtdCoreSgd,
        ytd_nlcs_sgd: temaYtdNlcsSgd,
        ytd_delta_sgd: temaYtdDeltaSgd,
        ytd_vt_earned: temaYtdVt
      },
      combined: {
        vwra_shares: combinedVwra,
        vt_shares: combinedVt,
        value_sgd: combinedValueSgd,
        principal_sgd: combinedPrincipalSgd,
        gain_sgd: combinedGainSgd,
        roi_pct: combinedRoiPct,
        ytd_audit_note: ytdAuditNote
      },
      custody: {
        vwra_row: custodyLoc.vwraRow,
        vt_row: custodyLoc.vtRow,
        vwra_held_shares: vwraHeld,
        vwra_buffer_shares: vwraBuffer,
        vt_held_shares: vtHeld,
        vt_earmarked_shares: combinedVt,
        vt_buffer_shares: vtBuffer,
        vt_buy_needed_shares: vtBuyNeededShares,
        vt_buy_needed_sgd: vtBuyNeededSgd,
        vt_deficit: vtBuffer < 0,
        vt_low_buffer: vtBuffer >= 0 && vtBuffer < KIDS_LOW_VT_BUFFER_THRESHOLD,
        vt_status_text: vtStatusText
      },
      unclassified_months: unclassifiedMonths
    };
  } catch (err) {
    Logger.log('readKidsStatus error: ' + err.message);
    return null;
  }
}

/**
 * Updates IBKR VT household custody inventory in Kids Section 5 (`C49` in 2026 / `C51` in 2027)
 * from Telegram `/kids held <N> vt` or `/kids +<N> vt` under withBudgetWriteLock.
 */
function updateKidsVtInventory(textArgs, optSs) {
  const raw = String(textArgs || '').trim();
  const absMatch = /^(?:held|set|vt)\s+(\d+(?:[.,]\d+)?)\s*(?:vt|sh|shares?)?$/i.exec(raw);
  const deltaMatch = /^(?:buy\s+|add\s+)?([+-])\s*(\d+(?:[.,]\d+)?)\s*(?:vt|sh|shares?)?$/i.exec(raw) ||
    /^(?:buy|add)\s+(\d+(?:[.,]\d+)?)\s*(?:vt|sh|shares?)?$/i.exec(raw);

  if (!absMatch && !deltaMatch) {
    return { status: 'unmatched' };
  }

  const runWrite = typeof withBudgetWriteLock === 'function' ? withBudgetWriteLock : fn => fn();
  return runWrite(() => {
    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (!ss || typeof ss.getSheetByName !== 'function') throw new Error('Active spreadsheet unavailable.');
    const sheet = ss.getSheetByName(KIDS_SHEET);
    if (!sheet) throw new Error('Kids tab is missing.');

    const maxRow = Math.min(55, sheet.getLastRow());
    const grid = sheet.getRange(1, 1, maxRow, 7).getValues();
    const loc = findKidsCustodyRows_(grid);
    if (loc.vtRow < 0) {
      throw new Error('Kids Section 5 (NYSEARCA:VT custody row) not found.');
    }

    const priorHeld = Number(parseKidsNum_(grid[loc.vtRow - 1][2]).toFixed(4));
    let newHeld;
    if (absMatch) {
      newHeld = Number(parseKidsNum_(absMatch[1]).toFixed(4));
    } else if (deltaMatch.length >= 3 && (deltaMatch[1] === '+' || deltaMatch[1] === '-')) {
      const amt = parseKidsNum_(deltaMatch[2]);
      newHeld = Number((deltaMatch[1] === '-' ? Math.max(0, priorHeld - amt) : (priorHeld + amt)).toFixed(4));
    } else {
      const amt = parseKidsNum_(deltaMatch[1]);
      newHeld = Number((priorHeld + amt).toFixed(4));
    }

    sheet.getRange(loc.vtRow, 3, 1, 1).setValues([[newHeld]]);
    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp && typeof SpreadsheetApp.flush === 'function') {
      SpreadsheetApp.flush();
    }
    const updatedStatus = readKidsStatus(ss);
    return {
      status: 'updated',
      row: loc.vtRow,
      prior_held: priorHeld,
      new_held: newHeld,
      kids_status: updatedStatus
    };
  });
}

/**
 * Formats a concise Telegram HTML digest for /kids.
 */
function renderKidsTelegramSummary(status) {
  if (!status) {
    return 'ℹ️ <b>Kids</b> tab is not present in the active workbook.';
  }
  const html = typeof escapeCoachHtml === 'function' ? escapeCoachHtml : s => String(s);
  const m0 = v => (Number(v) < 0 ? '-' : '') + 'S$' + Math.round(Math.abs(Number(v) || 0)).toLocaleString('en-US');

  const lines = [
    '🎒 <b>Kids Investment Fund — Model 2A (' + status.plan_year + ')</b>',
    '• <b>Combined Value:</b> <b>' + m0(status.combined.value_sgd) + '</b> (Principal ' +
      m0(status.combined.principal_sgd) + ' · Gain ' + (status.combined.gain_sgd >= 0 ? '+' : '') +
      m0(status.combined.gain_sgd) + ' / <b>' + status.combined.roi_pct.toFixed(1) + '%</b> ROI).',
    '• <b>Глаша:</b> <b>' + m0(status.glasha.value_sgd) + '</b> (' + status.glasha.vwra_shares.toFixed(0) +
      ' VWRA + ' + status.glasha.vt_shares.toFixed(2) + ' VT · ' + status.plan_year + ' YTD Core ' +
      m0(status.glasha.ytd_core_sgd) + ' → +' + status.glasha.ytd_vt_earned.toFixed(2) + ' VT).',
    '• <b>Тёма:</b> <b>' + m0(status.tema.value_sgd) + '</b> (' + status.tema.vt_shares.toFixed(2) +
      ' VT · ' + status.plan_year + ' YTD Core ' + m0(status.tema.ytd_core_sgd) + ' → +' +
      status.tema.ytd_vt_earned.toFixed(2) + ' VT).'
  ];

  const c = status.custody;
  if (c.vt_deficit) {
    lines.push('• 🚨 <b>IBKR VT Buy Needed:</b> Earmarked <b>' + c.vt_earmarked_shares.toFixed(1) +
      ' VT</b> vs ' + c.vt_held_shares.toFixed(1) + ' held → <b>Buy ' + c.vt_buy_needed_shares.toFixed(1) +
      ' VT (~' + m0(c.vt_buy_needed_sgd) + ')</b> in IBKR.');
  } else if (c.vt_low_buffer) {
    lines.push('• ⚠️ <b>IBKR VT Buffer Low:</b> ' + c.vt_held_shares.toFixed(1) + ' held vs ' +
      c.vt_earmarked_shares.toFixed(1) + ' earmarked → only <b>+' + c.vt_buffer_shares.toFixed(1) +
      ' spare VT</b> left (plan next IBKR VT buy).');
  } else {
    lines.push('• ✅ <b>IBKR VT Custody Covered:</b> ' + c.vt_held_shares.toFixed(1) + ' held vs ' +
      c.vt_earmarked_shares.toFixed(1) + ' earmarked (<b>+' + c.vt_buffer_shares.toFixed(1) +
      ' spare VT</b> · VWRA +' + c.vwra_buffer_shares.toFixed(0) + ' spare).');
  }

  if (status.unclassified_months.length) {
    lines.push('• ⚠️ <b>Unclassified School Txns:</b> ' +
      status.unclassified_months.map(u => html(u.label) + ' (' + html(u.note) + ')').join('; '));
  } else if (status.combined.ytd_audit_note) {
    lines.push('• <b>Model 2A Audit:</b> ' + html(status.combined.ytd_audit_note));
  }

  lines.push('', '<i>Tip: after buying VT in IBKR, update custody via</i> <code>/kids +100 vt</code> <i>or</i> <code>/kids held 631 vt</code>.');
  return lines.join('\n');
}

/**
 * Deterministic Monthly Coach watch line for Kids VT Sufficiency & Unclassified School Txns.
 * Quiet when buffer >= 30 VT and 0 unclassified txns on non-quarter months.
 */
function renderKidsCoachLine(status, reportMonth) {
  if (!status || !status.custody) return '';
  const html = typeof escapeCoachHtml === 'function' ? escapeCoachHtml : s => String(s);
  const m0 = v => (Number(v) < 0 ? '-' : '') + 'S$' + Math.round(Math.abs(Number(v) || 0)).toLocaleString('en-US');
  const isQuarterEnd = /^(?:\d{4})-(?:03|06|09|12)$/.test(String(reportMonth || ''));
  const c = status.custody;

  const alerts = [];
  if (c.vt_deficit) {
    alerts.push('🚨 <b>Buy ' + c.vt_buy_needed_shares.toFixed(1) + ' VT (~' + m0(c.vt_buy_needed_sgd) +
      ')</b> in IBKR to cover Kids Model 2A accrual (' + c.vt_earmarked_shares.toFixed(1) + ' earmarked vs ' + c.vt_held_shares.toFixed(1) + ' held)');
  } else if (c.vt_low_buffer) {
    alerts.push('⚠️ IBKR VT buffer low: only <b>' + c.vt_buffer_shares.toFixed(1) + ' spare VT</b> left (~1 month of accrual) — plan next VT buy');
  }
  if (status.unclassified_months && status.unclassified_months.length) {
    alerts.push(status.unclassified_months.length + ' month(s) have unclassified Школа &amp; Детский сад spend (tag <code>[Kid: Glasha/Tema/Hobby]</code>)');
  }

  if (alerts.length) {
    return '• <b>Kids Model 2A &amp; VT Custody:</b> ' + alerts.join('; ') + ' (run <code>/kids</code>).';
  }
  if (isQuarterEnd) {
    return '• <b>Kids Model 2A Checkpoint:</b> combined fund at <b>' + m0(status.combined.value_sgd) +
      '</b> (Глаша ' + m0(status.glasha.value_sgd) + ' · Тёма ' + m0(status.tema.value_sgd) +
      '; IBKR VT custody covered with +' + c.vt_buffer_shares.toFixed(1) + ' spare VT).';
  }
  return '';
}

/**
 * Handles `/kids` or `/kids held <N> vt` / `/kids +<N> vt` from webhook.gs.
 */
function handleTelegramKidsCommand(chatId, textArgs, optSs) {
  const args = String(textArgs || '').trim();
  if (args) {
    const upd = updateKidsVtInventory(args, optSs);
    if (upd.status === 'updated') {
      const reply = '✅ <b>Updated IBKR VT Custody:</b> ' + upd.prior_held + ' → <b>' + upd.new_held +
        ' VT</b>\n\n' + renderKidsTelegramSummary(upd.kids_status);
      if (chatId && typeof sendTelegramMessage === 'function') sendTelegramMessage(reply, chatId);
      return { mode: 'updated', html: reply, update: upd };
    }
  }
  const status = readKidsStatus(optSs);
  const html = renderKidsTelegramSummary(status);
  if (chatId && typeof sendTelegramMessage === 'function') sendTelegramMessage(html, chatId);
  return { mode: 'status', html: html, status: status };
}
