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
  let uploadProgress = null;
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

    const incomingDoc = update.message && update.message.document;
    const incomingDocMime = incomingDoc ? String(incomingDoc.mime_type || '').toLowerCase() : '';
    const incomingDocName = incomingDoc ? String(incomingDoc.file_name || '').toLowerCase() : '';
    const isIncomingImageUpload = Boolean(update.message && (
      (Array.isArray(update.message.photo) && update.message.photo.length > 0) ||
      (incomingDoc && !incomingDocMime.includes('pdf') && !incomingDocName.endsWith('.pdf') &&
       !incomingDocMime.includes('csv') && !incomingDocName.endsWith('.csv') && incomingDocMime.startsWith('image/'))
    ));
    if (!isIncomingImageUpload) {
      dismissIdlePhotoBatchProgress(authorizedChatId);
    }

    // 3. Handle Callback Query (Button taps - Step 3)
    if (update.callback_query) {
      if (typeof handleCallbackQuery === 'function') {
        try {
          withTelegramProposalLock(() => handleCallbackQuery(update.callback_query));
        } catch (cbErr) {
          if (/Lock timeout/i.test(String(cbErr && cbErr.message || ''))) {
            Logger.log('Callback query deferred due to proposal lock contention: ' + cbErr.message);
            if (typeof answerCallbackQuery === 'function') {
              try {
                answerCallbackQuery(update.callback_query.id,
                  '⏳ Still updating the proposal — please tap again in a moment.', true);
              } catch (_) {}
            }
            return HtmlService.createHtmlOutput('OK');
          }
          throw cbErr;
        }
      }
      return HtmlService.createHtmlOutput('OK');
    }

    // 4. Handle Incoming Messages (Text, Photo, Voice - UC-1 §6.1)
    if (update.message) {
      const message = update.message;
      const chatId = message.chat.id;
      const inputs = [];
      let pdfDocumentType = null;

      // Handle Telegram Slash Commands, Merchant Rename, and Proposal Comment Edits first
      if (message.text) {
        const textTrimmed = message.text.trim();
        // Explicit edit commands take precedence over a pending merchant rename.
        if (/^\/(?:edit|cancel)(?:@\w+)?(?:\s|$)/i.test(textTrimmed) &&
            handleTelegramProposalComment(message)) {
          return HtmlService.createHtmlOutput('OK');
        }
        if (textTrimmed === '/mandatory' || textTrimmed.indexOf('/mandatory@') === 0) {
          if (typeof sendWeeklyMandatoryAudit === 'function') {
            sendWeeklyMandatoryAudit(chatId);
          }
          return HtmlService.createHtmlOutput('OK');
        }
        const itemsCommand = /^\/items(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(textTrimmed);
        if (itemsCommand) {
          const argument = (itemsCommand[1] || '').trim();
          if (argument.toLowerCase() === 'status') {
            sendTelegramMessage(previewReceiptCapture(undefined, chatId).message, chatId);
          } else {
            const match = /^(?:(details)(?:\s+(\d{4}-(?:0[1-9]|1[0-2])))?|(\d{4}-(?:0[1-9]|1[0-2]))(?:\s+(details))?)?$/i.exec(argument);
            if (!match) sendTelegramMessage('Use /items for Basket Review, /items details for evidence, /items YYYY-MM for a month, or /items status for capture diagnostics.', chatId);
            else sendBasketReview(chatId, match[2] || match[3] || undefined, undefined, Boolean(match[1] || match[4]));
          }
          return HtmlService.createHtmlOutput('OK');
        }
        if (/^\/trips?(?:@\w+)?(?:\s|$)/i.test(textTrimmed)) {
          if (typeof readTravelPlanStatus === 'function' && typeof renderTravelPlanTelegramSummary === 'function') {
            sendTelegramMessage(renderTravelPlanTelegramSummary(readTravelPlanStatus()), chatId);
          }
          return HtmlService.createHtmlOutput('OK');
        }
        if (/^\/(?:tax|capital)(?:@\w+)?(?:\s|$)/i.test(textTrimmed)) {
          if (typeof readCapitalPlanStatus === 'function' && typeof renderCapitalPlanTelegramSummary === 'function') {
            sendTelegramMessage(renderCapitalPlanTelegramSummary(readCapitalPlanStatus()), chatId);
          }
          return HtmlService.createHtmlOutput('OK');
        }

        // --- INTERCEPT MERCHANT RENAME ---
        const cache = CacheService.getScriptCache();
        const awaitingMerchantData = cache.get('awaiting_merchant:' + chatId);
        if (awaitingMerchantData) {
          cache.remove('awaiting_merchant:' + chatId);
          const renameLock = LockService.getUserLock();
          try {
            renameLock.waitLock(30000);
            const state = JSON.parse(awaitingMerchantData);
            const token = state.token;
            const index = state.index;
            const msgId = state.messageId;
            
            let transactions = typeof getPendingTransactions === 'function' ? getPendingTransactions(token) : null;
            if (Array.isArray(transactions) && transactions[index] &&
                state.transactionSnapshot === JSON.stringify(transactions[index])) {
              const txn = transactions[index];
              const newName = textTrimmed;
              
              captureTelegramRuleBaseline(txn);
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
          } finally {
            try { renameLock.releaseLock(); } catch (e) {}
          }
          // Never reinterpret a rename reply as a new transaction or an AI batch edit.
          return HtmlService.createHtmlOutput('OK');
        }
        // --- END INTERCEPT ---

        if (handleTelegramProposalComment(message)) {
          return HtmlService.createHtmlOutput('OK');
        }
      }

      // Inspect attached document metadata up front to reject unsupported formats before progress tracking.
      const doc = message.document || null;
      const docMime = doc ? String(doc.mime_type || '').toLowerCase() : '';
      const docName = doc ? String(doc.file_name || '').toLowerCase() : '';
      const isPdfDoc = Boolean(doc && (docMime.includes('pdf') || docName.endsWith('.pdf')));
      const isCsvDoc = Boolean(doc && !isPdfDoc && (docMime.includes('csv') || docMime.includes('excel') ||
        docMime.includes('plain') || docName.endsWith('.csv')));
      const isImageDoc = Boolean(doc && !isPdfDoc && !isCsvDoc && docMime.startsWith('image/'));
      if (doc && !isImageDoc && !isPdfDoc && !isCsvDoc) {
        const warningUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        fetchWithRetry(warningUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({
            chat_id: chatId,
            text: "⚠️ Unsupported file format. Please send a receipt image or PDF."
          }),
          muteHttpExceptions: true
        });
        return HtmlService.createHtmlOutput('OK');
      }

      if (isCsvDoc) {
        sendTelegramMessage('ℹ️ Bank statement reconciliation via the sheet inbox has been retired. Upload CSV statements directly in your AI chat to reconcile.', chatId);
        return HtmlService.createHtmlOutput('OK');
      }

      const hasPhotoMedia = Boolean((Array.isArray(message.photo) && message.photo.length > 0) || isImageDoc);
      const rawCaption = !message.text && message.caption ? String(message.caption) : '';
      // Ignore OS/client auto-generated screenshot filename captions (e.g. "Screenshot (22 Nov 2026 4:30:42 am)")
      // so screenshots extract independently without resending or locking prior proposals.
      const effectiveCaption = (hasPhotoMedia && isBoilerplateMediaCaption(rawCaption)) ? '' : rawCaption;

      if (message.text) {
        inputs.push({ text: message.text });
      } else if (effectiveCaption) {
        inputs.push({ text: effectiveCaption });
      }

      // Start live step-by-step progress bar for the user's upload (PDF, photo/image, voice, or text).
      const progressKind = isPdfDoc ? 'pdf'
        : hasPhotoMedia ? 'photo'
        : message.voice ? 'voice'
        : (message.text && message.text.trim()) ? 'text'
        : null;
      if (progressKind) {
        uploadProgress = startTelegramUploadProgress(chatId, progressKind, {
          mediaGroupId: message.media_group_id || null,
          botToken: botToken
        });
      }

      // Case B: Photo input (Receipt / Bank Screenshot)
      if (Array.isArray(message.photo) && message.photo.length > 0) {
        const downloadStarted = Date.now();
        const largestPhoto = message.photo[message.photo.length - 1];
        const filePath = getTelegramFilePath(largestPhoto.file_id, botToken);
        const photoMediaObj = fetchTelegramFileAsBase64(filePath, botToken);
        inputs.push(photoMediaObj);
        logProposalTiming('photo_download', downloadStarted);
        if (uploadProgress) uploadProgress.completeStep('download', 'Downloaded image from Telegram');
      }

      // Case C: Voice input (Voice Note)
      if (message.voice) {
        const filePath = getTelegramFilePath(message.voice.file_id, botToken);
        const voiceMediaObj = fetchTelegramFileAsBase64(filePath, botToken);
        inputs.push(voiceMediaObj);
        if (uploadProgress) uploadProgress.completeStep('download', 'Downloaded voice note');
      }

      // Case D: PDF receipts / payment confirmations and image documents.
      if (doc) {
        if (isImageDoc) {
          const downloadStarted = Date.now();
          const filePath = getTelegramFilePath(doc.file_id, botToken);
          inputs.push(fetchTelegramFileAsBase64(filePath, botToken, docMime));
          logProposalTiming('photo_download', downloadStarted);
          if (uploadProgress) uploadProgress.completeStep('download', 'Downloaded image from Telegram');
        } else if (isPdfDoc) {
          const filePath = getTelegramFilePath(doc.file_id, botToken);
          const docMediaObj = fetchTelegramFileAsBase64(filePath, botToken, 'application/pdf');
          if (uploadProgress) {
            uploadProgress.completeStep('download', 'Downloaded PDF from Telegram');
          }
          if (uploadProgress) uploadProgress.startStep('classify');
          const classificationStarted = Date.now();
          pdfDocumentType = classifyPdfDocument(docMediaObj);
          logProposalTiming('pdf_classification', classificationStarted);
          if (pdfDocumentType === 'bank_statement') {
            sendTelegramMessage('ℹ️ Bank statement reconciliation via the sheet inbox has been retired. Upload bank statements directly in your AI chat to reconcile, or send individual receipts or payment confirmations here.', chatId);
            if (uploadProgress) uploadProgress.complete('Bank statement — reconcile in AI chat');
            return HtmlService.createHtmlOutput('OK');
          } else if (pdfDocumentType === 'receipt' || pdfDocumentType === 'bank_transaction') {
            if (uploadProgress) {
              uploadProgress.completeStep('classify', pdfDocumentType === 'receipt'
                ? 'Classified as merchant receipt'
                : 'Classified as bank payment confirmation');
            }
            inputs.push(docMediaObj);
          } else {
            sendTelegramMessage('This PDF could not be identified as a receipt or payment confirmation. Please send a clearer copy.', chatId);
            if (uploadProgress) uploadProgress.complete('Unidentified PDF');
            return HtmlService.createHtmlOutput('OK');
          }
        }
      }

      // Telegram delivers one update per album photo. Process every update;
      // neither cache image bytes nor guess when an album has finished arriving.
      // Model extraction ALWAYS runs outside LockService.getUserLock() so slow LLM
      // calls or 503 retries never block comment edits, callbacks, or sibling photos.

      // Process inputs through AI Extraction & Confirmation Pipeline
      if (inputs.length > 0) {
        const independentPhoto = Boolean(hasPhotoMedia && !effectiveCaption && !message.text && !message.voice &&
          !inputs.some(input => typeof input === 'string' || (input && input.text)));
        const independentDocument = independentPhoto || Boolean(pdfDocumentType);

        // Rolling-context inputs (text, voice, or intentionally captioned photos) take a brief
        // lock-protected snapshot of any active proposal, then release the lock before calling Gemini.
        let snapshotToken = null;
        let snapshotProposal = null;
        let snapshotRevision = null;
        if (!independentDocument) {
          withTelegramProposalLock(() => {
            const userProperties = PropertiesService.getUserProperties();
            snapshotToken = userProperties.getProperty(`latest_token_${chatId}`);
            if (snapshotToken) {
              const pending = getPendingTransactions(snapshotToken);
              if (Array.isArray(pending) && pending.length > 0) {
                snapshotProposal = pending;
                snapshotRevision = typeof telegramProposalRevision === 'function'
                  ? telegramProposalRevision(pending)
                  : JSON.stringify(pending);
              }
            }
          });
        }

        const onProgress = uploadProgress ? (stage, info) => {
          if (stage === 'extract_transactions_start') {
            uploadProgress.startStep('extract');
          } else if (stage === 'extract_transactions_done') {
            const count = Number(info && info.count) || 0;
            uploadProgress.completeStep('extract', count === 1 ? 'Extracted 1 transaction' : `Extracted ${count} transactions`);
          } else if (stage === 'receipt_items_start') {
            uploadProgress.startStep('items');
          } else if (stage === 'receipt_items_done') {
            const count = Number(info && info.itemCount) || 0;
            const label = (info && info.warning)
              ? 'Receipt item scan unavailable (transaction kept)'
              : count > 0
                ? (count === 1 ? 'Captured 1 receipt item' : `Captured ${count} receipt items`)
                : 'No itemized product lines found';
            uploadProgress.completeStep('items', label);
          } else if (stage === 'receipt_items_skipped') {
            uploadProgress.completeStep('items', (info && info.reason) || 'Skipped receipt item scan');
          } else if (stage === 'duplicates_start') {
            uploadProgress.startStep('finalize');
          }
        } : undefined;

        const extractionStarted = Date.now();
        const extractionContext = independentDocument
          ? { defaultAccount: DEFAULT_ACCOUNT, pdf_document_type: pdfDocumentType, onProgress: onProgress }
          : { defaultAccount: DEFAULT_ACCOUNT, previous_proposal: snapshotProposal, onProgress: onProgress };
        const extractedTransactions = extractTransactions(inputs, extractionContext);
        logProposalTiming(pdfDocumentType ? 'pdf_extraction' : (hasPhotoMedia ? 'photo_extraction' : 'input_extraction'), extractionStarted);

        if (uploadProgress) uploadProgress.ensureStepStarted('finalize');

        // Proposal state uses the user lock only for the sub-second merge/commit step;
        // statement scans / ledger writes keep the separate script lock.
        let isNewProposalCard = false;
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

          let finalTransactionsToConfirm;
          let effectiveBaseProposal = previousProposal;
          if (independentDocument) {
            finalTransactionsToConfirm = mergeScreenshotProposals(previousProposal || [], extractedTransactions);
          } else {
            const reconciled = reconcileConcurrentRollingProposal(
              snapshotProposal, snapshotToken, snapshotRevision,
              previousProposal, activeToken, extractedTransactions
            );
            if (reconciled.alreadyCompleted) {
              sendTelegramMessage("ℹ️ The previous proposal was already completed while processing your message. Please resend if you want to log a new transaction.", chatId);
              if (uploadProgress) uploadProgress.complete('Previous proposal already completed', { summary: 'Previous proposal completed' });
              return HtmlService.createHtmlOutput('OK');
            }
            finalTransactionsToConfirm = reconciled.transactions;
            effectiveBaseProposal = reconciled.baseProposal;
          }

          // Only carry corrections across an unambiguous source transaction match.
          if (!independentDocument && message.text && Array.isArray(effectiveBaseProposal)) {
            finalTransactionsToConfirm.forEach(txn => {
              const matches = effectiveBaseProposal.filter(old =>
                (old.raw_where || old.where) === (txn.raw_where || txn.where) &&
                old.date === txn.date && Number(old.amount) === Number(txn.amount) &&
                (old.currency || 'SGD') === (txn.currency || 'SGD'));
              if (matches.length !== 1) return;
              const old = matches[0];
              const changed = ['where', 'category', 'account', 'type'].some(field => old[field] !== txn[field]);
              if (!changed && !old.telegram_rule_baseline) return;
              captureTelegramRuleBaseline(old);
              txn.telegram_rule_baseline = old.telegram_rule_baseline;
              txn.manual_merchant_category = true;
            });
          }

          if (finalTransactionsToConfirm.length === 0) {
            sendTelegramMessage("ℹ️ No financial transactions detected in your input. Try sending a receipt photo, voice note, or text spend (e.g., 'lunch 12.50').", chatId);
            if (uploadProgress) uploadProgress.complete('No transactions detected', { summary: 'No transactions detected' });
            return HtmlService.createHtmlOutput('OK');
          }

          // Phase 3: Save state in CacheService (preserve activeToken if refining an active proposal)
          const tokenToSave = (effectiveBaseProposal && effectiveBaseProposal.length > 0 && activeToken) ? activeToken : null;
          const token = savePendingTransactions(finalTransactionsToConfirm, tokenToSave);
          userProperties.setProperty(activeTokenKey, token);
          rememberReceiptCaptureEvent(chatId, 'upload', extractedTransactions);
          if (message.media_group_id) {
            Logger.log(`[Album photo] group=${message.media_group_id}; message=${message.message_id}; extracted=${extractedTransactions.length}; proposal_rows=${finalTransactionsToConfirm.length}`);
          }

          if (typeof sendConfirmationMessage === 'function') {
            // Check if we are appending/updating an existing proposal
            const isUpdate = Boolean(effectiveBaseProposal && effectiveBaseProposal.length > 0 && activeToken);
            const confirmationStarted = Date.now();
            sendConfirmationMessage(chatId, token, finalTransactionsToConfirm, isUpdate);
            isNewProposalCard = !isUpdate;
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
        if (uploadProgress) {
          uploadProgress.complete('Proposal ready', {
            newProposalPosted: isNewProposalCard,
            summary: buildExtractedImageSummary(extractedTransactions)
          });
        }
      }
    }
  } catch (err) {
    const safeErrMessage = redactSecretsFromText(err && err.message ? err.message : String(err));
    const safeErrStack = redactSecretsFromText(err && err.stack ? err.stack : '');
    Logger.log(`Error processing webhook update: ${safeErrMessage}\nStack: ${safeErrStack}`);
    // Authentication/config/parse failures must never notify a body-supplied chat.
    if (!authorizedChatId) return HtmlService.createHtmlOutput('Unauthorized');
    if (uploadProgress) uploadProgress.fail(safeErrMessage);
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
            text: `⚠️ Bot Error: ${safeErrMessage}`
          }),
          muteHttpExceptions: true
        });
      }
    } catch (notifyErr) {
      Logger.log('Failed to send error notification to Telegram: ' + redactSecretsFromText(notifyErr && notifyErr.message));
    }
  }

  // 5. Always return "OK" fast to acknowledge Telegram webhook delivery (§5.3)
  return HtmlService.createHtmlOutput('OK');
}

