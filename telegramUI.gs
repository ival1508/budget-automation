/**
 * Budget 2026 Automation v1 - Telegram UI, Inline Keyboards & Interactive Editor
 * File: telegramUI.gs
 * 
 * Formats proposed transactions into Telegram HTML messages and builds dynamic inline keyboard menus
 * for interactive field editing (category picker, account picker, item deletion) (§5.1, §6.4).
 */

/**
 * Formats an array of proposed transactions into a readable Telegram HTML message.
 * 
 * @param {Array<Object>} transactions - Array of enriched transaction objects.
 * @return {string} Formatted HTML message text.
 */
function formatTransactionConfirmationHtml(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return '<i>No transactions remaining in proposal.</i>';
  }

  const lines = ['<b>📝 Proposed Transactions for Review:</b>\n'];

  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    const dateStr = txn.date || 'Today';
    const accountStr = txn.account || 'DBS CC SGD';
    const merchant = txn.where || 'Unknown';
    const amountStr = txn.currency === 'SGD'
      ? `S$${Number(txn.amount).toFixed(2)}`
      : `${Number(txn.amount).toFixed(2)} ${txn.currency}`;
    const categoryStr = txn.category || 'Другое';
    const bucketStr = txn.bucket || 'Wants';

    const typeStr = txn.type || TRANSACTION_TYPES.EXPENSE;

    lines.push(`<b>Item ${i + 1}:</b>`);
    const itemText = `📅 <b>${dateStr}</b> | 💳 <i>${accountStr}</i> | ⚖️ <b>${typeStr}</b>\n` +
      `💸 <b>${merchant}</b> — S$${Number(txn.amount).toFixed(2)}${txn.currency !== 'SGD' ? ` (${txn.currency})` : ''}\n` +
      `🏷️ Category: <b>${categoryStr}</b> (<i>${bucketStr}</i>)`;
    lines.push(itemText);

    // Append diagnostic review reasons if flagged
    const reviewWarnings = formatReviewReasons(txn);
    if (reviewWarnings) {
      lines.push(reviewWarnings);
    }

    lines.push(''); // Blank line spacing between transactions
  }

  lines.push('Tap <b>Approve All</b> to log into Budget 2026, <b>Edit</b> to modify, or <b>Discard</b> to cancel.');
  return lines.join('\n');
}

/**
 * Formats explicit review reasons and warnings for a transaction item (§6.4).
 * 
 * @param {Object} item - Transaction item object.
 * @return {string} Formatted review reasons block string or empty string.
 */
function formatReviewReasons(item) {
  if (!item) return '';

  const hasFlags = Array.isArray(item.flags) && item.flags.length > 0;
  if (!item.needs_review && !hasFlags) {
    return '';
  }

  const reasons = [];

  // 1. Foreign Currency Check
  if (item.currency && item.currency !== 'SGD') {
    reasons.push(`💱 <b>Foreign Currency (${item.currency}):</b> Verify or update the S$ equivalent amount before approving.`);
  } else if (hasFlags && item.flags.indexOf('foreign_currency') !== -1) {
    reasons.push('💱 <b>Foreign Currency:</b> Non-SGD spend detected. Verify the S$ amount.');
  }

  // 2. Reimbursable / Pass-Through Check
  if (hasFlags && item.flags.indexOf('reimbursable') !== -1) {
    reasons.push('🔁 <b>Reimbursable:</b> Marked as pass-through/to be returned (e.g., Wise/Revolut/Папа). Remember to log the matching incoming receipt later.');
  }

  // 3. Papa Charge Check
  if (hasFlags && item.flags.indexOf('papa_charge') !== -1) {
    reasons.push('👨‍👦 <b>Papa Charge:</b> Marked as dad\'s spend on your card.');
  }

  // 4. Duplicate Detection & Override Check
  if (hasFlags && item.flags.indexOf('force_add') !== -1) {
    reasons.push('✅ <b>Force Add Enabled:</b> Will be logged as a legitimate separate purchase.');
  } else if (hasFlags && item.flags.indexOf('possible_duplicate') !== -1) {
    reasons.push('🔁 <i>Possible duplicate of an earlier charge today (will confirm on approve)</i>');
  }

  // 5. Low AI Confidence Check
  if (item.confidence) {
    if (item.confidence.category < 0.8) {
      const catPct = Math.round(item.confidence.category * 100);
      reasons.push(`❓ <b>Low Category Confidence (${catPct}%):</b> AI wasn't sure about '<b>${item.category}</b>' — please double-check.`);
    }
    if (item.confidence.amount < 0.9) {
      reasons.push('❓ <b>Low Amount Confidence:</b> Messy receipt/text — please verify the exact amount.');
    }
  }

  // Fallback if needs_review is true but no specific flag matched
  if (reasons.length === 0 && item.needs_review) {
    reasons.push('⚠️ <b>Manual Review Flagged:</b> Please double-check transaction details before approving.');
  }

  return '\n<i>Why review is needed:</i>\n• ' + reasons.join('\n• ');
}

