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
function formatTransactionConfirmationHtml(transactions, showActions = true) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return '<i>No transactions remaining in proposal.</i>';
  }

  const attachmentCount = transactions.filter(proposalNeedsReceiptAttachment).length;
  const lines = [showActions && attachmentCount === transactions.length
    ? '<b>🧾 Add line items to a recorded purchase:</b>\n'
    : '<b>📝 Proposed Transactions for Review:</b>\n'];

  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    const dateStr = escapeProposalCommentHtml(txn.date || 'Today');
    const accountStr = escapeProposalCommentHtml(txn.account || 'DBS CC SGD');
    const merchant = escapeProposalCommentHtml(txn.where || 'Unknown');
    const currencyStr = escapeProposalCommentHtml(txn.currency || 'SGD');
    const amountStr = (txn.currency || 'SGD') === 'SGD'
      ? `S$${Number(txn.amount).toFixed(2)}`
      : `${Number(txn.amount).toFixed(2)} ${currencyStr}`;
    const categoryStr = escapeProposalCommentHtml(txn.category || 'Другое');
    const bucketStr = escapeProposalCommentHtml(txn.bucket || 'Wants');

    const typeStr = escapeProposalCommentHtml(txn.type || TRANSACTION_TYPES.EXPENSE);

    lines.push(`<b>Item ${i + 1}:</b>`);
    const itemText = `📅 <b>${dateStr}</b> | 💳 <i>${accountStr}</i> | ⚖️ <b>${typeStr}</b>\n` +
      `💸 <b>${merchant}</b> — ${amountStr}\n` +
      `🏷️ Category: <b>${categoryStr}</b> (<i>${bucketStr}</i>)`;
    lines.push(itemText);
    if (isDbsCreditCardPayment(txn)) {
      lines.push('💳 Transfer: DBS SGD −S$' + Math.abs(Number(txn.amount)).toFixed(2) +
        ' → DBS CC SGD +S$' + Math.abs(Number(txn.amount)).toFixed(2) + ' (two records)');
    }
    if (txn.currency && txn.currency !== 'SGD' && Number(txn.amount_sgd) > 0) {
      lines.push('💱 SGD equivalent: S$' + Number(txn.amount_sgd).toFixed(2));
    }
    if (txn.notes) lines.push('🗒️ ' + escapeProposalCommentHtml(txn.notes));
    const captureStatus = receiptCaptureProposalStatus(txn);
    if (captureStatus) lines.push(escapeProposalCommentHtml(captureStatus));
    const receiptDetails = formatReceiptItemDetailsHtml(txn, 3, Math.floor(1600 / transactions.length));
    if (receiptDetails) lines.push(receiptDetails);

    // Append diagnostic review reasons if flagged
    const reviewWarnings = formatReviewReasons(txn);
    if (reviewWarnings) {
      lines.push(reviewWarnings);
    }

    lines.push(''); // Blank line spacing between transactions
  }

  if (showActions) {
    const instruction = attachmentCount
      ? 'Tap <b>Add line items</b> to review the recorded purchase and attach its receipt items.' +
        (attachmentCount < transactions.length ? ' Then approve the remaining new transactions.' : '')
      : 'Tap <b>' + proposalApprovalLabel(transactions) + '</b> to save.';
    lines.push('Reply to this message with any changes. ' + instruction + ' Tap <b>Discard</b> to cancel.');
  }
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
    reasons.push(proposalNeedsReceiptAttachment(item)
      ? '🧾 <i>A matching payment is already recorded. Review it before adding line items.</i>'
      : '🔁 <i>Possible duplicate of an earlier charge today (will confirm on approve)</i>');
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
 * One save action: approve new purchases with their items, or attach to recorded purchases.
 * 
 * @param {string} token - Cache token for state tracking.
 * @return {Object} Telegram reply_markup inline_keyboard structure.
 */
function getMainProposalKeyboard(token, transactions) {
  const rows = transactions || [];
  const receiptButtons = rows.map((txn, index) => proposalNeedsReceiptAttachment(txn)
    ? [{ text: '🧾 Add line items' + (rows.length > 1 ? ' · item ' + (index + 1) : ''),
      callback_data: 'receipt_menu:' + token + ':' + index }]
    : null).filter(Boolean);
  const discard = { text: '🗑️ Discard', callback_data: `discard:${token}` };
  // Finish receipt-only attachments before approving a mixed proposal. Each
  // attachment removes just that item and refreshes the remaining actions.
  if (receiptButtons.length) return { inline_keyboard: receiptButtons.concat([[discard]]) };
  const approve = { text: '✅ ' + proposalApprovalLabel(rows), callback_data: `approve:${token}` };
  return { inline_keyboard: rows.some(proposalHasReceiptItems) ? [[approve], [discard]] : [[approve, discard]] };
}