/** Log timing only, never screenshot content, transaction details or credentials. */
function logProposalTiming(phase, started) {
  Logger.log(`[Proposal timing] ${phase}: ${Date.now() - started}ms`);
}

/** Detect OS/client auto-generated screenshot or camera filename captions so they do not trigger rolling-context mode. */
function isBoilerplateMediaCaption(caption) {
  if (typeof caption !== 'string') return false;
  const text = caption.trim();
  if (!text || text.length > 120) return false;
  // e.g. "Screenshot (22 Nov 2026 4:30:42 am)" or "Снимок экрана (22 нояб. 2026 г., 04:30:42)"
  const parenMatch = /^(?:screen\s*shot|снимок\s+экрана)\s*(\([^()\n]{1,70}\))(?:\.(?:png|jpe?g|webp|heic))?$/i.exec(text);
  if (parenMatch && /^\(\d{1,4}[\s./\-]+[a-zа-яё0-9.,\s:/\-]+\d(?:\s*(?:am|pm))?\)$/i.test(parenMatch[1])) {
    return true;
  }
  // e.g. "Screenshot 2026-11-22 at 4.34.36 AM", "Screenshot_20261122-043042_com.dbs.app.jpg", "Screenshot"
  if (/^(?:screen\s*shot|снимок\s+экрана)(?:[\s_-]+\d[\d_.\-/:,\s]*(?:(?:at|в)\s+\d[\d_.\-/:,\s]*)?(?:am|pm)?(?:_[a-z0-9]+(?:\.[a-z0-9]+)+)?)?(?:\.(?:png|jpe?g|webp|heic))?$/i.test(text)) {
    return true;
  }
  // Bare camera/export filenames such as "IMG_20261122_043042.JPG" or "PHOTO-2026-11-22-04-30-42.jpg"
  if (/^(?:img|dsc|pxl|photo)[\s_-]*\d[\d_-]*\.(?:png|jpe?g|webp|heic)$/i.test(text)) {
    return true;
  }
  return false;
}

