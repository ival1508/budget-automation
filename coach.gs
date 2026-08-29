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
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSs] - Optional Spreadsheet instance.
 * @return {Object} Structured JSON payload for Gemini coach model.
 */
function buildCoachPayload(period, optSs) {
  const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
  const p = period || 'daily';
  
  const saldoData = typeof getDailySaldo === 'function' ? getDailySaldo(ss) : { saldo: 0, currentDailyBudget: 0, daysLeftInMonth: 1 };
  const pacing = typeof get503020Status === 'function' ? get503020Status(ss) : {};
  const catVelocity = typeof getCategoryVelocity === 'function' ? getCategoryVelocity(ss) : {};
  const trendsData = typeof getRecentDailyTrends === 'function' ? getRecentDailyTrends(ss) : { trends: [] };

  const currentDailyBudget = Number(saldoData.currentDailyBudget || 0);
  const dailySaldo = Number(saldoData.saldo || 0);
  const daysLeftInMonth = Number(saldoData.daysLeftInMonth || 1);

  // Parse chronological daily trends and isolate completed days prior to today
  const trends = trendsData.trends || [];
  const now = new Date();
  const todayDay = parseInt(Utilities.formatDate(now, 'Asia/Singapore', 'd'), 10);
  const getDayNumber = (dateStr) => {
    const str = String(dateStr || '').trim();
    const match = str.match(/^(?:Day\s*)?(\d{1,2})(?:[\/\.-].*)?$/i);
    return match ? parseInt(match[1], 10) : -1;
  };

  // Filter for completed days prior to today
  let completedDays = trends.filter(item => {
    const dNum = getDayNumber(item.date);
    return dNum > 0 && dNum < todayDay;
  });

  if (completedDays.length === 0 && trends.length > 1) {
    completedDays = trends.slice(0, trends.length - 1);
  } else if (completedDays.length === 0 && trends.length === 1) {
    completedDays = trends;
  }

  // Identify yesterday, day before yesterday, and 3-days-ago data points
  const yesterdayItem = completedDays.length > 0 ? completedDays[completedDays.length - 1] : null;
  const dayBeforeItem = completedDays.length > 1 ? completedDays[completedDays.length - 2] : null;
  const threeDaysAgoItem = completedDays.length > 2 ? completedDays[completedDays.length - 3] : null;

  const yesterdaySpend = yesterdayItem ? Number(yesterdayItem.spend || 0) : 0;
  const yesterdayBudget = yesterdayItem ? Number(yesterdayItem.budget || 0) : currentDailyBudget;
  const yesterdaySaldo = yesterdayItem ? Number(yesterdayItem.saldo || 0) : dailySaldo;
  const yesterdayDate = yesterdayItem ? String(yesterdayItem.date || '') : (todayDay === 1 ? 'Start of Month' : '');

  // 1. Spend Dynamics Calculation (multi-day trajectory)
  const last3Completed = completedDays.slice(-3);
  const avgSpend3Day = last3Completed.length > 0 
    ? (last3Completed.reduce((sum, d) => sum + Number(d.spend || 0), 0) / last3Completed.length)
    : yesterdaySpend;
  const last7Completed = completedDays.slice(-7);
  const avgSpend7Day = last7Completed.length > 0 
    ? (last7Completed.reduce((sum, d) => sum + Number(d.spend || 0), 0) / last7Completed.length)
    : avgSpend3Day;

  let spendTrajectory = 'steady';
  if (yesterdayItem && Number(yesterdayItem.spend || 0) === 0) {
    spendTrajectory = 'zero_spend_reset';
  } else if (last3Completed.length >= 2 && last3Completed.every(d => Number(d.spend || 0) > Number(d.budget || 0))) {
    spendTrajectory = 'elevated';
  } else if (dayBeforeItem && yesterdaySpend < (Number(dayBeforeItem.spend || 0) * 0.6) && yesterdaySpend <= yesterdayBudget) {
    spendTrajectory = 'cooling_down';
  } else if (yesterdaySpend > (avgSpend7Day * 1.35) && yesterdaySpend > yesterdayBudget) {
    spendTrajectory = 'surging';
  } else if (last3Completed.length >= 2 && last3Completed.every(d => Number(d.spend || 0) <= Number(d.budget || 0))) {
    spendTrajectory = 'disciplined';
  }

  // 2. Daily Budget Dynamics Calculation (increasing / decreasing / digging down)
  const dayOverDayBudgetChange = Number((currentDailyBudget - yesterdayBudget).toFixed(2));
  const baselineItem = threeDaysAgoItem || dayBeforeItem || yesterdayItem;
  const baselineBudget = baselineItem ? Number(baselineItem.budget || currentDailyBudget) : currentDailyBudget;
  const multiDayBudgetChange = Number((currentDailyBudget - baselineBudget).toFixed(2));

  let consecutiveOverspendDays = 0;
  let consecutiveUnderspendDays = 0;
  for (let i = completedDays.length - 1; i >= 0; i--) {
    const item = completedDays[i];
    const s = Number(item.spend || 0);
    const b = Number(item.budget || 0);
    if (s > b) {
      if (consecutiveUnderspendDays === 0) {
        consecutiveOverspendDays++;
      } else {
        break;
      }
    } else {
      if (consecutiveOverspendDays === 0) {
        consecutiveUnderspendDays++;
      } else {
        break;
      }
    }
  }

  let budgetDirection = 'steady';
  let isDiggingDown = false;
  let paceVerdict = '';

  if (consecutiveOverspendDays >= 2 || (multiDayBudgetChange <= -15 && currentDailyBudget < baselineBudget)) {
    budgetDirection = 'digging_down';
    isDiggingDown = true;
    paceVerdict = `Digging down: Consecutive high-spend days have shrunk your remaining daily allowance from ~S$${baselineBudget.toFixed(0)} to ~S$${currentDailyBudget.toFixed(0)}/day (${multiDayBudgetChange < 0 ? '-' : ''}S$${Math.abs(multiDayBudgetChange).toFixed(2)}/day).`;
  } else if (dayOverDayBudgetChange <= -3) {
    budgetDirection = 'decreasing';
    paceVerdict = `Decreasing: Yesterday's spend trimmed today's available daily allowance by S$${Math.abs(dayOverDayBudgetChange).toFixed(2)} (now S$${currentDailyBudget.toFixed(2)}/day).`;
  } else if (dayOverDayBudgetChange >= 3 || (consecutiveUnderspendDays >= 2 && dayOverDayBudgetChange >= 0)) {
    budgetDirection = 'increasing';
    paceVerdict = `Increasing: Mindful spending boosted your daily allowance up by +S$${dayOverDayBudgetChange.toFixed(2)} to S$${currentDailyBudget.toFixed(2)}/day!`;
  } else {
    budgetDirection = 'steady';
    paceVerdict = `Steady: Daily allowance is holding stable at ~S$${currentDailyBudget.toFixed(2)}/day.`;
  }

  const budgetTrend = {
    direction: budgetDirection,
    is_digging_down: isDiggingDown,
    today_daily_budget: currentDailyBudget,
    yesterday_budget: yesterdayBudget,
    day_over_day_change: dayOverDayBudgetChange,
    multi_day_change: multiDayBudgetChange,
    consecutive_overspend_days: consecutiveOverspendDays,
    consecutive_underspend_days: consecutiveUnderspendDays,
    verdict: paceVerdict
  };

  const spendTrend = {
    yesterday_spend: yesterdaySpend,
    yesterday_date: yesterdayDate,
    avg_spend_3_day: Number(avgSpend3Day.toFixed(2)),
    avg_spend_7_day: Number(avgSpend7Day.toFixed(2)),
    trajectory: spendTrajectory,
    recent_completed_days: completedDays.slice(-5).map(d => ({
      date: d.date,
      spend: Number(d.spend || 0),
      budget: Number(d.budget || 0),
      saldo: Number(d.saldo || 0),
      is_over_budget: Number(d.spend || 0) > Number(d.budget || 0)
    }))
  };

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
            target_monthly: Number(sub.target || 0),
            actual_monthly_total: Number(sub.actual || 0),
            daily_budget_contributing_spend: rashodySpend
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
        daily_budget_contributing_spend: rashodySpend
      };
    }
  });

  const buckets = {
    needs: {
      actual: Number((pacing.needs && pacing.needs.actual) || 0),
      target: Number((pacing.needs && pacing.needs.target) || 0)
    },
    wants: {
      actual: Number((pacing.wants && pacing.wants.actual) || 0),
      target: Number((pacing.wants && pacing.wants.target) || 0)
    },
    savings: {
      actual: Number((pacing.savings && pacing.savings.actual) || 0),
      target: Number((pacing.savings && pacing.savings.target) || 0)
    },
    taxes: {
      actual: Number((pacing.taxes && pacing.taxes.actual) || 0),
      target: Number((pacing.taxes && pacing.taxes.target) || 0)
    }
  };

  return {
    period: p,
    daily_saldo: dailySaldo,
    current_daily_budget: currentDailyBudget,
    days_left_in_month: daysLeftInMonth,
    yesterday_spend: yesterdaySpend,
    yesterday_budget: yesterdayBudget,
    yesterday_date: yesterdayDate,
    budget_trend: budgetTrend,
    spend_trend: spendTrend,
    pace_verdict: paceVerdict,
    buckets: buckets,
    category_pacing: categoryPacing,
    recent_daily_trends: trends.slice(-7),
    mandatory_warnings: []
  };
}

