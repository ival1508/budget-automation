/**
 * Step 2: Live "Отдых 2027 Plan" [Trip] Ledger Wiring, Wise Pinch-Point / Sweep Tracking,
 * and "CapitalPlan" (IRAS Dual S$80k Tax-Relief Cap Optimizer & Bonus/GSU Sinking-Fund Runway).
 * File: tripAndCapital.gs
 */

const TRAVEL_PLAN_SHEET = 'Отдых 2027 Plan';
const CAPITAL_PLAN_SHEET = 'CapitalPlan';
const TRAVEL_LEDGER_START_ROW = 68;
const TRAVEL_LEDGER_END_ROW = 250;

const DEFAULT_2027_TRIPS = Object.freeze([
  'London (Valeriy)',
  'Grandparents Apr–May (×2)',
  'Paris (Anniversary)',
  'Moscow (Kids + Rita)',
  'Tokyo (Family)',
  'Australia RWC (Valeriy)',
  'China Winter Ski',
  "Tatiana V. Jan'28 (×1)"
]);

function tripWordRegex_(inner) {
  return new RegExp('(?:^|[^A-Za-zА-Яа-яЁё0-9])(?:' + inner + ')(?=$|[^A-Za-zА-Яа-яЁё0-9])', 'i');
}

const TRIP_SHORTHAND_PATTERNS = Object.freeze([
  { pattern: tripWordRegex_('london|лондон[а-яё]*|lhr|gatwick'), match: /london/i },
  { pattern: tripWordRegex_('grandparents|бабушк[а-яё]*|родител[а-яё]*\\s+апр[а-яё]*'), match: /grandparents/i },
  { pattern: tripWordRegex_('paris|париж[а-яё]*|cdg|anniversary'), match: /paris/i },
  { pattern: tripWordRegex_('moscow|москв[а-яё]*|мск|шереметьев[а-яё]*|домодедов[а-яё]*'), match: /moscow/i },
  { pattern: tripWordRegex_('tokyo|токио|japan|япони[а-яё]*|narita|haneda|disneyland\\s*hotel|disneysea'), match: /tokyo/i },
  { pattern: tripWordRegex_('australia|австрали[а-яё]*|rwc|rugby\\s*world\\s*cup|sydney|melbourne|brisbane|perth'), match: /australia/i },
  { pattern: tripWordRegex_('china|кита[йяею][а-яё]*|beidahu|бэйдаху|harbin|харбин[а-яё]*|club\\s*med|winter\\s*ski|лыж[а-яё]*'), match: /china/i },
  { pattern: tripWordRegex_('tatiana|татьян[а-яё]*'), match: /tatiana/i }
]);

/**
 * Reads canonical trip names from 'Отдых 2027 Plan'!A3:A10 when available,
 * falling back to DEFAULT_2027_TRIPS.
 */
function getConfiguredTripNames(optSs) {
  try {
    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (ss && typeof ss.getSheetByName === 'function') {
      const sheet = ss.getSheetByName(TRAVEL_PLAN_SHEET);
      if (sheet && sheet.getLastRow() >= 10) {
        const names = sheet.getRange(3, 1, 8, 1).getValues()
          .map(r => String(r[0] || '').trim())
          .filter(name => name && !/^subtotal|^total/i.test(name));
        if (names.length) return names;
      }
    }
  } catch (_) {}
  return DEFAULT_2027_TRIPS.slice();
}

/**
 * Resolves a raw trip hint (e.g. "London", "Париж", "China Ski", "Tokyo (Family)")
 * to the exact canonical trip name in 'Отдых 2027 Plan'!A3:A10.
 */
function resolveCanonicalTripName(rawHint, optTrips) {
  const hint = String(rawHint || '').trim();
  if (!hint) return null;
  const trips = Array.isArray(optTrips) && optTrips.length ? optTrips : DEFAULT_2027_TRIPS;
  const lower = hint.toLowerCase();

  // 1. Exact case-insensitive match
  const exact = trips.find(t => t.toLowerCase() === lower);
  if (exact) return exact;

  // 2. Prefix / substring match (at least 3 chars)
  if (lower.length >= 3) {
    const subMatches = trips.filter(t => t.toLowerCase().includes(lower) || lower.includes(t.split('(')[0].trim().toLowerCase()));
    if (subMatches.length === 1) return subMatches[0];
  }

  // 3. Deterministic shorthand / Russian alias patterns
  for (let i = 0; i < TRIP_SHORTHAND_PATTERNS.length; i++) {
    const rule = TRIP_SHORTHAND_PATTERNS[i];
    if (rule.pattern.test(hint)) {
      const found = trips.find(t => rule.match.test(t));
      if (found) return found;
    }
  }

  return null;
}

/**
 * Extracts an explicit [Trip: <Name>] tag from notes or merchant text and normalizes it
 * against the canonical trip list.
 */