function proposalRowIdentityKey(txn) {
  return JSON.stringify([normalizeDateString(txn.date), String(txn.account || '').trim(),
    String(txn.currency || 'SGD').toUpperCase(), Number(txn.amount).toFixed(2),
    normaliseWhere(txn.where || ''), String(txn.type || ''), String(txn.card_last4 || txn.cardholder || ''),
    (txn.flags || []).includes('papa_charge') || /grandparents/i.test(String(txn.notes || ''))]);
}

/** Preserve reviewed fields and occurrence counts when screenshots overlap. */
function mergeScreenshotProposals(previous, incoming) {
  const remaining = new Map();
  previous.forEach(txn => {
    const id = proposalRowIdentityKey(txn);
    if (!remaining.has(id)) remaining.set(id, []);
    remaining.get(id).push(txn);
  });
  const merged = previous.slice();
  incoming.forEach(txn => {
    const id = proposalRowIdentityKey(txn), matches = remaining.get(id) || [];
    if (matches.length) {
      const old = matches.shift();
      if (txn.receipt_capture) old.receipt_capture = old.receipt_capture
        ? mergeReceiptCaptureEvidence(old.receipt_capture, txn.receipt_capture) : txn.receipt_capture;
      if (txn.receipt_capture_warning && !old.receipt_capture) old.receipt_capture_warning = txn.receipt_capture_warning;
      if (txn.receipt_capture_status && (!old.receipt_capture || txn.receipt_capture)) old.receipt_capture_status = txn.receipt_capture_status;
    }
    else merged.push(txn);
  });
  return merged;
}

/**
 * Reconciles a lock-free rolling extraction against any concurrent proposal edits, merges, or approvals.
 */
