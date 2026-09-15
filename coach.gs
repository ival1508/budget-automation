/**
 * Budget 2026 Automation v1 - Budget Coach & Audit Assistant
 * File: coach.gs
 * 
 * Provides automated AI budget coaching, daily briefings, weekly mandatory expense audits,
 * and semantic reconciliation using Gemini Flash multimodal AI.
 */

/**
 * Assembles the structured JSON payload for the Gemini Coach API.
 * Stage 2 schema: contains only the required grounding numbers, strictly rounded to 2dp.
 * 
 * @param {string} [period='daily'] - Period type ('daily' or 'monthly').
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSs] - Optional Spreadsheet instance.
 * @param {Date} [optReportDate] - Daily snapshot date or monthly window; monthly defaults to getMonthlyReportDate().
 * @return {Object} Structured JSON payload for Gemini coach model.
 */
function buildCoachPayload(period, optSs, optReportDate) {
  const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
  const p = period || 'daily';
  if (p === 'monthly') return buildMonthlyCoachPayload(ss, optReportDate || getMonthlyReportDate());
  const reportDate = optReportDate || new Date();
  
  // Single source for all daily budget & pacing metrics
  const pacingData = typeof getDailyPacing === 'function' ? getDailyPacing(reportDate, ss) : {
    K_cumulative_today: 0,
    L_saldo_yesterday: 0,
    D17_flat_daily: 0,
    D19_realistic_daily: 0,
    days_left: 1,
    days_to_positive: 0
  };

  if (pacingData.error) {
    return { period: p, error: pacingData.error, month_tab: pacingData.month_tab || '' };
  }

  const pacing = typeof get503020Status === 'function' ? get503020Status(ss, false, reportDate) : {};
  const todaySpend = typeof getTodaySpend === 'function' ? getTodaySpend(reportDate, ss) : 0;

  const cumulativeToday = Number(Number(pacingData.K_cumulative_today || 0).toFixed(2));
  const realisticDaily = Number(Number(pacingData.D19_realistic_daily || 0).toFixed(2));
  const flatDaily = Number(Number(pacingData.D17_flat_daily || 0).toFixed(2));
  const daysLeftInMonth = pacingData.days_left || 1;
  const daysToPositive = pacingData.days_to_positive || 0;
  const spendToday = Number(Number(todaySpend || 0).toFixed(2));

  const buckets = {
    needs: {
      actual: Number(Number((pacing.needs && pacing.needs.actual) || 0).toFixed(2)),
      target: Number(Number((pacing.needs && pacing.needs.target) || 0).toFixed(2))
    },
    wants: {
      actual: Number(Number((pacing.wants && pacing.wants.actual) || 0).toFixed(2)),
      target: Number(Number((pacing.wants && pacing.wants.target) || 0).toFixed(2))
    },
    savings: {
      actual: Number(Number((pacing.savings && pacing.savings.actual) || 0).toFixed(2)),
      target: Number(Number((pacing.savings && pacing.savings.target) || 0).toFixed(2))
    }
  };

  // Compute current-month category spend splits from Transactions (discretionary vs committed)
  const splits = getCurrentMonthCategorySplits(ss, reportDate);

  // Pool ALL sub_categories across ALL buckets from get503020Status
  const allSubCategories = [
    ...((pacing.needs && pacing.needs.sub_categories) || []),
    ...((pacing.wants && pacing.wants.sub_categories) || []),
    ...((pacing.savings && pacing.savings.sub_categories) || [])
  ];

  // 1. Filter for categories over target with S$100 materiality floor (target > 0 && actual - target >= 100)
  // 2. Compute the split between discretionary (Расходы) and committed (Обязательные расходы)
  // 3. Keep categories where discretionary_spend > 0, rank by discretionary_spend descending, cap at 5
  const categoriesOverTarget = allSubCategories
    .filter(sub => {
      const act = Number(sub.actual || 0);
      const tgt = Number(sub.target || 0);
      return tgt > 0 && (act - tgt) >= 100;
    })
    .map(sub => {
      const catName = String(sub.name || '').trim();
      const catKey = catName.toLowerCase();
      const split = splits[catKey] || { discretionary: 0, committed: 0 };

      const act = Number(Number(sub.actual || 0).toFixed(2));
      const tgt = Number(Number(sub.target || 0).toFixed(2));
      const overBy = Number((act - tgt).toFixed(2));
      const discretionarySpend = Number(Number(split.discretionary || 0).toFixed(2));
      const committedSpend = Number(Number(split.committed || 0).toFixed(2));

      return {
        name: catName,
        actual: act,
        target: tgt,
        over_by: overBy,
        discretionary_spend: discretionarySpend,
        committed_spend: committedSpend,
        actionable: discretionarySpend > 0
      };
    })
    .filter(item => item.discretionary_spend > 0)
    .sort((a, b) => b.discretionary_spend - a.discretionary_spend)
    .slice(0, 5);

  const isOverBudget = realisticDaily < 0;

  return {
    period: p,
    cumulative_today: cumulativeToday,
    realistic_daily: realisticDaily,
    flat_daily: flatDaily,
    days_left_in_month: daysLeftInMonth,
    days_to_positive: daysToPositive,
    spend_today: spendToday,
    over_budget: isOverBudget,
    buckets: buckets,
    target_header: String(pacing.target_header || ''),
    categories_over_target: categoriesOverTarget,
    mandatory_warnings: []
  };
}

