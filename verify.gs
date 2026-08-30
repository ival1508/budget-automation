/**
 * BUDGET 2026 AUTOMATION — MASTER RUNTIME VERIFICATION (STAGES 0, 1, 2)
 * File: verify.gs
 * 
 * Single read-only entrypoint: verifyStages012()
 * Checks all sheet models, readers, coach engine, scheduler, and security properties.
 * Guaranteed zero sheet mutations. Sends test message to Val (96069960) ONLY.
 */

/**
 * Master Verification Function for Stages 0, 1, and 2.
 * @return {{ passed: number, failed: number, total: number }}
 */
function verifyStages012() {
  Logger.log('================================================================');
  Logger.log('      BUDGET 2026 — RUNTIME VERIFICATION SUITE (STAGES 0, 1, 2)  ');
  Logger.log('================================================================\n');

  let passCount = 0;
  let failCount = 0;

  function assert(condition, testName, details) {
    if (condition) {
      Logger.log(`✅ PASS: ${testName}`);
      passCount++;
    } else {
      Logger.log(`❌ FAIL: ${testName} -> ${details || 'Assertion failed'}`);
      failCount++;
    }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const transSheet = ss.getSheetByName('Transactions');
  const initialTransLastRow = transSheet ? transSheet.getLastRow() : 0;

  // -------------------------------------------------------------
  // STAGE 0 — SHEET_FACTS vs LIVE SHEET
  // -------------------------------------------------------------
  Logger.log('--- [STAGE 0] SHEET_FACTS vs Live Spreadsheet ---');
  
  // 1. Structure completeness
  const hasFacts = typeof SHEET_FACTS !== 'undefined';
  assert(hasFacts && SHEET_FACTS.MONTH_TAB_NAMES && SHEET_FACTS.CORE_TABS && SHEET_FACTS.USERS &&
         SHEET_FACTS.MONTHLY_TAB_STRUCTURE && SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE &&
         SHEET_FACTS.BUDGET_50_30_20_TAB_STRUCTURE,
         'SHEET_FACTS structure completeness',
         'Missing core keys in SHEET_FACTS');
         
  assert(hasFacts && SHEET_FACTS.MONTHLY_TAB_STRUCTURE.FLAT_DAILY_PACING_CELL === 'D17' &&
         SHEET_FACTS.MONTHLY_TAB_STRUCTURE.CURRENT_DAILY_BUDGET_CELL === 'D19',
         'SHEET_FACTS cell coordinates (D17 and D19)',
         `Expected D17 & D19, got ${SHEET_FACTS?.MONTHLY_TAB_STRUCTURE?.FLAT_DAILY_PACING_CELL} & ${SHEET_FACTS?.MONTHLY_TAB_STRUCTURE?.CURRENT_DAILY_BUDGET_CELL}`);

  // 2. getMonthTabName() returns actual existing tab
  const currentTabName = (hasFacts && typeof SHEET_FACTS.getMonthTabName === 'function')
    ? SHEET_FACTS.getMonthTabName(new Date())
    : (typeof getCurrentMonthTabName === 'function' ? getCurrentMonthTabName() : '');
  const activeTabSheet = ss.getSheetByName(currentTabName);
  assert(activeTabSheet !== null, `Current month tab "${currentTabName}" exists in spreadsheet`, `Tab "${currentTabName}" not found`);

  // 3. Transactions columns & headers
  let transColsValid = false;
  if (transSheet) {
    const headerVals = transSheet.getRange(1, 1, 1, 11).getDisplayValues()[0];
    const numCols = transSheet.getLastColumn();
    const jHeader = String(headerVals[9] || '').trim().toLowerCase();
    const kHeader = String(headerVals[10] || '').trim().toLowerCase();
    transColsValid = (numCols >= 11) && (jHeader === 'notes') && (kHeader.startsWith('50/30/20'));
    assert(transColsValid, 'Transactions tab has 11+ columns with header J="Notes" and header K starting with "50/30/20"',
           `Cols=${numCols}, J="${headerVals[9]}", K="${headerVals[10]}"`);
  } else {
    assert(false, 'Transactions tab found', 'Sheet not found');
  }

  // 4. Monthly tab D3:G13 yields 11 non-empty labels in Col D
  let monthlyLabelsCount = 0;
  if (activeTabSheet) {
    const d3g13Vals = activeTabSheet.getRange('D3:D13').getDisplayValues();
    monthlyLabelsCount = d3g13Vals.filter(r => r[0] && r[0].trim() !== '' && r[0].trim() !== '-').length;
    assert(monthlyLabelsCount === 11, `Monthly tab D3:G13 yields 11 non-empty labels in Col D (found ${monthlyLabelsCount})`,
           `Found ${monthlyLabelsCount} labels`);
  } else {
    assert(false, 'Monthly tab D3:G13 readable', 'Active monthly tab not found');
  }

  // 5. D17 and D19 parse to numbers
  let d17Val = NaN, d19Val = NaN;
  if (activeTabSheet) {
    const d17Range = activeTabSheet.getRange('D17');
    const d19Range = activeTabSheet.getRange('D19');
    d17Val = parseAmountNumber(d17Range.getValue(), d17Range.getDisplayValue());
    d19Val = parseAmountNumber(d19Range.getValue(), d19Range.getDisplayValue());
    assert(!isNaN(d17Val) && typeof d17Val === 'number' && !isNaN(d19Val) && typeof d19Val === 'number',
           `D17 (${d17Val}) and D19 (${d19Val}) parse to valid numbers`,
           `D17=${d17Val}, D19=${d19Val}`);
  }

  // 6. 50/30/20 column AE target header readable
  const sheet503020 = ss.getSheetByName('50/30/20');
  if (sheet503020) {
    const aeHeader = sheet503020.getRange(1, 31).getDisplayValue();
    Logger.log(`ℹ️ 50/30/20 Col AE Row 1 Header text: "${aeHeader}"`);
    assert(aeHeader && aeHeader.trim() !== '' && aeHeader.trim() !== 'undefined',
           `50/30/20 Col AE header readable: "${aeHeader}"`,
           `Got "${aeHeader}"`);
  } else {
    assert(false, '50/30/20 tab found', 'Sheet not found');
  }

  // 7. Reference tab "-" yields 22 categories
  const catMap = typeof getCategoryBucketMap === 'function' ? getCategoryBucketMap(ss) : {};
  const catCount = Object.keys(catMap).length;
  assert(catCount === 22, `Reference tab "-" yields 22 categories via getCategoryBucketMap() (found ${catCount})`,
         `Found ${catCount} categories`);

  // 8. USERS config
  const users = (hasFacts && SHEET_FACTS.USERS) ? SHEET_FACTS.USERS : {};
  assert(users.VAL && users.VAL.chat_id === '96069960' && users.VAL.morning_time && users.VAL.active === true &&
         users.RITA && users.RITA.chat_id === '402188776' && users.RITA.morning_time && users.RITA.active === true,
         'SHEET_FACTS.USERS contains Val and Rita with valid chat_id, morning_time, active',
         `Users config: ${JSON.stringify(users)}`);

  // -------------------------------------------------------------
  // STAGE 1 — READER.GS AUDIT
  // -------------------------------------------------------------
  Logger.log('\n--- [STAGE 1] reader.gs Runtime Values & Cross-Checks ---');

  // 1. getDailyPacing()
  const pacing = typeof getDailyPacing === 'function' ? getDailyPacing(null, ss) : null;
  if (pacing) {
    assert(pacing.K_cumulative_today !== undefined && pacing.L_saldo_yesterday !== undefined &&
           pacing.D17_flat_daily !== undefined && pacing.D19_realistic_daily !== undefined &&
           pacing.days_left !== undefined && pacing.days_to_positive !== undefined,
           'getDailyPacing() returns all 6 expected fields',
           `Returned: ${JSON.stringify(pacing)}`);

    // Identity check: K ≈ L + D17
    const identityDiff = Math.abs(pacing.K_cumulative_today - (pacing.L_saldo_yesterday + pacing.D17_flat_daily));
    assert(identityDiff <= 0.05,
           `getDailyPacing() identity holds: K (${pacing.K_cumulative_today}) ≈ L (${pacing.L_saldo_yesterday}) + D17 (${pacing.D17_flat_daily}) [diff: ${identityDiff.toFixed(3)}]`,
           `K=${pacing.K_cumulative_today}, L+D17=${pacing.L_saldo_yesterday + pacing.D17_flat_daily}`);

    // D19 direct match
    assert(pacing.D19_realistic_daily === d19Val,
           `D19_realistic_daily (${pacing.D19_realistic_daily}) matches direct D19 cell read (${d19Val})`,
           `Pacing=${pacing.D19_realistic_daily}, Direct=${d19Val}`);

    // days_to_positive logic
    const expectedDaysToPositive = pacing.K_cumulative_today >= 0
      ? 0
      : ((pacing.D17_flat_daily > 0) ? Math.ceil(Math.abs(pacing.K_cumulative_today) / pacing.D17_flat_daily) : 0);
    assert(pacing.days_to_positive === expectedDaysToPositive,
           `days_to_positive (${pacing.days_to_positive}) equals expected (${expectedDaysToPositive})`,
           `Got ${pacing.days_to_positive}, expected ${expectedDaysToPositive}`);
  } else {
    assert(false, 'getDailyPacing() returns object', 'getDailyPacing returned null');
  }

  // 2. getTodaySpend() cross-checks
  // A: Today
  const todaySpend = typeof getTodaySpend === 'function' ? getTodaySpend(null, ss) : 0;
  let monthlyColJToday = 0;
  if (activeTabSheet) {
    const tz = ss.getSpreadsheetTimeZone() || 'Asia/Singapore';
    const currentDay = parseInt(Utilities.formatDate(new Date(), tz, 'd'), 10);
    const dailyTrackerValues = activeTabSheet.getRange('H2:L32').getValues();
    const dailyTrackerDisp = activeTabSheet.getRange('H2:L32').getDisplayValues();
    for (let r = 0; r < dailyTrackerValues.length; r++) {
      const rawDate = dailyTrackerValues[r][0];
      const dispDate = dailyTrackerDisp[r][0];
      let rowDay = null;
      if (rawDate instanceof Date) rowDay = rawDate.getDate();
      else if (typeof rawDate === 'number') rowDay = rawDate;
      else if (dispDate) {
        const m = dispDate.match(/^(\d{1,2})/);
        if (m) rowDay = parseInt(m[1], 10);
      }
      if (rowDay === currentDay) {
        monthlyColJToday = parseAmountNumber(dailyTrackerValues[r][2], dailyTrackerDisp[r][2]);
        break;
      }
    }
  }
  assert(Math.abs(todaySpend - monthlyColJToday) <= 0.01,
         `getTodaySpend() for today (${todaySpend}) equals Monthly Tab Col J (${monthlyColJToday})`,
         `getTodaySpend=${todaySpend}, Col J=${monthlyColJToday}`);

  // B: Mixed-type date 01.07.2026
  const spend0107 = typeof getTodaySpend === 'function' ? getTodaySpend('01.07.2026', ss) : 0;
  assert(Math.abs(spend0107 - 279.66) <= 0.01,
         `getTodaySpend('01.07.2026') equals verified 279.66 (Расходы only; ignores S$7,592 mortgage & S$372 withdrawal)`,
         `Expected 279.66, got ${spend0107}`);

  // 3. get503020Status()
  const status503020 = typeof get503020Status === 'function' ? get503020Status(ss) : null;
  if (status503020) {
    const hasThreeBuckets = status503020.needs && status503020.wants && status503020.savings && (status503020.taxes === undefined);
    assert(hasThreeBuckets, 'get503020Status() returns exactly 3 buckets (needs, wants, savings, NO taxes)',
           `Buckets: ${Object.keys(status503020).join(', ')}`);

    const headerClean = status503020.target_header && status503020.target_header !== 'undefined' && status503020.target_header !== 'null';
    assert(headerClean, `get503020Status() target_header is clean: "${status503020.target_header}"`,
           `Header: "${status503020.target_header}"`);

    // Assert no summary rows in sub_categories
    const allSubs = [
      ...(status503020.needs?.sub_categories || []),
      ...(status503020.wants?.sub_categories || []),
      ...(status503020.savings?.sub_categories || [])
    ];
    const forbiddenSummaryNames = ['total', 'total income', 'difference', 'итого', 'всего', 'разница'];
    const offender = allSubs.find(s => forbiddenSummaryNames.includes(String(s.name || '').trim().toLowerCase()));
    assert(!offender, 'No spreadsheet summary rows (Total/Difference) present in sub_categories',
           `Offender found: ${JSON.stringify(offender)}`);
  } else {
    assert(false, 'get503020Status() returns object', 'Returned null');
  }

  // 4. getCategoryVelocity()
  const velocity = typeof getCategoryVelocity === 'function' ? getCategoryVelocity(ss) : {};
  const hasCoreFour = velocity['Рестораны'] && velocity['Развлечения'] && velocity['Дом'] && velocity['Подарки'] && !velocity['Шопинг'];
  assert(hasCoreFour, 'getCategoryVelocity() contains Рестораны, Развлечения, Дом, Подарки (and NO Шопинг)',
         `Categories: ${Object.keys(velocity).join(', ')}`);

  // Assert non-discretionary categories are 0
  const nonDiscretionaryZero = (!velocity['Квартира'] || velocity['Квартира'].total === 0) &&
                               (!velocity['Налоги'] || velocity['Налоги'].total === 0) &&
                               (!velocity['Отложения'] || velocity['Отложения'].total === 0) &&
                               (!velocity['Кредитка'] || velocity['Кредитка'].total === 0);
  assert(nonDiscretionaryZero, 'Non-discretionary categories (Квартира, Налоги, Отложения, Кредитка) have 0 velocity',
         `Velocity sample: Квартира=${velocity['Квартира']?.total}, Налоги=${velocity['Налоги']?.total}`);

  // 5. getCategoryBucketMap() taxonomy checks
  assert(catMap['Квартира'] === 'Needs' && catMap['Рестораны'] === 'Wants' &&
         catMap['Отложения'] === 'Savings' && catMap['Отложения (премия)'] === 'Savings' &&
         catMap['Налоги'] === 'Taxes' && catMap['Кредитка'] === '-' &&
         catMap['Авто'] === 'Wants' && catMap['Транспорт'] === 'Needs',
         'getCategoryBucketMap() spot-check mappings match taxonomy',
         `Mappings: ${JSON.stringify(catMap)}`);

  // 6. getMandatoryExpenses()
  const mandatoryList = typeof getMandatoryExpenses === 'function' ? getMandatoryExpenses(ss) : [];
  assert(mandatoryList.length === 11, `getMandatoryExpenses() returns 11 items (found ${mandatoryList.length})`,
         `Found ${mandatoryList.length}`);
  const roditeli = mandatoryList.find(m => m.name === 'Родители' || m.label === 'Родители');
  assert(roditeli && (roditeli.planned_amount === 0 || roditeli.amount === 0),
         'Родители line is present with planned_amount = 0 (satisfied)',
         `Родители: ${JSON.stringify(roditeli)}`);

  // 7. Currency parsing
  const parsedCurrency = parseAmountNumber('S$1 234,56');
  assert(parsedCurrency === 1234.56, `Currency parsing "S$1 234,56" -> 1234.56 (got ${parsedCurrency})`,
         `Got ${parsedCurrency}`);

  // 8. Missing-tab safety
  let missingTabSafe = false;
  try {
    const res = getActiveMonthTab(ss, new Date(2026, 8, 1)); // Month 9 (September)
    missingTabSafe = (res && res.exists === false);
  } catch (e) {
    missingTabSafe = false;
  }
  assert(missingTabSafe, 'getActiveMonthTab() returns safe {exists: false} signal for non-existent future tab without throwing',
         'Failed or threw error');

  // -------------------------------------------------------------
  // STAGE 2 — COACH ENGINE & DISPATCH
  // -------------------------------------------------------------
  Logger.log('\n--- [STAGE 2] Coach Payload, Generation & Delivery ---');

  // 1. buildCoachPayload('daily')
  const payload = typeof buildCoachPayload === 'function' ? buildCoachPayload('daily', ss) : null;
  if (payload) {
    const requiredKeys = ['period', 'cumulative_today', 'realistic_daily', 'flat_daily', 'days_left_in_month',
                          'days_to_positive', 'spend_today', 'over_budget', 'over_budget_by', 'buckets', 'target_header', 'categories_over_target', 'mandatory_warnings'];
    const actualKeys = Object.keys(payload);
    const hasAllRequired = requiredKeys.every(k => actualKeys.includes(k));
    const forbiddenKeys = ['budget_trend', 'spend_trend', 'recent_daily_trends', 'pace_verdict', 'taxes'];
    const hasNoForbidden = forbiddenKeys.every(k => !actualKeys.includes(k));
    assert(hasAllRequired && hasNoForbidden,
           'buildCoachPayload("daily") has exact Stage 2 schema with 0 legacy trend keys',
           `Keys: ${actualKeys.join(', ')}`);

    // 2. categories_over_target rules (with S$100 materiality floor)
    const catsOver = payload.categories_over_target || [];
    let catsOverValid = catsOver.length <= 5;
    let isSortedDesc = true;
    for (let i = 0; i < catsOver.length; i++) {
      const item = catsOver[i];
      if (item.discretionary_spend === undefined || item.committed_spend === undefined || item.actionable === undefined || item.discretionary_spend <= 0 || item.over_by < 100) {
        catsOverValid = false;
      }
      if (i > 0 && item.discretionary_spend > catsOver[i - 1].discretionary_spend) {
        isSortedDesc = false;
      }
    }
    assert(catsOverValid && isSortedDesc,
           `categories_over_target valid: count <= 5 (${catsOver.length}), sorted by discretionary_spend desc, all over_by >= 100 & discretionary_spend > 0`,
           `Categories: ${JSON.stringify(catsOver)}`);

    // 3. Rounding: no numeric values with > 2 decimal places
    let unroundedFound = [];
    function checkRounding(obj, path) {
      if (obj === null || obj === undefined) return;
      if (typeof obj === 'number') {
        const str = obj.toString();
        if (str.includes('.') && str.split('.')[1].length > 2) {
          unroundedFound.push(`${path}: ${obj}`);
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((item, idx) => checkRounding(item, `${path}[${idx}]`));
      } else if (typeof obj === 'object') {
        Object.keys(obj).forEach(k => checkRounding(obj[k], `${path}.${k}`));
      }
    }
    checkRounding(payload, 'payload');
    assert(unroundedFound.length === 0, 'No float-tail numbers (>2 decimal places) anywhere in coach payload',
           `Offenders: ${unroundedFound.join(', ')}`);
  } else {
    assert(false, 'buildCoachPayload("daily") returns payload object', 'Payload is null');
  }

  // 4. Model Config
  assert(typeof GEMINI_MODEL_ID !== 'undefined' && GEMINI_MODEL_ID === 'gemini-3.6-flash' &&
         typeof BACKUP_MODEL_1 !== 'undefined' && BACKUP_MODEL_1 === 'gemini-3.5-flash-lite' &&
         typeof BACKUP_MODEL_2 !== 'undefined' && BACKUP_MODEL_2 === 'gemini-3.7-flash',
         'Gemini model constants: 3.6-flash (primary) -> 3.5-flash-lite (b1) -> 3.7-flash (b2)',
         `Config: Primary=${typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'undefined'}`);

  // 5. Generate Coach Brief
  let brief = '';
  try {
    brief = typeof generateCoachBrief === 'function' ? generateCoachBrief(payload) : '';
  } catch (e) {
    Logger.log(`Error calling generateCoachBrief: ${e.message}`);
  }

  Logger.log('\n========================================================');
  Logger.log('GENERATED MORNING COACH BRIEF:');
  Logger.log('--------------------------------------------------------');
  Logger.log(brief || '(Empty brief generated)');
  Logger.log('========================================================\n');

  if (brief) {
    // Assert ≤4 sentences
    const sentences = brief.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    assert(sentences.length <= 5, `Coach brief is concise (<= 4-5 sentences, found ${sentences.length})`,
           `Sentences count: ${sentences.length}`);

    // Assert Telegram HTML (<b> or <i>) and no **markdown**
    const hasMarkdownBold = brief.includes('**');
    const hasHtmlTag = brief.includes('<b>') || brief.includes('<i>') || brief.includes('<code>');
    assert(!hasMarkdownBold && hasHtmlTag, 'Coach brief uses Telegram HTML (<b> or <i>) and NO markdown **bold**',
           'Contains markdown or lacks HTML tags');

    // Assert no bare minus sign before money value
    const hasProseMinus = /-\s*S\$|\b-\d+\.\d{2}/.test(brief);
    assert(!hasProseMinus, 'Coach brief contains no bare minus signs before money values (e.g. no -S$ or -87.81)',
           'Found bare negative sign in text');
  } else {
    assert(false, 'Coach brief generated successfully', 'Brief is empty');
  }

  // 6. Test Delivery to Val ONLY (no spam to Rita)
  if (brief) {
    try {
      sendTelegramMessage(`[TEST VERIFY] ${brief}`, '96069960');
      assert(true, 'Test Telegram delivery sent to Val (96069960) ONLY', '');
    } catch (e) {
      assert(false, 'Test Telegram delivery to Val', e.message);
    }
  }

  // -------------------------------------------------------------
  // SCHEDULER & DISPATCH AUDIT
  // -------------------------------------------------------------
  Logger.log('\n--- [SCHEDULER] Triggers & Dispatch Configuration ---');
  
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log(`Existing project triggers count: ${triggers.length}`);
  triggers.forEach((t, i) => {
    Logger.log(`  Trigger #${i + 1}: handler="${t.getHandlerFunction()}", eventType=${t.getEventType()}`);
  });

  // Timezone check
  const tz = Session.getScriptTimeZone();
  assert(tz === 'Asia/Singapore', `Script timezone is "Asia/Singapore" (got "${tz}")`, `Got "${tz}"`);

  // Report existing sent_* keys
  const props = PropertiesService.getScriptProperties();
  const allPropKeys = props.getKeys();
  const sentKeys = allPropKeys.filter(k => k.startsWith('sent_'));
  Logger.log(`Existing sent_* keys in Script Properties (${sentKeys.length}):`);
  sentKeys.forEach(k => {
    Logger.log(`  ${k} = "${props.getProperty(k)}"`);
  });

  // -------------------------------------------------------------
  // CROSS-CUTTING & INTEGRITY AUDIT
  // -------------------------------------------------------------
  Logger.log('\n--- [CROSS-CUTTING] Security & Read-Only Integrity ---');

  // Script Properties presence (length only, never values)
  ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'WEBHOOK_SECRET', 'AUTHORIZED_CHAT_IDS'].forEach(k => {
    const val = props.getProperty(k);
    assert(Boolean(val && val.length > 0), `Script Property "${k}" is present (length: ${val ? val.length : 0})`,
           `Property "${k}" missing or empty`);
  });

  // Assert Transactions row count did NOT change
  const finalTransLastRow = transSheet ? transSheet.getLastRow() : 0;
  assert(initialTransLastRow === finalTransLastRow,
         `Transactions tab row count is unchanged before (${initialTransLastRow}) vs after (${finalTransLastRow}) [Read-Only Guarantee]`,
         `Row count changed: ${initialTransLastRow} -> ${finalTransLastRow}`);

  // -------------------------------------------------------------
  // SUMMARY REPORT
  // -------------------------------------------------------------
  Logger.log('\n================================================================');
  Logger.log(`VERIFICATION SUMMARY: ${passCount} PASSED, ${failCount} FAILED (Total: ${passCount + failCount})`);
  Logger.log('================================================================\n');

  return {
    passed: passCount,
    failed: failCount,
    total: passCount + failCount
  };
}
