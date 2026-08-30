/**
 * Budget 2026 Automation v1 - Budget Coach & Audit Assistant
 * File: coach.gs
 * 
 * Provides automated AI budget coaching, daily briefings, weekly mandatory expense audits,
 * and semantic reconciliation using Gemini Flash multimodal AI.
 */

/**
 * STAGE 2 — UC-3 Reusable Coach Engine Payload Assembly.
 * Assembles clean JSON from reader.gs for AI coaching (daily or monthly views).
 * 
 * @param {string} [period] - 'daily' or 'monthly' (defaults to 'daily').
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSs] - Optional Spreadsheet instance/**
 * Assembles the structured JSON payload for the Gemini Coach API.
 * Step 8 payload: contains only the required grounding numbers, strictly rounded to 2dp.
 * Trend narratives and multi-day historical trend dumps are omitted to prevent LLM hallucinations.
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
  const catVelocity = typeof getCategoryVelocity === 'function' ? getCategoryVelocity(ss) : {};

  const currentDailyBudget = Number(Number(pacingData.D19_realistic_daily || 0).toFixed(2)); // Spendable per day (D19)
  const spendablePerDay = currentDailyBudget;
  const cumulativePosition = Number(Number(pacingData.K_cumulative_today || 0).toFixed(2)); // Cumulative position (Col K)
  const dailySaldo = Number(Number(pacingData.L_saldo_yesterday || 0).toFixed(2)); // Yesterday's saldo (Col L)
  const flatDailyBudget = Number(Number(pacingData.D17_flat_daily || 0).toFixed(2)); // Flat pacing (D17)
  const daysLeftInMonth = pacingData.days_left || 1;
  const daysToPositive = pacingData.days_to_positive || 0;

  // Compute yesterday's spend directly from Transactions (Тип == "Расходы")
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdaySpend = typeof getTodaySpend === 'function' ? getTodaySpend(yesterday, ss) : 0;

  // Combine actuals and targets for BOTH Needs and Wants subcategories.
  // CRITICAL RULE: Only transactions of type "Расходы" contribute against the daily budget.
  const categoryPacing = {
    needs: {},
    wants: {}
  };

  const processSubCategories = (subCategories, bucketKey) => {
    if (Array.isArray(subCategories)) {
      subCategories.forEach(sub => {
        if (sub && sub.name) {
          const catName = sub.name;
          const vel = catVelocity[catName] || {};
          let rashodySpend = 0;
          Object.keys(vel).forEach(txType => {
            if (txType !== 'total' && txType.toLowerCase().trim() === 'расходы') {
              rashodySpend += Number(vel[txType] || 0);
            }
          });

          categoryPacing[bucketKey][catName] = {
            target_monthly: Number(Number(sub.target || 0).toFixed(2)),
            actual_monthly_total: Number(Number(sub.actual || 0).toFixed(2)),
            daily_budget_contributing_spend: Number(Number(rashodySpend || 0).toFixed(2))
          };
        }
      });
    }
  };

  processSubCategories(pacing.needs && pacing.needs.sub_categories, 'needs');
  processSubCategories(pacing.wants && pacing.wants.sub_categories, 'wants');

  // Include any other categories present in catVelocity that have "Расходы" spend
  Object.keys(catVelocity).forEach(cat => {
    if (cat === 'total') return;
    let rashodySpend = 0;
    Object.keys(catVelocity[cat]).forEach(txType => {
      if (txType !== 'total' && txType.toLowerCase().trim() === 'расходы') {
        rashodySpend += Number(catVelocity[cat][txType] || 0);
      }
    });
    if (rashodySpend > 0 && !categoryPacing.needs[cat] && !categoryPacing.wants[cat]) {
      categoryPacing.wants[cat] = {
        target_monthly: 0,
        daily_budget_contributing_spend: Number(Number(rashodySpend || 0).toFixed(2))
      };
    }
  });

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

  return {
    period: p,
    spendable_per_day: spendablePerDay,
    current_daily_budget: currentDailyBudget,
    cumulative_position: cumulativePosition,
    flat_daily_budget: flatDailyBudget,
    daily_saldo: dailySaldo,
    days_left_in_month: daysLeftInMonth,
    days_to_positive: daysToPositive,
    yesterday_spend: Number(Number(yesterdaySpend || 0).toFixed(2)),
    buckets: buckets,
    category_pacing: categoryPacing
  };
}

/**
 * STAGE 2 — Reusable Coach Brief Generator using gemini-3.5-flash-lite.
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

  const systemInstruction = `You are a smart, attentive personal financial coach for a user in Singapore. Your job is to deliver a fresh, sharp, and encouraging morning coach update for Telegram based strictly on the provided budget JSON.

### CRITICAL ANTI-HALLUCINATION & ANTI-REPETITION RULES (ZERO TOLERANCE):
1. USE ONLY NUMBERS PRESENT IN THE JSON: Never compute, infer, extrapolate, or invent figures. Every single number you mention MUST exist verbatim in the JSON payload.
2. NO UNGROUNDED TREND CLAIMS: Never describe a trend direction (e.g. claiming an allowance increased or decreased or that money was clawed back) unless the JSON explicitly states it.
3. NO FORMULAIC ROBOTIC GREETINGS: Do NOT begin messages with repetitive boilerplate like "Good morning! You have about S$X available to spend today, compared to your target daily goal of S$Y." Vary your opening naturally.
4. NO CANNED CLICHÉ ADVICE: NEVER use canned suggestions like "a cozy home-cooked meal instead of dining out", "a relaxing walk in the park", or generic "taking it easy to reset".
5. NO REPETITIVE MOTIVATIONAL SIGN-OFFS: NEVER end with formulaic cheerleading phrases like "You've got this! 🌟", "setting up peace of mind and incredible financial success for tomorrow", or robotic slogans.

### CORE CONTENT REQUIREMENTS (2 to 4 CONCISE SENTENCES):
1. State the spendable amount per day (from \`spendable_per_day\`, e.g. <b>S$110.63</b>/day).
2. State the cumulative position (from \`cumulative_position\`, e.g. if negative, explain that they are S$X behind pace, and use \`days_to_positive\` to state how many zero-spend days clear it). NEVER describe cumulative position as a negative daily allowance.
3. If yesterday's spend is present (\`yesterday_spend\`), mention it concisely.

### FORMATTING & SYNTAX RULES:
- Output MUST be formatted in Telegram HTML (use <b>bold</b> and <i>italic</i> tags only).
- NEVER use Markdown syntax (do NOT use **bold** or *italic* or # headings).
- Use <b>S$XX.XX</b> for currency figures.
- Length: 2 to 4 sentences maximum.`;

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
      temperature: 0.4
    }
  };

  Logger.log(`Generating Coach Brief via Gemini (Target: ${typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.7-flash'})...`);
  try {
    const apiResult = callGeminiApiWithRetry(apiPayload, apiKey);
    const responseText = typeof apiResult === 'object' ? apiResult.text : apiResult;
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : (typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.7-flash');
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
 * @return {string} Short, dynamic fallback brief in Telegram HTML.
 */