/**
 * Helper to compute category spend breakdown (discretionary vs committed) from Transactions for current month.
 * Excludes Снятие денег and all income types.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {Object<string, { discretionary: number, committed: number }>}
 */
function getCurrentMonthCategorySplits(ss, optDate, optStrict) {
  const splits = {};
  try {
    const transTabName = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.CORE_TABS) ? SHEET_FACTS.CORE_TABS.TRANSACTIONS : 'Transactions';
    const sheet = ss.getSheetByName(transTabName);
    if (!sheet) return splits;

    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return splits;

    const tz = optStrict ? 'Asia/Singapore' : (ss.getSpreadsheetTimeZone() || 'Asia/Singapore');
    const now = optDate || new Date();
    const currentMonthYearStr = Utilities.formatDate(now, tz, 'MM.yyyy');

    const numCols = sheet.getLastColumn();
    const startRow = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE)
      ? SHEET_FACTS.TRANSACTIONS_TAB_STRUCTURE.DATA_START_ROW
      : 2;

    const rawData = sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).getValues();
    const dispData = sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).getDisplayValues();

    for (let r = 0; r < rawData.length; r++) {
      const row = rawData[r];
      const disp = dispData[r];
      const cellDate = row[0];
      const category = String(row[7] || '').trim(); // Col H

      if (!category) continue;

      let dateMatch = false;
      if (cellDate instanceof Date) {
        const rowMonthYearStr = Utilities.formatDate(cellDate, tz, 'MM.yyyy');
        dateMatch = (rowMonthYearStr === currentMonthYearStr);
      } else if (typeof cellDate === 'string' && cellDate.trim()) {
        const parts = cellDate.trim().split('.');
        if (parts.length === 3) {
          const monthYear = `${parts[1].padStart(2, '0')}.${parts[2]}`;
          dateMatch = (monthYear === currentMonthYearStr);
        }
      }

      if (!dateMatch) continue;

      const typeColC = String(row[2] || '').trim().replace(/\t/g, '');
      if (optStrict && typeColC !== 'Расходы' && typeColC !== 'Обязательные расходы') continue;
      const catKey = category.toLowerCase();
      if (!splits[catKey]) {
        splits[catKey] = { discretionary: 0, committed: 0 };
      }

      const amount = optStrict ? readCoachTransactionAmount(row, disp, true) : (typeof parseAmountNumber === 'function')
        ? (parseAmountNumber(row[4], disp[4]) || parseAmountNumber(row[3], disp[3]) || 0)
        : (parseFloat(row[4]) || parseFloat(row[3]) || 0);

      if (typeColC === 'Расходы') {
        splits[catKey].discretionary += amount;
      } else if (typeColC === 'Обязательные расходы') {
        splits[catKey].committed += amount;
      }
    }
  } catch (e) {
    if (optStrict) throw e;
    Logger.log(`Error in getCurrentMonthCategorySplits: ${e.message}`);
  }
  return splits;
}

