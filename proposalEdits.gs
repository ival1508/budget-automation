/** Free-text proposal editing. The model proposes patches; only this code applies them. */

function telegramProposalRevision(transactions) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(transactions), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function escapeProposalCommentHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Conversation is scoped to one chat, proposal and exact revision, never a global merchant rule. */
function getTelegramProposalCommentContext(chatId, token, transactions) {
  const stored = CacheService.getScriptCache().get('proposal_comment_context:' + chatId + ':' + token);
  if (stored) {
    try {
      const context = JSON.parse(stored);
      if (context.revision === telegramProposalRevision(transactions) && Array.isArray(context.turns) &&
          Array.isArray(context.lastEditedItems)) return context;
    } catch (err) { Logger.log('Ignoring invalid proposal comment context.'); }
  }
  return { turns: [], lastEditedItems: [] };
}

function saveTelegramProposalCommentContext(chatId, token, transactions, context, comment, response, lastEditedItems) {
  const turns = context.turns.concat([
    { role: 'user', text: String(comment).slice(0, 1500) },
    { role: 'assistant', text: String(response).slice(0, 1500) }
  ]).slice(-12);
  const updated = { revision: telegramProposalRevision(transactions), turns: turns,
    lastEditedItems: lastEditedItems === undefined ? context.lastEditedItems : lastEditedItems };
  CacheService.getScriptCache().put('proposal_comment_context:' + chatId + ':' + token,
    JSON.stringify(updated), CACHE_EXPIRATION_SECONDS);
}

/** Ending an older proposal must not cancel comment mode for a newer one. */
function finishTelegramProposalComment(chatId, token) {
  const cache = CacheService.getScriptCache();
  const key = 'awaiting_proposal_comment:' + chatId;
  const saved = cache.get(key);
  if (saved && JSON.parse(saved).token === token) cache.remove(key);
  cache.remove('proposal_comment_context:' + chatId + ':' + token);
}

function rememberTelegramProposalComment(chatId, messageId, token, transactions) {
  const state = { token: token, messageId: messageId, requestId: Utilities.getUuid(),
    revision: telegramProposalRevision(transactions), expiresAt: Date.now() + 5 * 60 * 1000 };
  // Keep an expired marker as long as the proposal so a late reply is never a new spend.
  CacheService.getScriptCache().put('awaiting_proposal_comment:' + chatId,
    JSON.stringify(state), CACHE_EXPIRATION_SECONDS);
  return state;
}

function startTelegramProposalComment(chatId, messageId, token, transactions) {
  CacheService.getScriptCache().remove('awaiting_merchant:' + chatId);
  rememberTelegramProposalComment(chatId, messageId, token, transactions);
  sendTelegramMessage('💬 Describe changes to this proposal, for example: “Change Cold Storage to Дом” or “Make the Unity amount 46.86.”\n' +
    'You can use merchant names or item numbers, then follow up with “make it back” or another correction. If several purchases match, specify an amount or date. I’ll show the revised proposal for approval. Send /cancel to stop editing. This request expires after 5 minutes of inactivity.', chatId);
}