function extractTripTag(row, optTrips) {
  if (!row || typeof row !== 'object') return null;
  const trips = Array.isArray(optTrips) && optTrips.length ? optTrips : DEFAULT_2027_TRIPS;
  const sources = [row.notes, row.where, row.raw_where, row.description];
  for (let i = 0; i < sources.length; i++) {
    const text = String(sources[i] || '');
    const tagMatch = /\[\s*trip\s*:\s*([^\]]+?)\s*\]/i.exec(text);
    if (tagMatch) {
      const resolved = resolveCanonicalTripName(tagMatch[1], trips);
      return resolved || tagMatch[1].trim();
    }
  }
  // If category is explicitly 'Отдых', also allow unambiguous trip keyword in notes/where
  if (String(row.category || '').trim() === 'Отдых') {
    const combined = [row.where, row.notes].filter(Boolean).join(' ');
    const inferred = resolveCanonicalTripName(combined, trips);
    if (inferred) return inferred;
  }
  return null;
}

/**
 * Normalizes any [Trip: ...] tag inside notes to [Trip: <Canonical Name>] and strips
 * accidental [Trip: ...] prefixes from merchant display names.
 */
function normalizeTransactionTripTag(row, optTrips) {
  if (!row || typeof row !== 'object') return row;
  const canonicalTrip = extractTripTag(row, optTrips);
  if (!canonicalTrip) return row;

  const cleanWhere = String(row.where || '').replace(/\[\s*trip\s*:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
  let notes = String(row.notes || '').trim();
  const tagText = '[Trip: ' + canonicalTrip + ']';
  if (/\[\s*trip\s*:[^\]]*\]/i.test(notes)) {
    notes = notes.replace(/\[\s*trip\s*:[^\]]*\]/gi, tagText);
  } else {
    notes = notes ? (tagText + ' ' + notes) : tagText;
  }
  return Object.assign({}, row, {
    where: cleanWhere || row.where,
    notes: notes,
    trip_name: canonicalTrip
  });
}

/**
 * Maps a travel transaction into one of the 7 View 1 columns of 'Отдых 2027 Plan':
 * Flights | Hotel | Transport | Food | Activities / Ski | Shopping | Other / Visas
 */
function classifyTripSpendCategory(txn) {
  const text = [txn.where, txn.raw_where, txn.raw_snippet, txn.notes].filter(Boolean).join(' ');
  if (/\[\s*trip[_\s-]*cat(?:egory)?\s*:\s*([^\]]+)\]/i.test(text)) {
    const explicit = /\[\s*trip[_\s-]*cat(?:egory)?\s*:\s*([^\]]+)\]/i.exec(text)[1].trim().toLowerCase();
    if (/flight|авиа/.test(explicit)) return 'Flights';
    if (/hotel|отел|stay|accom/.test(explicit)) return 'Hotel';
    if (/transp|train|такси/.test(explicit)) return 'Transport';
    if (/food|еда|рест/.test(explicit)) return 'Food';
    if (/activ|ski|лыж|билет/.test(explicit)) return 'Activities / Ski';
    if (/shop|покуп/.test(explicit)) return 'Shopping';
    return 'Other / Visas';
  }
  if (tripWordRegex_('singapore\\s*air\\w*|sq|scoot|british\\s*air\\w*|air\\s*france|klm|ana|all\\s*nippon|jal|japan\\s*air\\w*|qantas|jetstar|emirates|qatar\\s*air\\w*|cathay|china\\s*(?:southern|eastern)|air\\s*china|aeroflot|аэрофлот|flight\\w*|airlines?|авиа[а-яё]*').test(text)) {
    return 'Flights';
  }
  if (tripWordRegex_('club\\s*med|hotel\\w*|отел[а-яё]*|resort\\w*|airbnb|booking\\.com|agoda|expedia|marriott|hilton|hyatt|accor|sofitel|novotel|ibis|disneyland\\s*hotel|ryokan|hostel|stay').test(text)) {
    return 'Hotel';
  }
  if (tripWordRegex_('vfs|visa\\w*|виз[аыуеой]*|notary|нотари[а-яё]*|согласи[а-яё]*|insur\\w*|страхов[а-яё]*|sim|esim|airalo').test(text)) {
    return 'Other / Visas';
  }
  if (tripWordRegex_('jr\\s*east|shinkansen|suica|pasmo|eurostar|heathrow\\s*express|uber|bolt|grab|gojek|taxi|train|поезд[а-яё]*|метро|metro|car\\s*rental|hertz|avis').test(text) ||
      String(txn.category || '') === 'Транспорт') {
    return 'Transport';
  }
  if (tripWordRegex_('ski\\w*|лыж[а-яё]*|ски[-\\s]*пасс|lift\\s*pass|disney\\w*|museum|музе[йия]*|louvre|лувр|ticket\\w*|match\\w*|rwc|rugby|tour|экскурс[а-яё]*').test(text) ||
      String(txn.category || '') === 'Развлечения') {
    return 'Activities / Ski';
  }
  if (String(txn.category || '') === 'Рестораны' || String(txn.category || '') === 'Продукты' ||
      tripWordRegex_('cafe|кафе|restaurant|ресторан[а-яё]*|dinner|lunch|breakfast|bistro|bakery|bar|pub').test(text)) {
    return 'Food';
  }
  if (tripWordRegex_('uniqlo|duty\\s*free|shopping|шоппинг|mall|department\\s*store|galeries\\s*lafayette|harrods|bic\\s*camera|donki').test(text) ||
      String(txn.category || '') === 'Подарки' || String(txn.category || '') === 'Дом') {
    return 'Shopping';
  }
  return 'Other / Visas';
}