/**
 * Builds the primary proposal Inline Keyboard (§6.4).
 * Buttons: Approve All, Edit, Discard
 * 
 * @param {string} token - Cache token for state tracking.
 * @return {Object} Telegram reply_markup inline_keyboard structure.
 */
function getMainProposalKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve All', callback_data: `approve:${token}` },
        { text: '✏️ Edit', callback_data: `edit_menu:${token}` },
        { text: '🗑️ Discard', callback_data: `discard:${token}` }
      ]
    ]
  };
}

/**
 * Sends a confirmation message with Inline Keyboard to Telegram chat (§6.4).
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {string} token - Session token for CacheService retrieval.
 * @param {Array<Object>} transactions - Array of enriched proposed transactions.
 * @return {Object} Telegram API response object.
 */
function sendConfirmationMessage(chatId, token, transactions, isUpdate = false) {
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN missing in Script Properties.');
  }

  const messageText = formatTransactionConfirmationHtml(transactions);
  const inlineKeyboard = getMainProposalKeyboard(token);
  
  const userProps = PropertiesService.getUserProperties();
  const msgIdKey = `latest_message_id_${chatId}`;
  const existingMsgId = userProps.getProperty(msgIdKey);

  let url;
  const payload = {
    chat_id: chatId,
    text: messageText,
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard
  };

  if (isUpdate && existingMsgId) {
    // Edit the existing message
    url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    payload.message_id = parseInt(existingMsgId, 10);
  } else {
    // Send a new message
    url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const respJson = JSON.parse(response.getContentText());

  // Store the message ID for future rolling context updates
  if (respJson.ok && respJson.result && respJson.result.message_id) {
    userProps.setProperty(msgIdKey, String(respJson.result.message_id));
  }

  return respJson;
}

/**
 * Displays the Edit Menu keyboard listing a button for each transaction item in proposal (§6.4).
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Telegram message ID.
 * @param {string} token - Session token.
 * @param {Array<Object>} transactions - Current array of proposed transactions.
 */
function sendEditMenuKeyboard(chatId, messageId, token, transactions) {
  const keyboardRows = [];

  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    const amountStr = Number(txn.amount).toFixed(2);
    const label = `${i + 1}. ${txn.where || 'Item'} — S$${amountStr}`;
    keyboardRows.push([
      { text: label, callback_data: `edit_item:${token}:${i}` }
    ]);
  }

  keyboardRows.push([
    { text: '🔙 Back to Proposal', callback_data: `back_to_main:${token}` }
  ]);

  editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: keyboardRows });
}

/**
 * Displays action buttons for a single selected transaction item (§6.4).
 * Actions: Change Category, Change Account, Change Type, Remove Item, Back.
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Telegram message ID.
 * @param {string} token - Session token.
 * @param {number} index - Item index in transactions array.
 * @param {Object} item - Transaction item object.
 * @param {number} [totalCount] - Total number of transactions in proposal.
 */