function proposalHasReceiptItems(txn) {
  return Boolean(txn && txn.receipt_capture && Array.isArray(txn.receipt_capture.line_items) &&
    txn.receipt_capture.line_items.length);
}

function proposalNeedsReceiptAttachment(txn) {
  const flags = txn && txn.flags || [];
  return proposalHasReceiptItems(txn) && flags.includes('possible_duplicate') &&
    !flags.includes('force_add') && !flags.includes('skipped') &&
    // Old cached cards lack the explicit ledger/batch distinction. Their
    // attachment screen still validates every candidate before any write.
    txn.receipt_existing_purchase !== false;
}

function proposalApprovalLabel(transactions) {
  const rows = transactions || [];
  return (rows.length === 1 ? 'Approve' : 'Approve all') +
    (rows.some(proposalHasReceiptItems) ? ' and save receipt items' : '');
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
  const inlineKeyboard = getMainProposalKeyboard(token, transactions);
  
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

  const response = fetchTelegramUiApi(url, options, 3);
  const respJson = JSON.parse(response.getContentText());

  // Overlapping screenshots can leave the proposal unchanged. Other delivery
  // failures must reach the webhook error handler instead of looking successful.
  const unchanged = isUpdate && existingMsgId && respJson.error_code === 400 &&
    /message is not modified/i.test(String(respJson.description || ''));
  if (!respJson.ok && !unchanged) {
    throw new Error(`Telegram proposal delivery failed (${respJson.error_code || response.getResponseCode()}): ${respJson.description || 'Unknown error'}`);
  }

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
  const mainKeyboard = getMainProposalKeyboard(token, transactions);
  return editTelegramMessage(chatId, messageId, newText, mainKeyboard);
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

  const response = fetchTelegramUiApi(url, options, 3);
  const result = JSON.parse(response.getContentText());
  const unchanged = result.error_code === 400 && /message is not modified/i.test(String(result.description || ''));
  if (!result.ok && !unchanged) {
    throw new Error('Telegram proposal update failed: ' + (result.description || response.getResponseCode()));
  }
  return result;
}

/**
 * Safely updates a Telegram message to discarded status and explicitly wipes its inline keyboard.
 * 
 * @param {number|string} chatId - Target Telegram chat ID.
 * @param {number} messageId - Target Telegram message ID.
 * @param {string} [textMessage] - Optional custom discard text message.
 */
function sendDiscardedMessage(chatId, messageId, textMessage) {
  return editTelegramMessage(chatId, messageId, textMessage || '🗑️ Discarded by user.', null);
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

  const response = fetchTelegramUiApi(url, options, 3);
  return JSON.parse(response.getContentText());
}

function redactTelegramUiSecrets(value) {
  return String(value || '')
    .replace(/(https?:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/\s"']+/gi, '$1[REDACTED]')
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]')
    .replace(/([?&](?:key|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
}

function fetchTelegramUiApi(url, options, maxRetries = 3) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxRetries) || 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return UrlFetchApp.fetch(url, options);
    } catch (err) {
      const safeMsg = redactTelegramUiSecrets(err && err.message);
      lastError = new Error(safeMsg || 'Telegram API network request failed.');
      Logger.log(`Telegram UI fetch attempt ${attempt}/${attempts} failed: ${safeMsg}`);
      if (attempt < attempts && typeof Utilities !== 'undefined' && Utilities && typeof Utilities.sleep === 'function') {
        Utilities.sleep(attempt * 450);
      }
    }
  }
  throw lastError;
}

