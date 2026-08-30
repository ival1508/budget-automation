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
  const spendablePerDay = Number(Number(pacing.D19_realistic_daily || 0).toFixed(2));
  const cumulativePosition = Number(Number(pacing.K_cumulative_today || 0).toFixed(2));
  const daysToPositive = pacing.days_to_positive || 0;

  let positionLine = '';
  if (cumulativePosition < 0) {
    const behindAmount = Math.abs(Math.round(cumulativePosition));
    const dayText = daysToPositive === 1 ? 'one zero-spend day clears it' : `${daysToPositive} zero-spend days clear it`;
    positionLine = `• 📊 <b>Cumulative position:</b> You're S$${behindAmount} behind pace — ${dayText}.`;
  } else if (cumulativePosition > 0) {
    positionLine = `• 📊 <b>Cumulative position:</b> S$${cumulativePosition.toFixed(2)} ahead of pace.`;
  } else {
    positionLine = `• 📊 <b>Cumulative position:</b> Exactly on pace.`;
  }

  if (todaysTxns.length === 0) {
    return [
      `🌙 <b>Daily Recap — ${dateStr}</b>\n`,
      `😴 <b>Zero Spend Day!</b> No transactions were logged for today.\n`,
      `• 🎯 <b>Spendable per day:</b> S$${spendablePerDay.toFixed(2)}/day`,
      positionLine + `\n`,
      `✨ <i>Great job! Zero-spend days protect your runway and boost your pacing for the rest of the month.</i>`
    ].join('\n');
  }

  const lines = [
    `🌙 <b>Daily Spending Recap — ${dateStr}</b>\n`,
    `• 💰 <b>Total Spend Today:</b> <b>S$${totalSpend.toFixed(2)}</b>`,
    `• 🎯 <b>Spendable per day:</b> S$${spendablePerDay.toFixed(2)}/day`,
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

  lines.push(`\n✨ <i>Logged & tracked in Budget 2026. Rest up!</i>`);
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
 * Sets up all automated time-driven triggers for Budget 2026:
 * 1. sendMorningCoach: Daily at 08:00 SGT
 * 2. sendDailyNudge: Daily at 21:00 SGT (9 PM)
 * 3. sendDailyEveningRecap: Daily at 22:00 SGT (10 PM)
 * 4. sendWeeklyMandatoryAudit: Weekly on Mondays at 09:00 SGT
 * 5. sendMonthlyCoach: Monthly on 1st at 09:00 SGT
 */
function setupAllTriggers() {
  const existingTriggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;

  for (let i = 0; i < existingTriggers.length; i++) {
    const fn = existingTriggers[i].getHandlerFunction();
    if (fn === 'sendDailyNudge' || fn === 'sendDailyEveningRecap' || fn === 'sendMorningCoach' || fn === 'sendWeeklyMandatoryAudit' || fn === 'sendMonthlyCoach') {
      ScriptApp.deleteTrigger(existingTriggers[i]);
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    Logger.log(`Cleaned up ${deletedCount} existing trigger(s).`);
  }

  // 1. Morning Coach Daily at 08:00 SGT
  ScriptApp.newTrigger('sendMorningCoach')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .inTimezone('Asia/Singapore')
    .create();

  // 2. Evening Nudge Daily at 21:00 SGT (9 PM)
  ScriptApp.newTrigger('sendDailyNudge')
    .timeBased()
    .everyDays(1)
    .atHour(21)
    .inTimezone('Asia/Singapore')
    .create();

  // 3. Evening Transactions Recap Daily at 22:00 SGT (10 PM)
  ScriptApp.newTrigger('sendDailyEveningRecap')
    .timeBased()
    .everyDays(1)
    .atHour(22)
    .inTimezone('Asia/Singapore')
    .create();

  // 4. Weekly Mandatory Audit on Monday at 09:00 SGT
  ScriptApp.newTrigger('sendWeeklyMandatoryAudit')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .inTimezone('Asia/Singapore')
    .create();

  // 5. Monthly Retrospective Coach on 1st of every month at 09:00 SGT
  ScriptApp.newTrigger('sendMonthlyCoach')
    .timeBased()
    .onMonthDay(1)
    .atHour(9)
    .inTimezone('Asia/Singapore')
    .create();

  Logger.log('✅ All 5 time-driven triggers scheduled successfully!');
}

/**
 * Backwards compatible alias for setupDailyTrigger.
 */
function setupDailyTrigger() {
  setupAllTriggers();
}
