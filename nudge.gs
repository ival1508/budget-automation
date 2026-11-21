/**
 * Budget 2026 Automation v1 - Nudge & Coach Scheduler (Cron & Command Layer)
 * File: nudge.gs
 * 
 * Manages daily morning coach updates, daily evening nudges, and weekly mandatory audits (§6.5).
 */

/**
 * Sends to active configured users, or one explicitly requested chat.
 * Every delivery requires HTTP 200 and Telegram ok:true; partial broadcasts throw
 * with accepted/failure details after attempting every recipient.
 * 
 * @param {string} htmlText - Formatted Telegram HTML text message.
 * @param {string|number} [targetChatId] - Optional specific Chat ID for on-demand requests.
 * @param {Object} [optOptions] - Optional reply_markup. Legacy true arguments are harmless.
 * @return {Array<Object>} Accepted delivery receipts.
 */
function sendTelegramMessage(htmlText, targetChatId, optOptions) {
  const token = PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN");
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN missing in Script Properties.');
  }

  const chatIds = targetChatId ? [String(targetChatId).trim()] : getActiveTelegramUsers().map(user => user.chat_id);
  if (!chatIds.length) throw new Error('No active Telegram recipients are configured.');
  const accepted = [], failures = [];
  chatIds.forEach(chatId => {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML'
    };
    if (optOptions && optOptions.reply_markup) payload.reply_markup = optOptions.reply_markup;
    if (optOptions && optOptions.disable_notification) payload.disable_notification = true;
    let response;
    try {
      response = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
      });
    } catch (_) {
      // UrlFetch exceptions can contain the token-bearing request URL.
      failures.push({ chat_id: chatId, description: 'Network request failed.', retry_after: 0 });
      return;
    }
    const code = response.getResponseCode();
    let result;
    try { result = JSON.parse(response.getContentText()); }
    catch (_) { result = null; }
    if (code !== 200 || !result || result.ok !== true) {
      const retryAfter = Number(result && result.parameters && result.parameters.retry_after);
      failures.push({ chat_id: chatId, description: `HTTP ${code}: ` + ((result && result.description) || 'Invalid Telegram response.'),
        retry_after: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0 });
    } else {
      accepted.push({ chat_id: chatId, message_id: result.result && result.result.message_id });
      Logger.log(`✅ Telegram accepted message for Chat ID ${chatId}`);
    }
  });
  if (failures.length) {
    const error = new Error('Telegram delivery failed: ' + failures.map(failure => failure.chat_id + ' ' + failure.description).join('; '));
    error.accepted = accepted;
    error.failures = failures;
    error.retryAfterSeconds = Math.max(...failures.map(failure => failure.retry_after));
    throw error;
  }
  return accepted;
}

function getActiveTelegramUsers() {
  const seen = new Set();
  const users = typeof SHEET_FACTS !== 'undefined' ? SHEET_FACTS.USERS || {} : {};
  return Object.values(users).filter(user => {
    const chatId = user && String(user.chat_id || '').trim();
    if (!user || user.active !== true || !chatId || seen.has(chatId)) return false;
    seen.add(chatId); return true;
  }).map(user => ({ ...user, chat_id: String(user.chat_id).trim() }));
}