/**
 * Acknowledges a Telegram Callback Query to dismiss the button loading spinner.
 * Retries transient socket blips and fails open so spinner dismissal never surfaces a Bot Error
 * after an Approve, Discard, or Edit action has already completed.
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

  try {
    fetchTelegramUiApi(url, options, 2);
  } catch (err) {
    Logger.log('Non-fatal answerCallbackQuery error: ' + redactTelegramUiSecrets(err && err.message));
  }
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
                    "This purchase appears to already exist in your sheet:\n" +
                    "📅 <b>" + escapeProposalCommentHtml(item.date) + "</b> | 💳 <i>" + escapeProposalCommentHtml(item.account) + "</i>\n" +
                    "💸 <b>" + escapeProposalCommentHtml(item.where) + "</b> — S$" + Number(item.amount).toFixed(2) + "\n" +
                    "🏷️ Category: " + escapeProposalCommentHtml(item.category) + "\n\n" +
                    "Is this a legitimate separate purchase?";
                    
  var buttons = [
    [
      { text: "⚠️ Force Add This Item", callback_data: "resolve_dup:" + token + ":" + currentIndex + ":force" },
      { text: "❌ Skip This Item", callback_data: "resolve_dup:" + token + ":" + currentIndex + ":skip" }
    ],
    [{ text: "❌ Skip All Remaining Duplicates", callback_data: "resolve_dup:" + token + ":all:skip_all" }],
    [{ text: "🔙 Back to Review", callback_data: "back_to_main:" + token }]
  ];
  if (proposalHasReceiptItems(item)) {
    const canAttach = proposalNeedsReceiptAttachment(item);
    textMessage += '\n\n🧾 ' + item.receipt_capture.line_items.length +
      ' receipt items are available. ' + (canAttach
        ? 'Add them to the existing purchase without adding another payment, or skip this upload.'
        : 'Approving a new purchase also saves its receipt items. Skipping a duplicate copy skips its items.');
    const details = formatReceiptItemDetailsHtml(item, 3, 1000);
    if (details) textMessage += '\n\n' + details;
    if (canAttach) buttons.unshift([{ text: '🧾 Add line items', callback_data: 'receipt_menu:' + token + ':' + currentIndex }]);
  } else if (item.receipt_capture_warning) {
    textMessage += '\n\n⚠️ ' + escapeProposalCommentHtml(item.receipt_capture_warning);
  }
  
  return editTelegramMessage(chatId, messageId, textMessage, { inline_keyboard: buttons });
}

/** Review real recorded purchases before the explicit receipt-only save. */
function showReceiptAttachmentOptions(chatId, messageId, token, transactions, index, notice) {
  const txn = transactions[index];
  if (!txn || !txn.receipt_capture) throw new Error('No extracted receipt items are available. Upload the detailed receipt again.');
  let candidates = findReceiptAttachmentCandidates(txn);
  const lines = [notice || '<b>🧾 Add line items to an existing transaction</b>',
    txn.receipt_capture.line_items.length + ' receipt item' + (txn.receipt_capture.line_items.length === 1 ? '' : 's') +
      ' extracted from ' + escapeProposalCommentHtml(txn.receipt_capture.merchant) + '.',
    'Choose the recorded purchase below. Its amount, category and account will stay unchanged.'];
  const parentCounts = new Map();
  candidates.forEach(row => parentCounts.set(row.key, (parentCounts.get(row.key) || 0) + 1));
  if (candidates.some(row => parentCounts.get(row.key) > 1)) {
    lines.push('Identical duplicate payments are ambiguous and cannot receive receipt items until they are resolved.');
    candidates = candidates.filter(row => parentCounts.get(row.key) === 1);
  }
  if (candidates.length > 8) {
    candidates = candidates.filter(row => compactWhere(row.where) === compactWhere(txn.where));
    if (candidates.length > 8) candidates = [];
    lines.push('Many purchases match the date, account and amount. Showing matches for the current merchant; reply with a corrected merchant to narrow the choice if needed.');
  }
  txn.receipt_attachment_candidates = candidates;
  txn.receipt_attachment_revision = receiptAttachmentRevision(txn);
  txn.receipt_attachment_selection = Utilities.getUuid().slice(0, 8);
  savePendingTransactions(transactions, token);
  const buttons = candidates.map((row, candidateIndex) => {
    lines.push('\n' + (candidateIndex + 1) + '. ' + escapeProposalCommentHtml(row.date) + ' · ' +
      escapeProposalCommentHtml(row.account) + ' · <b>' + escapeProposalCommentHtml(row.where) +
      '</b> · S$' + row.amount_sgd.toFixed(2) + ' (transaction row ' + row.row + ')');
    return [{ text: 'Add line items' + (candidates.length > 1 ? ' to purchase ' + (candidateIndex + 1) : ''),
      callback_data: 'receipt_save:' + token + ':' + index + ':' + candidateIndex + ':' + txn.receipt_attachment_selection }];
  });
  if (!candidates.length) lines.push('\nNo unique choice is available. Reply with any corrections to the date, account, merchant or SGD amount, then try again. No items or transactions were saved.');
  const details = formatReceiptItemDetailsHtml(txn, 8, Math.max(0, 3600 - lines.join('\n').length));
  if (details) lines.splice(2, 0, details + '\n');
  if ((txn.flags || []).includes('possible_duplicate')) {
    buttons.push([{ text: 'Review as a separate purchase', callback_data: 'receipt_new:' + token + ':' + index }]);
  }
  buttons.push([{ text: '🔙 Back to review', callback_data: 'back_to_main:' + token }]);
  return editTelegramMessage(chatId, messageId, lines.join('\n'), { inline_keyboard: buttons });
}