/** Manual retrospectives use the latest completed month; late month-end uses today. */
function getMonthlyReportDate(optNow) {
  const now = optNow || new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('A valid monthly report date is required.');
  const year = Number(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy'));
  const month = Number(Utilities.formatDate(now, 'Asia/Singapore', 'M'));
  const day = Number(Utilities.formatDate(now, 'Asia/Singapore', 'd'));
  const minutes = Number(Utilities.formatDate(now, 'Asia/Singapore', 'H')) * 60 +
    Number(Utilities.formatDate(now, 'Asia/Singapore', 'm'));
  if (day === new Date(Date.UTC(year, month, 0)).getUTCDate() && minutes >= 23 * 60 + 30) {
    return new Date(now.getTime());
  }
  return new Date(Date.UTC(year, month - 1, 0, 12));
}

/** Payment completion is deterministic; this summary does not infer due dates. */
function summarizeMonthlyMandatory(expected, logged) {
  const totals = {};
  logged.forEach(item => {
    const key = String(item.category || '').trim().toLowerCase();
    const amount = Number(item.amount !== undefined ? item.amount : item.actual_amount);
    if (!Number.isFinite(amount)) throw new Error('Invalid logged mandatory amount.');
    totals[key] = (totals[key] || 0) + amount;
  });
  const summary = { paid: 0, unpaid: 0, excluded: 0, items: [] };
  expected.forEach(item => {
    const name = String(item.label || item.name || '').trim();
    const planned = Number(item.amount !== undefined ? item.amount : item.planned_amount);
    if (!Number.isFinite(planned) || planned < 0) throw new Error('Invalid planned mandatory amount.');
    if (planned === 0 || (SHEET_FACTS.NON_LEDGER_MANDATORY || []).includes(name)) {
      summary.excluded++; return;
    }
    const actual = Number((totals[name.toLowerCase()] || 0).toFixed(2));
    const paid = item.paidFlag === true || item.is_checked === true || actual >= planned - 0.005;
    summary[paid ? 'paid' : 'unpaid']++;
    summary.items.push({ name: name, planned: planned, actual: actual,
      status: paid ? 'paid' : (actual > 0 ? 'partial' : 'unpaid') });
  });
  return summary;
}

/** Assemble only the selected month's numbers; never label daily pacing as monthly results. */
function buildMonthlyCoachPayload(ss, reportDate) {
  if (!(reportDate instanceof Date) || !Number.isFinite(reportDate.getTime())) throw new Error('A valid monthly report date is required.');
  const monthTab = getCurrentMonthTabName(reportDate);
  const reportMonth = Utilities.formatDate(reportDate, 'Asia/Singapore', 'yyyy-MM');
  try {
    if (!ss || !ss.getSheetByName(monthTab)) return { period: 'monthly', error: 'missing_month', month_tab: monthTab, report_month: reportMonth };
    if (!ss.getSheetByName('Transactions')) throw new Error('Transactions is missing.');
    const pacing = get503020Status(ss, false, reportDate, true);
    if (pacing.error || !pacing.target_header) throw new Error(pacing.message || pacing.error || 'Budget targets are unavailable.');
    const expected = getMandatoryExpenses(ss, reportDate, true);
    if (!expected.length) throw new Error('Mandatory plan is unavailable.');
    const logged = getLoggedMandatoryThisMonth(ss, reportDate, true);
    const velocity = getCategoryVelocity(ss, reportDate, true);
    const splits = getCurrentMonthCategorySplits(ss, reportDate, true);
    const buckets = {};
    ['needs', 'wants', 'savings'].forEach(key => {
      const source = pacing[key];
      if (!source || !Number.isFinite(source.actual) || !Number.isFinite(source.target) ||
          source.target_percent === undefined) throw new Error('Monthly bucket totals/targets are unavailable.');
      buckets[key] = { actual: source.actual, target: source.target,
        actual_percent: source.total_percent, target_percent: source.target_percent };
    });
    const volatile = ['Рестораны', 'Развлечения', 'Дом', 'Подарки'].map(name => ({
      name: name, actual: Number(((velocity[name] || {}).total || 0).toFixed(2))
    }));
    const categories = [...(pacing.needs.sub_categories || []), ...(pacing.wants.sub_categories || [])]
      .map(category => ({ ...category, over_by: Number((category.actual - category.target).toFixed(2)),
        discretionary_spend: Number(((splits[category.name.toLowerCase()] || {}).discretionary || 0).toFixed(2)),
        committed_spend: Number(((splits[category.name.toLowerCase()] || {}).committed || 0).toFixed(2)) }))
      .filter(category => category.actual > 0 && category.target > 0 && category.discretionary_spend > 0)
      .sort((a, b) => b.over_by - a.over_by || b.actual - a.actual);
    return { period: 'monthly', report_month: reportMonth, month_tab: monthTab,
      report_start: '01.' + Utilities.formatDate(reportDate, 'Asia/Singapore', 'MM.yyyy'),
      report_end: Utilities.formatDate(new Date(Date.UTC(
        Number(Utilities.formatDate(reportDate, 'Asia/Singapore', 'yyyy')),
        Number(Utilities.formatDate(reportDate, 'Asia/Singapore', 'M')), 0, 12)), 'Asia/Singapore', 'dd.MM.yyyy'),
      buckets: buckets, target_header: pacing.target_header, volatile_categories: volatile,
      category_focus: categories.length ? categories[0] : null,
      mandatory_summary: summarizeMonthlyMandatory(expected, logged) };
  } catch (error) {
    return { period: 'monthly', error: 'monthly_read_error', message: error.message,
      month_tab: monthTab, report_month: reportMonth };
  }
}

/**
 * STAGE 2 — Reusable Coach Brief Generator using gemini-3.6-flash.
 * Evaluates budget payload and produces a concise, strictly grounded conversational brief.
 * 
 * @param {Object} [payload] - Structured budget payload (from buildCoachPayload).
 * @return {string} Concise Telegram-native HTML financial coach message.
 */
function generateCoachBrief(payload) {
  const ctx = payload || buildCoachPayload('daily');
  const fallback = ctx.period === 'monthly' ? buildFallbackMonthlyBrief : buildFallbackCoachBrief;
  if (ctx.error) return fallback(ctx);
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    if (ctx.period === 'monthly') return fallback(ctx);
    throw new Error('GEMINI_API_KEY property is missing in Script Properties.');
  }

  const systemInstruction = ctx.period === 'monthly' ? `You are a sharp, warm financial coach for a Singapore family. Write a month-in-review using only this monthly JSON, in at most four short conversational sentences.
Lead with the month_tab and compare the actual/target amounts and percentages for Needs, Wants and Savings. Include the mandatory_summary paid and unpaid counts; partial items are unpaid, and excluded planning lines are not payments. Do not call unpaid items late: no due dates are supplied.
For each bucket use "Needs S$actual (actual_percent) vs S$target (target_percent)" (and likewise Wants and Savings). Use "N paid, N unpaid" for completion counts.
Reference at most one category, using category_focus, and end with one concrete focus for next month. Do not advise cutting committed costs. Carry target_header as a short separate label so the target basis remains visible.
USE ONLY numbers supplied in this payload. Never calculate a total from bucket amounts, invent a cap, infer a month-over-month trend, or quote daily pacing. All money must use S$; percentages must use %. No tables, bullet lists, or headings; use only <b> and <i> for Telegram HTML.` : `You are a sharp, warm financial coach for a Singapore family. From this JSON write a concise Telegram brief formatted as clean bullet points. At most 3 short sentences total.

Structure as bullet points:
• <b>Pace:</b> State the reality check on pace and allowance:
  - If realistic_daily is negative (or over_budget is true): do NOT state a daily allowance. Say the month's budget is already spent and state days_left_in_month. Do not quote a total overspend: realistic_daily is per day and no monthly overspend amount is supplied. NEVER present a negative number as a daily allowance or a "daily deficit".
  - If realistic_daily is positive:
    * If cumulative_today is negative: state plainly how far behind pace they are and how to clear it (e.g. "You're <b>S$88</b> behind pace (one zero-spend day clears it), leaving <b>S$110.63</b>/day for the last 2 days.").
    * NEVER use a minus sign in prose (write "S$88 behind pace", NEVER "-S$88" or "behind pace at -87.81").
    * If cumulative_today is positive: state that they are ahead of pace (e.g. "You're <b>S$120</b> ahead of pace with <b>S$150</b>/day spendable for the last 3 days.").
• <b>Watch:</b> Name at most 2 categories from categories_over_target — the largest discretionary overspend first. Do not list every category.
  - If committed_spend > 0: quote the discretionary portion and note the rest is committed (e.g. "<i>Транспорт</i> is over target, though S$2,707 is the car loan; S$786 was discretionary.").
  - If committed_spend == 0: quote actual vs target (e.g. "<i>Развлечения</i> is at S$1,892 vs a S$450 target.").
  - Never imply the user can cut a committed cost. If categories_over_target is empty, omit this bullet; an empty filtered list does not prove all categories are within target.
• <b>Action:</b> End with one concrete instruction, never a motivational sign-off (e.g. "Zero out discretionary spending for the next 2 days to stop the deficit." or "Keep today’s discretionary spending within the supplied realistic_daily allowance."). NEVER end with motivational sign-offs like "finish the month strong", "keep up the great work", or "you've got this".

Rules:
- USE ONLY numbers present in the JSON. Never compute, infer, extrapolate or invent figures.
- Every money amount MUST be formatted with the "S$" currency symbol and 2 decimal places or rounded integers (e.g. S$88, S$104, S$110.63, S$1,892, S$3,304.80). NEVER print bare numbers without S$.
- NEVER use a minus sign or negative amount in prose (e.g. no -S$104, no "-103.92/day", no "daily deficit of S$103.92").
- Never describe trend directions (rising, falling, clawed back) not in the JSON.
- Structure strictly as bullet points starting with "• ". Do not output a single long paragraph.
- Keep total length to at most 3 short sentences.
- Telegram HTML only: <b>bold</b>, <i>italic</i>. Never markdown (**bold**).
- Direct, natural, actionable — never preachy, robotic, or moralising.`;

  const apiPayload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        parts: [{ text: JSON.stringify(ctx, null, 2) }]
      }
    ],
    generationConfig: {
      temperature: 0.3
    }
  };

  const targetModel = typeof COACH_MODEL_ID !== 'undefined' ? COACH_MODEL_ID : 'gemini-3.8-flash';
  Logger.log(`Generating Coach Brief via Gemini (Target: ${targetModel})...`);
  const coachStart = Date.now();
  try {
    const apiResult = callGeminiApiWithRetry(apiPayload, apiKey, targetModel);
    const responseText = typeof apiResult === 'object' ? apiResult.text : apiResult;
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : targetModel;
    const elapsedMs = (typeof apiResult === 'object' && apiResult.elapsedTimeMs) ? apiResult.elapsedTimeMs : (Date.now() - coachStart);
    Logger.log(`Coach Brief successfully generated by model: ${modelUsed} in ${elapsedMs}ms`);

    const responseJson = JSON.parse(responseText);
    const textOutput = responseJson.candidates &&
      responseJson.candidates[0] &&
      responseJson.candidates[0].content &&
      responseJson.candidates[0].content.parts &&
      responseJson.candidates[0].content.parts[0].text;

    if (textOutput && textOutput.trim()) {
      let cleaned = textOutput.trim();
      // Ensure any markdown **bold** is converted to <b>bold</b> for Telegram HTML
      cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
      if (!coachMoneyIsGrounded(cleaned, ctx) || (ctx.period === 'monthly' && !monthlyCoachBriefIsGrounded(cleaned, ctx))) {
        Logger.log('Coach returned ungrounded figures or an invalid monthly brief; using grounded fallback.');
        return fallback(ctx);
      }
      return cleaned;
    }
    Logger.log('Empty response from Gemini, using fallback brief.');
    return fallback(ctx);
  } catch (err) {
    Logger.log(`Gemini Coach invocation failed: ${err.message}. Using fallback brief.`);
    return fallback(ctx);
  }
}

