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
 * @return {Object} Structured JSON payload for Gemini coach model.
 */
function buildCoachPayload(period, optSs) {
  const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
  const p = period || 'daily';
  
  // Single source for all daily budget & pacing metrics
  const pacingData = typeof getDailyPacing === 'function' ? getDailyPacing(null, ss) : {
    K_cumulative_today: 0,
    L_saldo_yesterday: 0,
    D17_flat_daily: 0,
    D19_realistic_daily: 0,
    days_left: 1,
    days_to_positive: 0
  };

  const pacing = typeof get503020Status === 'function' ? get503020Status(ss) : {};
  const todaySpend = typeof getTodaySpend === 'function' ? getTodaySpend(null, ss) : 0;

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
  const splits = getCurrentMonthCategorySplits(ss);

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
  const overBudgetBy = isOverBudget ? Number(Math.abs(realisticDaily).toFixed(2)) : 0;

  return {
    period: p,
    cumulative_today: cumulativeToday,
    realistic_daily: realisticDaily,
    flat_daily: flatDaily,
    days_left_in_month: daysLeftInMonth,
    days_to_positive: daysToPositive,
    spend_today: spendToday,
    over_budget: isOverBudget,
    over_budget_by: overBudgetBy,
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
function getCurrentMonthCategorySplits(ss) {
  const splits = {};
  try {
    const transTabName = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.CORE_TABS) ? SHEET_FACTS.CORE_TABS.TRANSACTIONS : 'Transactions';
    const sheet = ss.getSheetByName(transTabName);
    if (!sheet) return splits;

    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return splits;

    const tz = ss.getSpreadsheetTimeZone() || 'Asia/Singapore';
    const now = new Date();
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
      const catKey = category.toLowerCase();
      if (!splits[catKey]) {
        splits[catKey] = { discretionary: 0, committed: 0 };
      }

      const amount = (typeof parseAmountNumber === 'function')
        ? (parseAmountNumber(row[4], disp[4]) || parseAmountNumber(row[3], disp[3]) || 0)
        : (parseFloat(row[4]) || parseFloat(row[3]) || 0);

      if (typeColC === 'Расходы') {
        splits[catKey].discretionary += amount;
      } else if (typeColC === 'Обязательные расходы') {
        splits[catKey].committed += amount;
      }
    }
  } catch (e) {
    Logger.log(`Error in getCurrentMonthCategorySplits: ${e.message}`);
  }
  return splits;
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
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY property is missing in Script Properties.');
  }

  const systemInstruction = `You are a sharp, warm financial coach for a Singapore family. From this JSON write a concise Telegram brief formatted as clean bullet points. At most 3 short sentences total.

Structure as bullet points:
• <b>Pace:</b> State the reality check on pace and allowance:
  - If realistic_daily is negative (or over_budget is true): do NOT state a daily allowance. Say the month's budget is already spent and name the overspend amount from over_budget_by, e.g. "You're <b>S$104</b> past the month's budget with 2 days left." NEVER present a negative number as a daily allowance or a "daily deficit".
  - If realistic_daily is positive:
    * If cumulative_today is negative: state plainly how far behind pace they are and how to clear it (e.g. "You're <b>S$88</b> behind pace (one zero-spend day clears it), leaving <b>S$110.63</b>/day for the last 2 days.").
    * NEVER use a minus sign in prose (write "S$88 behind pace", NEVER "-S$88" or "behind pace at -87.81").
    * If cumulative_today is positive: state that they are ahead of pace (e.g. "You're <b>S$120</b> ahead of pace with <b>S$150</b>/day spendable for the last 3 days.").
• <b>Watch:</b> Name at most 2 categories from categories_over_target — the largest discretionary overspend first. Do not list every category.
  - If committed_spend > 0: quote the discretionary portion and note the rest is committed (e.g. "<i>Транспорт</i> is over target, though S$2,707 is the car loan; S$786 was discretionary.").
  - If committed_spend == 0: quote actual vs target (e.g. "<i>Развлечения</i> is at S$1,892 vs a S$450 target.").
  - Never imply the user can cut a committed cost. If categories_over_target is empty, omit this bullet or state categories are within target.
• <b>Action:</b> End with one concrete instruction, never a motivational sign-off (e.g. "Zero out discretionary spending for the next 2 days to stop the deficit." or "Cap dining out at S$50 today to preserve your daily allowance."). NEVER end with motivational sign-offs like "finish the month strong", "keep up the great work", or "you've got this".

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

  Logger.log(`Generating Coach Brief via Gemini (Target: ${typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.6-flash'})...`);
  try {
    const apiResult = callGeminiApiWithRetry(apiPayload, apiKey);
    const responseText = typeof apiResult === 'object' ? apiResult.text : apiResult;
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : (typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.6-flash');
    Logger.log(`Coach Brief successfully generated by model: ${modelUsed}`);

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
      return cleaned;
    }
    Logger.log('Empty response from Gemini, using fallback brief.');
    return buildFallbackCoachBrief(ctx);
  } catch (err) {
    Logger.log(`Gemini Coach invocation failed: ${err.message}. Using fallback brief.`);
    return buildFallbackCoachBrief(ctx);
  }
}

/**
 * Backwards-compatible alias for generateCoachBrief.
 */
function generateDailyCoachBrief(contextJSON) {
  return generateCoachBrief(contextJSON || buildCoachPayload('daily'));
}

/**
 * Fallback generator for coach brief if Gemini API call fails or capacity exceeds.
 * Generates dynamic, strictly grounded messages without hallucinations.
 * 
 * @param {Object} payload - Budget coach payload object.
 * @return {string} Short, dynamic fallback brief in Telegram HTML with bullet points.
 */
function buildFallbackCoachBrief(payload) {
  const cumulativeToday = Number(Number(payload.cumulative_today || 0).toFixed(2));
  const realisticDaily = Number(Number(payload.realistic_daily || 0).toFixed(2));
  const daysLeft = payload.days_left_in_month || 1;
  const daysToPositive = payload.days_to_positive || 0;
  const isOverBudget = Boolean(payload.over_budget || realisticDaily < 0);
  const overBudgetBy = Number(Number(payload.over_budget_by || Math.abs(realisticDaily)).toFixed(2));
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
    bullet1 = `• <b>Pace:</b> You're <b>${formatSgd(overBudgetBy, true)}</b> past the month's budget with ${daysText} left.`;
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
        over_budget_by: 103.92,
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
  const context = getBudgetCoachContext();
  Logger.log('Monthly Context Aggregated: ' + JSON.stringify(context.pacing_50_30_20, null, 2));
  
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

  Logger.log('Generating Weekly Mandatory Audit report via Gemini...');
  try {
    const apiResult = callGeminiApiWithRetry(payload, apiKey);
    const responseText = typeof apiResult === 'object' ? apiResult.text : apiResult;
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : (typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.6-flash');
    Logger.log(`Weekly Mandatory Audit report generated by model: ${modelUsed}`);

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
  const ctx = contextJSON || getBudgetCoachContext();
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY property is missing in Script Properties.');
  }

  const systemInstruction = `You are an elite, highly strategic financial coach for a family in Singapore. Analyze their Google Sheets budget context (specifically the 50/30/20 pacing data, monthly tab name, and recent trends) and generate an End-of-Month Retrospective Brief for Telegram.

CRITICAL FORMATTING & CONTENT RULES:
1. Strict Telegram HTML: Use ONLY Telegram-supported HTML tags (e.g., <b>, <i>, <code>). Do NOT use markdown syntax (no **, ##, or \`\`\`) and do NOT use markdown or HTML tables.
2. Structure: Format the brief into clean, bulleted sections with emojis.
3. Content Requirements:
   - Total Monthly Overview: State total monthly spend vs. budget from the 50/30/20 data or daily status.
   - Final 50/30/20 Ratios: Display actual percentages and spend amounts for Needs, Wants, and Savings.
   - Volatile Sub-Category Callout: Identify and call out the single most volatile or highest over-budget sub-category in Needs or Wants.
   - Behavioral Recommendation: Provide 1-2 actionable, direct coaching recommendations for the upcoming month (e.g. 'tighten up on dining out' or 'great job staying under budget').

MANDATORY HTML MESSAGE TEMPLATE:
📊 <b>Monthly Financial Retrospective — [month_tab]</b>

• 💰 <b>Total Monthly Spend:</b> [Total actual spend]
• ⚖️ <b>Final 50/30/20 Split:</b>
  - <b>Needs:</b> [total_actual] ([total_percent])
  - <b>Wants:</b> [total_actual] ([total_percent])
  - <b>Savings:</b> [total_actual] ([total_percent])
• ⚠️ <b>Most Volatile Category:</b> [Identify highest spending / over-budget sub-category with exact amount]
• 💡 <b>Monthly Coach Recommendation:</b> [1-2 sentences of actionable coaching]`;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        parts: [{ text: JSON.stringify(ctx, null, 2) }]
      }
    ],
    generationConfig: {
      temperature: 0.2
    }
  };

  Logger.log('Generating Monthly Coach Brief via Gemini...');
  try {
    const apiResult = callGeminiApiWithRetry(payload, apiKey);
    const responseText = typeof apiResult === 'object' ? apiResult.text : apiResult;
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : (typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.6-flash');
    Logger.log(`Monthly Coach Brief generated by model: ${modelUsed}`);

    const json = JSON.parse(responseText);
    const textOutput = json.candidates &&
      json.candidates[0] &&
      json.candidates[0].content &&
      json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0].text;

    return textOutput ? textOutput.trim() : buildFallbackMonthlyBrief(ctx);
  } catch (err) {
    Logger.log(`Failed to parse Gemini monthly coach response: ${err.message}`);
    return buildFallbackMonthlyBrief(ctx);
  }
}