/**
 * Maps a travel transaction into one of the 4 View 2 funding columns of 'Отдых 2027 Plan':
 * Wise (Allowance) | DBS (To Sweep) | Miles / Points | Cash
 */
function classifyTripFundingSource(txn) {
  const notes = String(txn.notes || '');
  const account = String(txn.account || '');
  const flags = Array.isArray(txn.flags) ? txn.flags : [];
  if (tripWordRegex_('miles|мил[иьяей]*|krisflyer|points|балл[а-яё]*').test(notes)) {
    return 'Miles / Points';
  }
  if (tripWordRegex_('paid\\s*from\\s*wise|wise\\s*card|с\\s*wise|оплачено\\s*wise').test(notes) || /^wise$/i.test(account)) {
    return 'Wise (Allowance)';
  }
  if (tripWordRegex_('cash|наличн[а-яё]*').test(notes)) {
    return 'Cash';
  }
  const isDbsOrCiti = /^(?:DBS SGD|DBS CC SGD|Citibank CC)$/i.test(account);
  if (isDbsOrCiti && (txn.type === TRANSACTION_TYPES.WITHDRAWAL || flags.indexOf('reimbursable') !== -1 || tripWordRegex_('sweep|вернуть\\s*с\\s*wise').test(notes))) {
    return 'DBS (To Sweep)';
  }
  if (isDbsOrCiti && tripWordRegex_('to\\s*sweep').test(notes)) {
    return 'DBS (To Sweep)';
  }
  return isDbsOrCiti ? 'DBS (To Sweep)' : 'Wise (Allowance)';
}

function parseOrigCurrencyFromNotes_(txn) {
  const curr = String(txn.currency || 'SGD').toUpperCase();
  if (curr !== 'SGD' && Number(txn.amount) > 0) {
    return { origAmount: Number(txn.amount), origCurrency: curr };
  }
  const notes = String(txn.notes || '');
  const m = /\b([A-Z]{3})\s*([0-9]+(?:[.,][0-9]+)?)\b/.exec(notes);
  if (m && m[1] !== 'SGD') {
    return { origAmount: Number(m[2].replace(',', '.')), origCurrency: m[1] };
  }
  const sgd = Number(txn.amount_sgd !== undefined && txn.amount_sgd !== null ? txn.amount_sgd : txn.amount) || 0;
  return { origAmount: sgd, origCurrency: 'SGD' };
}

/**
 * Post-write hook invoked inside withBudgetWriteLock after appendTransactionsUnlocked succeeds.
 * 1. Appends any [Trip: <Name>] bookings to 'Отдых 2027 Plan'!A68:I250 idempotently.
 * 2. Reconciles Wise -> DBS sweep inflows ('Получение денег' on DBS SGD mentioning Wise)
 *    by flipping matching 'DBS (To Sweep)' rows to 'Wise (Allowance)'.
 * Isolated in try/catch so travel-plan sync never rolls back a saved ledger transaction.
 */