/** Returns true only when the incoming text belongs to an explicit proposal edit flow. */
function handleTelegramProposalComment(message) {
  const text = String(message.text || '').trim();
  const chatId = message.chat.id;
  const cache = CacheService.getScriptCache();
  const stateKey = 'awaiting_proposal_comment:' + chatId;
  const editCommand = text.match(/^\/edit(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    const pending = cache.get(stateKey);
    const token = pending ? JSON.parse(pending).token :
      PropertiesService.getUserProperties().getProperty('latest_token_' + chatId);
    if (token) finishTelegramProposalComment(chatId, token);
    cache.remove(stateKey);
    cache.remove('awaiting_merchant:' + chatId);
    sendTelegramMessage('Comment editing cancelled. Your proposal is unchanged.', chatId);
    return true;
  }
  const userProps = PropertiesService.getUserProperties();
  const latestMessageId = userProps.getProperty('latest_message_id_' + chatId);
  const isProposalReply = message.reply_to_message && latestMessageId &&
    String(message.reply_to_message.message_id) === String(latestMessageId);
  const saved = cache.get(stateKey);
  if (!editCommand && !saved && !isProposalReply) return false;

  let state;
  let snapshot;
  let context;
  try {
    // Replying to the proposal or /edit explicitly chooses the current revision.
    state = saved && !editCommand && !isProposalReply ? JSON.parse(saved) : null;
    withTelegramProposalLock(() => {
      const token = state ? state.token : userProps.getProperty('latest_token_' + chatId);
      const rows = getPendingTransactions(token);
      if (!Array.isArray(rows) || !rows.length || (state &&
          (state.expiresAt < Date.now() || state.revision !== telegramProposalRevision(rows)))) {
        throw new Error('The proposal changed or this edit request expired. Tap 💬 Comment on the current proposal to try again.');
      }
      snapshot = rows;
      state = rememberTelegramProposalComment(chatId, state ? state.messageId : latestMessageId, token, rows);
      context = getTelegramProposalCommentContext(chatId, token, rows);
    });
    if (editCommand) cache.remove('awaiting_merchant:' + chatId);
    const comment = editCommand ? String(editCommand[1] || '').trim() : text;
    if (!comment) {
      sendTelegramMessage('💬 Type your changes using merchant names or item numbers, or send /cancel. Example: “Change Cold Storage to Дом.”', chatId);
      return true;
    }
    // Model latency holds no proposal lock. A second snapshot check prevents stale overwrites.
    const plan = generateProposalEditPlan(comment, snapshot, context);
    const result = applyProposalEditPlan(snapshot, plan);
    withTelegramProposalLock(() => {
      const current = getPendingTransactions(state.token);
      const activeRequest = cache.get(stateKey);
      const request = activeRequest ? JSON.parse(activeRequest) : null;
      if (!Array.isArray(current) || telegramProposalRevision(current) !== state.revision ||
          !request || request.requestId !== state.requestId || request.token !== state.token) {
        throw new Error('The proposal changed while I was interpreting your comment. Tap 💬 Comment to try again.');
      }
      if (result.clarification) {
        saveTelegramProposalCommentContext(chatId, state.token, current, context, comment, result.clarification);
        sendTelegramMessage(escapeProposalCommentHtml(result.clarification), chatId);
        return;
      }
      if (!result.summary.length) {
        const reply = 'No changes applied. Describe the merchant and fields you want to change, or send /cancel.';
        saveTelegramProposalCommentContext(chatId, state.token, current, context, comment, reply);
        sendTelegramMessage(reply, chatId);
        return;
      }
      if (result.transactions.length) {
        const checked = flagExistingDuplicates(result.transactions);
        savePendingTransactions(checked, state.token);
        // Keep the request until both the revised card and its recap have been delivered.
        rememberTelegramProposalComment(chatId, state.messageId, state.token, checked);
        if (state.messageId) refreshProposalCard(chatId, state.messageId, state.token, checked);
        else sendConfirmationMessage(chatId, state.token, checked, true);
        const revised = getPendingTransactions(state.token);
        saveTelegramProposalCommentContext(chatId, state.token, revised, context, comment,
          result.summary.join('\n'), result.editedItems);
        rememberTelegramProposalComment(chatId, state.messageId, state.token, revised);
      } else {
        clearPendingTransactions(state.token);
        finishTelegramProposalComment(chatId, state.token);
        if (state.messageId) sendDiscardedMessage(chatId, state.messageId, '🗑️ All items removed by your comment. Nothing logged.');
      }
      const lines = result.summary.map(escapeProposalCommentHtml);
      sendTelegramMessage('📝 <b>Proposal changes</b>\n' + lines.join('\n') +
        (result.transactions.length ? '\n\nReview the revised proposal and tap Approve All to save. Merchant, category, account and type corrections are recorded as rules after approval.' : '\nNothing logged; no rules recorded.'), chatId);
    });
  } catch (err) {
    Logger.log('Proposal comment failed: ' + err.message);
    // Keep edit mode on failure: a retry must not become a fresh transaction.
    sendTelegramMessage('⚠️ Could not complete the comment edit. ' + escapeProposalCommentHtml(err.message), chatId);
  }
  return true;
}

/** Validate the entire plan before changing cached state, including every item number and field. */
function applyProposalEditPlan(transactions, plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.operations) ||
      typeof plan.clarification !== 'string') throw new Error('Invalid edit response. Please try again.');
  if (plan.clarification.trim()) {
    if (plan.operations.length) throw new Error('The edit response mixed a question with changes. Please clarify your request.');
    return { clarification: plan.clarification, transactions: transactions, summary: [] };
  }
  const allowed = ['where', 'category', 'account', 'type', 'amount', 'currency', 'date', 'amount_sgd', 'notes'];
  const edits = new Map();
  const summary = [];
  for (const op of plan.operations) {
    if (!op || !Number.isInteger(op.item) || op.item < 1 || op.item > transactions.length ||
        !['update', 'remove'].includes(op.action) || edits.has(op.item)) {
      throw new Error('Could not identify the transaction in the edit response. Please name the merchant and, if needed, its amount or date.');
    }
    const original = transactions[op.item - 1];
    if (op.action === 'remove') {
      if (op.changes && Object.keys(op.changes).length) throw new Error('A removed item cannot also be updated.');
      edits.set(op.item, null);
      summary.push(original.where + ' (item ' + op.item + '): removed.');
      continue;
    }
    if (!op.changes || typeof op.changes !== 'object' || Array.isArray(op.changes) ||
        Object.keys(op.changes).some(field => !allowed.includes(field))) {
      throw new Error('The edit response contains an unsupported field.');
    }
    const changes = Object.assign({}, op.changes);
    for (const field of Object.keys(changes)) {
      const value = changes[field];
      if (['amount', 'amount_sgd'].includes(field)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new Error('Item ' + op.item + ': amounts must be positive numbers. Use the transaction type to change direction.');
        }
      } else if (typeof value !== 'string' || (field !== 'notes' && !value.trim())) {
        throw new Error('Item ' + op.item + ': invalid ' + field + '.');
      }
      if (field === 'category' && !CATEGORIES.includes(value)) throw new Error('Unknown category: ' + value);
      if (field === 'account' && !ACCOUNTS.includes(value)) throw new Error('Unknown account: ' + value);
      if (field === 'type' && !ALL_TYPES.includes(value)) throw new Error('Unknown transaction type: ' + value);
      if (field === 'currency') {
        changes.currency = value.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(changes.currency)) throw new Error('Use a three-letter currency code.');
      }
      if (field === 'date') {
        const date = normalizeDateString(value);
        const match = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        const parsed = match && new Date(Date.UTC(+match[3], +match[2] - 1, +match[1]));
        if (!match || parsed.getUTCDate() !== +match[1] || parsed.getUTCMonth() + 1 !== +match[2] ||
            parsed.getUTCFullYear() !== +match[3]) throw new Error('Invalid transaction date: ' + value);
        changes.date = date;
      }
    }
    const fields = Object.keys(changes).filter(field => changes[field] !== original[field]);
    if (!fields.length) { edits.set(op.item, original); continue; }
    const candidate = JSON.parse(JSON.stringify(original));
    if (fields.some(field => ['where', 'category', 'account', 'type'].includes(field))) {
      captureTelegramRuleBaseline(candidate);
    }
    Object.assign(candidate, changes);
    candidate.manual_merchant_category = true;
    const identityChanged = fields.some(field => ['where', 'amount', 'currency', 'date', 'account'].includes(field));
    if (identityChanged) candidate.flags = (candidate.flags || []).filter(flag =>
      !['possible_duplicate', 'force_add', 'skipped'].includes(flag));
    if (candidate.currency !== 'SGD' && (fields.includes('currency') || fields.includes('amount')) &&
        !Object.prototype.hasOwnProperty.call(changes, 'amount_sgd')) candidate.amount_sgd = null;
    if (candidate.currency === 'SGD' && Object.prototype.hasOwnProperty.call(changes, 'amount_sgd') &&
        changes.amount_sgd !== candidate.amount) throw new Error('For SGD, the SGD amount must equal the transaction amount.');
    const enriched = enrichTransaction(candidate);
    if (changes.type && enriched.type !== changes.type) {
      throw new Error('Item ' + op.item + ': that type conflicts with its category or reimbursement flags. Please clarify both.');
    }
    edits.set(op.item, enriched);
    const actualFields = allowed.filter(field => enriched[field] !== original[field]);
    summary.push(enriched.where + ' (item ' + op.item + '): ' + actualFields.map(field =>
      field + ': ' + (original[field] == null ? '—' : original[field]) + ' → ' +
      (enriched[field] == null ? '—' : enriched[field])).join('; '));
  }
  const remaining = transactions.map((txn, index) => edits.has(index + 1) ? edits.get(index + 1) : txn)
    .filter(txn => txn !== null);
  // Record current positions after removals, so "it" cannot target an item that shifted into its place.
  const changed = new Set(Array.from(edits.entries()).filter(([item, txn]) => txn && txn !== transactions[item - 1])
    .map(([, txn]) => txn));
  return { transactions: remaining, summary: summary,
    editedItems: remaining.map((txn, index) => changed.has(txn) ? index + 1 : null).filter(item => item !== null) };
}