// A live execution expires after seven minutes (longer than Apps Script's six-minute limit).
// Only the brief property claim holds the shared lock; no model/network work holds it.
function deliverScheduledMessage(key, slot, chatId, buildMessage, optSentKey) {
  const props = PropertiesService.getScriptProperties();
  const sentKey = optSentKey || 'sent_' + key;
  const sentValue = optSentKey ? 'sent' : slot.period;
  const sendingKey = 'sending_' + key, retryKey = 'retry_' + key;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return false;
  let token, attempts;
  try {
    if (props.getProperty(sentKey) === sentValue) return true;
    if (Date.now() < slot.dueAt || Date.now() >= slot.expiresAt) return false;
    const retry = JSON.parse(props.getProperty(retryKey) || 'null');
    if (retry && retry.period === slot.period && Date.now() < retry.notBefore) return false;
    const current = JSON.parse(props.getProperty(sendingKey) || 'null');
    if (current && Date.now() - current.startedAt < 420000) return false;
    token = Utilities.getUuid();
    attempts = retry && retry.period === slot.period ? retry.attempts : 0;
    props.setProperty(sendingKey, JSON.stringify({ token: token, period: slot.period, startedAt: Date.now() }));
  } finally { lock.releaseLock(); }
  try {
    const partsKey = 'parts_' + key + '_' + slot.period + '_';
    const savedCount = Number(props.getProperty(partsKey + 'count')) || 0;
    const message = savedCount ? { parts: Array.from({ length: savedCount }, (_, index) => {
      const part = props.getProperty(partsKey + index);
      if (part === null) throw new Error('Saved monthly report part is missing.');
      return part;
    }) } : buildMessage();
    if (Date.now() >= slot.expiresAt) throw new Error('Delivery window expired during generation.');
    if (message.parts) {
      if (!savedCount) {
        message.parts.forEach((part, index) => props.setProperty(partsKey + index, part));
        props.setProperty(partsKey + 'count', String(message.parts.length));
      }
      const next = Number(props.getProperty(partsKey + 'next')) || 0;
      for (let index = next; index < message.parts.length; index++) {
        if (Date.now() >= slot.expiresAt) throw new Error('Monthly delivery window expired.');
        sendTelegramMessage(message.parts[index], chatId);
        props.setProperty(partsKey + 'next', String(index + 1));
      }
    } else {
      sendTelegramMessage(typeof message === 'string' ? message : message.text, chatId,
        typeof message === 'string' ? true : { reply_markup: message.reply_markup });
    }
    props.setProperty(sentKey, sentValue);
    if (message.parts) {
      message.parts.forEach((_, index) => props.deleteProperty(partsKey + index));
      props.deleteProperty(partsKey + 'count'); props.deleteProperty(partsKey + 'next');
    }
    props.deleteProperty(retryKey);
    Logger.log(`✅ [DISPATCH] Accepted ${key} for ${slot.period}`);
    return true;
  } catch (error) {
    const serverDelay = Number(error.retryAfterSeconds) || 0;
    const backoffSeconds = Math.min(900, 60 * Math.pow(2, Math.min(attempts, 4)));
    props.setProperty(retryKey, JSON.stringify({ period: slot.period, attempts: attempts + 1,
      notBefore: Date.now() + Math.max(serverDelay, backoffSeconds) * 1000 }));
    Logger.log(`❌ [DISPATCH] ${key} pending until the next eligible heartbeat: ${error.message}`);
    return false;
  } finally {
    const current = JSON.parse(props.getProperty(sendingKey) || 'null');
    if (current && current.token === token) props.deleteProperty(sendingKey);
  }
}

/** Daily catch-up ends at its deadline or SGT midnight, whichever comes first. */
function getDailyDeliverySlot(now, time, catchUpMinutes) {
  const parts = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59) return null;
  const year = Number(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy'));
  const month = Number(Utilities.formatDate(now, 'Asia/Singapore', 'M'));
  const day = Number(Utilities.formatDate(now, 'Asia/Singapore', 'd'));
  const dueAt = Date.UTC(year, month - 1, day, Number(parts[1]) - 8, Number(parts[2]));
  const expiresAt = Math.min(dueAt + catchUpMinutes * 60000, Date.UTC(year, month - 1, day + 1, -8));
  return now.getTime() >= dueAt && now.getTime() < expiresAt
    ? { period: Utilities.formatDate(now, 'Asia/Singapore', 'yyyy-MM-dd'), dueAt: dueAt, expiresAt: expiresAt } : null;
}