/**
 * Backwards-compatible alias for generateCoachBrief.
 */
function generateDailyCoachBrief(contextJSON) {
  return generateCoachBrief(contextJSON || buildCoachPayload('daily'));
}

/** Reject generated monetary figures that cannot be traced to a money field. */
function coachMoneyIsGrounded(text, payload) {
  const allowed = new Set();
  function add(value) {
    if (typeof value !== 'number' || !isFinite(value)) return;
    const amount = Math.abs(value);
    allowed.add(Number(amount.toFixed(2)));
    allowed.add(Math.round(amount));
  }
  ['cumulative_today', 'realistic_daily', 'flat_daily', 'spend_today'].forEach(key => add(payload[key]));
  Object.values(payload.buckets || {}).forEach(bucket => { add(bucket.actual); add(bucket.target); });
  (payload.volatile_categories || []).forEach(category => add(category.actual));
  if (payload.category_focus) {
    ['actual', 'target', 'over_by', 'discretionary_spend', 'committed_spend'].forEach(key => add(payload.category_focus[key]));
  }
  ((payload.mandatory_summary || {}).items || []).forEach(item => { add(item.planned); add(item.actual); });
  (payload.categories_over_target || []).forEach(category => {
    ['actual', 'target', 'over_by', 'discretionary_spend', 'committed_spend'].forEach(key => add(category[key]));
  });
  const plain = String(text || '').replace(/<[^>]*>/g, '');
  const amounts = plain.matchAll(/(?:S\$|\$|SGD\s*)\s*(-?\d[\d,]*(?:\.\d+)?)/gi);
  for (const match of amounts) {
    if (!allowed.has(Number(match[1].replace(/,/g, '')))) return false;
  }
  return true;
}

