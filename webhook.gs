/**
 * Budget 2026 Automation v1 - Telegram Webhook Entry Point
 * File: webhook.gs
 * 
 * Main Web App doPost(e) endpoint handling incoming Telegram updates (§5.2, §5.3).
 */

/**
 * Main Web App HTTP POST entry point for Telegram webhook.
 * 
 * @param {Object} e - Event object containing postData and query parameters.
 * @return {GoogleAppsScript.HTML.HtmlOutput} Standard HTML output response.
 */
function doPost(e) {
  try {
    // 1. Security Check: Validate webhook secret parameter (§5.2)
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    if (expectedSecret) {
      const incomingSecret = e && e.parameter && e.parameter.secret;
      if (incomingSecret !== expectedSecret) {
        Logger.log('Unauthorized webhook access attempt.');
        return HtmlService.createHtmlOutput('Unauthorized');
      }
    }

    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput('OK');
    }

    // 2. Parse Telegram Update Payload
    const update = JSON.parse(e.postData.contents);
    const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');

    // 2a. Anti-Loop Guard: Prevent Telegram retry loop on long-running updates
    if (update && update.update_id) {
      const cache = CacheService.getScriptCache();
      const lockKey = `telegram_update_${update.update_id}`;
      if (cache.get(lockKey)) {
        Logger.log(`⏭️ Skipping duplicate Telegram update_id retry: ${update.update_id}`);
        return HtmlService.createHtmlOutput('OK');
      }
      cache.put(lockKey, '1', 600); // Lock for 10 minutes
    }

    // Automatically capture TELEGRAM_CHAT_ID for daily cron nudges (§6.5)
    let incomingChatId = null;
    if (update.message && update.message.chat) {
      incomingChatId = update.message.chat.id;
    } else if (update.callback_query && update.callback_query.message && update.callback_query.message.chat) {
      incomingChatId = update.callback_query.message.chat.id;
    }

    if (incomingChatId) {
      const props = PropertiesService.getScriptProperties();
      if (!props.getProperty('TELEGRAM_CHAT_ID')) {
        props.setProperty('TELEGRAM_CHAT_ID', String(incomingChatId));
        Logger.log('✅ New Telegram Chat ID locked in permanently: ' + incomingChatId);
      }
    }

    // 2b. Security Check: Validate Authorized Chat IDs allowlist (if configured)
    const authorizedIdsString = String(PropertiesService.getScriptProperties().getProperty('AUTHORIZED_CHAT_IDS') || '').trim();
    const strChatId = String(incomingChatId || '').trim();
    let isUserInConfig = false;
    if (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.USERS) {
      Object.values(SHEET_FACTS.USERS).forEach(user => {
        if (user && user.active && String(user.chat_id || '').trim() === strChatId) {
          isUserInConfig = true;
        }
      });
    }
    if (authorizedIdsString && !isUserInConfig) {
      const authorizedIds = authorizedIdsString.split(',').map(id => id.trim());
      if (!strChatId || authorizedIds.indexOf(strChatId) === -1) {
        Logger.log('🚨 Unauthorized access attempt from Chat ID: ' + strChatId);
        return HtmlService.createHtmlOutput('Unauthorized');
      }
    }

    // 3. Handle Callback Query (Button taps - Step 3)
    if (update.callback_query) {
      if (typeof handleCallbackQuery === 'function') {
        handleCallbackQuery(update.callback_query);
      }
      return HtmlService.createHtmlOutput('OK');
    }

    // 4. Handle Incoming Messages (Text, Photo, Voice - UC-1 §6.1)
    if (update.message) {
      const message = update.message;
      const chatId = message.chat.id;
      const inputs = [];

      // Handle Telegram Slash Commands (e.g. /mandatory)
      if (message.text) {
        const textTrimmed = message.text.trim();
        if (textTrimmed === '/mandatory' || textTrimmed.indexOf('/mandatory@') === 0) {
          if (typeof sendWeeklyMandatoryAudit === 'function') {
            sendWeeklyMandatoryAudit(chatId);
          }
          return HtmlService.createHtmlOutput('OK');
        }

        // --- INTERCEPT MERCHANT RENAME ---
        const cache = CacheService.getScriptCache();
        const awaitingMerchantData = cache.get('awaiting_merchant:' + chatId);
        if (awaitingMerchantData) {
          cache.remove('awaiting_merchant:' + chatId);
          try {
            const state = JSON.parse(awaitingMerchantData);
            const token = state.token;
            const index = state.index;
            const msgId = state.messageId;
            
            const transactions = typeof getPendingTransactions === 'function' ? getPendingTransactions(token) : null;
            if (transactions && transactions[index]) {
              const txn = transactions[index];
              const rawName = txn.raw_where || txn.where;
              const newName = textTrimmed;
              
              txn.where = newName;
              if (typeof saveMerchantAlias === 'function' && rawName) {
                saveMerchantAlias(rawName, newName, txn.category);
              }
              
              if (typeof enrichTransaction === 'function') {
                transactions[index] = enrichTransaction(txn);
              }

              if (typeof flagExistingDuplicates === 'function') {
                transactions = flagExistingDuplicates(transactions);
              }

              if (typeof savePendingTransactions === 'function') {
                savePendingTransactions(transactions, token);
              }
              
              if (typeof refreshProposalCard === 'function') {
                refreshProposalCard(chatId, msgId, token, transactions);
              }
              return HtmlService.createHtmlOutput('OK');
            }
          } catch (e) {
            Logger.log('Error processing merchant rename: ' + e.message);
          }
        }
        // --- END INTERCEPT ---

        inputs.push({ text: message.text });
      } else if (message.caption) {
        inputs.push({ text: message.caption });
      }

      let isDocumentInput = false;

      // Case B: Photo input (Receipt / Bank Screenshot)
      if (Array.isArray(message.photo) && message.photo.length > 0) {
        const largestPhoto = message.photo[message.photo.length - 1];
        const filePath = getTelegramFilePath(largestPhoto.file_id, botToken);
        const photoMediaObj = fetchTelegramFileAsBase64(filePath, botToken);
        inputs.push(photoMediaObj);
      }

      // Case C: Voice input (Voice Note)
      if (message.voice) {
        const filePath = getTelegramFilePath(message.voice.file_id, botToken);
        const voiceMediaObj = fetchTelegramFileAsBase64(filePath, botToken);
        inputs.push(voiceMediaObj);
      }

      // Case D: Document input (Bank Statement PDF / CSV)
      if (message.document) {
        const doc = message.document;
        const mimeType = String(doc.mime_type || '').toLowerCase();
        const fileName = String(doc.file_name || '').toLowerCase();

        const isPdf = mimeType.includes('pdf') || fileName.endsWith('.pdf');
        const isCsv = mimeType.includes('csv') || mimeType.includes('excel') || mimeType.includes('plain') || fileName.endsWith('.csv');

        if (isPdf || isCsv) {
          isDocumentInput = true;
          const targetMime = isPdf ? 'application/pdf' : 'text/csv';
          const filePath = getTelegramFilePath(doc.file_id, botToken);
          const docMediaObj = fetchTelegramFileAsBase64(filePath, botToken, targetMime);
          inputs.push(docMediaObj);
        } else {
          const warningUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
          fetchWithRetry(warningUrl, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({
              chat_id: chatId,
              text: "⚠️ Unsupported file format. Please send a PDF or CSV bank statement."
            }),
            muteHttpExceptions: true
          });
          return HtmlService.createHtmlOutput('OK');
        }
      }

      // === ALBUM GATHERING LOGIC ===
      // If part of an album, gather all inputs into one batch and only let the first webhook proceed.
      if (message.media_group_id && inputs.length > 0) {
        const albumLock = LockService.getScriptLock();
        let isFirst = false;
        try {
          albumLock.waitLock(10000);
          const cache = CacheService.getScriptCache();
          const cacheKey = 'album_' + message.media_group_id;
          let albumData = cache.get(cacheKey);
          let album = albumData ? JSON.parse(albumData) : [];
          
          isFirst = (album.length === 0);
          
          // Append current inputs
          inputs.forEach(inp => album.push(inp));
          cache.put(cacheKey, JSON.stringify(album), 300);
        } catch (e) {
          Logger.log("Album lock error: " + e.message);
        } finally {
          albumLock.releaseLock();
        }

        if (!isFirst) {
          // If not the first message in the album, simply return to avoid duplicative processing
          return HtmlService.createHtmlOutput('OK');
        } else {
          // If first, wait a few seconds for Telegram to deliver the rest of the album
          Utilities.sleep(4000);
          const cache = CacheService.getScriptCache();
          const finalAlbumData = cache.get('album_' + message.media_group_id);
          if (finalAlbumData) {
            inputs = JSON.parse(finalAlbumData);
          }
        }
      }
      // === END ALBUM GATHERING LOGIC ===

      // Process inputs through AI Extraction & Confirmation Pipeline
      if (inputs.length > 0) {
        const sequentialLock = LockService.getScriptLock();
        try {
          // Wait up to 30 seconds for the lock (enough time for prior images to finish)
          sequentialLock.waitLock(30000);

          const userProperties = PropertiesService.getUserProperties();
          const activeTokenKey = `latest_token_${chatId}`;
          const activeToken = userProperties.getProperty(activeTokenKey);

          let previousProposal = null;
          if (activeToken) {
            previousProposal = getPendingTransactions(activeToken);
            if (previousProposal === "PROCESSED") {
              previousProposal = null;
            }
          }

          const context = {
            defaultAccount: DEFAULT_ACCOUNT,
            previous_proposal: previousProposal
          };

          // Phase 2: AI Multimodal Extraction & Phase 1 Enrichment
          const enrichedTransactions = extractTransactions(inputs, context);

          let finalTransactionsToConfirm = enrichedTransactions;

          // Smart PDF Classification: Individual Receipt PDF vs. Bank Statement PDF
          if (isDocumentInput) {
            // Check if Gemini extracted multiple transactions (>1) indicating a multi-item Bank Statement
            const isBankStatement = enrichedTransactions.length > 1;

            if (isBankStatement) {
              // Bank Statement Matching Exercise: compare against existing ledger
              const missingTransactions = getMissingTransactions(enrichedTransactions);
              if (missingTransactions.length === 0) {
                sendTelegramMessage("📊 <b>Bank Statement Reconciled!</b> 100% of transactions in this statement are already logged in your sheet.", chatId);
                return HtmlService.createHtmlOutput('OK');
              }
              finalTransactionsToConfirm = missingTransactions;
            } else if (enrichedTransactions.length === 0) {
              sendTelegramMessage("ℹ️ No financial transactions detected in your PDF. Please ensure it is a valid receipt or bank statement.", chatId);
              return HtmlService.createHtmlOutput('OK');
            }
            // Note: Single-item PDF Receipts (length === 1) proceed directly to standard transaction proposal confirmation
          } else if (finalTransactionsToConfirm.length === 0) {
            sendTelegramMessage("ℹ️ No financial transactions detected in your input. Try sending a receipt photo, voice note, or text spend (e.g., 'lunch 12.50').", chatId);
            return HtmlService.createHtmlOutput('OK');
          }

          // Phase 3: Save state in CacheService (preserve activeToken if refining previous proposal)
          const tokenToSave = (previousProposal && previousProposal.length > 0) ? activeToken : null;
          const token = savePendingTransactions(finalTransactionsToConfirm, tokenToSave);
          userProperties.setProperty(activeTokenKey, token);

          if (typeof sendConfirmationMessage === 'function') {
            // Check if we are appending/updating an existing proposal
            const isUpdate = (previousProposal && previousProposal.length > 0 && activeToken);
            sendConfirmationMessage(chatId, token, finalTransactionsToConfirm, isUpdate);
          } else {
            Logger.log(`Confirmation message helper not yet attached. Token: ${token}`);
          }
        } catch (lockOrProcessErr) {
          Logger.log('Sequential processing error: ' + lockOrProcessErr.message);
        } finally {
          try { sequentialLock.releaseLock(); } catch (e) {}
        }
      }
    }
  } catch (err) {
    Logger.log(`Error processing webhook update: ${err.message}\nStack: ${err.stack}`);
    // Notify user in Telegram if chatId is known so errors are never silent
    try {
      if (e && e.postData && e.postData.contents) {
        const updateObj = JSON.parse(e.postData.contents);
        const errChatId = (updateObj.message && updateObj.message.chat && updateObj.message.chat.id) ||
                          (updateObj.callback_query && updateObj.callback_query.message && updateObj.callback_query.message.chat && updateObj.callback_query.message.chat.id);
        const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
        if (errChatId && botToken) {
          const errUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
          fetchWithRetry(errUrl, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({
              chat_id: errChatId,
              text: `⚠️ Bot Error: ${err.message}`
            }),
            muteHttpExceptions: true
          });
        }
      }
    } catch (notifyErr) {
      Logger.log('Failed to send error notification to Telegram: ' + notifyErr.message);
    }
  }

  // 5. Always return "OK" fast to acknowledge Telegram webhook delivery (§5.3)
  return HtmlService.createHtmlOutput('OK');
}