/** Latest month-end due date, including catch-up across the next month's midnight. */
function getMonthEndDeliverySlot(now) {
  const year = Number(Utilities.formatDate(now, 'Asia/Singapore', 'yyyy'));
  const month = Number(Utilities.formatDate(now, 'Asia/Singapore', 'M'));
  let dueAt = Date.UTC(year, month, 0, 15, 30); // Last day, 23:30 SGT.
  if (now.getTime() < dueAt) dueAt = Date.UTC(year, month - 1, 0, 15, 30);
  const expiresAt = dueAt + 180 * 60000;
  if (now.getTime() < dueAt || now.getTime() >= expiresAt) return null;
  const reportDate = new Date(dueAt);
  return { period: Utilities.formatDate(reportDate, 'Asia/Singapore', 'yyyy-MM'),
    reportDate: reportDate, dueAt: dueAt, expiresAt: expiresAt };
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

  return sendTelegramMessage(briefText);
}

/**
 * Generates and sends the Weekly Mandatory Expenses Audit report to Telegram.
 * Triggered automatically on Mondays at 09:00 SGT, or on-demand via the /mandatory command.
 * 
 * @param {string|number} [targetChatId] - Optional Chat ID for on-demand execution.
 */
function sendWeeklyMandatoryAudit(targetChatId) {
  Logger.log('=== Running Weekly Mandatory Expenses Audit ===');
  const reportHtml = generateWeeklyMandatoryReport();
  return sendTelegramMessage(reportHtml, targetChatId);
}

/**
 * Sends the daily evening nudge message via Telegram at 21:00 SGT (§6.5).
 */
function buildDailyNudgeMessage() {
  return {
    text: "🌙 <b>Evening! Anything to log for today?</b>\n\nSnap a receipt, paste a text dump, or tap below if today was a zero-spend day.",
    reply_markup: {
      inline_keyboard: [[{ text: "😴 Nothing today", callback_data: "nothing_today" }]]
    }
  };
}