function reconcileConcurrentRollingProposal(snapshotProposal, snapshotToken, snapshotRevision, currentProposal, currentToken, extractedTransactions) {
  const currentActive = Array.isArray(currentProposal) && currentProposal.length > 0 ? currentProposal : null;
  const currentRevision = currentActive
    ? (typeof telegramProposalRevision === 'function' ? telegramProposalRevision(currentActive) : JSON.stringify(currentActive))
    : null;

  // Fast path: proposal state did not change while Gemini was running.
  if (currentToken === snapshotToken && currentRevision === snapshotRevision) {
    return { transactions: extractedTransactions, baseProposal: currentActive, alreadyCompleted: false };
  }

  // Strip unchanged snapshot occurrences to isolate newly added/modified items.
  const exactKey = txn => JSON.stringify([proposalRowIdentityKey(txn), String(txn.category || '')]);
  const snapshotCounts = new Map();
  (snapshotProposal || []).forEach(txn => {
    const k = exactKey(txn);
    snapshotCounts.set(k, (snapshotCounts.get(k) || 0) + 1);
  });
  const deltaRows = [];
  (extractedTransactions || []).forEach(txn => {
    const k = exactKey(txn);
    const count = snapshotCounts.get(k) || 0;
    if (count > 0) snapshotCounts.set(k, count - 1);
    else deltaRows.push(txn);
  });

  // Previous proposal was approved or discarded while this rolling input was extracting.
  if (snapshotProposal && snapshotProposal.length > 0 && !currentActive) {
    if (deltaRows.length === 0) {
      return { transactions: [], baseProposal: null, alreadyCompleted: true };
    }
    return { transactions: deltaRows, baseProposal: null, alreadyCompleted: false };
  }

  // Another edit or screenshot updated the active proposal concurrently: merge new delta rows without clobbering.
  if (currentActive) {
    return {
      transactions: mergeScreenshotProposals(currentActive, snapshotProposal && snapshotProposal.length > 0 ? deltaRows : extractedTransactions),
      baseProposal: currentActive,
      alreadyCompleted: false
    };
  }

  return { transactions: extractedTransactions, baseProposal: null, alreadyCompleted: false };
}

function escapeUploadProgressHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Builds a fixed-width Unicode progress bar string, e.g. "[█████░░░░░] 50%".
 */
function renderTelegramProgressBar(percent, width = 10) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const total = Math.max(4, Number(width) || 10);
  const filled = Math.round((clamped / 100) * total);
  return '[' + '█'.repeat(filled) + '░'.repeat(total - filled) + '] ' + clamped + '%';
}

/**
 * Formats the multi-step upload progress state into Telegram HTML showing the progress bar,
 * current stage, completed steps (✅), active step (🔄), and upcoming steps (⬜).
 */
function formatTelegramUploadProgressHtml(state) {
  const steps = (state && state.steps) || [];
  const activeIdx = steps.findIndex(step => step.status === 'active' || step.status === 'failed');
  const doneCount = steps.filter(step => step.status === 'done').length;
  const stepNum = activeIdx !== -1 ? activeIdx + 1 : Math.min(steps.length, Math.max(1, doneCount));
  let header;
  if (state.finished === 'done') {
    header = `✅ <b>${escapeUploadProgressHtml(state.title)}</b> · Complete\n<code>${renderTelegramProgressBar(100)}</code>`;
  } else if (state.finished === 'failed') {
    header = `⚠️ <b>${escapeUploadProgressHtml(state.title)} — stopped</b> · Step ${stepNum} of ${steps.length}\n<code>${renderTelegramProgressBar(state.percent)}</code>`;
  } else {
    header = `${state.icon || '⏳'} <b>${escapeUploadProgressHtml(state.title)}</b> · Step ${stepNum} of ${steps.length}\n<code>${renderTelegramProgressBar(state.percent)}</code>`;
  }

  const lines = steps.map((step, index) => {
    const n = index + 1;
    if (step.status === 'done') {
      return `✅ ${n}. ${escapeUploadProgressHtml(step.detail || step.doneLabel || step.pendingLabel)}`;
    }
    if (step.status === 'active') {
      return `🔄 <b>${n}. ${escapeUploadProgressHtml(step.detail || step.activeLabel || step.pendingLabel)}</b>`;
    }
    if (step.status === 'failed') {
      return `❌ <b>${n}. ${escapeUploadProgressHtml(step.detail || (step.pendingLabel + ' — failed'))}</b>`;
    }
    return `⬜ ${n}. ${escapeUploadProgressHtml(step.pendingLabel)}`;
  });

  return header + '\n\n' + lines.join('\n');
}

function getUploadProgressProfile(kind, optOptions) {
  const isAlbum = Boolean(optOptions && optOptions.mediaGroupId);
  if (kind === 'pdf') {
    return {
      icon: '📄',
      title: 'PDF received — processing',
      steps: [
        { id: 'download', percent: 15, pendingLabel: 'Download PDF from Telegram', activeLabel: 'Downloading PDF from Telegram…', doneLabel: 'Downloaded PDF from Telegram' },
        { id: 'classify', percent: 35, pendingLabel: 'Classify PDF document', activeLabel: 'Classifying PDF document…', doneLabel: 'Classified PDF document' },
        { id: 'extract', percent: 60, pendingLabel: 'Extract transactions with AI', activeLabel: 'Extracting transactions with AI…', doneLabel: 'Extracted transactions' },
        { id: 'items', percent: 80, pendingLabel: 'Check receipt line items', activeLabel: 'Extracting receipt line items…', doneLabel: 'Checked receipt line items' },
        { id: 'finalize', percent: 95, pendingLabel: 'Check duplicates & update proposal', activeLabel: 'Checking duplicates & updating proposal…', doneLabel: 'Proposal ready' }
      ]
    };
  }
  if (kind === 'photo') {
    return {
      icon: '🖼️',
      title: isAlbum ? 'Processing album photos' : 'Processing image',
      steps: [
        { id: 'download', percent: 15, pendingLabel: 'Download image from Telegram', activeLabel: 'Downloading image from Telegram…', doneLabel: 'Downloaded image from Telegram' },
        { id: 'extract', percent: 45, pendingLabel: 'Extract transactions with AI', activeLabel: 'Extracting transactions with AI…', doneLabel: 'Extracted transactions' },
        { id: 'items', percent: 75, pendingLabel: 'Check receipt line items', activeLabel: 'Checking receipt line items…', doneLabel: 'Checked receipt line items' },
        { id: 'finalize', percent: 90, pendingLabel: 'Check duplicates & update proposal', activeLabel: 'Checking duplicates & updating proposal…', doneLabel: 'Proposal ready' }
      ]
    };
  }
  if (kind === 'voice') {
    return {
      icon: '🎙️',
      title: 'Processing voice note',
      steps: [
        { id: 'download', percent: 20, pendingLabel: 'Download voice note from Telegram', activeLabel: 'Downloading voice note from Telegram…', doneLabel: 'Downloaded voice note' },
        { id: 'extract', percent: 60, pendingLabel: 'Transcribe & extract transactions with AI', activeLabel: 'Transcribing & extracting transactions with AI…', doneLabel: 'Extracted transactions' },
        { id: 'finalize', percent: 90, pendingLabel: 'Check duplicates & update proposal', activeLabel: 'Checking duplicates & updating proposal…', doneLabel: 'Proposal ready' }
      ]
    };
  }
  return {
    icon: '✍️',
    title: 'Processing transaction text',
    steps: [
      { id: 'extract', percent: 50, pendingLabel: 'Extract transactions with AI', activeLabel: 'Extracting transactions with AI…', doneLabel: 'Extracted transactions' },
      { id: 'finalize', percent: 90, pendingLabel: 'Check duplicates & update proposal', activeLabel: 'Checking duplicates & updating proposal…', doneLabel: 'Proposal ready' }
    ]
  };
}

function redactSecretsFromText(value) {
  return String(value || '')
    .replace(/(https?:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/\s"']+/gi, '$1[REDACTED]')
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]')
    .replace(/([?&](?:key|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
}

function fetchTelegramProgressApi(url, options, maxRetries = 3) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxRetries) || 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return UrlFetchApp.fetch(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < attempts && typeof Utilities !== 'undefined' && Utilities && typeof Utilities.sleep === 'function') {
        Utilities.sleep(attempt * 400);
      }
    }
  }
  throw new Error(redactSecretsFromText(lastError && lastError.message));
}