function buildFallbackCoachBrief(payload) {
  const spendablePerDay = Number(Number(payload.spendable_per_day || payload.current_daily_budget || 0).toFixed(2));
  const cumulativePosition = Number(Number(payload.cumulative_position || 0).toFixed(2));
  const daysToPositive = payload.days_to_positive || 0;
  const ySpend = Number(Number(payload.yesterday_spend || 0).toFixed(2));

  let paceContext = '';
  if (cumulativePosition < 0) {
    const behindAmt = Math.abs(Math.round(cumulativePosition));
    const dayText = daysToPositive === 1 ? 'one zero-spend day clears it' : `${daysToPositive} zero-spend days clear it`;
    paceContext = `You're S$${behindAmt} behind pace — ${dayText}.`;
  } else if (cumulativePosition > 0) {
    paceContext = `You're S$${Math.round(cumulativePosition)} ahead of pace.`;
  } else {
    paceContext = `You're right on pace.`;
  }

  let yesterdayContext = '';
  if (ySpend > 0) {
    yesterdayContext = ` Yesterday logged <b>S$${ySpend.toFixed(2)}</b> in discretionary expenses.`;
  } else {
    yesterdayContext = ` Yesterday was a clean zero-spend day.`;
  }

  const msg = `Your spendable allowance sits at <b>S$${spendablePerDay.toFixed(2)}</b>/day. ${paceContext}${yesterdayContext}`;
  return msg.trim();
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
        spendable_per_day: 110.63,
        current_daily_budget: 110.63,
        cumulative_position: -87.81,
        flat_daily_budget: 125.00,
        daily_saldo: 85.00,
        days_left_in_month: 2,
        days_to_positive: 1,
        yesterday_spend: 210.00,
        buckets: basePacing,
        category_pacing: {
          needs: { 'Продукты': { target_monthly: 600, actual_monthly_total: 400, daily_budget_contributing_spend: 120 } },
          wants: { 'Рестораны': { target_monthly: 400, actual_monthly_total: 350, daily_budget_contributing_spend: 180 } }
        }
      }
    },
    {
      name: 'Scenario 2: Ahead of Pace (Positive Cumulative Position)',
      payload: {
        period: 'daily',
        spendable_per_day: 135.00,
        current_daily_budget: 135.00,
        cumulative_position: 120.50,
        flat_daily_budget: 125.00,
        daily_saldo: 165.00,
        days_left_in_month: 10,
        days_to_positive: 0,
        yesterday_spend: 0.00,
        buckets: basePacing,
        category_pacing: {
          needs: { 'Продукты': { target_monthly: 600, actual_monthly_total: 400, daily_budget_contributing_spend: 0 } },
          wants: { 'Рестораны': { target_monthly: 400, actual_monthly_total: 350, daily_budget_contributing_spend: 0 } }
        }
      }
    },
    {
      name: 'Scenario 3: Disciplined / Steady Spending',
      payload: {
        period: 'daily',
        spendable_per_day: 118.00,
        current_daily_budget: 118.00,
        cumulative_position: 15.00,
        flat_daily_budget: 120.00,
        daily_saldo: 120.00,
        days_left_in_month: 16,
        days_to_positive: 0,
        yesterday_spend: 25.00,
        buckets: basePacing,
        category_pacing: {
          needs: { 'Продукты': { target_monthly: 600, actual_monthly_total: 400, daily_budget_contributing_spend: 25 } },
          wants: { 'Рестораны': { target_monthly: 400, actual_monthly_total: 350, daily_budget_contributing_spend: 0 } }
        }
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
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : (typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.7-flash');
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
    const modelUsed = typeof apiResult === 'object' ? apiResult.modelUsed : (typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.7-flash');
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
