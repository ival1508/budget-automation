/**
 * Budget 2026 Automation v1 - Nudge & Coach Scheduler (Cron & Command Layer)
 * File: nudge.gs
 * 
 * Manages daily morning coach updates, daily evening nudges, and weekly mandatory audits (§6.5).
 */

/**
 * Sends a Telegram HTML message to all authorized chat IDs (or a specific targetChatId).
 * 
 * @param {string} htmlText - Formatted Telegram HTML text message.
 * @param {string|number} [targetChatId] - Optional specific Chat ID for on-demand requests.
 */
function sendTelegramMessage(htmlText, targetChatId) {
  const token = PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN");
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN missing in Script Properties.');
  }

  let chatIds = [];
  if (targetChatId) {
    chatIds = [String(targetChatId)];
  } else {
    const authorizedIdsString = String(
      PropertiesService.getScriptProperties().getProperty("AUTHORIZED_CHAT_IDS") ||
      PropertiesService.getScriptProperties().getProperty("TELEGRAM_CHAT_ID") || ""
    ).trim();

    if (!authorizedIdsString) {
      Logger.log('No registered Chat IDs found in AUTHORIZED_CHAT_IDS or TELEGRAM_CHAT_ID.');
      return;
    }
    chatIds = authorizedIdsString.split(",").map(id => id.trim());
  }

  chatIds.forEach(chatId => {
    if (!chatId) return;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML'
    };

    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      Logger.log(`✅ Telegram message sent to Chat ID ${chatId}`);
    } else {
      Logger.log(`❌ Failed to send to Chat ID ${chatId}: ${response.getContentText()}`);
    }
  });
}

/**
 * STAGE 2 — UC-3 Sends the Daily Morning Coach message via Telegram at 08:00 SGT.
 * Uses gemini-3.5-flash-lite to generate a warm personal financial coach brief.
 */
function sendMorningCoach() {
  Logger.log('=== Running STAGE 2 Morning Coach Daily Brief ===');
  const payload = typeof buildCoachPayload === 'function' ? buildCoachPayload('daily') : getBudgetCoachContext();
  Logger.log('Assembled Coach Payload:\n' + JSON.stringify(payload, null, 2));

  const briefText = typeof generateCoachBrief === 'function' ? generateCoachBrief(payload) : generateDailyCoachBrief(payload);
  Logger.log('Generated Coach Brief Text:\n' + briefText);

  // Check USERS config in SHEET_FACTS for per-user dispatch rules
  if (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.USERS) {
    Object.values(SHEET_FACTS.USERS).forEach(user => {
      if (user && user.active && user.chat_id) {
        Logger.log(`Delivering Morning Coach brief to ${user.name} (Chat ID: ${user.chat_id}, Morning Time: ${user.morning_time} SGT)...`);
        sendTelegramMessage(briefText, user.chat_id);
      } else {
        Logger.log(`Skipping delivery to ${user ? user.name : 'User'} (Inactive for trial run or missing chat_id).`);
      }
    });
  } else {
    // Default fallback if USERS is unavailable
    sendTelegramMessage(briefText, '96069960');
  }
}

/**
 * Generates and sends the Weekly Mandatory Expenses Audit report to Telegram.
 * Triggered automatically on Mondays at 09:00 SGT, or on-demand via the /mandatory command.
 * 
 * @param {string|number} [targetChatId] - Optional Chat ID for on-demand execution.
 */
function sendWeeklyMandatoryAudit(targetChatId) {
  Logger.log('=== Running Weekly Mandatory Expenses Audit ===');
  const context = getBudgetCoachContext();
  const reportHtml = generateWeeklyMandatoryReport(context);
  sendTelegramMessage(reportHtml, targetChatId);
}

/**
 * Sends the daily evening nudge message via Telegram at 21:00 SGT (§6.5).
 */