function syncTripLedgerAfterWrite(transactionsArray, writeResult, optSs) {
  if (!writeResult || writeResult.dryRun || !Array.isArray(writeResult.writtenRows) || !writeResult.writtenRows.length) {
    return writeResult;
  }
  try {
    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (!ss || typeof ss.getSheetByName !== 'function') return writeResult;
    const sheet = ss.getSheetByName(TRAVEL_PLAN_SHEET);
    if (!sheet) return writeResult;

    const canonicalTrips = getConfiguredTripNames(ss);
    const ledgerHeight = TRAVEL_LEDGER_END_ROW - TRAVEL_LEDGER_START_ROW + 1;
    const existingGrid = sheet.getRange(TRAVEL_LEDGER_START_ROW, 1, ledgerHeight, 9).getValues();

    const seenTxKeys = new Set();
    let nextEmptyOffset = -1;
    for (let i = 0; i < existingGrid.length; i++) {
      const row = existingGrid[i];
      const hasContent = row.some(cell => cell !== '' && cell !== null && cell !== undefined);
      if (!hasContent && nextEmptyOffset === -1) {
        nextEmptyOffset = i;
      }
      const keyMatch = /\[TxKey:([^\]]+)\]/.exec(String(row[8] || ''));
      if (keyMatch) seenTxKeys.add(keyMatch[1]);
    }

    let appendedTripRows = 0;
    let sweptRowsCount = 0;

    writeResult.writtenRows.forEach(rawTxn => {
      // Check for Wise -> DBS sweep inflow first
      const isWiseSweepInflow = rawTxn.type === TRANSACTION_TYPES.RECEIVED &&
        String(rawTxn.account || '') === 'DBS SGD' &&
        /\bwise\b/i.test([rawTxn.where, rawTxn.notes, rawTxn.raw_snippet].filter(Boolean).join(' '));

      if (isWiseSweepInflow) {
        let remainingSweepCents = Math.round((Number(rawTxn.amount_sgd || rawTxn.amount) || 0) * 100);
        const sweepDate = String(rawTxn.date || '');
        for (let i = 0; i < existingGrid.length && remainingSweepCents > 0; i++) {
          const r = existingGrid[i];
          if (String(r[3] || '').trim() !== 'DBS (To Sweep)') continue;
          const rowCents = Math.round((Number(r[4]) || 0) * 100);
          if (rowCents <= 0 || rowCents > remainingSweepCents) continue;
          remainingSweepCents -= rowCents;
          const updatedNote = [String(r[8] || '').trim(), '✓ Swept ' + sweepDate].filter(Boolean).join(' · ');
          sheet.getRange(TRAVEL_LEDGER_START_ROW + i, 4, 1, 1).setValues([['Wise (Allowance)']]);
          sheet.getRange(TRAVEL_LEDGER_START_ROW + i, 9, 1, 1).setValues([[updatedNote]]);
          r[3] = 'Wise (Allowance)';
          r[8] = updatedNote;
          sweptRowsCount++;
        }
        return;
      }

      // Check for [Trip: <Name>] booking/expense
      if (rawTxn.type === TRANSACTION_TYPES.RECEIVED ||
          rawTxn.type === TRANSACTION_TYPES.INCOME ||
          rawTxn.type === TRANSACTION_TYPES.INCOME_BONUS ||
          rawTxn.type === TRANSACTION_TYPES.INCOME_EASY) {
        return;
      }
      const tripName = extractTripTag(rawTxn, canonicalTrips);
      if (!tripName) return;
      const txKey = String(rawTxn.dedupe_key || (rawTxn.date + '|' + rawTxn.account + '|' + rawTxn.amount + '|' + rawTxn.where));
      if (seenTxKeys.has(txKey)) return;
      if (nextEmptyOffset < 0 || TRAVEL_LEDGER_START_ROW + nextEmptyOffset > TRAVEL_LEDGER_END_ROW) {
        Logger.log('Отдых 2027 Plan travel ledger is full (rows 68..250).');
        return;
      }

      const normalized = normalizeTransactionTripTag(rawTxn, canonicalTrips);
      const sgdAmount = Number((Number(rawTxn.amount_sgd !== undefined && rawTxn.amount_sgd !== null ? rawTxn.amount_sgd : rawTxn.amount) || 0).toFixed(2));
      if (sgdAmount <= 0) return;

      const spendCat = classifyTripSpendCategory(normalized);
      const fundingSource = classifyTripFundingSource(normalized);
      const orig = parseOrigCurrencyFromNotes_(normalized);
      const cleanNote = String(normalized.notes || '')
        .replace(/\[\s*trip\s*:[^\]]*\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      const ledgerNote = [
        fundingSource === 'DBS (To Sweep)' ? ('Paid via ' + (rawTxn.account || 'DBS') + ' — sweep from Wise') : '',
        cleanNote,
        '[TxKey:' + txKey + ']'
      ].filter(Boolean).join(' · ');

      const writeRow = TRAVEL_LEDGER_START_ROW + nextEmptyOffset;
      const newLedgerRow = [
        rawTxn.date || '',
        tripName,
        spendCat,
        fundingSource,
        sgdAmount,
        orig.origAmount,
        orig.origCurrency,
        normalized.where || rawTxn.where || '',
        ledgerNote
      ];
      sheet.getRange(writeRow, 1, 1, 9).setValues([newLedgerRow]);
      existingGrid[nextEmptyOffset] = newLedgerRow;
      seenTxKeys.add(txKey);
      appendedTripRows++;

      // Advance nextEmptyOffset
      nextEmptyOffset = -1;
      for (let j = 0; j < existingGrid.length; j++) {
        if (!existingGrid[j].some(cell => cell !== '' && cell !== null && cell !== undefined)) {
          nextEmptyOffset = j;
          break;
        }
      }
    });

    if (appendedTripRows || sweptRowsCount) {
      writeResult.tripSync = { appendedTripRows: appendedTripRows, sweptRowsCount: sweptRowsCount };
    }
  } catch (err) {
    Logger.log('Warning: syncTripLedgerAfterWrite skipped: ' + err.message);
  }
  return writeResult;
}

/**
 * Reads live 'Отдых 2027 Plan' View 0 (65% Gate & Actuals), Wise Cash Flow pinch points,
 * and View 2 (DBS Sweep status). Returns null when 'Отдых 2027 Plan' is absent.
 */