function editTelegramProgressMessage(chatId, messageId, htmlText) {
  if (!chatId || !messageId || typeof UrlFetchApp === 'undefined' || !UrlFetchApp || typeof UrlFetchApp.fetch !== 'function') {
    return false;
  }
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) return false;
  try {
    const response = fetchTelegramProgressApi(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) || messageId, text: htmlText, parse_mode: 'HTML' }),
      muteHttpExceptions: true
    }, 3);
    const parsed = JSON.parse(response.getContentText());
    return Boolean(parsed && parsed.ok) ||
      Boolean(parsed && parsed.error_code === 400 && /message is not modified/i.test(String(parsed.description || '')));
  } catch (_) {
    return false;
  }
}

function deleteTelegramProgressMessage(chatId, messageId) {
  if (!chatId || !messageId || typeof UrlFetchApp === 'undefined' || !UrlFetchApp || typeof UrlFetchApp.fetch !== 'function') {
    return false;
  }
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) return false;
  try {
    const response = fetchTelegramProgressApi(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) || messageId }),
      muteHttpExceptions: true
    }, 3);
    const parsed = JSON.parse(response.getContentText());
    const deleted = Boolean(parsed && parsed.ok) ||
      Boolean(parsed && parsed.error_code === 400 && /message to delete not found/i.test(String(parsed.description || '')));
    if (deleted) untrackActiveProgressCardId(chatId, messageId);
    return Boolean(parsed && parsed.ok);
  } catch (_) {
    return false;
  }
}

function buildExtractedImageSummary(extractedTransactions) {
  const txnCount = Array.isArray(extractedTransactions) ? extractedTransactions.length : 0;
  if (txnCount === 0) return 'No transactions detected';
  const itemCount = extractedTransactions.reduce((sum, txn) =>
    sum + (txn && txn.receipt_capture && Array.isArray(txn.receipt_capture.line_items) ? txn.receipt_capture.line_items.length : 0), 0);
  const txnPart = txnCount === 1 ? 'Extracted 1 transaction' : `Extracted ${txnCount} transactions`;
  const itemPart = itemCount > 0 ? (itemCount === 1 ? ' · 1 receipt item' : ` · ${itemCount} receipt items`) : '';
  return txnPart + itemPart;
}

function getTelegramPendingUpdateCount(optBotToken) {
  if (typeof UrlFetchApp === 'undefined' || !UrlFetchApp || typeof UrlFetchApp.fetch !== 'function') {
    return null;
  }
  const botToken = optBotToken || PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) return null;
  try {
    const response = fetchTelegramProgressApi(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
      method: 'get',
      muteHttpExceptions: true
    }, 2);
    if (!response || typeof response.getContentText !== 'function') return null;
    const parsed = JSON.parse(response.getContentText());
    const count = parsed && parsed.ok && parsed.result && parsed.result.pending_update_count;
    return (typeof count === 'number' && Number.isFinite(count) && count >= 0) ? count : null;
  } catch (_) {
    return null;
  }
}

// 15-minute batch TTL comfortably exceeds Apps Script's 6-minute maximum runtime so slow concurrent
// extractions never lose the shared progress card messageId while sibling photos finish ahead of them.
const PHOTO_BATCH_TTL_SECONDS = 900;
const PHOTO_BATCH_STALE_MS = 45000;
const PHOTO_SLOT_MAX_RUNTIME_MS = 370000;
const PROGRESS_CARD_TRACK_TTL_SECONDS = 21600;

function isPhotoBatchSlotActive(slot) {
  if (!slot || slot.status !== 'active') return false;
  if (slot.startedAt && (Date.now() - Number(slot.startedAt)) > PHOTO_SLOT_MAX_RUNTIME_MS) {
    return false;
  }
  return true;
}

function getProgressCacheSafe() {
  if (typeof CacheService === 'undefined' || !CacheService || typeof CacheService.getScriptCache !== 'function') {
    return null;
  }
  try {
    return CacheService.getScriptCache();
  } catch (_) {
    return null;
  }
}

