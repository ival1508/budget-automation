/**
 * Budget 2026 Automation v1 - Telegram Webhook Entry Point
 * File: webhook.gs
 * 
 * Main Web App doPost(e) endpoint handling incoming Telegram updates (§5.2, §5.3).
 */

/**
 * Web App HTTP GET entry point.
 * 
 * @param {Object} e - Event object containing query parameters.
 * @return {GoogleAppsScript.Content.TextOutput} JSON response.
 */
function doGet(e) {
  // Health check only. Run diagnostics/tests from the Apps Script editor;
  // this web app is publicly accessible and executes with the owner's access.
  return ContentService.createTextOutput(JSON.stringify({ status: 'OK', message: 'Ready' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Both configured user membership and the explicit allowlist are required. */
function getWebhookAccessPolicy(optProps) {
  const props = optProps || PropertiesService.getScriptProperties();
  const secret = props.getProperty('WEBHOOK_SECRET');
  if (typeof secret !== 'string' || !secret.trim()) throw new Error('WEBHOOK_SECRET is required.');
  const rawIds = String(props.getProperty('AUTHORIZED_CHAT_IDS') || '').trim();
  const ids = rawIds.split(',').map(id => id.trim()).filter(Boolean);
  if (!ids.length || ids.some(id => !/^-?[1-9]\d*$/.test(id))) {
    throw new Error('AUTHORIZED_CHAT_IDS must contain valid Telegram chat IDs.');
  }
  const allowed = new Set(ids);
  const chatIds = new Set(getActiveTelegramUsers().map(user => user.chat_id).filter(id => allowed.has(id)));
  if (!chatIds.size) throw new Error('At least one active configured user must appear in AUTHORIZED_CHAT_IDS.');
  return { secret: secret, chatIds: chatIds };
}

function getWebhookChatId(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  // A Telegram update carries one event. Reject conflicting event identities.
  if (update.message && update.callback_query) return null;
  const message = update.message || (update.callback_query && update.callback_query.message);
  const id = message && message.chat && message.chat.id;
  if (typeof id === 'number' && !Number.isSafeInteger(id)) return null;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  return /^-?[1-9]\d*$/.test(String(id)) ? String(id) : null;
}

/**
 * Main Web App HTTP POST entry point for Telegram webhook.
 * 
 * @param {Object} e - Event object containing postData and query parameters.
 * @return {GoogleAppsScript.HTML.HtmlOutput} Standard HTML output response.
 */
function doPost(e) {
  const requestStarted = Date.now();
  let authorizedChatId = null;
  try {
    // 1. Security Check: Validate webhook secret parameter (§5.2)
    const props = PropertiesService.getScriptProperties();
    const policy = getWebhookAccessPolicy(props);
    const incomingSecret = e && e.parameter && e.parameter.secret;
    if (incomingSecret !== policy.secret) {
      Logger.log('Unauthorized webhook access attempt.');
      return HtmlService.createHtmlOutput('Unauthorized');
    }

    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput('OK');
    }

    // 2. Parse Telegram Update Payload
    const update = JSON.parse(e.postData.contents);
    const incomingChatId = getWebhookChatId(update);
    if (!incomingChatId || !policy.chatIds.has(incomingChatId)) {
      Logger.log('Unauthorized Telegram chat or unsupported update.');
      return HtmlService.createHtmlOutput('Unauthorized');
    }
    authorizedChatId = incomingChatId;
    const botToken = props.getProperty('TELEGRAM_BOT_TOKEN');

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

    // Retain the legacy fallback only after authorization; broadcasts use USERS.
    if (!props.getProperty('TELEGRAM_CHAT_ID')) {
      props.setProperty('TELEGRAM_CHAT_ID', authorizedChatId);
      Logger.log('✅ Authorized Telegram Chat ID captured: ' + authorizedChatId);
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
            
            let transactions = typeof getPendingTransactions === 'function' ? getPendingTransactions(token) : null;
            if (Array.isArray(transactions) && transactions[index] &&
                state.transactionSnapshot === JSON.stringify(transactions[index])) {
              const txn = transactions[index];
              const newName = textTrimmed;
              
              txn.where = newName;
              txn.manual_merchant_category = true;
              
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
            sendTelegramMessage('The selected transaction changed or expired. Please select Rename Merchant again.', chatId);
          } catch (e) {
            Logger.log('Error processing merchant rename: ' + e.message);
            sendTelegramMessage('Could not complete the rename. Please reopen the proposal and try again.', chatId);
          }
          // Never reinterpret a rename reply as a new transaction or an AI batch edit.
          return HtmlService.createHtmlOutput('OK');
        }
        // --- END INTERCEPT ---

        inputs.push({ text: message.text });
      } else if (message.caption) {
        inputs.push({ text: message.caption });
      }

      // Case B: Photo input (Receipt / Bank Screenshot)
      if (Array.isArray(message.photo) && message.photo.length > 0) {
        const downloadStarted = Date.now();
        const largestPhoto = message.photo[message.photo.length - 1];
        const filePath = getTelegramFilePath(largestPhoto.file_id, botToken);
        const photoMediaObj = fetchTelegramFileAsBase64(filePath, botToken);
        inputs.push(photoMediaObj);
        logProposalTiming('photo_download', downloadStarted);
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
          const targetMime = isPdf ? 'application/pdf' : 'text/csv';
          const filePath = getTelegramFilePath(doc.file_id, botToken);
          const docMediaObj = fetchTelegramFileAsBase64(filePath, botToken, targetMime);
          const blob = Utilities.newBlob(Utilities.base64Decode(docMediaObj.inlineData.data), targetMime, doc.file_name || (isPdf ? 'statement.pdf' : 'statement.csv'));
          enqueueStatementFile(blob, doc.file_unique_id || doc.file_id);
          sendTelegramMessage('📥 Statement queued in the Drive inbox. Use 💰 Budget → Reconcile statements from Drive, or wait for the automatic scan; review the results in _Reconcile.', chatId);
          return HtmlService.createHtmlOutput('OK');
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

      // Telegram delivers one update per album photo. Process every update;
      // neither cache image bytes nor guess when an album has finished arriving.
      // Plain photos merge under the proposal lock below, even if they finish late.

      // Process inputs through AI Extraction & Confirmation Pipeline
      if (inputs.length > 0) {
        // Plain photos are independent extraction jobs. Merge with the latest state
        // after extraction, so model latency never holds up other photo requests.
        const independentPhoto = Boolean(message.photo && !message.caption && !message.text && !message.voice &&
          !inputs.some(input => typeof input === 'string' || (input && input.text)));
        let photoTransactions = null;
        if (independentPhoto) {
          const extractionStarted = Date.now();
          photoTransactions = extractTransactions(inputs, { defaultAccount: DEFAULT_ACCOUNT });
          logProposalTiming('photo_extraction', extractionStarted);
        }
        // Proposal state uses the user lock; statement scans / ledger writes keep
        // the separate script lock. The web app executes as the owning user.
        const sequentialLock = LockService.getUserLock();
        try {
          const lockStarted = Date.now();
          sequentialLock.waitLock(30000);
          logProposalTiming('proposal_lock_wait', lockStarted);

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
          const enrichedTransactions = independentPhoto ? photoTransactions : extractTransactions(inputs, context);

          const finalTransactionsToConfirm = independentPhoto
            ? mergeScreenshotProposals(previousProposal || [], enrichedTransactions)
            : enrichedTransactions;

          if (finalTransactionsToConfirm.length === 0) {
            sendTelegramMessage("ℹ️ No financial transactions detected in your input. Try sending a receipt photo, voice note, or text spend (e.g., 'lunch 12.50').", chatId);
            return HtmlService.createHtmlOutput('OK');
          }

          // Phase 3: Save state in CacheService (preserve activeToken if refining previous proposal)
          const tokenToSave = (previousProposal && previousProposal.length > 0) ? activeToken : null;
          const token = savePendingTransactions(finalTransactionsToConfirm, tokenToSave);
          userProperties.setProperty(activeTokenKey, token);
          if (message.media_group_id) {
            Logger.log(`[Album photo] group=${message.media_group_id}; message=${message.message_id}; extracted=${enrichedTransactions.length}; proposal_rows=${finalTransactionsToConfirm.length}`);
          }

          if (typeof sendConfirmationMessage === 'function') {
            // Check if we are appending/updating an existing proposal
            const isUpdate = (previousProposal && previousProposal.length > 0 && activeToken);
            const confirmationStarted = Date.now();
            sendConfirmationMessage(chatId, token, finalTransactionsToConfirm, isUpdate);
            logProposalTiming('confirmation_delivery', confirmationStarted);
            logProposalTiming('proposal_total', requestStarted);
          } else {
            Logger.log(`Confirmation message helper not yet attached. Token: ${token}`);
          }
        } catch (lockOrProcessErr) {
          Logger.log('Sequential processing error: ' + lockOrProcessErr.message);
          throw lockOrProcessErr;
        } finally {
          try { sequentialLock.releaseLock(); } catch (e) {}
        }
      }
    }
  } catch (err) {
    Logger.log(`Error processing webhook update: ${err.message}\nStack: ${err.stack}`);
    // Authentication/config/parse failures must never notify a body-supplied chat.
    if (!authorizedChatId) return HtmlService.createHtmlOutput('Unauthorized');
    // Processing errors can notify only the identity that already passed both gates.
    try {
      const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
      if (botToken) {
        const errUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        fetchWithRetry(errUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({
            chat_id: authorizedChatId,
            text: `⚠️ Bot Error: ${err.message}`
          }),
          muteHttpExceptions: true
        });
      }
    } catch (notifyErr) {
      Logger.log('Failed to send error notification to Telegram: ' + notifyErr.message);
    }
  }

  // 5. Always return "OK" fast to acknowledge Telegram webhook delivery (§5.3)
  return HtmlService.createHtmlOutput('OK');
}

/** Log timing only, never screenshot content, transaction details or credentials. */
function logProposalTiming(phase, started) {
  Logger.log(`[Proposal timing] ${phase}: ${Date.now() - started}ms`);
}

/** Preserve reviewed fields and occurrence counts when screenshots overlap. */
function mergeScreenshotProposals(previous, incoming) {
  const key = txn => JSON.stringify([normalizeDateString(txn.date), String(txn.account || '').trim(),
    String(txn.currency || 'SGD').toUpperCase(), Number(txn.amount).toFixed(2),
    normaliseWhere(txn.where || ''), String(txn.type || ''), String(txn.card_last4 || txn.cardholder || ''),
    (txn.flags || []).includes('papa_charge') || /grandparents/i.test(String(txn.notes || ''))]);
  const remaining = new Map();
  previous.forEach(txn => { const id = key(txn); remaining.set(id, (remaining.get(id) || 0) + 1); });
  const merged = previous.slice();
  incoming.forEach(txn => {
    const id = key(txn), count = remaining.get(id) || 0;
    if (count) remaining.set(id, count - 1);
    else merged.push(txn);
  });
  return merged;
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
