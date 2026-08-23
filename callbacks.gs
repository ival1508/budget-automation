/**
 * Budget 2026 Automation v1 - Telegram Callback Handlers & Interactive Editor Router
 * File: callbacks.gs
 * 
 * Handles inline keyboard button taps (Approve All, Edit Menu, Pick Category, Pick Account, Remove Item, Discard)
 * and updates Merchant Memory (§5.1, §5.2, §6.4).
 */

/**
 * Handles incoming Telegram Callback Queries from inline keyboard buttons.
 * 
 * @param {Object} callbackQuery - Telegram callback_query object from update.
 */
function handleCallbackQuery(callbackQuery) {
  if (!callbackQuery || !callbackQuery.data) return;

  const queryId = callbackQuery.id;
  const dataParts = callbackQuery.data.split(':');
  const action = dataParts[0];
  const token = dataParts[1];

  const message = callbackQuery.message;
  if (!message || !message.chat) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;

  Logger.log(`Handling Callback Query - Action: "${action}", Token: "${token}", Chat: ${chatId}`);

  // 1. ACTION: DISCARD
  if (action === 'discard') {
    clearPendingTransactions(token);
    sendDiscardedMessage(chatId, messageId, '🗑️ Discarded by user.');
    answerCallbackQuery(queryId, 'Discarded');
    return;
  }

  // 1b. ACTION: NOTHING TODAY (Zero-spend day nudge response §6.5)
  if (action === 'nothing_today') {
    answerCallbackQuery(queryId, 'Zero spend confirmed!');
    const recapHtml = typeof generateDailyTransactionsRecap === 'function'
      ? generateDailyTransactionsRecap()
      : '🌙 <b>Daily Recap</b>\n\n😴 <b>Zero Spend Day!</b> No spend logged for today.';
    editTelegramMessage(chatId, messageId, recapHtml, null);
    return;
  }

  // 2. Retrieve pending transactions for all other actions
  let transactions = getPendingTransactions(token);
  
  // Handle double-taps or webhook retries gracefully
  if (transactions === "PROCESSED") {
    answerCallbackQuery(queryId, 'Already processed!', false);
    return;
  }

  if (!transactions || transactions.length === 0) {
    answerCallbackQuery(queryId, 'Session expired. Please resend.', true);
    sendDiscardedMessage(
      chatId,
      messageId,
      '⚠️ <i>Session expired or already processed. Please resend your transaction.</i>'
    );
    return;
  }

  // 3. ACTION: APPROVE ALL
  if (action === 'approve') {
    // Re-evaluate duplicates against sheet on latest transaction state
    if (typeof flagExistingDuplicates === 'function') {
      transactions = flagExistingDuplicates(transactions);
      savePendingTransactions(transactions, token);
    }

    // THE INTERCEPT: Check if any item is an unresolved duplicate
    const nextIndex = findNextUnresolvedDuplicate(transactions);

    // If an unresolved duplicate is found, launch the sequential wizard for that item!
    if (nextIndex !== -1) {
      sendDuplicateWizardMessage(chatId, messageId, token, transactions, nextIndex);
      answerCallbackQuery(queryId, 'Duplicate detected');
      return;
    }

    // Otherwise, proceed with normal clean write
    const result = appendTransactions(transactions);

    try {
      updateMerchantLearningStore(transactions);
    } catch (e) {
      Logger.log(`Warning: Failed to update merchant learning store: ${e.message}`);
    }

    answerCallbackQuery(queryId, `Saved ${result.writtenCount} row(s) to Sheet! ✅`);

    const summaryHeader = `<b>✅ Logged to Sheet!</b> (${result.writtenCount} added${result.skippedCount > 0 ? `, ${result.skippedCount} duplicate skipped` : ''})\n\n`;
    const updatedBody = formatTransactionConfirmationHtml(transactions);
    const finalMessage = summaryHeader + updatedBody.replace('Tap <b>Approve All</b> to log into Budget 2026, <b>Edit</b> to modify, or <b>Discard</b> to cancel.', '');

    editTelegramMessage(chatId, messageId, finalMessage, null);
    clearPendingTransactions(token);
    return;
  }

  // 4. ACTION: EDIT MENU (Lists items to pick for editing)
  if (action === 'edit_menu') {
    answerCallbackQuery(queryId);
    if (transactions.length === 1) {
      // 1-item shortcut: Skip item list menu and go straight to item 0 actions
      sendItemActionKeyboard(chatId, messageId, token, 0, transactions[0], 1);
    } else {
      sendEditMenuKeyboard(chatId, messageId, token, transactions);
    }
    return;
  }

  // 5. ACTION: BACK TO MAIN PROPOSAL
  if (action === 'back_to_main') {
    answerCallbackQuery(queryId);
    refreshProposalCard(chatId, messageId, token, transactions);
    return;
  }

  // Parse item index for item-level actions
  const itemIndex = parseInt(dataParts[2], 10);

  // 6. ACTION: EDIT ITEM ACTIONS (Category, Account, Type, Remove, Back)
  if (action === 'edit_item') {
    answerCallbackQuery(queryId);
    if (!isNaN(itemIndex) && transactions[itemIndex]) {
      sendItemActionKeyboard(chatId, messageId, token, itemIndex, transactions[itemIndex], transactions.length);
    }
    return;
  }

  // 7. ACTION: DROP ITEM (Remove single item from proposal)
  if (action === 'drop_item') {
    if (!isNaN(itemIndex) && itemIndex >= 0 && itemIndex < transactions.length) {
      transactions.splice(itemIndex, 1);
      
      // If that was the last item, treat it as a full discard
      if (transactions.length === 0) {
        clearPendingTransactions(token);
        sendDiscardedMessage(chatId, messageId, '🗑️ All items removed. Discarded.');
        answerCallbackQuery(queryId, 'All items removed');
        return;
      }
      
      // Otherwise, save the remaining items and refresh the menu
      savePendingTransactions(transactions, token);
      refreshProposalCard(chatId, messageId, token, transactions);
      answerCallbackQuery(queryId, 'Item removed');
    }
    return;
  }

  // 7.1. ACTION: PICK MERCHANT (Rename Merchant)
  if (action === 'pick_merch') {
    answerCallbackQuery(queryId);
    if (!isNaN(itemIndex)) {
      const cache = CacheService.getScriptCache();
      cache.put('awaiting_merchant:' + chatId, JSON.stringify({ token: token, index: itemIndex, messageId: messageId }), 300); // 5 mins
      sendTelegramMessage('Please type the new Merchant display name for this transaction:', chatId);
    }
    return;
  }

  // 8. ACTION: PICK CATEGORY MENU
  if (action === 'pick_cat') {
    answerCallbackQuery(queryId);
    if (!isNaN(itemIndex)) {
      sendCategoryPickerKeyboard(chatId, messageId, token, itemIndex);
    }
    return;
  }

  // 9. ACTION: SET CATEGORY (Index-based lookup to fit Telegram 64-byte payload limit)
  if (action === 'set_cat') {
    const catIndex = parseInt(dataParts[3], 10);
    const categories = typeof CATEGORIES !== 'undefined' ? CATEGORIES : [];
    const selectedCategory = categories[catIndex];

    if (!isNaN(itemIndex) && transactions[itemIndex] && selectedCategory) {
      transactions[itemIndex].category = selectedCategory;
      
      // Record user's category preference for this merchant
      if (typeof saveMerchantAlias === 'function' && transactions[itemIndex].where) {
        saveMerchantAlias(
          transactions[itemIndex].raw_where || transactions[itemIndex].where,
          transactions[itemIndex].where,
          selectedCategory
        );
      }

      // Re-enrich transaction to update 50/30/20 bucket and dedupe key
      transactions[itemIndex] = enrichTransaction(transactions[itemIndex]);
      
      if (typeof flagExistingDuplicates === 'function') {
        transactions = flagExistingDuplicates(transactions);
      }
      
      savePendingTransactions(transactions, token);
      answerCallbackQuery(queryId, `Category -> ${selectedCategory}`);
      refreshProposalCard(chatId, messageId, token, transactions);
    }
    return;
  }

  // 10. ACTION: PICK ACCOUNT MENU
  if (action === 'pick_acc') {
    answerCallbackQuery(queryId);
    if (!isNaN(itemIndex)) {
      sendAccountPickerKeyboard(chatId, messageId, token, itemIndex);
    }
    return;
  }

  // 11. ACTION: SET ACCOUNT
  if (action === 'set_acc') {
    const rawEncodedAcc = dataParts[3];
    const newAccount = decodeURIComponent(rawEncodedAcc || '');

    if (!isNaN(itemIndex) && transactions[itemIndex] && newAccount) {
      transactions[itemIndex].account = newAccount;
      // Re-enrich transaction to update dedupe key
      transactions[itemIndex] = enrichTransaction(transactions[itemIndex]);
      
      if (typeof flagExistingDuplicates === 'function') {
        transactions = flagExistingDuplicates(transactions);
      }
      
      savePendingTransactions(transactions, token);
      answerCallbackQuery(queryId, `Account -> ${newAccount}`);
      refreshProposalCard(chatId, messageId, token, transactions);
    }
    return;
  }

  // 12. ACTION: PICK TYPE MENU
  if (action === 'pick_type') {
    answerCallbackQuery(queryId);
    if (!isNaN(itemIndex)) {
      sendTypePickerKeyboard(chatId, messageId, token, itemIndex);
    }
    return;
  }

  // 13. ACTION: SET TYPE (Index-based lookup to fit Telegram 64-byte payload limit)
  if (action === 'set_type') {
    const typeIndex = parseInt(dataParts[3], 10);
    const types = typeof ALL_TYPES !== 'undefined' ? ALL_TYPES : Object.values(TRANSACTION_TYPES);
    const selectedType = types[typeIndex];

    if (!isNaN(itemIndex) && transactions[itemIndex] && selectedType) {
      transactions[itemIndex].type = selectedType;
      // Re-enrich transaction to apply fixed expense guardrails and update dedupe key
      transactions[itemIndex] = enrichTransaction(transactions[itemIndex]);

      if (typeof flagExistingDuplicates === 'function') {
        transactions = flagExistingDuplicates(transactions);
      }

      savePendingTransactions(transactions, token);
      
      if (transactions[itemIndex].type !== selectedType) {
        answerCallbackQuery(queryId, '⚠️ Cannot set Mandatory Expense. Change the category to a fixed expense (e.g., Rent, Auto) first.', true);
      } else {
        answerCallbackQuery(queryId, 'Type updated');
      }
      
      savePendingTransactions(transactions, token);
      refreshProposalCard(chatId, messageId, token, transactions);
    }
    return;
  }

  // 14. ACTION: FORCE ADD (Override duplicate detection §6.7)
  if (action === 'force_add') {
    if (!isNaN(itemIndex) && transactions[itemIndex]) {
      const item = transactions[itemIndex];
      item.flags = (item.flags || []).filter(f => f !== 'possible_duplicate');
      if (item.flags.indexOf('force_add') === -1) {
        item.flags.push('force_add');
      }

      // Re-evaluate needs_review: clear if no other flags or low confidence exist
      const hasOtherFlags = item.flags.some(f => f !== 'force_add');
      const hasLowConf = item.confidence && (item.confidence.category < 0.8 || item.confidence.amount < 0.9);
      const isForeign = item.currency && item.currency !== 'SGD';

      if (!hasOtherFlags && !hasLowConf && !isForeign) {
        item.needs_review = false;
      }

      savePendingTransactions(transactions, token);
      answerCallbackQuery(queryId, 'Force add enabled');
      refreshProposalCard(chatId, messageId, token, transactions);
    }
    return;
  }

  // 15. ACTION: UNDO FORCE ADD (§6.7)
  if (action === 'undo_force') {
    if (!isNaN(itemIndex) && transactions[itemIndex]) {
      const item = transactions[itemIndex];
      item.flags = (item.flags || []).filter(f => f !== 'force_add');
      if (item.flags.indexOf('possible_duplicate') === -1) {
        item.flags.push('possible_duplicate');
      }
      item.needs_review = true;

      savePendingTransactions(transactions, token);
      answerCallbackQuery(queryId, 'Undo force add applied');
      refreshProposalCard(chatId, messageId, token, transactions);
    }
    return;
  }

  // 16. ACTION: FORCE ALL (Intercept option: Force add all duplicates in batch)
  if (action === 'force_all') {
    if (transactions) {
      // Add 'force_add' flag to all items so writer.gs allows them through
      for (let j = 0; j < transactions.length; j++) {
        transactions[j].flags = transactions[j].flags || [];
        if (transactions[j].flags.indexOf('force_add') === -1) {
          transactions[j].flags.push('force_add');
        }
      }
      appendTransactions(transactions);
      
      // Update learning store for all items
      try {
        updateMerchantLearningStore(transactions);
      } catch (e) {
        Logger.log(`Warning: Failed to update merchant learning store: ${e.message}`);
      }
      
      sendDiscardedMessage(chatId, messageId, '✅ <b>Logged to Sheet!</b> (Includes forced duplicates)');
      clearPendingTransactions(token);
    }
    answerCallbackQuery(queryId, 'Forced all items');
    return;
  }

  // 17. ACTION: SKIP DUPS (Intercept option: Skip duplicates and write clean non-duplicates)
  if (action === 'skip_dups') {
    if (transactions) {
      // Filter ONLY clean items that are NOT duplicates (or were already forced)
      const cleanToLog = [];
      let skippedCount = 0;
      for (let k = 0; k < transactions.length; k++) {
        const f = transactions[k].flags || [];
        if (f.indexOf('possible_duplicate') !== -1 && f.indexOf('force_add') === -1) {
          skippedCount++;
        } else {
          cleanToLog.push(transactions[k]);
        }
      }
      
      if (cleanToLog.length > 0) {
        appendTransactions(cleanToLog);
        try {
          updateMerchantLearningStore(cleanToLog);
        } catch (e) {
          Logger.log(`Warning: Failed to update merchant learning store: ${e.message}`);
        }
        sendDiscardedMessage(chatId, messageId, `✅ <b>Logged clean items!</b> (${skippedCount} duplicate(s) skipped)`);
      } else {
        sendDiscardedMessage(chatId, messageId, '🗑️ All items were duplicates and skipped. Nothing logged.');
      }
      clearPendingTransactions(token);
    }
    answerCallbackQuery(queryId, 'Skipped duplicates');
    return;
  }

  // 18. ACTION: RESOLVE DUP (Sequential Duplicate Resolution Wizard Step §6.7)
  if (action === 'resolve_dup') {
    if (!transactions) return;
    
    const targetIndex = dataParts[2]; // Can be an index number or "all"
    const decision = dataParts[3];    // "force", "skip", or "skip_all"
    
    if (decision === 'skip_all') {
      // Mark all remaining unresolved duplicates as skipped
      for (let j = 0; j < transactions.length; j++) {
        const f = transactions[j].flags || [];
        if (f.indexOf('possible_duplicate') !== -1 && f.indexOf('force_add') === -1) {
          if (f.indexOf('skipped') === -1) f.push('skipped');
        }
      }
    } else {
      const idx = parseInt(targetIndex, 10);
      if (!isNaN(idx) && transactions[idx]) {
        transactions[idx].flags = transactions[idx].flags || [];
        if (decision === 'force') {
          transactions[idx].flags.push('force_add');
        } else if (decision === 'skip') {
          transactions[idx].flags.push('skipped');
        }
      }
    }
    
    // Save state after this step
    savePendingTransactions(transactions, token);
    
    // Check if there are any MORE unresolved duplicates in the queue
    const nextUnresolved = findNextUnresolvedDuplicate(transactions);
    
    if (nextUnresolved !== -1) {
      // Advance the wizard to the next duplicate!
      sendDuplicateWizardMessage(chatId, messageId, token, transactions, nextUnresolved);
      answerCallbackQuery(queryId, 'Saved. Next item...');
      return;
    }
    
    // If nextUnresolved === -1, ALL duplicates have been decided! Commit to sheet now.
    const cleanToLog = [];
    let skippedCount = 0;
    for (let k = 0; k < transactions.length; k++) {
      const flags = transactions[k].flags || [];
      if (flags.indexOf('skipped') !== -1) {
        skippedCount++;
      } else {
        cleanToLog.push(transactions[k]);
      }
    }
    
    if (cleanToLog.length > 0) {
      appendTransactions(cleanToLog);
      
      // Update learning store for approved items
      try {
        updateMerchantLearningStore(cleanToLog);
      } catch (e) {
        Logger.log(`Warning: Failed to update merchant learning store: ${e.message}`);
      }
      
      const msg = `✅ <b>Logged to Sheet!</b> (${cleanToLog.length} added${skippedCount > 0 ? `, ${skippedCount} duplicate skipped` : ''})`;
      sendDiscardedMessage(chatId, messageId, msg);
    } else {
      sendDiscardedMessage(chatId, messageId, '🗑️ All items were skipped as duplicates. Nothing logged.');
    }
    
    clearPendingTransactions(token);
    answerCallbackQuery(queryId, 'All resolved and logged!');
    return;
  }

  answerCallbackQuery(queryId, 'Unknown action');
}