function sendItemActionKeyboard(chatId, messageId, token, index, item, totalCount) {
  const count = (typeof totalCount === 'number') ? totalCount : 2;
  const backTarget = (count === 1) ? `back_to_main:${token}` : `edit_menu:${token}`;

  const rows = [];

  // Prepend Force Add or Undo Force Add button if duplicate flagged
  if (item && Array.isArray(item.flags)) {
    if (item.flags.indexOf('possible_duplicate') !== -1) {
      rows.push([
        { text: '⚠️ Force Add Anyway (Not a Duplicate)', callback_data: `force_add:${token}:${index}` }
      ]);
    } else if (item.flags.indexOf('force_add') !== -1) {
      rows.push([
        { text: '↩️ Undo Force Add (Keep Skip)', callback_data: `undo_force:${token}:${index}` }
      ]);
    }
  }

  rows.push([
    { text: '🏷️ Change Category', callback_data: `pick_cat:${token}:${index}` },
    { text: '💳 Change Account', callback_data: `pick_acc:${token}:${index}` }
  ]);
  rows.push([
    { text: '⚖️ Change Type', callback_data: `pick_type:${token}:${index}` },
    { text: '🏪 Rename Merchant', callback_data: `pick_merch:${token}:${index}` }
  ]);
  rows.push([
    { text: '❌ Remove Item', callback_data: `drop_item:${token}:${index}` },
    { text: '🔙 Back', callback_data: backTarget }
  ]);

  const keyboard = { inline_keyboard: rows };
  editTelegramMessageReplyMarkup(chatId, messageId, keyboard);
}

/**
 * Displays a 2-column Type Picker grid from controlled TRANSACTION_TYPES (§4.2, §6.4).
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Telegram message ID.
 * @param {string} token - Session token.
 * @param {number} index - Item index in transactions array.
 */
function sendTypePickerKeyboard(chatId, messageId, token, index) {
  const types = typeof ALL_TYPES !== 'undefined' ? ALL_TYPES : Object.values(TRANSACTION_TYPES);
  const rows = [];
  let currentRow = [];

  for (let i = 0; i < types.length; i++) {
    const typeName = types[i];
    
    currentRow.push({
      text: typeName,
      callback_data: `set_type:${token}:${index}:${i}`
    });

    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  rows.push([
    { text: '🔙 Back', callback_data: `edit_item:${token}:${index}` }
  ]);

  editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: rows });
}

/**
 * Displays a 2-column Category Picker grid from controlled CATEGORIES (§4.6, §6.4).
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Telegram message ID.
 * @param {string} token - Session token.
 * @param {number} index - Item index in transactions array.
 */
function sendCategoryPickerKeyboard(chatId, messageId, token, index) {
  const categories = typeof CATEGORIES !== 'undefined' ? CATEGORIES : [];
  const rows = [];
  let currentRow = [];

  for (let i = 0; i < categories.length; i++) {
    const catName = categories[i];
    
    currentRow.push({
      text: catName,
      callback_data: `set_cat:${token}:${index}:${i}`
    });

    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  rows.push([
    { text: '🔙 Back', callback_data: `edit_item:${token}:${index}` }
  ]);

  editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: rows });
}

/**
 * Displays an Account Picker grid from KNOWN_ACCOUNTS constant (§4.1, §6.4).
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Telegram message ID.
 * @param {string} token - Session token.
 * @param {number} index - Item index in transactions array.
 */
function sendAccountPickerKeyboard(chatId, messageId, token, index) {
  const accounts = typeof KNOWN_ACCOUNTS !== 'undefined' ? KNOWN_ACCOUNTS : ACCOUNTS;
  const rows = [];

  for (let i = 0; i < accounts.length; i++) {
    const accName = accounts[i];
    const encodedAcc = encodeURIComponent(accName);
    
    rows.push([
      {
        text: `💳 ${accName}`,
        callback_data: `set_acc:${token}:${index}:${encodedAcc}`
      }
    ]);
  }

  rows.push([
    { text: '🔙 Back', callback_data: `edit_item:${token}:${index}` }
  ]);

  editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: rows });
}

/**
 * Re-generates the proposal card HTML text and restores the main proposal Inline Keyboard (§6.4).
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Telegram message ID.
 * @param {string} token - Session token.
 * @param {Array<Object>} transactions - Updated transactions array.
 */
function refreshProposalCard(chatId, messageId, token, transactions) {
  if (typeof flagExistingDuplicates === 'function') {
    transactions = flagExistingDuplicates(transactions);
    if (typeof savePendingTransactions === 'function') {
      savePendingTransactions(transactions, token);
    }
  }
  const newText = formatTransactionConfirmationHtml(transactions);
  const mainKeyboard = getMainProposalKeyboard(token);
  editTelegramMessage(chatId, messageId, newText, mainKeyboard);
}