function sendDailyNudge(targetChatId) {
  const message = buildDailyNudgeMessage();
  return sendTelegramMessage(message.text, targetChatId, { reply_markup: message.reply_markup });
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
  let reportDate = optDate || new Date();
  if (typeof reportDate === 'string') {
    const parts = calendarDateParts(reportDate);
    reportDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 4));
  }
  const dateStr = Utilities.formatDate(reportDate, tz, 'dd.MM.yyyy');

  const todaysTxns = typeof getTodaysTransactions === 'function' ? getTodaysTransactions(ss, reportDate) : [];
  const pacing = typeof getDailyPacing === 'function' ? getDailyPacing(reportDate, ss) : { error: 'unavailable' };

  const todaySpend = typeof getTodaySpend === 'function' 
    ? getTodaySpend(reportDate, ss)
    : todaysTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);

  const totalSpend = Number(Number(todaySpend || 0).toFixed(2));
  const pacingLines = buildEveningPacingLines(pacing);
  const parts = calendarDateParts(reportDate);
  const isLastDay = parts.day === parts.lastDay;

  // Sign-off message
  const zeroSpendSignoff = isLastDay
    ? `✨ <i>No spending logged for the final day of the month. Rest up!</i>`
    : `✨ <i>No spending logged today. Rest up!</i>`;

  const activeSpendSignoff = isLastDay
    ? `\n✨ <i>Logged & tracked in Budget ${parts.year} for month-end close. Rest up!</i>`
    : `\n✨ <i>Logged & tracked in Budget ${parts.year}. Rest up!</i>`;

  if (todaysTxns.length === 0) {
    return [
      `🌙 <b>Daily Recap — ${dateStr}</b>\n`,
      `😴 <b>Zero Spend Day!</b> No transactions were logged for today.\n`,
      `• 💰 <b>Total Spend Today:</b> <b>S$${totalSpend.toFixed(2)}</b>`,
      ...pacingLines,
      '',
      zeroSpendSignoff
    ].join('\n');
  }

  const lines = [
    `🌙 <b>Daily Spending Recap — ${dateStr}</b>\n`,
    `• 💰 <b>Total Spend Today:</b> <b>S$${totalSpend.toFixed(2)}</b>`,
    ...pacingLines,
    '',
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

/** Opening allowance (K), closing saldo (L), and change versus yesterday's close. */
function buildEveningPacingLines(pacing) {
  if (!pacing || pacing.error || !['K_cumulative_today', 'L_saldo_today', 'L_saldo_yesterday']
    .every(key => typeof pacing[key] === 'number' && Number.isFinite(pacing[key]))) {
    return [`• 📊 <b>Budget position:</b> Today's budget position is unavailable.`];
  }
  const opening = Number(pacing.K_cumulative_today.toFixed(2));
  const closing = Number(pacing.L_saldo_today.toFixed(2));
  const change = Number((pacing.L_saldo_today - pacing.L_saldo_yesterday).toFixed(2));
  const available = opening < 0
    ? `No spending room — S$${Math.abs(opening).toFixed(2)} behind pace before spending.`
    : `S$${opening.toFixed(2)}`;
  const result = closing < 0
    ? `S$${Math.abs(closing).toFixed(2)} overspent — behind pace at close.`
    : closing > 0
      ? `S$${closing.toFixed(2)} underspent — ahead of pace at close.`
      : `Exactly used today's available budget — on pace at close.`;
  const movement = change > 0
    ? `Improved by S$${change.toFixed(2)} today.`
    : change < 0
      ? `Worsened by S$${Math.abs(change).toFixed(2)} today.`
      : `Unchanged today.`;
  return [
    `• 🎯 <b>Available Today:</b> ${available}`,
    `• 📊 <b>Result:</b> ${result}`,
    `• ${change > 0 ? '↗️' : change < 0 ? '↘️' : '↔️'} <b>Daily position:</b> ${movement}`
  ];
}

/**
 * Sends a recap of all transactions logged today at 22:00 SGT (10 PM SGT) or on-demand.
 * 
 * @param {string|number} [targetChatId] - Optional specific Chat ID.
 */
function sendDailyEveningRecap(targetChatId) {
  Logger.log('=== Running Daily Evening Transaction Recap (22:00 SGT) ===');
  const recapHtml = generateDailyTransactionsRecap();
  return sendTelegramMessage(recapHtml, targetChatId);
}

/**
 * Sends the End-of-Month Retrospective Coach Brief via Telegram (§6.5).
 * On demand: defaults to the latest completed month, or accepts an explicit report date.
 * Scheduled month-end delivery is sequenced by runMonthEndJobs().
 */
function sendMonthlyCoach(optReportDate, optSs) {
  Logger.log('=== Running Monthly Coach Retrospective Brief ===');
  const context = buildCoachPayload('monthly', optSs, optReportDate);
  const briefText = generateMonthlyCoachBrief(context);
  splitMonthlyReview(briefText).forEach(part => sendTelegramMessage(part));
  return briefText;
}

/** Reminder then coach for each active user, guarded by reporting month and delivery step. */
function runMonthEndJobs(reportDate, optSs, optSlot) {
  const slot = optSlot || getMonthEndDeliverySlot(reportDate);
  if (!slot) return;
  const reportMonth = Utilities.formatDate(reportDate, 'Asia/Singapore', 'yyyy-MM');
  const props = PropertiesService.getScriptProperties();
  const runningKey = 'month_end_running_' + reportMonth;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const token = Utilities.getUuid();
  try {
    const previous = JSON.parse(props.getProperty(runningKey) || 'null');
    if (previous && Date.now() - previous.startedAt < 420000) return;
    props.setProperty(runningKey, JSON.stringify({ token: token, startedAt: Date.now() }));
  } finally { lock.releaseLock(); }

  try {
    // Expired incomplete report snapshots are no longer retryable; retain only this month.
    if (typeof props.getProperties === 'function') Object.keys(props.getProperties()).forEach(key => {
      if (key.startsWith('parts_month_end_') && !key.startsWith('parts_month_end_' + reportMonth + '_')) props.deleteProperty(key);
    });
    const users = getActiveTelegramUsers();
    let briefText = null;
    for (const user of users) {
      const prefix = 'month_end_' + reportMonth + '_' + user.chat_id;
      if (props.getProperty(prefix + '_coach') === 'sent') continue;
      const reminded = deliverScheduledMessage(prefix + '_reminder', slot, user.chat_id, () => {
        const monthTabLabel = (optSs && typeof resolveMonthSheet === 'function')
          ? resolveMonthSheet(optSs, reportDate).tabName
          : getCurrentMonthTabName(reportDate);
        return `Please upload the bank statements for <b>${escapeCoachHtml(monthTabLabel)}</b> in your AI chat to reconcile any missing transactions.`;
      }, prefix + '_reminder');
      if (!reminded) continue;
      deliverScheduledMessage(prefix + '_coach', slot, user.chat_id, () => {
        if (!briefText) briefText = generateMonthlyCoachBrief(buildCoachPayload('monthly', optSs, reportDate));
        const parts = splitMonthlyReview(briefText);
        return parts.length === 1 ? briefText : { parts: parts };
      }, prefix + '_coach');
    }
  } finally {
    // Do not hold the shared script lock during model generation or network delivery.
    const current = JSON.parse(props.getProperty(runningKey) || 'null');
    if (current && current.token === token) props.deleteProperty(runningKey);
  }
}

/**
 * Master dispatcher for all scheduled events.
 * Executed every 15 minutes by a single project trigger.
 * Fast early-exit prevents unnecessary quota and execution usage.
 */
function dispatch() {
  const now = new Date();
  if (typeof runScheduledMonthCreation === 'function') {
    try { runScheduledMonthCreation(now); }
    catch (error) { Logger.log('Scheduled month creation failed: ' + error.message); }
  }
  try { runMonthCreationConfirmations(now); }
  catch (error) { Logger.log('Month creation confirmation pending: ' + error.message); }
  const users = getActiveTelegramUsers();
  let morningBrief = null, recap = null, weeklyReport = null;
  const nudgeSlot = getDailyDeliverySlot(now, '21:00', 60);
  const recapSlot = getDailyDeliverySlot(now, '22:00', 90);
  const weeklySlot = getMandatoryWeeklySlot(now);

  for (const user of users) {
    const morningSlot = getDailyDeliverySlot(now, user.morning_time || '08:00', 180);
    if (morningSlot) deliverScheduledMessage('morning_coach_' + user.chat_id, morningSlot, user.chat_id, () => {
      if (!morningBrief) morningBrief = generateCoachBrief(buildCoachPayload('daily', undefined, now));
      return morningBrief;
    });
    if (nudgeSlot) deliverScheduledMessage('daily_nudge_' + user.chat_id, nudgeSlot, user.chat_id, buildDailyNudgeMessage);
    if (recapSlot) deliverScheduledMessage('daily_evening_recap_' + user.chat_id, recapSlot, user.chat_id, () => {
      if (!recap) recap = generateDailyTransactionsRecap(undefined, now);
      return recap;
    });
    if (weeklySlot) deliverScheduledMessage('weekly_mandatory_audit_' + user.chat_id, weeklySlot, user.chat_id, () => {
      if (!weeklyReport) weeklyReport = generateWeeklyMandatoryReport(undefined, undefined, now);
      return weeklyReport;
    });
  }

  runMandatorySameDayAlerts(now, users);

  // Month-end catch-up uses the original closing month, including after midnight.
  const monthEndSlot = getMonthEndDeliverySlot(now);
  if (monthEndSlot) {
    try { runMonthEndJobs(monthEndSlot.reportDate, undefined, monthEndSlot); }
    catch (error) { Logger.log('Month-end jobs failed: ' + error.message); }
    try { runScheduledBasketReview(monthEndSlot.reportDate, undefined, monthEndSlot); }
    catch (error) { Logger.log('Monthly Basket Review failed: ' + error.message); }
  }

  // Monthly money-market benchmark refresh for the "Папа" debt tab (once per SGT month).
  if (typeof runScheduledPapaRateSync === 'function') {
    try { runScheduledPapaRateSync(now); }
    catch (error) { Logger.log('Папа monthly rate sync failed: ' + error.message); }
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