/**
 * Updates an existing transaction cache entry in CacheService.
 * 
 * @param {string} token - Session token.
 * @param {Array<Object>} transactions - Updated transactions array.
 */
function updateCachedTransactions(token, transactions) {
  const cache = CacheService.getScriptCache();
  cache.put(token, JSON.stringify(transactions), 21600); // 6 hours
}

/**
 * Updates the 'Merchants' learning store sheet (§5.2) with confirmed merchant->category associations and naming aliases.
 * 
 * @param {Array<Object>} transactions - Array of confirmed enriched transaction objects.
 */
function updateMerchantLearningStore(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) return;

  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    const cleanWhere = (txn.where || '').trim();
    if (!cleanWhere) continue;

    const rawWhere = (txn.raw_where || txn.raw_snippet || '').trim();
    const category = txn.category || 'Другое';

    if (typeof saveMerchantAlias === 'function') {
      saveMerchantAlias(rawWhere || cleanWhere, cleanWhere, category);
    }
  }
}

/**
 * Finds the index of the next unresolved duplicate transaction in a batch (§6.7).
 * An item is an unresolved duplicate if flagged as possible_duplicate, 
 * but hasn't been marked as force_add OR skipped yet.
 * 
 * @param {Array<Object>} transactions - Array of pending transactions.
 * @return {number} Index of next unresolved duplicate or -1 if all resolved.
 */
function findNextUnresolvedDuplicate(transactions) {
  if (!Array.isArray(transactions)) return -1;
  for (var i = 0; i < transactions.length; i++) {
    var flags = transactions[i].flags || [];
    if (flags.indexOf("possible_duplicate") !== -1 && 
        flags.indexOf("force_add") === -1 && 
        flags.indexOf("skipped") === -1) {
      return i;
    }
  }
  return -1; // No unresolved duplicates remaining!
}