/**
 * Edits an existing Telegram message text and updates the Inline Keyboard.
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Message ID to edit.
 * @param {string} text - New HTML text content.
 * @param {Object|null} [replyMarkup] - Optional new Inline Keyboard object (null to remove keyboard).
 * @return {Object} Telegram API response.
 */
function editTelegramMessage(chatId, messageId, text, replyMarkup) {
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) return null;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML'
  };

  if (replyMarkup === null) {
    payload.reply_markup = JSON.stringify({ inline_keyboard: [] });
  } else if (replyMarkup !== undefined) {
    payload.reply_markup = replyMarkup;
  }

  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

/**
 * Safely updates a Telegram message to discarded status and explicitly wipes its inline keyboard.
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Target Telegram message ID.
 * @param {string} [textMessage] - Optional custom discard text message.
 */
function sendDiscardedMessage(chatId, messageId, textMessage) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/editMessageText`;

  const payload = {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text: textMessage || '🗑️ Discarded by user.',
    parse_mode: 'HTML',
    reply_markup: JSON.stringify({ inline_keyboard: [] })
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  Logger.log('Discard edit response: ' + response.getContentText());
}

/**
 * Edits only the reply_markup (inline keyboard) of a Telegram message.
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Message ID to edit.
 * @param {Object} replyMarkup - Inline Keyboard object structure.
 * @return {Object} Telegram API response.
 */
function editTelegramMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) return null;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup
  };

  const url = `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

/**
 * Acknowledges a Telegram Callback Query to dismiss the button loading spinner.
 * 
 * @param {string} callbackQueryId - Telegram callback_query_id.
 * @param {string} [text] - Optional toast notification text.
 * @param {boolean} [showAlert] - If true, presents an alert popup instead of a toast.
 */
function answerCallbackQuery(callbackQueryId, text, showAlert) {
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken || !callbackQueryId) return;

  const payload = {
    callback_query_id: callbackQueryId,
    text: text || '',
    show_alert: Boolean(showAlert)
  };

  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

/**
 * Sends a sequential resolution wizard step for a specific duplicate transaction item (§6.7).
 * Progress indicator: "Duplicate Intercept (1 of 3)"
 * Buttons: Force Add This Item, Skip This Item, Skip All Remaining Duplicates, Back to Review
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Telegram message ID.
 * @param {string} token - Session token.
 * @param {Array<Object>} transactions - Array of pending transactions.
 * @param {number} currentIndex - Index of duplicate transaction being resolved.
 */
function sendDuplicateWizardMessage(chatId, messageId, token, transactions, currentIndex) {
  var tokenProp = PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN");
  var url = "https://api.telegram.org/bot" + tokenProp + "/editMessageText";
  
  // Count total duplicates to show progress (e.g., "1 of 3")
  var totalDupes = 0;
  var currentDupeNumber = 0;
  for (var i = 0; i < transactions.length; i++) {
    var f = transactions[i].flags || [];
    if (f.indexOf("possible_duplicate") !== -1) {
      totalDupes++;
      if (i <= currentIndex) {
        currentDupeNumber++;
      }
    }
  }
  
  var item = transactions[currentIndex];
  var textMessage = "⚠️ <b>Duplicate Intercept (" + currentDupeNumber + " of " + totalDupes + ")</b>\n\n" +
                    "This purchase appears to already exist in your sheet today:\n" +
                    "📅 <b>" + item.date + "</b> | 💳 <i>" + item.account + "</i>\n" +
                    "💸 <b>" + item.where + "</b> — S$" + Number(item.amount).toFixed(2) + "\n" +
                    "🏷️ Category: " + item.category + "\n\n" +
                    "Is this a legitimate separate purchase?";
                    
  var buttons = [
    [
      { text: "⚠️ Force Add This Item", callback_data: "resolve_dup:" + token + ":" + currentIndex + ":force" },
      { text: "❌ Skip This Item", callback_data: "resolve_dup:" + token + ":" + currentIndex + ":skip" }
    ],
    [{ text: "❌ Skip All Remaining Duplicates", callback_data: "resolve_dup:" + token + ":all:skip_all" }],
    [{ text: "🔙 Back to Review", callback_data: "back_to_main:" + token }]
  ];
  
  var payload = {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text: textMessage,
    parse_mode: "HTML",
    reply_markup: JSON.stringify({ inline_keyboard: buttons })
  };
  
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  UrlFetchApp.fetch(url, options);
}