function sendDailyNudge() {
  const token = PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN");
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN missing in Script Properties.');
  }

  const authorizedIdsString = String(
    PropertiesService.getScriptProperties().getProperty("AUTHORIZED_CHAT_IDS") ||
    PropertiesService.getScriptProperties().getProperty("TELEGRAM_CHAT_ID") || ""
  ).trim();

  const chatIdsSet = new Set(authorizedIdsString ? authorizedIdsString.split(",").map(id => id.trim()) : []);
  if (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.USERS) {
    Object.values(SHEET_FACTS.USERS).forEach(user => {
      if (user && user.active && user.chat_id) {
        chatIdsSet.add(String(user.chat_id).trim());
      }
    });
  }
  const chatIds = Array.from(chatIdsSet).filter(Boolean);

  if (chatIds.length === 0) {
    Logger.log('No registered Chat IDs found in AUTHORIZED_CHAT_IDS, TELEGRAM_CHAT_ID, or SHEET_FACTS.USERS.');
    return;
  }
  const payload = {
    text: "🌙 <b>Evening! Anything to log for today?</b>\n\nSnap a receipt, paste a text dump, or tap below if today was a zero-spend day.",
    parse_mode: "HTML",
    reply_markup: JSON.stringify({
      inline_keyboard: [[{ text: "😴 Nothing today", callback_data: "nothing_today" }]]
    })
  };

  chatIds.forEach(chatId => {
    if (!chatId) return;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(Object.assign({}, payload, { chat_id: chatId })),
      muteHttpExceptions: true
    });
  });
}

/**
 * Formats a clean, readable Telegram HTML summary of all transactions logged today (or on a specific date).
 * Shows total spent today, daily budget, remaining saldo, and detailed item list.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSs] - Optional Spreadsheet instance.
 * @param {Date|string} [optDate] - Optional target date to summarize (defaults to today in SGT).
 * @return {string} Formatted Telegram HTML daily recap message.
 */