function readTravelPlanStatus(optSs, optAsOf) {
  try {
    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (!ss || typeof ss.getSheetByName !== 'function') return null;
    const sheet = ss.getSheetByName(TRAVEL_PLAN_SHEET);
    if (!sheet || sheet.getLastRow() < 64) return null;

    const asOf = optAsOf instanceof Date ? optAsOf : new Date();
    const parts = calendarDateParts(asOf);

    const view0 = sheet.getRange(3, 1, 8, 12).getValues();
    const totalRow = sheet.getRange(15, 1, 1, 12).getValues()[0] || [];
    const wiseRows = sheet.getRange(20, 1, 13, 7).getValues();
    const view2 = sheet.getRange(64, 1, 1, 6).getValues()[0] || [];

    const trips = view0
      .filter(r => String(r[0] || '').trim())
      .map(r => ({
        name: String(r[0]).trim(),
        bucket: String(r[1] || '').trim(),
        dates: String(r[2] || '').trim(),
        target_sgd: Number(r[3]) || 0,
        ceiling_sgd: Number(r[4]) || 0,
        gate_65_sgd: Number(r[5]) || 0,
        committed_fh_sgd: Number(r[6]) || 0,
        gate_status: String(r[7] || '—').trim(),
        actual_spent_sgd: Number(r[8]) || 0,
        remaining_sgd: Number(r[9]) || 0
      }));

    const overGateTrips = trips.filter(t => t.gate_status === 'OVER GATE' || t.committed_fh_sgd > t.gate_65_sgd);
    const overTargetTrips = trips.filter(t => t.actual_spent_sgd > t.target_sgd);
    const dbsToSweepSgd = Number((Number(view2[1]) || 0).toFixed(2));

    const monthShortNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const currentLabel = monthShortNames[parts.month - 1] + ' ' + parts.year;
    const nextDate = new Date(Date.UTC(parts.year, parts.month, 15, 12));
    const nextParts = calendarDateParts(nextDate);
    const nextLabel = monthShortNames[nextParts.month - 1] + ' ' + nextParts.year;

    const parseWiseRow = r => ({
      month: String(r[0] || '').trim(),
      inflow_sgd: Number(r[3]) || 0,
      planned_outflow_sgd: Number(r[4]) || 0,
      ending_balance_sgd: Number(r[5]) || 0,
      notes: String(r[6] || '').trim()
    });
    const wiseSchedule = wiseRows.filter(r => String(r[0] || '').trim()).map(parseWiseRow);
    const currentWise = wiseSchedule.find(w => w.month.toLowerCase() === currentLabel.toLowerCase()) || null;
    const rawNextWise = wiseSchedule.find(w => w.month.toLowerCase() === nextLabel.toLowerCase()) || null;
    const nextWise = (rawNextWise && (!currentWise || rawNextWise.month !== currentWise.month)) ? rawNextWise : null;
    const pinchPoints = [currentWise, nextWise]
      .filter(Boolean)
      .filter(w => w.ending_balance_sgd <= 2000 || w.planned_outflow_sgd >= 6000);

    return {
      total_target_sgd: Number(totalRow[3]) || 0,
      total_ceiling_sgd: Number(totalRow[4]) || 0,
      total_actual_sgd: Number(totalRow[8]) || 0,
      dbs_to_sweep_sgd: dbsToSweepSgd,
      sweep_status: String(view2[5] || '').trim(),
      trips: trips,
      over_gate_trips: overGateTrips,
      over_target_trips: overTargetTrips,
      current_wise: currentWise,
      next_wise: nextWise,
      pinch_points: pinchPoints
    };
  } catch (err) {
    Logger.log('readTravelPlanStatus error: ' + err.message);
    return null;
  }
}

/**
 * Formats a concise Telegram HTML report for /trips.
 */