function readProgressCacheJson(cache, key) {
  if (!cache || !key) return null;
  try {
    const raw = cache.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeProgressCacheJson(cache, key, value, ttlSeconds) {
  if (!cache || !key) return;
  try {
    cache.put(key, JSON.stringify(value), ttlSeconds || PHOTO_BATCH_TTL_SECONDS);
  } catch (_) {}
}

function photoBatchMetaKey(chatId) {
  return 'upload_batch_meta_' + String(chatId);
}

function photoBatchItemKey(batchId, index) {
  return 'upload_batch_item_' + String(batchId) + '_' + String(index);
}

function photoGroupHistKey(mediaGroupId) {
  return 'upload_group_hist_' + String(mediaGroupId);
}

function progressTrackedCardsKey(chatId) {
  return 'upload_progress_cards_' + String(chatId);
}

function getProgressUserPropsSafe() {
  if (typeof PropertiesService === 'undefined' || !PropertiesService || typeof PropertiesService.getUserProperties !== 'function') {
    return null;
  }
  try {
    const up = PropertiesService.getUserProperties();
    return (up && typeof up.getProperty === 'function' && typeof up.setProperty === 'function') ? up : null;
  } catch (_) {
    return null;
  }
}

function readTrackedProgressCardIds(chatId) {
  if (!chatId) return [];
  const key = progressTrackedCardsKey(chatId);
  const cache = getProgressCacheSafe();
  const fromCache = readProgressCacheJson(cache, key);
  if (Array.isArray(fromCache) && fromCache.length > 0) return fromCache;
  const userProps = getProgressUserPropsSafe();
  if (!userProps) return [];
  try {
    const raw = userProps.getProperty(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeTrackedProgressCardIds(chatId, ids) {
  if (!chatId) return;
  const key = progressTrackedCardsKey(chatId);
  const clean = Array.from(new Set((ids || []).filter(Boolean).map(id => Number(id) || id))).slice(-10);
  const cache = getProgressCacheSafe();
  if (cache) {
    if (clean.length > 0) writeProgressCacheJson(cache, key, clean, PROGRESS_CARD_TRACK_TTL_SECONDS);
    else { try { cache.remove(key); } catch (_) {} }
  }
  const userProps = getProgressUserPropsSafe();
  if (userProps) {
    try {
      userProps.setProperty(key, clean.length > 0 ? JSON.stringify(clean) : '');
    } catch (_) {}
  }
}

function trackActiveProgressCardId(chatId, messageId) {
  if (!chatId || !messageId) return;
  const existing = readTrackedProgressCardIds(chatId);
  existing.push(Number(messageId) || messageId);
  writeTrackedProgressCardIds(chatId, existing);
}

function untrackActiveProgressCardId(chatId, messageId) {
  if (!chatId || !messageId) return;
  const target = String(messageId);
  const remaining = readTrackedProgressCardIds(chatId).filter(id => String(id) !== target);
  writeTrackedProgressCardIds(chatId, remaining);
}

function sweepTrackedProgressCards(chatId, optKeepMessageId) {
  if (!chatId) return;
  const keep = optKeepMessageId ? String(optKeepMessageId) : null;
  const ids = readTrackedProgressCardIds(chatId);
  if (!ids.length) return;
  const remaining = [];
  ids.forEach(id => {
    if (keep && String(id) === keep) return;
    if (!deleteTelegramProgressMessage(chatId, id)) {
      // Drop unrecoverable IDs after one sweep attempt so stale IDs do not accumulate forever.
    }
  });
  writeTrackedProgressCardIds(chatId, remaining);
}

function readPhotoBatchItems(cache, batchId, maxIndex) {
  const items = [];
  const count = Math.max(0, Number(maxIndex) || 0);
  for (let i = 1; i <= count; i++) {
    items.push(readProgressCacheJson(cache, photoBatchItemKey(batchId, i)));
  }
  return items;
}

/**
 * Dismisses any waiting or orphaned photo-batch progress card when a non-photo update (callback,
 * Discard/Approve, text edit, command, voice note, or PDF) arrives for the chat.
 */
function dismissIdlePhotoBatchProgress(chatId) {
  if (!chatId) return;
  const cache = getProgressCacheSafe();
  const metaKey = photoBatchMetaKey(chatId);
  const meta = readProgressCacheJson(cache, metaKey);
  if (meta && meta.batchId) {
    const items = readPhotoBatchItems(cache, meta.batchId, meta.nextIndex || meta.total || 0);
    if (items.some(isPhotoBatchSlotActive)) return;
    if (cache) { try { cache.remove(metaKey); } catch (_) {} }
    const settledItems = items.map(item => {
      if (item && item.status === 'active') {
        return { ...item, status: 'failed', summary: 'Timed out before completion' };
      }
      return item;
    }).filter(Boolean);
    if (settledItems.some(item => item.status === 'failed')) {
      if (meta.messageId) {
        const html = formatTelegramPhotoBatchHtml({
          total: Math.max(1, settledItems.length),
          finished: 'failed',
          isAlbum: Boolean(meta.mediaGroupId),
          items: settledItems
        });
        editTelegramProgressMessage(chatId, meta.messageId, html);
        sweepTrackedProgressCards(chatId, meta.messageId);
      }
      return;
    }
    if (meta.messageId) {
      deleteTelegramProgressMessage(chatId, meta.messageId);
    }
  }
  sweepTrackedProgressCards(chatId);
}

/**
 * Renders either a single-image progress card (when total === 1) or a clear multi-image
 * "Image 1/n, 2/n, …" batch progress card showing completed images (✅), the active image
 * with its step breakdown (🔄), and queued images (⬜).
 */
function formatTelegramPhotoBatchHtml(batchView) {
  const total = Math.max(1, Number(batchView && batchView.total) || 1);
  const items = (batchView && batchView.items) || [];
  if (total === 1) {
    const single = items[0] || { percent: 15, steps: getUploadProgressProfile('photo').steps };
    return formatTelegramUploadProgressHtml({
      icon: '🖼️',
      title: 'Processing image',
      percent: single.percent,
      finished: batchView && batchView.finished,
      steps: single.steps || []
    });
  }

  let doneCount = 0;
  let failedCount = 0;
  let pointsSum = 0;
  const activeIndices = [];
  let firstQueuedIndex = null;

  for (let i = 1; i <= total; i++) {
    const slot = items[i - 1];
    if (slot && slot.status === 'done') {
      doneCount++;
      pointsSum += 100;
    } else if (slot && slot.status === 'failed') {
      failedCount++;
      pointsSum += 100;
    } else if (isPhotoBatchSlotActive(slot)) {
      activeIndices.push(i);
      pointsSum += Math.max(5, Math.min(99, Number(slot.percent) || 15));
    } else if (firstQueuedIndex === null) {
      firstQueuedIndex = i;
    }
  }

  const allSettled = (doneCount + failedCount) >= total;
  const overallPercent = (batchView && batchView.finished === 'done') || (allSettled && failedCount === 0 && batchView && batchView.finished)
    ? 100
    : (allSettled ? 100 : Math.min(99, Math.max(1, Math.round(pointsSum / total))));

  let header;
  if (batchView && batchView.finished === 'done') {
    header = `✅ <b>Processed ${total}/${total} images</b> · Complete\n<code>${renderTelegramProgressBar(100)}</code>`;
  } else if (batchView && batchView.finished === 'failed') {
    header = `⚠️ <b>Processed images (${doneCount}/${total} succeeded, ${failedCount} failed)</b>\n<code>${renderTelegramProgressBar(overallPercent)}</code>`;
  } else if (activeIndices.length > 0) {
    const currentNum = activeIndices[0];
    header = `🖼️ <b>Processing images (${currentNum}/${total})</b> · Image ${currentNum} of ${total}\n<code>${renderTelegramProgressBar(overallPercent)}</code>`;
  } else {
    const nextNum = firstQueuedIndex || Math.min(total, doneCount + failedCount + 1);
    header = `🖼️ <b>Processing images (${doneCount + failedCount}/${total} done)</b> · Next: Image ${nextNum} of ${total}\n<code>${renderTelegramProgressBar(overallPercent)}</code>`;
  }

  const lines = [];
  for (let imgNum = 1; imgNum <= total; imgNum++) {
    const slot = items[imgNum - 1];
    if (slot && slot.status === 'done') {
      lines.push(`✅ Image ${imgNum}/${total} — ${escapeUploadProgressHtml(slot.summary || 'Processed')}`);
    } else if (slot && slot.status === 'failed') {
      lines.push(`❌ <b>Image ${imgNum}/${total} — ${escapeUploadProgressHtml(slot.summary || 'Failed')}</b>`);
    } else if (isPhotoBatchSlotActive(slot)) {
      const steps = slot.steps || [];
      const activeStep = steps.find(step => step.status === 'active');
      const stageText = activeStep ? (activeStep.detail || activeStep.activeLabel || activeStep.pendingLabel) : 'Processing…';
      lines.push(`🔄 <b>Image ${imgNum}/${total} — ${escapeUploadProgressHtml(stageText)}</b>`);
      steps.forEach((step, idx) => {
        const sNum = idx + 1;
        if (step.status === 'done') {
          lines.push(`   ✅ ${sNum}. ${escapeUploadProgressHtml(step.detail || step.doneLabel || step.pendingLabel)}`);
        } else if (step.status === 'active') {
          lines.push(`   🔄 <b>${sNum}. ${escapeUploadProgressHtml(step.detail || step.activeLabel || step.pendingLabel)}</b>`);
        } else if (step.status === 'failed') {
          lines.push(`   ❌ <b>${sNum}. ${escapeUploadProgressHtml(step.detail || (step.pendingLabel + ' — failed'))}</b>`);
        } else {
          lines.push(`   ⬜ ${sNum}. ${escapeUploadProgressHtml(step.pendingLabel)}`);
        }
      });
    } else if (activeIndices.length === 0 && imgNum === firstQueuedIndex && !(batchView && batchView.finished)) {
      lines.push(`⏳ <b>Image ${imgNum}/${total} — Starting next…</b>`);
    } else {
      lines.push(`⬜ Image ${imgNum}/${total} — Queued`);
    }
  }

  return header + '\n\n' + lines.join('\n');
}

function sendTelegramProgressCard(htmlText, chatId, silent, trackForSweep) {
  if (typeof sendTelegramMessage !== 'function') return null;
  try {
    const opts = silent ? { disable_notification: true } : undefined;
    const receipts = opts ? sendTelegramMessage(htmlText, chatId, opts) : sendTelegramMessage(htmlText, chatId);
    if (Array.isArray(receipts) && receipts[0] && receipts[0].message_id) {
      const msgId = receipts[0].message_id;
      if (trackForSweep) trackActiveProgressCardId(chatId, msgId);
      return msgId;
    }
  } catch (_) {
    Logger.log('[Upload progress] Progress message could not be delivered.');
  }
  return null;
}

function startTelegramPhotoBatchProgress(chatId, optOptions) {
  const profile = getUploadProgressProfile('photo', optOptions);
  const mediaGroupId = (optOptions && optOptions.mediaGroupId) || null;
  const botToken = (optOptions && optOptions.botToken) || undefined;
  const cache = getProgressCacheSafe();
  const metaKey = photoBatchMetaKey(chatId);

  let meta = readProgressCacheJson(cache, metaKey);
  if (meta && meta.batchId) {
    const existingItems = readPhotoBatchItems(cache, meta.batchId, meta.nextIndex || meta.total || 0);
    const hasActive = existingItems.some(isPhotoBatchSlotActive);
    if (!hasActive && Date.now() - (meta.updatedAt || 0) > PHOTO_BATCH_STALE_MS) {
      if (meta.messageId) deleteTelegramProgressMessage(chatId, meta.messageId);
      sweepTrackedProgressCards(chatId);
      if (cache) { try { cache.remove(metaKey); } catch (_) {} }
      meta = null;
    }
  } else {
    sweepTrackedProgressCards(chatId);
  }

  // Restore completed sibling album history if a sequential album photo arrives after the prior one closed.
  if (!meta && mediaGroupId && cache) {
    const groupHist = readProgressCacheJson(cache, photoGroupHistKey(mediaGroupId));
    if (groupHist && Array.isArray(groupHist.items) && groupHist.items.length > 0) {
      const restoredId = String(Date.now()) + '_' + Math.floor(Math.random() * 100000);
      groupHist.items.forEach((slot, idx) => {
        if (slot) writeProgressCacheJson(cache, photoBatchItemKey(restoredId, idx + 1), slot, PHOTO_BATCH_TTL_SECONDS);
      });
      meta = {
        batchId: restoredId,
        messageId: null,
        total: groupHist.items.length + 1,
        nextIndex: groupHist.items.length,
        mediaGroupId: mediaGroupId,
        updatedAt: Date.now()
      };
      try { cache.remove(photoGroupHistKey(mediaGroupId)); } catch (_) {}
    }
  }

  if (!meta || !meta.batchId) {
    meta = {
      batchId: String(Date.now()) + '_' + Math.floor(Math.random() * 100000),
      messageId: null,
      total: 1,
      nextIndex: 0,
      mediaGroupId: mediaGroupId,
      updatedAt: Date.now()
    };
  }

  const myIndex = (Number(meta.nextIndex) || 0) + 1;
  meta.nextIndex = myIndex;
  if (mediaGroupId && !meta.mediaGroupId) meta.mediaGroupId = mediaGroupId;
  meta.updatedAt = Date.now();

  const priorSlots = cache ? readPhotoBatchItems(cache, meta.batchId, myIndex - 1) : [];
  const settledBefore = priorSlots.filter(item => item && (item.status === 'done' || item.status === 'failed')).length;
  const pendingAtStart = getTelegramPendingUpdateCount(botToken);
  if (pendingAtStart !== null && pendingAtStart > 0) {
    meta.total = Math.max(Number(meta.total) || 1, myIndex, settledBefore + Math.min(pendingAtStart, 20));
  } else {
    meta.total = Math.max(Number(meta.total) || 1, myIndex);
  }

  const mySlot = {
    index: myIndex,
    status: 'active',
    startedAt: Date.now(),
    percent: profile.steps[0].percent,
    summary: '',
    steps: profile.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? 'active' : 'pending',
      detail: ''
    }))
  };
  writeProgressCacheJson(cache, photoBatchItemKey(meta.batchId, myIndex), mySlot, PHOTO_BATCH_TTL_SECONDS);

  const buildCurrentHtml = (overrideMeta, finishedState) => {
    const activeMeta = overrideMeta || meta;
    const total = Math.max(Number(activeMeta.total) || 1, Number(activeMeta.nextIndex) || 1, myIndex);
    const items = cache
      ? readPhotoBatchItems(cache, activeMeta.batchId, total)
      : [mySlot];
    if (!items[myIndex - 1]) items[myIndex - 1] = mySlot;
    return formatTelegramPhotoBatchHtml({
      total: total,
      finished: finishedState || null,
      isAlbum: Boolean(activeMeta.mediaGroupId || mediaGroupId),
      items: items
    });
  };

  let lastRenderedHtml = buildCurrentHtml(meta, null);
  if (meta.messageId) {
    writeProgressCacheJson(cache, metaKey, meta, PHOTO_BATCH_TTL_SECONDS);
    editTelegramProgressMessage(chatId, meta.messageId, lastRenderedHtml);
  } else {
    meta.messageId = sendTelegramProgressCard(lastRenderedHtml, chatId, false, true);
    writeProgressCacheJson(cache, metaKey, meta, PHOTO_BATCH_TTL_SECONDS);
  }

  const syncLatestMeta = () => {
    const latest = readProgressCacheJson(cache, metaKey);
    if (latest && latest.batchId === meta.batchId) {
      meta = latest;
    }
    return meta;
  };

  const flushBatchEdit = () => {
    writeProgressCacheJson(cache, photoBatchItemKey(meta.batchId, myIndex), mySlot, PHOTO_BATCH_TTL_SECONDS);
    const activeMeta = syncLatestMeta();
    const html = buildCurrentHtml(activeMeta, null);
    if (!activeMeta.messageId || html === lastRenderedHtml) {
      lastRenderedHtml = html;
      return;
    }
    lastRenderedHtml = html;
    editTelegramProgressMessage(chatId, activeMeta.messageId, html);
  };

  const settleSlot = (finalStatus, optCompleteOptions) => {
    writeProgressCacheJson(cache, photoBatchItemKey(meta.batchId, myIndex), mySlot, PHOTO_BATCH_TTL_SECONDS);
    const activeMeta = syncLatestMeta();
    const maxSlot = Math.max(Number(activeMeta.nextIndex) || 1, myIndex);
    const knownSlots = cache ? readPhotoBatchItems(cache, activeMeta.batchId, maxSlot) : [mySlot];
    if (!knownSlots[myIndex - 1]) knownSlots[myIndex - 1] = mySlot;

    const activeOthers = knownSlots.filter(item => item && item.index !== myIndex && isPhotoBatchSlotActive(item)).length;
    const settledCount = knownSlots.filter(item => item && (item.status === 'done' || item.status === 'failed')).length;
    const hasFailed = knownSlots.some(item => item && item.status === 'failed');

    const pendingEnd = getTelegramPendingUpdateCount(botToken);
    const inFlight = activeOthers + 1;
    const waitingBehind = pendingEnd !== null ? Math.max(0, Math.min(pendingEnd, 20) - inFlight) : 0;

    if (activeOthers > 0 || waitingBehind > 0) {
      activeMeta.total = pendingEnd !== null
        ? Math.max(maxSlot, settledCount + activeOthers + waitingBehind)
        : Math.max(Number(activeMeta.total) || 1, maxSlot, settledCount + activeOthers);
      activeMeta.updatedAt = Date.now();
      const html = buildCurrentHtml(activeMeta, null);
      lastRenderedHtml = html;
      // Only re-anchor below a newly posted Proposal Card when no sibling execution is concurrently mid-flight.
      if (activeOthers === 0 && optCompleteOptions && optCompleteOptions.newProposalPosted && activeMeta.messageId &&
          deleteTelegramProgressMessage(chatId, activeMeta.messageId)) {
        activeMeta.messageId = sendTelegramProgressCard(html, chatId, true, true);
      } else if (activeMeta.messageId) {
        editTelegramProgressMessage(chatId, activeMeta.messageId, html);
      }
      writeProgressCacheJson(cache, metaKey, activeMeta, PHOTO_BATCH_TTL_SECONDS);
      meta = activeMeta;
      return;
    }

    // All images in the batch have completed.
    activeMeta.total = maxSlot;
    activeMeta.nextIndex = maxSlot;
    if (cache) {
      try { cache.remove(metaKey); } catch (_) {}
      const groupId = activeMeta.mediaGroupId || mediaGroupId;
      if (groupId && pendingEnd === null) {
        writeProgressCacheJson(cache, photoGroupHistKey(groupId), { items: knownSlots }, 60);
      }
    }

    if (hasFailed || finalStatus === 'failed') {
      const html = buildCurrentHtml(activeMeta, 'failed');
      lastRenderedHtml = html;
      if (activeMeta.messageId) {
        editTelegramProgressMessage(chatId, activeMeta.messageId, html);
        sweepTrackedProgressCards(chatId, activeMeta.messageId);
      }
      return;
    }

    if (activeMeta.messageId) {
      if (!deleteTelegramProgressMessage(chatId, activeMeta.messageId)) {
        const html = buildCurrentHtml(activeMeta, 'done');
        lastRenderedHtml = html;
        editTelegramProgressMessage(chatId, activeMeta.messageId, html);
        untrackActiveProgressCardId(chatId, activeMeta.messageId);
      }
    }
    sweepTrackedProgressCards(chatId);
  };

  let finished = false;
  return {
    getState: () => JSON.parse(JSON.stringify(mySlot)),
    getMessageId: () => syncLatestMeta().messageId,
    completeStep: (stepId, doneDetail) => {
      if (finished) return;
      const step = mySlot.steps.find(item => item.id === stepId);
      if (!step) return;
      step.status = 'done';
      if (doneDetail) step.detail = doneDetail;
      writeProgressCacheJson(cache, photoBatchItemKey(meta.batchId, myIndex), mySlot, PHOTO_BATCH_TTL_SECONDS);
    },
    startStep: (stepId, activeDetail) => {
      if (finished) return;
      const targetIndex = mySlot.steps.findIndex(item => item.id === stepId);
      if (targetIndex === -1) return;
      for (let i = 0; i < targetIndex; i++) {
        if (mySlot.steps[i].status !== 'done') mySlot.steps[i].status = 'done';
      }
      mySlot.steps[targetIndex].status = 'active';
      mySlot.steps[targetIndex].detail = activeDetail || '';
      mySlot.percent = mySlot.steps[targetIndex].percent;
      if (stepId === 'extract') {
        const activeMeta = syncLatestMeta();
        if ((Number(activeMeta.total) || 1) <= myIndex) {
          const pendingNow = getTelegramPendingUpdateCount(botToken);
          if (pendingNow !== null && pendingNow > 1) {
            const priors = cache ? readPhotoBatchItems(cache, activeMeta.batchId, myIndex - 1) : [];
            const settled = priors.filter(item => item && (item.status === 'done' || item.status === 'failed')).length;
            activeMeta.total = Math.max(Number(activeMeta.total) || 1, myIndex, settled + Math.min(pendingNow, 20));
            activeMeta.updatedAt = Date.now();
            writeProgressCacheJson(cache, metaKey, activeMeta, PHOTO_BATCH_TTL_SECONDS);
            meta = activeMeta;
          }
        }
      }
      flushBatchEdit();
    },
    ensureStepStarted: stepId => {
      if (finished) return;
      const target = mySlot.steps.find(item => item.id === stepId);
      if (target && target.status === 'pending') {
        const targetIndex = mySlot.steps.indexOf(target);
        for (let i = 0; i < targetIndex; i++) {
          if (mySlot.steps[i].status !== 'done') mySlot.steps[i].status = 'done';
        }
        target.status = 'active';
        mySlot.percent = target.percent;
        flushBatchEdit();
      }
    },
    complete: (doneDetail, optCompleteOptions) => {
      if (finished) return;
      finished = true;
      mySlot.steps.forEach((step, idx) => {
        step.status = 'done';
        if (idx === mySlot.steps.length - 1 && doneDetail && !step.detail) step.detail = doneDetail;
      });
      mySlot.percent = 100;
      mySlot.status = 'done';
      mySlot.summary = (optCompleteOptions && optCompleteOptions.summary) || doneDetail || 'Processed';
      settleSlot('done', optCompleteOptions);
    },
    fail: () => {
      if (finished) return;
      finished = true;
      let target = mySlot.steps.find(item => item.status === 'active');
      if (!target) target = mySlot.steps.find(item => item.status === 'pending');
      if (target) {
        target.status = 'failed';
        target.detail = target.pendingLabel + ' — failed';
      }
      mySlot.status = 'failed';
      mySlot.summary = target ? target.detail : 'Failed';
      settleSlot('failed');
    }
  };
}

/**
 * Sends and updates a single in-place Telegram progress card for an upload pipeline.
 * Photo uploads use multi-image batch tracking ("Image 1/n, 2/n, …") across sequential and concurrent updates.
 */
function startTelegramUploadProgress(chatId, kind, optOptions) {
  if (kind === 'photo') {
    return startTelegramPhotoBatchProgress(chatId, optOptions);
  }
  const profile = getUploadProgressProfile(kind, optOptions);
  const state = {
    icon: profile.icon,
    title: profile.title,
    percent: profile.steps[0].percent,
    finished: null,
    steps: profile.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? 'active' : 'pending',
      detail: ''
    }))
  };

  let messageId = sendTelegramProgressCard(formatTelegramUploadProgressHtml(state), chatId, false);
  let lastRenderedHtml = formatTelegramUploadProgressHtml(state);

  const flushEdit = () => {
    const html = formatTelegramUploadProgressHtml(state);
    if (!messageId || html === lastRenderedHtml) {
      lastRenderedHtml = html;
      return;
    }
    lastRenderedHtml = html;
    editTelegramProgressMessage(chatId, messageId, html);
  };

  return {
    getState: () => JSON.parse(JSON.stringify(state)),
    getMessageId: () => messageId,
    completeStep: (stepId, doneDetail) => {
      if (state.finished) return;
      const step = state.steps.find(item => item.id === stepId);
      if (!step) return;
      step.status = 'done';
      if (doneDetail) step.detail = doneDetail;
    },
    startStep: (stepId, activeDetail) => {
      if (state.finished) return;
      const targetIndex = state.steps.findIndex(item => item.id === stepId);
      if (targetIndex === -1) return;
      for (let i = 0; i < targetIndex; i++) {
        if (state.steps[i].status !== 'done') state.steps[i].status = 'done';
      }
      state.steps[targetIndex].status = 'active';
      state.steps[targetIndex].detail = activeDetail || '';
      state.percent = state.steps[targetIndex].percent;
      flushEdit();
    },
    ensureStepStarted: stepId => {
      if (state.finished) return;
      const target = state.steps.find(item => item.id === stepId);
      if (target && target.status === 'pending') {
        const targetIndex = state.steps.indexOf(target);
        for (let i = 0; i < targetIndex; i++) {
          if (state.steps[i].status !== 'done') state.steps[i].status = 'done';
        }
        target.status = 'active';
        state.percent = target.percent;
        flushEdit();
      }
    },
    complete: doneDetail => {
      if (state.finished) return;
      state.steps.forEach((step, idx) => {
        step.status = 'done';
        if (idx === state.steps.length - 1 && doneDetail && !step.detail) step.detail = doneDetail;
      });
      state.percent = 100;
      state.finished = 'done';
      if (messageId) {
        if (!deleteTelegramProgressMessage(chatId, messageId)) {
          flushEdit();
        }
      }
    },
    fail: () => {
      if (state.finished) return;
      let target = state.steps.find(item => item.status === 'active');
      if (!target) target = state.steps.find(item => item.status === 'pending');
      if (target) {
        target.status = 'failed';
        target.detail = target.pendingLabel + ' — failed';
      }
      state.finished = 'failed';
      flushEdit();
    }
  };
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
      const safeMsg = redactSecretsFromText(err && err.message);
      lastError = new Error(safeMsg || 'HTTP request failed');
      Logger.log(`Fetch attempt ${attempt}/${maxRetries} failed: ${safeMsg}`);
      if (attempt < maxRetries && typeof Utilities !== 'undefined' && Utilities && typeof Utilities.sleep === 'function') {
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