/**
 * STAGE 2 — Reusable Coach Brief Generator using gemini-3.5-flash-lite.
 * Evaluates budget payload and produces a dynamic, 2-4 sentence conversational brief.
 * 
 * @param {Object} [payload] - Structured budget payload (from buildCoachPayload).
 * @return {string} Concise Telegram-native financial coach message.
 */
function generateCoachBrief(payload) {
  const ctx = payload || buildCoachPayload('daily');
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY property is missing in Script Properties.');
  }

  const systemInstruction = `You are a smart, attentive personal financial coach for a user in Singapore. Your job is to deliver a fresh, sharp, and encouraging morning coach update for Telegram based on the provided budget JSON.

### CRITICAL ANTI-REPETITION RULES (DO NOT VIOLATE):
1. NO FORMULAIC ROBOTIC GREETINGS: Do NOT begin messages with repetitive boilerplate like "Good morning! You have about S$X available to spend today, compared to your target daily goal of S$Y." Vary your opening naturally every day.
2. NO CANNED CLICHÉ ADVICE: NEVER use canned suggestions like "a cozy home-cooked meal instead of dining out", "a relaxing walk in the park", or generic "taking it easy to reset". If you suggest an adjustment, make it specific to recent category activity or simply focus on the financial momentum.
3. NO REPETITIVE MOTIVATIONAL SIGN-OFFS: NEVER end with formulaic cheerleading phrases like "You've got this! 🌟", "setting up peace of mind and incredible financial success for tomorrow", or robotic slogans. Keep the ending crisp, purposeful, and fresh.
4. VARY YOUR FOCUS & STRUCTURE: Base today's core message around what actually changed in the numbers over the last 2-4 days.

### CORE CONTENT REQUIREMENTS (2 to 4 CONCISE SENTENCES):
1. Current Financial Grounding: State the current remaining daily allowance (from \`current_daily_budget\`, e.g., **S$115/day**) and available room today (from \`daily_saldo\`, e.g., **S$140** available today).
2. Spend Trajectory & Changes: Explicitly address how spending has been moving over recent days (using \`spend_trend\` and \`yesterday_spend\`):
   - Did spending cool down yesterday after a spike?
   - Has spending been elevated for consecutive days?
   - Was yesterday a zero-spend day that provided a clean reset?
   - Is spending holding steady and disciplined?
3. Daily Budget Direction & Hole Detection: Explicitly address whether the daily budget allowance is increasing, decreasing, or being dug further down:
   - DIGGING DOWN (\`budget_trend.is_digging_down\` = true or consecutive overspend): Be honest and direct. Point out that consecutive overspending is eroding the daily allowance day-by-day (e.g. daily allowance has compressed from **S$145** down to **S$110/day**), and emphasize the need to stop the slide before the buffer shrinks further.
   - DECREASING: Note that yesterday's spend caused a minor dip in the available daily allowance for the rest of the month.
   - INCREASING: Celebrate that mindful or under-budget spending boosted the daily allowance (+**S$X/day**), expanding breathing room for upcoming days.
   - STEADY: Confirm that the daily budget is holding steady.
4. Category Context: If a specific subcategory in \`category_pacing\` has high "Расходы" spend, you may reference it naturally without lecturing.

### OUTPUT RULES:
- Format: Plain, direct Telegram text. Use **bold** on all monetary figures (e.g., **S$124.50**, **S$85.00/day**).
- Length: 2 to 4 sentences maximum.
- Accuracy: NEVER invent or hallucinate financial amounts not present in the JSON payload.`;

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
      temperature: 0.5
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
      return textOutput.trim();
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
 * Generates dynamic, trend-aware messages reflecting budget trajectory and spend changes.
 * 
 * @param {Object} payload - Budget coach payload object.
 * @return {string} Short, dynamic fallback brief.
 */