/**
 * Fallback generator for monthly brief if Gemini API call fails.
 * 
 * @param {Object} ctx - Budget coach context object.
 * @return {string} Formatted Telegram HTML monthly retrospective brief.
 */
function buildFallbackMonthlyBrief(ctx) {
  const monthName = ctx.month_tab || 'Current Month';
  const pacing = ctx.pacing_50_30_20 || {};
  const needs = pacing.needs || { total_actual: 0, total_percent: '0%', sub_categories: [] };
  const wants = pacing.wants || { total_actual: 0, total_percent: '0%', sub_categories: [] };
  const savings = pacing.savings || { total_actual: 0, total_percent: '0%', sub_categories: [] };

  const totalSpend = (needs.total_actual + wants.total_actual + savings.total_actual).toFixed(2);

  // Find most volatile subcategory in Wants or Needs
  let topSub = { name: 'None', actual: 0 };
  const allSubs = [...(needs.sub_categories || []), ...(wants.sub_categories || [])];
  allSubs.forEach(s => {
    if (s.actual > topSub.actual) {
      topSub = s;
    }
  });

  return [
    `📊 <b>Monthly Financial Retrospective — ${monthName}</b>`,
    ``,
    `• 💰 <b>Total Monthly Spend:</b> S$${totalSpend}`,
    `• ⚖️ <b>Final 50/30/20 Split:</b>`,
    `  - <b>Needs:</b> S$${Number(needs.total_actual).toFixed(2)} (${needs.total_percent})`,
    `  - <b>Wants:</b> S$${Number(wants.total_actual).toFixed(2)} (${wants.total_percent})`,
    `  - <b>Savings:</b> S$${Number(savings.total_actual).toFixed(2)} (${savings.total_percent})`,
    `• ⚠️ <b>Most Volatile Category:</b> ${topSub.name} (S$${Number(topSub.actual).toFixed(2)})`,
    `• 💡 <b>Monthly Coach Recommendation:</b> Keep an eye on discretionary spending as you head into the new month to stay within your targets!`
  ].join('\n');
}