function generateDailyTransactionsRecap(optSs, optDate) {
  const ss = optSs || SpreadsheetApp.getActiveSpreadsheet();
  const tz = (ss && typeof ss.getSpreadsheetTimeZone === 'function') ? ss.getSpreadsheetTimeZone() : 'Asia/Singapore';
  const now = new Date();
  
  let dateStr = '';
  if (optDate) {
    if (optDate instanceof Date) {
      dateStr = Utilities.formatDate(optDate, tz, 'dd.MM.yyyy');
    } else {
      dateStr = typeof normalizeDateString === 'function' ? normalizeDateString(optDate) : String(optDate).trim();
    }
  } else {
    dateStr = Utilities.formatDate(now, tz, 'dd.MM.yyyy');
  }

  const todaysTxns = typeof getTodaysTransactions === 'function' ? getTodaysTransactions(ss, optDate) : [];
  const pacing = typeof getDailyPacing === 'function' ? getDailyPacing(optDate, ss) : {
    K_cumulative_today: 0,
    L_saldo_yesterday: 0,
    D17_flat_daily: 0,
    D19_realistic_daily: 0,
    days_left: 1,
    days_to_positive: 0
  };

  const todaySpend = typeof getTodaySpend === 'function' 
    ? getTodaySpend(optDate, ss) 
    : todaysTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);

  const totalSpend = Number(Number(todaySpend || 0).toFixed(2));
  const realisticDaily = Number(Number(pacing.D19_realistic_daily || 0).toFixed(2));
  const cumulativePosition = Number(Number(pacing.K_cumulative_today || 0).toFixed(2));
  const daysLeft = pacing.days_left || 1;
  const isLastDay = (daysLeft <= 1);
  const daysToPositive = pacing.days_to_positive || 0;

  // 1. Allowance / Over-budget logic (shared with Morning Coach Brief)
  const isOverBudget = realisticDaily < 0;
  const overBudgetBy = isOverBudget ? Math.abs(realisticDaily) : 0;

  let allowanceLine = '';
  if (isOverBudget) {
    allowanceLine = `• 🎯 <b>Budget status:</b> You're S$${overBudgetBy.toFixed(2)} past the month's budget.`;
  } else {
    allowanceLine = `• 🎯 <b>Spendable per day:</b> S$${realisticDaily.toFixed(2)}/day`;
  }

  // 2. Cumulative position framing (month-end close vs mid-month runway)
  let positionLine = '';
  if (isLastDay) {
    if (cumulativePosition < 0) {
      const behindAmount = Math.abs(Math.round(cumulativePosition));
      positionLine = `• 📊 <b>Cumulative position:</b> You're S$${behindAmount} behind pace at month-end.`;
    } else if (cumulativePosition > 0) {
      positionLine = `• 📊 <b>Cumulative position:</b> S$${cumulativePosition.toFixed(2)} ahead of pace at month-end.`;
    } else {
      positionLine = `• 📊 <b>Cumulative position:</b> Exactly on pace at month-end.`;
    }
  } else {
    if (cumulativePosition < 0) {
      const behindAmount = Math.abs(Math.round(cumulativePosition));
      const dayText = daysToPositive === 1 ? 'one zero-spend day clears it' : `${daysToPositive} zero-spend days clear it`;
      positionLine = `• 📊 <b>Cumulative position:</b> You're S$${behindAmount} behind pace — ${dayText}.`;
    } else if (cumulativePosition > 0) {
      positionLine = `• 📊 <b>Cumulative position:</b> S$${cumulativePosition.toFixed(2)} ahead of pace.`;
    } else {
      positionLine = `• 📊 <b>Cumulative position:</b> Exactly on pace.`;
    }
  }

  // 3. Sign-off message
  let zeroSpendSignoff = isLastDay
    ? `✨ <i>Great job closing out the month with a zero-spend day! Rest up for the new month ahead.</i>`
    : `✨ <i>Great job! Zero-spend days protect your runway and boost your pacing for the rest of the month.</i>`;

  let activeSpendSignoff = isLastDay
    ? `\n✨ <i>Logged & tracked in Budget 2026 for month-end close. Rest up!</i>`
    : `\n✨ <i>Logged & tracked in Budget 2026. Rest up!</i>`;

  if (todaysTxns.length === 0) {
    return [
      `🌙 <b>Daily Recap — ${dateStr}</b>\n`,
      `😴 <b>Zero Spend Day!</b> No transactions were logged for today.\n`,
      allowanceLine,
      positionLine + `\n`,
      zeroSpendSignoff
    ].join('\n');
  }

  const lines = [
    `🌙 <b>Daily Spending Recap — ${dateStr}</b>\n`,
    `• 💰 <b>Total Spend Today:</b> <b>S$${totalSpend.toFixed(2)}</b>`,
    allowanceLine,
    positionLine + `\n`,
    `<b>Logged Transactions (${todaysTxns.length}):</b>`
  ];

  todaysTxns.forEach(t => {
    const desc = t.description || 'Expense';
    const amt = Number(t.amount || 0).toFixed(2);
    const cat = t.category ? ` — <i>${t.category}</i>` : '';
    const acc = t.account ? ` (<code>${t.account}</code>)` : '';
    const flagStr = t.notes ? ` ${t.notes}` : '';
    lines.push(`• <b>${desc}</b>: S$${amt}${cat}${acc}${flagStr}`);
  });

  lines.push(activeSpendSignoff);
  return lines.join('\n');
}

/**
 * Sends a recap of all transactions logged today at 22:00 SGT (10 PM SGT) or on-demand.
 * 
 * @param {string|number} [targetChatId] - Optional specific Chat ID.
 */
function sendDailyEveningRecap(targetChatId) {
  Logger.log('=== Running Daily Evening Transaction Recap (22:00 SGT) ===');
  const recapHtml = generateDailyTransactionsRecap();
  sendTelegramMessage(recapHtml, targetChatId);
}

/**
 * Sends the End-of-Month Retrospective Coach Brief via Telegram (§6.5).
 * Triggered automatically on the 1st day of every month at 09:00 SGT.
 */
function sendMonthlyCoach() {
  Logger.log('=== Running Monthly Coach Retrospective Brief ===');
  const context = getBudgetCoachContext();
  const briefText = generateMonthlyCoachBrief(context);
  sendTelegramMessage(briefText);
}