function renderTravelPlanTelegramSummary(status) {
  if (!status) {
    return 'ℹ️ <b>Отдых 2027 Plan</b> tab is not present in the active workbook.';
  }
  const money = val => 'S$' + Math.round(Math.abs(Number(val) || 0)).toLocaleString('en-US');
  const html = typeof escapeCoachHtml === 'function' ? escapeCoachHtml : s => String(s);
  const lines = [
    '✈️ <b>Отдых 2027 — Live Tracker &amp; 65% Gate</b>',
    '• <b>2027 Total:</b> ' + money(status.total_actual_sgd) + ' spent vs ' + money(status.total_target_sgd) +
      ' target (' + money(status.total_ceiling_sgd) + ' ceiling).'
  ];

  if (status.dbs_to_sweep_sgd > 0) {
    lines.push('• ⚠️ <b>DBS Sweep Needed:</b> <b>' + money(status.dbs_to_sweep_sgd) +
      '</b> booked on DBS/Citi — transfer from Wise to DBS SGD.');
  } else {
    lines.push('• ✅ <b>DBS Sweep:</b> All travel bookings swept.');
  }

  if (status.over_gate_trips.length) {
    status.over_gate_trips.forEach(t => {
      lines.push('• 🚨 <b>65% Gate Alert (' + html(t.name) + '):</b> Flights+Hotel at <b>' +
        money(t.committed_fh_sgd) + '</b> vs ' + money(t.gate_65_sgd) + ' gate.');
    });
  }

  if (status.pinch_points.length) {
    status.pinch_points.forEach(w => {
      lines.push('• 📌 <b>Wise Cashflow (' + html(w.month) + '):</b> ' + money(w.planned_outflow_sgd) +
        ' planned outflow → ' + money(w.ending_balance_sgd) + ' projected Wise buffer (' + html(w.notes) + ').');
    });
  }

  lines.push('', '<b>Trips Breakdown:</b>');
  status.trips.forEach(t => {
    const gateBadge = t.gate_status === 'OVER GATE' ? '🚨 OVER GATE'
      : t.committed_fh_sgd > 0 ? '✅ Gate OK' : '⏳ Unbooked';
    lines.push('◦ <b>' + html(t.name) + '</b> (' + html(t.dates) + '): ' +
      money(t.actual_spent_sgd) + ' / ' + money(t.target_sgd) + ' · F+H ' +
      money(t.committed_fh_sgd) + '/' + money(t.gate_65_sgd) + ' (' + gateBadge + ')');
  });

  return lines.join('\n');
}

/**
 * Reads live 'CapitalPlan' tab metrics (IRAS S$80k caps, 250% IPC Charity, SRS, CPF RSTU,
 * Monthly Salary Earmarks vs Pure Cash Capital Pool, SAYE S$120k Rainy-Day Top-Up,
 * Папа Loan Paydown, and separate GSU Vests). Returns null when 'CapitalPlan' is absent.
 */