/**
 * Executes an HTTP fetch with automatic exponential backoff retry for network resilience.
 * 
 * @param {string} url - Target URL.
 * @param {Object} options - UrlFetchApp options.
 * @param {number} [maxRetries=3] - Maximum retry attempts.
 * @return {GoogleAppsScript.URL_Fetch.HTTPResponse} HTTP response object.
 */
function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      return response;
    } catch (err) {
      lastError = err;
      Logger.log(`Fetch attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        Utilities.sleep(attempt * 600); // 600ms, 1200ms backoff
      }
    }
  }
  throw lastError;
}

/**
 * Resolves a Telegram file_id into a downloadable file_path using Telegram API with retry resilience.
 * 
 * @param {string} fileId - Telegram file identifier.
 * @param {string} [botToken] - Optional Telegram Bot Token.
 * @return {string} Relative file path (e.g. 'photos/file_0.jpg').
 */
function getTelegramFilePath(fileId, botToken) {
  const token = botToken || PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing in Script Properties.');
  }

  const url = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
  const response = fetchWithRetry(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error(`Telegram getFile failed (${response.getResponseCode()}): ${response.getContentText()}`);
  }

  const json = JSON.parse(response.getContentText());
  if (!json.ok || !json.result || !json.result.file_path) {
    throw new Error(`Invalid Telegram getFile response: ${response.getContentText()}`);
  }

  return json.result.file_path;
}