/**
 * Master dispatcher for all scheduled events in Budget 2026.
 * Executed every 15 minutes by a single project trigger.
 * Fast early-exit prevents unnecessary quota and execution usage.
 */
function dispatch() {
  const now = new Date();
  const tz = 'Asia/Singapore';
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const currentHour = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
  const currentMinute = parseInt(Utilities.formatDate(now, tz, 'm'), 10);
  const currentTotalMins = currentHour * 60 + currentMinute;
  const dayOfWeek = Utilities.formatDate(now, tz, 'E'); // 'Mon', 'Tue', etc.
  const dayOfMonth = parseInt(Utilities.formatDate(now, tz, 'd'), 10);

  // Month-rollover detection: check if tomorrow is in a different month
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowMonth = parseInt(Utilities.formatDate(tomorrow, tz, 'M'), 10);
  const currentMonth = parseInt(Utilities.formatDate(now, tz, 'M'), 10);
  const isLastDayOfMonth = (tomorrowMonth !== currentMonth);

  const props = PropertiesService.getScriptProperties();

  // Helper: checks if target HH:mm falls within the current 15-minute window (exact 15m, no overlap)
  function isTimeInWindow(targetTimeStr) {
    if (!targetTimeStr || !targetTimeStr.includes(':')) return false;
    const parts = targetTimeStr.split(':');
    const targetH = parseInt(parts[0], 10);
    const targetM = parseInt(parts[1], 10);
    const targetTotalMins = targetH * 60 + targetM;
    
    // Window: exactly 15 minutes without overlap: diff >= 0 && diff < 15
    const diff = currentTotalMins - targetTotalMins;
    return diff >= 0 && diff < 15;
  }

  // Helper: once-per-day guard
  function hasSentToday(key) {
    return props.getProperty(`sent_${key}`) === todayStr;
  }

  function markSentToday(key) {
    props.setProperty(`sent_${key}`, todayStr);
  }

  function clearSentToday(key) {
    props.deleteProperty(`sent_${key}`);
  }

  // 1. Per-User Morning Coach Briefs at each user's morning_time (SHEET_FACTS.USERS)
  const users = (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.USERS) ? SHEET_FACTS.USERS : {
    VAL: { name: 'Val', chat_id: '96069960', morning_time: '08:00', active: true },
    RITA: { name: 'Rita', chat_id: '402188776', morning_time: '08:00', active: true }
  };

  let morningPayload = null;
  let morningBriefText = null;

  Object.values(users).forEach(user => {
    if (!user || !user.active || !user.chat_id) return;
    const targetTime = user.morning_time || '08:00';
    const userKey = `morning_coach_${user.chat_id}`;

    if (isTimeInWindow(targetTime) && !hasSentToday(userKey)) {
      Logger.log(`[DISPATCH] Claiming slot & firing Morning Coach for ${user.name} (${user.chat_id}) for scheduled window ${targetTime}`);
      markSentToday(userKey); // Claim slot BEFORE async/LLM work to prevent double-firing
      try {
        if (!morningBriefText) {
          morningPayload = typeof buildCoachPayload === 'function' ? buildCoachPayload('daily') : getBudgetCoachContext();
          morningBriefText = typeof generateCoachBrief === 'function' ? generateCoachBrief(morningPayload) : generateDailyCoachBrief(morningPayload);
        }
        sendTelegramMessage(morningBriefText, user.chat_id);
        Logger.log(`✅ [DISPATCH] Morning Coach sent to ${user.name}`);
      } catch (err) {
        clearSentToday(userKey); // Clear slot on error so next tick can retry
        Logger.log(`❌ [DISPATCH] Error delivering Morning Coach to ${user.name} (slot cleared for retry): ${err.message}`);
      }
    }
  });

  // 2. Daily Evening Nudge at 21:00 SGT
  if (isTimeInWindow('21:00') && !hasSentToday('daily_nudge')) {
    Logger.log('[DISPATCH] Claiming slot & firing Daily Evening Nudge (21:00 SGT)');
    markSentToday('daily_nudge');
    try {
      sendDailyNudge();
      Logger.log('✅ [DISPATCH] Daily Evening Nudge sent.');
    } catch (err) {
      clearSentToday('daily_nudge');
      Logger.log(`❌ [DISPATCH] Error in sendDailyNudge (slot cleared for retry): ${err.message}`);
    }
  }

  // 3. Daily Evening Transactions Recap at 22:00 SGT
  if (isTimeInWindow('22:00') && !hasSentToday('daily_evening_recap')) {
    Logger.log('[DISPATCH] Claiming slot & firing Daily Evening Transactions Recap (22:00 SGT)');
    markSentToday('daily_evening_recap');
    try {
      sendDailyEveningRecap();
      Logger.log('✅ [DISPATCH] Daily Evening Recap sent.');
    } catch (err) {
      clearSentToday('daily_evening_recap');
      Logger.log(`❌ [DISPATCH] Error in sendDailyEveningRecap (slot cleared for retry): ${err.message}`);
    }
  }

  // 4. Weekly Mandatory Expenses Audit on Mondays at 09:00 SGT
  if (dayOfWeek === 'Mon' && isTimeInWindow('09:00') && !hasSentToday('weekly_mandatory_audit')) {
    Logger.log('[DISPATCH] Claiming slot & firing Weekly Mandatory Expenses Audit (Monday 09:00 SGT)');
    markSentToday('weekly_mandatory_audit');
    try {
      sendWeeklyMandatoryAudit();
      Logger.log('✅ [DISPATCH] Weekly Mandatory Audit sent.');
    } catch (err) {
      clearSentToday('weekly_mandatory_audit');
      Logger.log(`❌ [DISPATCH] Error in sendWeeklyMandatoryAudit (slot cleared for retry): ${err.message}`);
    }
  }

  // 5. Monthly Retrospective Coach Brief on 1st of every month at 09:00 SGT
  if (dayOfMonth === 1 && isTimeInWindow('09:00') && !hasSentToday('monthly_coach_retrospective')) {
    Logger.log('[DISPATCH] Claiming slot & firing Monthly Retrospective Coach Brief (1st of month 09:00 SGT)');
    markSentToday('monthly_coach_retrospective');
    try {
      sendMonthlyCoach();
      Logger.log('✅ [DISPATCH] Monthly Retrospective Coach sent.');
    } catch (err) {
      clearSentToday('monthly_coach_retrospective');
      Logger.log(`❌ [DISPATCH] Error in sendMonthlyCoach (slot cleared for retry): ${err.message}`);
    }
  }

  // 6. Month-Rollover Jobs (Last day of month at 23:30 SGT) - placeholder for Stages 3/5/6
  if (isLastDayOfMonth && isTimeInWindow('23:30')) {
    Logger.log('⏭️ [DISPATCH] Month-rollover jobs not yet implemented (Stages 3/5/6). Skipping.');
  }
}

/**
 * Sets up the single 15-minute master trigger for dispatch().
 * Deletes all existing project triggers to eliminate multiple uncoordinated .atHour() triggers.
 */
function setupTriggers() {
  Logger.log('=== Running setupTriggers() ===');
  const existingTriggers = ScriptApp.getProjectTriggers();
  Logger.log(`Found ${existingTriggers.length} existing project trigger(s). Deleting...`);

  existingTriggers.forEach(trigger => {
    try {
      ScriptApp.deleteTrigger(trigger);
    } catch (e) {
      Logger.log(`Warning deleting trigger: ${e.message}`);
    }
  });

  // Create single 15-minute heartbeat trigger
  const newTrigger = ScriptApp.newTrigger('dispatch')
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log(`✅ Successfully installed single 15-minute master trigger for dispatch() (Trigger ID: ${newTrigger.getUniqueId()})`);
}

/**
 * Backwards compatible alias for setupTriggers.
 */
function setupAllTriggers() {
  setupTriggers();
}

/**
 * Backwards compatible alias for setupDailyTrigger.
 */
function setupDailyTrigger() {
  setupTriggers();
}