function readCapitalPlanStatus(optSs, optAsOf) {
  try {
    const ss = optSs || (typeof getActiveBudgetSpreadsheet === 'function' ? getActiveBudgetSpreadsheet() : null);
    if (!ss || typeof ss.getSheetByName !== 'function') return null;
    const sheet = ss.getSheetByName(CAPITAL_PLAN_SHEET);
    if (!sheet || sheet.getLastRow() < 30) return null;

    const maxRow = Math.min(55, Math.max(34, sheet.getLastRow()));
    const grid = sheet.getRange(1, 1, maxRow, 9).getValues();
    const num = (r, c) => (r > 0 && grid[r - 1] ? (Number(grid[r - 1][c - 1]) || 0) : 0);
    const findRow = pattern => {
      for (let i = 0; i < grid.length; i++) {
        if (pattern.test(String((grid[i] && grid[i][0]) || '').trim())) return i + 1;
      }
      return -1;
    };

    const rCpfEmp = findRow(/Mandatory CPF Employee/i) || 10;
    const rRstu = findRow(/CPF Cash Top-Up|CPF Top-Up/i) || 11;
    const rSrs = findRow(/SRS Contribution|\bSRS\b/i) || 12;
    const rHeadroom = findRow(/Cap Headroom|^Headroom$/i) || 16;
    const rIpc = findRow(/Optimal IPC Charity|IPC Charity/i) || 17;
    const rTaxSaved = findRow(/Estimated Tax Saved|^Tax Saved$/i) || 19;

    const cpfTopupRemaining = Number(num(rRstu, 6).toFixed(2));
    const srsRemaining = Number(num(rSrs, 6).toFixed(2));
    const charityTargetCash = Number(num(rIpc, 4).toFixed(2));
    const charityPaidYtd = Number(num(rIpc, 5).toFixed(2));
    const charityRemainingCash = Number(num(rIpc, 6).toFixed(2));
    const valHeadroom = Number(num(rHeadroom, 2).toFixed(2));
    const ritaHeadroom = Number(num(rHeadroom, 3).toFixed(2));
    const totalTaxSaved = Number(num(rTaxSaved, 4).toFixed(2));
    const remainingTaxSaved = Number(num(rTaxSaved, 6).toFixed(2));
    const totalTaxAdvantagedRemaining = Number((cpfTopupRemaining + srsRemaining + charityRemainingCash).toFixed(2));

    const titleBanner = String((grid[0] && grid[0][0]) || '');
    const yearMatch = /\b(202[6-9]|203\d)\b/.exec(titleBanner);
    const planYear = yearMatch ? Number(yearMatch[1]) : 2027;
    const isDecClosingMode = /DECEMBER|DEC'26|P0 IRAS/i.test(titleBanner);
    const taxRateLabel = String((grid[rTaxSaved - 1] && grid[rTaxSaved - 1][7]) || '').trim() ||
      (planYear <= 2026 ? 'Val 23% + Rita 18% Year-2 PR' : 'Val 23% + Rita 18% Year-3 PR');

    // Locate cash pool / Dec cash availability, SAYE, P4, and GSU rows dynamically
    const rDecCashTotal = findRow(/^TOTAL PURE CASH AVAILABLE FOR DEC/i);
    const rCashPool = rDecCashTotal > 0 ? rDecCashTotal : (findRow(/^TOTAL .*PURE CASH/i) || 33);
    const rMonthlyIpc = findRow(/IPC 250% Charity Standing|IPC Standing/i);
    const rSaye = findRow(/Cash-Equivalent Rainy-Day|^P3\s*·?\s*SAYE|^1\.\s*SAYE/i);
    const rSubP13 = findRow(/^SUBTOTAL P1/i);
    const rPapa = findRow(/Repay Dad's Loan|P4.*Papa Loan/i);
    const rGsu = findRow(/GSU Vests/i);
    const rScenB = findRow(/^Scenario B/i);

    const pureCashPoolPlan = Number((rDecCashTotal > 0 ? num(rDecCashTotal, 2) : num(rCashPool, 2)).toFixed(2));
    const pureCashPoolYtd = Number((rDecCashTotal > 0 ? num(rDecCashTotal, 2) : num(rCashPool, 3)).toFixed(2));
    const decP0CashGap = rDecCashTotal > 0 ? Number(num(rDecCashTotal, 4).toFixed(2)) : null;

    const sayeTopupRemaining = rDecCashTotal > 0
      ? Number(Math.max(0, 120000 - num(rSaye > 0 ? rSaye : 23, 2)).toFixed(2))
      : Number(num(rSaye > 0 ? rSaye : 39, 4).toFixed(2));
    const cashLeftAfterSaye = rDecCashTotal > 0
      ? Number((decP0CashGap || 0).toFixed(2))
      : Number(num(rSubP13 > 0 ? rSubP13 : 40, 6).toFixed(2));
    const papaCashApplied = rPapa > 0 ? Number(num(rPapa, 2).toFixed(2)) : 0;
    const papaRemainingExGsu = rPapa > 0 ? Number(num(rPapa, 4).toFixed(2)) : 0;
    const gsuVestsPlan = rGsu > 0 ? Number((num(rGsu, 2) || 100000).toFixed(2)) : 100000;
    const gsuVestsYtd = rGsu > 0 ? Number(num(rGsu, 3).toFixed(2)) : 0;
    const charityMonthlyPlan = rMonthlyIpc > 0
      ? Number(num(rMonthlyIpc, 2).toFixed(2))
      : Number((charityTargetCash / 12).toFixed(2));

    return {
      plan_year: planYear,
      dec_closing_mode: isDecClosingMode,
      tax_rate_label: taxRateLabel,
      val_cap_headroom_sgd: valHeadroom,
      rita_cap_headroom_sgd: ritaHeadroom,
      mandatory_cpf_ytd_sgd: Number(num(rCpfEmp, 5).toFixed(2)),
      cpf_topup_paid_sgd: Number(num(rRstu, 5).toFixed(2)),
      cpf_topup_remaining_sgd: cpfTopupRemaining,
      srs_paid_sgd: Number(num(rSrs, 5).toFixed(2)),
      srs_remaining_sgd: srsRemaining,
      charity_target_cash_sgd: charityTargetCash,
      charity_monthly_plan_sgd: charityMonthlyPlan,
      charity_paid_ytd_sgd: charityPaidYtd,
      charity_remaining_cash_sgd: charityRemainingCash,
      estimated_tax_saved_sgd: totalTaxSaved,
      estimated_tax_saved_remaining_sgd: remainingTaxSaved || totalTaxSaved,
      total_tax_advantaged_remaining_sgd: totalTaxAdvantagedRemaining,
      pure_cash_pool_plan_sgd: pureCashPoolPlan,
      pure_cash_pool_ytd_sgd: pureCashPoolYtd,
      dec_p0_cash_gap_sgd: decP0CashGap,
      saye_topup_remaining_sgd: sayeTopupRemaining,
      cash_left_after_saye_sgd: cashLeftAfterSaye,
      papa_cash_applied_sgd: papaCashApplied,
      papa_remaining_ex_gsu_sgd: papaRemainingExGsu,
      gsu_vests_plan_sgd: gsuVestsPlan,
      gsu_vests_ytd_sgd: gsuVestsYtd,
      goog_vt_dca_monthly_scen_b_sgd: rScenB > 0 ? Number(num(rScenB, 3).toFixed(2)) : null,
      // Backwards-compatible aliases
      capital_inflows_plan_sgd: pureCashPoolPlan,
      capital_inflows_ytd_sgd: pureCashPoolYtd,
      capital_uses_target_sgd: rSubP13 > 0 ? Number(num(rSubP13, 2).toFixed(2)) : totalTaxAdvantagedRemaining,
      capital_surplus_plan_sgd: cashLeftAfterSaye
    };
  } catch (err) {
    Logger.log('readCapitalPlanStatus error: ' + err.message);
    return null;
  }
}

/**
 * Formats a concise Telegram HTML report for /tax (or /capital).
 */
function renderCapitalPlanTelegramSummary(cap) {
  if (!cap) {
    return 'ℹ️ <b>CapitalPlan</b> tab is not present in the active workbook.';
  }
  const money = val => (Number(val) < 0 ? '-' : '') + 'S$' + Math.round(Math.abs(Number(val) || 0)).toLocaleString('en-US');
  const html = typeof escapeCoachHtml === 'function' ? escapeCoachHtml : s => String(s);
  const yr = cap.plan_year || 2027;
  const rateNote = html(cap.tax_rate_label || (yr <= 2026 ? '23% Val / 18% Rita Yr-2 PR' : '23% Val / 18% Rita Yr-3 PR'));

  if (cap.dec_closing_mode) {
    const gapAbs = Math.abs(Number(cap.dec_p0_cash_gap_sgd) || 0);
    const remTax = cap.estimated_tax_saved_remaining_sgd || cap.estimated_tax_saved_sgd;
    return [
      '🏛 <b>CapitalPlan (' + yr + ') — Dec\'26 P0 IRAS Cutoff &amp; Funding Options</b>',
      '• <b>P0 Left Before 31 Dec:</b> <b>' + money(cap.total_tax_advantaged_remaining_sgd) +
        '</b> (RSTU ' + money(cap.cpf_topup_remaining_sgd) + ' · SRS ' + money(cap.srs_remaining_sgd) +
        ' · IPC ' + money(cap.charity_remaining_cash_sgd) + ').',
      '• <b>YA ' + (yr + 1) + ' Tax Saved by P0:</b> <b>' + money(remTax) + '</b> (' + money(cap.estimated_tax_saved_sgd) + ' full yr · ' + rateNote + ').',
      '• <b>Available Pure Cash (SAYE + Nov/Dec Savings):</b> <b>' + money(cap.pure_cash_pool_plan_sgd) +
        '</b> → Net P0 Cash Gap: <b>-' + money(gapAbs) + '</b>.',
      '• <b>Recommended P0 Execution:</b> Deploy ' + money(cap.pure_cash_pool_plan_sgd) +
        ' cash + trim ~' + money(gapAbs) + ' GOOG (swaps ' + money(cap.srs_remaining_sgd) +
        ' GOOG into Endowus SRS global equity + locks full tax rebate).'
    ].join('\n');
  }

  const sayeTail = cap.cash_left_after_saye_sgd >= 0
    ? ('leaves <b>' + money(cap.cash_left_after_saye_sgd) + '</b> pure cash for <b>Папа Loan</b> (reduces debt to ' +
       money(cap.papa_remaining_ex_gsu_sgd) + ' ex-GSU; ' + money(cap.gsu_vests_plan_sgd) + ' GSU held in GOOG' +
       (cap.goog_vt_dca_monthly_scen_b_sgd ? ', or Scenario B ' + money(cap.goog_vt_dca_monthly_scen_b_sgd) + '/mo GOOG→VT DCA hits &lt;35% GSU' : '') + ').')
    : ('prioritize 31 Dec tax caps first; carry remaining <b>' + money(Math.abs(cap.cash_left_after_saye_sgd)) +
       '</b> SAYE build + <b>Папа Loan</b> (' + money(cap.papa_remaining_ex_gsu_sgd) + ') into Q1 ' + (yr + 1) +
       ' bonus (' + money(cap.gsu_vests_plan_sgd) + ' GSU held in GOOG).');
  const lines = [
    '🏛 <b>CapitalPlan (' + yr + ') — IRAS S$80k Tax Caps &amp; Pure-Cash Waterfall</b>',
    '• <b>CPF Cash Top-Up (RSTU):</b> ' + money(cap.cpf_topup_paid_sgd) + ' paid · <b>' +
      money(cap.cpf_topup_remaining_sgd) + '</b> left before 31 Dec.',
    '• <b>SRS Contributions:</b> ' + money(cap.srs_paid_sgd) + ' paid · <b>' +
      money(cap.srs_remaining_sgd) + '</b> left before 31 Dec.',
    '• <b>IPC Charity (250% · Monthly НКО ' + money(cap.charity_monthly_plan_sgd || (cap.charity_target_cash_sgd / 12)) + '/mo):</b> ' +
      money(cap.charity_paid_ytd_sgd) + ' paid of ' + money(cap.charity_target_cash_sgd) +
      ' · <b>' + money(cap.charity_remaining_cash_sgd) + '</b> left.',
    '• <b>Estimated Tax Saved (Full Cap Plan):</b> <b>' + money(cap.estimated_tax_saved_sgd) +
      '</b> (' + rateNote + ').',
    '• <b>' + yr + ' Pure Cash Pool (Отложения + Bonuses):</b> ' + money(cap.pure_cash_pool_ytd_sgd) +
      ' YTD vs ' + money(cap.pure_cash_pool_plan_sgd) + ' plan.',
    '• <b>SAYE S$120k Rainy-Day Top-Up:</b> <b>' + money(cap.saye_topup_remaining_sgd) +
      '</b> needed → ' + sayeTail
  ];
  return lines.join('\n');
}