function buildFallbackCoachBrief(payload) {
  const availableToday = Number(payload.daily_saldo || 0).toFixed(2);
  const targetGoal = Number(payload.current_daily_budget || 0).toFixed(2);
  const ySpend = Number(payload.yesterday_spend || 0).toFixed(2);
  const bTrend = payload.budget_trend || {};
  const sTrend = payload.spend_trend || {};
  const isDigging = bTrend.is_digging_down;
  const direction = bTrend.direction || 'steady';
  const trajectory = sTrend.trajectory || 'steady';

  let msg = '';

  if (isDigging || direction === 'digging_down') {
    const dropAmount = Math.abs(Number(bTrend.multi_day_change || bTrend.day_over_day_change || 0)).toFixed(2);
    msg = `You have <b>S$${availableToday}</b> available today, with your daily allowance sitting at <b>S$${targetGoal}</b>/day.\n\n` +
      `Recent high-spend days have continued to dig into your daily budget, eroding your baseline allowance by <b>S$${dropAmount}</b> over the past few days. ` +
      `Yesterday came in at <b>S$${ySpend}</b>. Keeping discretionary spending minimal today will help halt the slide and protect your remaining buffer for the month.`;
  } else if (direction === 'increasing' || trajectory === 'zero_spend_reset') {
    const boostAmount = Number(bTrend.day_over_day_change || 0).toFixed(2);
    msg = `Great momentum! Yesterday's light spending (<b>S$${ySpend}</b>) boosted your daily allowance up to <b>S$${targetGoal}</b>/day (+<b>S$${boostAmount}</b>).\n\n` +
      `You have <b>S$${availableToday}</b> available to spend today with extra breathing room for the rest of the week.`;
  } else if (trajectory === 'cooling_down') {
    msg = `Spending cooled off nicely yesterday to <b>S$${ySpend}</b> after earlier high activity.\n\n` +
      `Your daily target is steady at <b>S$${targetGoal}</b>/day with <b>S$${availableToday}</b> available today. Maintaining this disciplined pace keeps your monthly pacing in great shape.`;
  } else if (direction === 'decreasing') {
    const dipAmount = Math.abs(Number(bTrend.day_over_day_change || 0)).toFixed(2);
    msg = `Yesterday's spending of <b>S$${ySpend}</b> trimmed your daily allowance slightly by <b>S$${dipAmount}</b> down to <b>S$${targetGoal}</b>/day.\n\n` +
      `You have <b>S$${availableToday}</b> available today—a steady day today will keep your baseline comfortable.`;
  } else {
    msg = `Your daily allowance is holding steady at <b>S$${targetGoal}</b>/day with <b>S$${availableToday}</b> available today.\n\n` +
      `Yesterday logged <b>S$${ySpend}</b> in daily expenses, keeping your monthly plan right on track.`;
  }

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
    savings: { actual: 1000, target: 1000 },
    taxes: { actual: 0, target: 0 }
  };

  const scenarios = [
    {
      name: 'Scenario 1: Digging Down (3 consecutive overspend days)',
      payload: {
        period: 'daily',
        daily_saldo: 85.00,
        current_daily_budget: 95.00,
        days_left_in_month: 16,
        yesterday_spend: 210.00,
        yesterday_budget: 115.00,
        yesterday_date: '14.08',
        budget_trend: {
          direction: 'digging_down',
          is_digging_down: true,
          today_daily_budget: 95.00,
          yesterday_budget: 115.00,
          day_over_day_change: -20.00,
          multi_day_change: -45.00,
          consecutive_overspend_days: 3,
          consecutive_underspend_days: 0,
          verdict: 'Digging down: Consecutive high-spend days have shrunk your remaining daily allowance from ~S$140 to ~S$95/day (-S$45.00/day).'
        },
        spend_trend: {
          yesterday_spend: 210.00,
          yesterday_date: '14.08',
          avg_spend_3_day: 195.00,
          avg_spend_7_day: 130.00,
          trajectory: 'elevated',
          recent_completed_days: [
            { date: '12.08', spend: 180.00, budget: 140.00, is_over_budget: true },
            { date: '13.08', spend: 195.00, budget: 125.00, is_over_budget: true },
            { date: '14.08', spend: 210.00, budget: 115.00, is_over_budget: true }
          ]
        },
        buckets: basePacing,
        category_pacing: {
          needs: { 'Продукты': { target_monthly: 600, actual_monthly_total: 400, daily_budget_contributing_spend: 120 } },
          wants: { 'Рестораны': { target_monthly: 400, actual_monthly_total: 350, daily_budget_contributing_spend: 180 } }
        }
      }
    },
    {
      name: 'Scenario 2: Increasing / Recovering (Zero spend reset + allowance gain)',
      payload: {
        period: 'daily',
        daily_saldo: 165.00,
        current_daily_budget: 135.00,
        days_left_in_month: 16,
        yesterday_spend: 0.00,
        yesterday_budget: 120.00,
        yesterday_date: '14.08',
        budget_trend: {
          direction: 'increasing',
          is_digging_down: false,
          today_daily_budget: 135.00,
          yesterday_budget: 120.00,
          day_over_day_change: 15.00,
          multi_day_change: 15.00,
          consecutive_overspend_days: 0,
          consecutive_underspend_days: 1,
          verdict: 'Increasing: Mindful spending boosted your daily allowance up by +S$15.00 to S$135.00/day!'
        },
        spend_trend: {
          yesterday_spend: 0.00,
          yesterday_date: '14.08',
          avg_spend_3_day: 45.00,
          avg_spend_7_day: 80.00,
          trajectory: 'zero_spend_reset',
          recent_completed_days: [
            { date: '12.08', spend: 85.00, budget: 120.00, is_over_budget: false },
            { date: '13.08', spend: 50.00, budget: 120.00, is_over_budget: false },
            { date: '14.08', spend: 0.00, budget: 120.00, is_over_budget: false }
          ]
        },
        buckets: basePacing,
        category_pacing: {
          needs: { 'Продукты': { target_monthly: 600, actual_monthly_total: 400, daily_budget_contributing_spend: 0 } },
          wants: { 'Рестораны': { target_monthly: 400, actual_monthly_total: 350, daily_budget_contributing_spend: 0 } }
        }
      }
    },
    {
      name: 'Scenario 3: Cooling Down (Light spend following heavy day)',
      payload: {
        period: 'daily',
        daily_saldo: 120.00,
        current_daily_budget: 118.00,
        days_left_in_month: 16,
        yesterday_spend: 25.00,
        yesterday_budget: 115.00,
        yesterday_date: '14.08',
        budget_trend: {
          direction: 'steady',
          is_digging_down: false,
          today_daily_budget: 118.00,
          yesterday_budget: 115.00,
          day_over_day_change: 3.00,
          multi_day_change: -10.00,
          consecutive_overspend_days: 0,
          consecutive_underspend_days: 1,
          verdict: 'Steady: Daily allowance is holding stable at ~S$118.00/day.'
        },
        spend_trend: {
          yesterday_spend: 25.00,
          yesterday_date: '14.08',
          avg_spend_3_day: 110.00,
          avg_spend_7_day: 105.00,
          trajectory: 'cooling_down',
          recent_completed_days: [
            { date: '12.08', spend: 80.00, budget: 125.00, is_over_budget: false },
            { date: '13.08', spend: 225.00, budget: 125.00, is_over_budget: true },
            { date: '14.08', spend: 25.00, budget: 115.00, is_over_budget: false }
          ]
        },
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