/** Monthly prose must preserve the reporting identity, percentages and payment counts. */
function monthlyCoachBriefIsGrounded(text, payload) {
  if (/<\/?(?!b\b|i\b)[a-z][^>]*>/i.test(text) || /[•|]|^\s*[-#]/m.test(text)) return false;
  let plain = String(text).replace(/<[^>]*>/g, '');
  if (!plain.includes(payload.month_tab) || !plain.includes(payload.target_header)) return false;
  plain = plain.split(payload.month_tab).join('').split(payload.target_header).join('');
  if (plain.length > 1600 || (plain.match(/[.!?](?=\s|$)/g) || []).length > 4) return false;
  if (/total (?:monthly )?(?:spend|budget)|volatile|month.over.month|daily (?:pace|allowance)|\blate\b|\boverdue\b/i.test(plain)) return false;
  if (/(?:^|[^S])\$|\bSGD\b/i.test(plain)) return false;
  // Verify the three comparisons against their own source fields, including their labels.
  for (const key of ['needs', 'wants', 'savings']) {
    const comparison = new RegExp('\\b' + key + '\\b\\s*:?\\s*S\\$\\s*(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*\\(([-\\d.,]+)%\\)\\s*vs\\.?\\s*S\\$\\s*(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*\\(([-\\d.,]+)%\\)', 'i');
    const match = plain.match(comparison), bucket = payload.buckets[key];
    if (!match) return false;
    const sameMoney = (text, value) => [Number(value.toFixed(2)), Math.round(value)].includes(Number(text.replace(/,/g, '')));
    const percent = value => Number(String(value).replace('%', '').replace(',', '.'));
    if (!sameMoney(match[1], bucket.actual) || !sameMoney(match[3], bucket.target) ||
        percent(match[2]) !== percent(bucket.actual_percent) || percent(match[4]) !== percent(bucket.target_percent)) return false;
  }
  const percentages = new Set();
  Object.values(payload.buckets).forEach(bucket => {
    [bucket.actual_percent, bucket.target_percent].forEach(value => {
      percentages.add(Number(String(value).replace(/%/g, '').replace(',', '.')));
    });
  });
  let valid = true;
  plain = plain.replace(/(\d+(?:[.,]\d+)?)\s*%/g, (_, value) => {
    if (!percentages.has(Number(value.replace(',', '.')))) valid = false;
    return '';
  });
  plain = plain.replace(/S\$\s*-?\d[\d,]*(?:\.\d+)?/g, '');
  const counts = payload.mandatory_summary;
  // Require unambiguous completion counts, rather than merely whitelisting any small integer.
  for (const label of ['paid', 'unpaid']) {
    const expected = counts[label];
    const pattern = new RegExp('\\b' + expected + '\\s+' + label + '\\b|\\b' + label + '\\s*:\\s*' + expected + '\\b', 'i');
    if (!pattern.test(plain)) return false;
  }
  for (const number of plain.matchAll(/\d+(?:[.,]\d+)?/g)) {
    if (![counts.paid, counts.unpaid, counts.excluded].includes(Number(number[0]))) valid = false;
  }
  return valid;
}

function escapeCoachHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Fallback generator for coach brief if Gemini API call fails or capacity exceeds.
 * Generates dynamic, strictly grounded messages without hallucinations.
 * 
 * @param {Object} payload - Budget coach payload object.
 * @return {string} Short, dynamic fallback brief in Telegram HTML with bullet points.
 */
function buildFallbackCoachBrief(payload) {
  if (payload.error === 'missing_month') {
    return "The current month's budget tab is missing; please create it before the next budget brief.";
  }
  if (payload.error) return 'Budget figures are unavailable; please check the sheet before planning today’s spending.';
  const cumulativeToday = Number(Number(payload.cumulative_today || 0).toFixed(2));
  const realisticDaily = Number(Number(payload.realistic_daily || 0).toFixed(2));
  const daysLeft = payload.days_left_in_month || 1;
  const daysToPositive = payload.days_to_positive || 0;
  const isOverBudget = Boolean(payload.over_budget || realisticDaily < 0);
  const categoriesOver = (payload.categories_over_target || []).slice(0, 2);

  const formatSgd = (val, roundInt = false) => {
    const num = Math.abs(Number(val) || 0);
    if (roundInt) {
      return 'S$' + Math.round(num).toLocaleString('en-US');
    }
    return 'S$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const daysText = daysLeft === 1 ? 'the final day' : `${daysLeft} days`;

  // Bullet 1: Pace & Runway
  let bullet1 = '';
  if (isOverBudget) {
    bullet1 = `• <b>Pace:</b> The month's budget is already spent with ${daysText} left.`;
  } else if (cumulativeToday < 0) {
    const behindFormatted = formatSgd(cumulativeToday, true);
    const dayText = daysToPositive === 1 ? 'one zero-spend day clears it' : `${daysToPositive} zero-spend days clear it`;
    bullet1 = `• <b>Pace:</b> You're <b>${behindFormatted}</b> behind pace (${dayText}), leaving <b>${formatSgd(realisticDaily)}</b>/day for the last ${daysText}.`;
  } else if (cumulativeToday > 0) {
    bullet1 = `• <b>Pace:</b> You're <b>${formatSgd(cumulativeToday)}</b> ahead of pace, with <b>${formatSgd(realisticDaily)}</b>/day spendable for the last ${daysText}.`;
  } else {
    bullet1 = `• <b>Pace:</b> Right on budget pace with <b>${formatSgd(realisticDaily)}</b>/day spendable for the last ${daysText}.`;
  }

  // Bullet 2: Category Watch (at most 2 categories)
  let bullet2 = '';
  if (categoriesOver.length > 0) {
    const catClauses = categoriesOver.map(cat => {
      if (cat.committed_spend > 0) {
        return `<i>${cat.name}</i> is over target (<b>${formatSgd(cat.committed_spend, true)}</b> committed, <b>${formatSgd(cat.discretionary_spend, true)}</b> discretionary)`;
      } else {
        return `<i>${cat.name}</i> is at <b>${formatSgd(cat.actual, true)}</b> vs <b>${formatSgd(cat.target, true)}</b> target`;
      }
    });
    bullet2 = `• <b>Watch:</b> ${catClauses.join('; ')}.`;
  }

  // Bullet 3: Action
  let bullet3 = '';
  if (isOverBudget) {
    bullet3 = `• <b>Action:</b> Zero out discretionary spending for the remaining ${daysText} to prevent further overspend.`;
  } else if (cumulativeToday < 0) {
    bullet3 = `• <b>Action:</b> Cap discretionary purchases today to protect your <b>${formatSgd(realisticDaily)}</b>/day allowance.`;
  } else {
    bullet3 = `• <b>Action:</b> Stick to your <b>${formatSgd(realisticDaily)}</b> daily limit to protect your buffer.`;
  }

  return [bullet1, bullet2, bullet3].filter(Boolean).join('\n');
}

/**
 * Backwards-compatible fallback alias.
 */
function buildFallbackDailyBrief(ctx) {
  return buildFallbackCoachBrief(ctx || buildCoachPayload('daily'));
}

/**
 * Test Runner: Simulates and logs coach briefs across 4 key financial trend scenarios:
 * 1. Digging down (consecutive overspend, shrinking allowance)
 * 2. Increasing / recovering (under budget, expanding allowance)
 * 3. Cooling down (spend slowed down after previous spike)
 * 4. Steady / on track
 */
function testCoachBriefScenarios() {
  Logger.log('=== Running testCoachBriefScenarios() ===');

  const basePacing = {
    needs: { actual: 1200, target: 2000, sub_categories: [{ name: 'Продукты', actual: 400, target: 600 }] },
    wants: { actual: 800, target: 1200, sub_categories: [{ name: 'Рестораны', actual: 350, target: 400 }] },
    savings: { actual: 1000, target: 1000 }
  };

  const scenarios = [
    {
      name: 'Scenario 1: Behind Pace (Negative Cumulative Position)',
      payload: {
        period: 'daily',
        cumulative_today: -87.81,
        realistic_daily: 110.63,
        flat_daily: 125.00,
        days_left_in_month: 2,
        days_to_positive: 1,
        spend_today: 0.00,
        buckets: basePacing,
        categories_over_target: [
          { name: 'Развлечения', actual: 1892.22, target: 450, over_by: 1442.22, discretionary_spend: 1892.22, committed_spend: 0, actionable: true },
          { name: 'Школа & Детский сад', actual: 7204.80, target: 3900, over_by: 3304.80, discretionary_spend: 304.80, committed_spend: 6900.00, actionable: true }
        ],
        mandatory_warnings: []
      }
    },
    {
      name: 'Scenario 2: Ahead of Pace (Positive Cumulative Position)',
      payload: {
        period: 'daily',
        cumulative_today: 120.50,
        realistic_daily: 135.00,
        flat_daily: 125.00,
        days_left_in_month: 10,
        days_to_positive: 0,
        spend_today: 0.00,
        buckets: basePacing,
        target_header: 'Target month',
        categories_over_target: [],
        mandatory_warnings: []
      }
    },
    {
      name: 'Scenario 3: Disciplined / Steady Spending',
      payload: {
        period: 'daily',
        cumulative_today: 15.00,
        realistic_daily: 118.00,
        flat_daily: 120.00,
        days_left_in_month: 16,
        days_to_positive: 0,
        spend_today: 25.00,
        buckets: basePacing,
        target_header: 'Target month',
        categories_over_target: [],
        mandatory_warnings: []
      }
    },
    {
      name: 'Scenario 4: Over Budget (Negative Realistic Daily Allowance)',
      payload: {
        period: 'daily',
        cumulative_today: -103.92,
        realistic_daily: -103.92,
        flat_daily: 125.00,
        days_left_in_month: 2,
        days_to_positive: 1,
        spend_today: 429.00,
        over_budget: true,
        buckets: basePacing,
        target_header: 'Target month',
        categories_over_target: [
          { name: 'Развлечения', actual: 1892.22, target: 450, over_by: 1442.22, discretionary_spend: 1892.22, committed_spend: 0, actionable: true }
        ],
        mandatory_warnings: []
      }
    }
  ];

  scenarios.forEach(sc => {
    Logger.log(`\n--- ${sc.name} ---`);
    const fallbackText = buildFallbackCoachBrief(sc.payload);
    Logger.log(`[Fallback Generator Output]:\n${fallbackText}\n`);
    try {
      const aiText = generateCoachBrief(sc.payload);
      Logger.log(`[Gemini Output]:\n${aiText}\n`);
    } catch (e) {
      Logger.log(`[Gemini Output Skipped/Error]: ${e.message}`);
    }
  });

  Logger.log('=== testCoachBriefScenarios() Complete ===');
}
function testSendMorningCoach() {
  Logger.log('=== Running testSendMorningCoach() (Stage 2 Checkpoint) ===');

  // 1. Build live coach payload
  const payload = buildCoachPayload('daily');
  Logger.log('Assembled Coach Payload:\n' + JSON.stringify(payload, null, 2));

  // 2. Generate brief via Gemini 3.6 Flash
  const briefText = generateCoachBrief(payload);
  Logger.log('Generated Coach Brief:\n' + briefText);

  // 3. Dispatch strictly to Val for trial run
  const trialChatId = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.USERS && SHEET_FACTS.USERS.VAL) 
    ? SHEET_FACTS.USERS.VAL.chat_id : '96069960';
  sendTelegramMessage(briefText, trialChatId);
  Logger.log(`✅ Stage 2 Checkpoint: Morning Coach brief sent to Val (Chat ID: ${trialChatId})!`);
}

/**
 * Backwards compatible test alias.
 */
function testSendCoachNudge() {
  testSendMorningCoach();
}

/**
 * Test Runner: Verifies Monthly Coach context collection, 
 * Gemini prompt execution, and Telegram delivery.
 */
function testSendMonthlyCoach() {
  Logger.log('=== Running testSendMonthlyCoach() ===');
  
  // 1. Fetch live context
  const context = buildCoachPayload('monthly');
  Logger.log('Monthly Context Aggregated: ' + JSON.stringify(context, null, 2));
  
  // 2. Generate Brief via Gemini
  let briefText = '';
  try {
    briefText = generateMonthlyCoachBrief(context);
  } catch (err) {
    Logger.log('Gemini Monthly Coach failed: ' + err.message);
    briefText = '⚠️ Failed to generate AI Monthly Brief. Error: ' + err.message;
  }
  
  Logger.log('--- Generated Monthly Brief ---\n' + briefText);
  
  // 3. Dispatch strictly to Val's Telegram chat ID
  sendTelegramMessage(briefText, '96069960');
  Logger.log('  Monthly Coach test message dispatched to Val only!');
}

/**
 * Generates a structured Weekly Mandatory Expenses Reconciliation Audit using Gemini AI.
 * Performs semantic matching between expected planned items (D3:E13) and logged fixed expenses.
 * 
 * @param {Object} [context] - Spreadsheet context object (defaults to getBudgetCoachContext()).
 * @return {string} Formatted audit message text in Telegram HTML format.
 */
function generateWeeklyMandatoryReport(context) {
  const ctx = context || getBudgetCoachContext();
  const mandatory = ctx.mandatory_expenses || { expected: [], logged: [] };

  const expectedList = mandatory.expected || [];
  const loggedList = mandatory.logged || [];

  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY property is missing in Script Properties.');
  }

  const promptText = `You are an expert financial controller analyzing a personal budget ledger.
Your task is to reconcile expected mandatory monthly expenses against actual logged fixed transactions for the current month.

### INPUT DATA:
1. EXPECTED MANDATORY EXPENSES (Planned D3:E13):
${JSON.stringify(expectedList, null, 2)}

2. LOGGED FIXED TRANSACTIONS ("Transactions" Sheet, Type: "Обязательные расходы"):
${JSON.stringify(loggedList, null, 2)}

### INSTRUCTIONS:
Perform semantic matching between expected item names (e.g. "Аренда", "Школа & Детский сад", "Лин", "Singtel") and logged transaction descriptions (e.g. "Mortgage July", "Agora Preschool", "Singtel Mobile", "Аренда за июль").

Generate a clean, structured Telegram HTML report using standard HTML tags (<b>, <i>, <code>). Do NOT use markdown syntax like ** or #.

Structure your response into exactly three sections:

1. ✅ <b>Paid / Settled:</b>
   - List expected planned items that have been logged this month.
   - For each: Item Name — S$Actual (Planned: S$Planned).
   - If there is a price variance (actual > planned or actual < planned), note the difference clearly (e.g., "Over planned by S$50.00").

2. ⏳ <b>Pending / Unpaid:</b>
   - List items from the planned D3:E13 list that have NO matching logged transaction yet this month.
   - For each: Item Name — Planned: S$Planned.

3. 💡 <b>Unplanned Fixed Spend:</b>
   - List any logged "Обязательные расходы" transactions that did NOT match any item on the planned D3:E13 list.
   - For each: Description — S$Actual (Logged on Date).

Keep the tone concise, encouraging, and clear.`;

  const payload = {
    contents: [
      {
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.2
    }
  };

  const targetModel = typeof COACH_MODEL_ID !== 'undefined' ? COACH_MODEL_ID : 'gemini-3.8-flash';
  Logger.log(`Generating Weekly Mandatory Audit report via Gemini (Target: ${targetModel})...`);
  const auditStart = Date.now();
  try {
    const apiResult = callGeminiApiWithRetry(payload, apiKey, targetModel);
    const responseText = typeof apiResult === 'object' ? apiResult.text : apiResult;
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : targetModel;
    const elapsedMs = (typeof apiResult === 'object' && apiResult.elapsedTimeMs) ? apiResult.elapsedTimeMs : (Date.now() - auditStart);
    Logger.log(`Weekly Mandatory Audit report generated by model: ${modelUsed} in ${elapsedMs}ms`);

    const json = JSON.parse(responseText);
    const textOutput = json.candidates &&
      json.candidates[0] &&
      json.candidates[0].content &&
      json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0].text;

    return textOutput || buildFallbackMandatoryReport(expectedList, loggedList);
  } catch (err) {
    Logger.log(`Failed to parse Gemini audit response: ${err.message}`);
    return buildFallbackMandatoryReport(expectedList, loggedList);
  }
}

/**
 * Fallback generator if Gemini API is unavailable for mandatory report.
 * 
 * @param {Array<Object>} expected - Array of expected mandatory objects.
 * @param {Array<Object>} logged - Array of logged mandatory objects.
 * @return {string} Formatted HTML fallback report.
 */
function buildFallbackMandatoryReport(expected, logged) {
  const lines = ['<b>📋 Weekly Mandatory Expenses Audit</b>\n'];
  
  lines.push('<b>Planned Mandatory Items (D3:E13):</b>');
  if (expected.length === 0) {
    lines.push('<i>None specified</i>');
  } else {
    expected.forEach(item => {
      lines.push(`• <b>${item.name}</b> — Planned: S$${Number(item.planned_amount).toFixed(2)}`);
    });
  }

  lines.push('\n<b>Logged Fixed Expenses:</b>');
  if (logged.length === 0) {
    lines.push('<i>No mandatory expenses logged this month yet.</i>');
  } else {
    logged.forEach(item => {
      lines.push(`• 📅 ${item.date} — <b>${item.description}</b>: S$${Number(item.actual_amount).toFixed(2)}`);
    });
  }

  return lines.join('\n');
}

/**
 * Generates an End-of-Month Retrospective Coach Brief using Gemini Flash AI.
 * 
 * @param {Object} [contextJSON] - Aggregated context object from reader.getBudgetCoachContext().
 * @return {string} Formatted Telegram HTML brief.
 */
function generateMonthlyCoachBrief(contextJSON) {
  const ctx = contextJSON || buildCoachPayload('monthly');
  if (ctx.period !== 'monthly') throw new Error('Monthly coaching requires an explicit monthly payload.');
  return generateCoachBrief(ctx);
}

/**
 * Fallback generator for monthly brief if Gemini API call fails.
 * 
 * @param {Object} ctx - Budget coach context object.
 * @return {string} Formatted Telegram HTML monthly retrospective brief.
 */
function buildFallbackMonthlyBrief(ctx) {
  const month = escapeCoachHtml(ctx.month_tab || ctx.report_month || 'Selected month');
  if (ctx.error) return `<b>${month}</b>: monthly results are unavailable; check that month's tab and budget figures before requesting the report again.`;
  const money = value => 'S$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const comparisons = ['needs', 'wants', 'savings'].map(key => {
    const bucket = ctx.buckets[key];
    return `${key[0].toUpperCase() + key.slice(1)} ${money(bucket.actual)} (${escapeCoachHtml(bucket.actual_percent)}) vs ${money(bucket.target)} (${escapeCoachHtml(bucket.target_percent)})`;
  });
  const payments = ctx.mandatory_summary;
  const focus = ctx.category_focus;
  const sentences = [
    `<b>${month}</b>: ${comparisons.join('; ')}.`,
    `Mandatory payments: ${payments.paid} paid, ${payments.unpaid} unpaid; CPF and zero-value plans are excluded.`
  ];
  if (focus) {
    sentences.push(`${escapeCoachHtml(focus.name)} finished at ${money(focus.actual)} vs ${money(focus.target)}, including ${money(focus.discretionary_spend)} discretionary spending.`);
    sentences.push(`Review discretionary purchases in ${escapeCoachHtml(focus.name)} against the target before spending next month.`);
  } else {
    sentences.push('Check the category targets before making discretionary purchases next month.');
  }
  return `<i>${escapeCoachHtml(ctx.target_header)}</i>\n` + sentences.join(' ');
}
