/**
 * Budget 2026 Automation v1 - Telegram Confirmation State Store
 * File: state.gs
 * 
 * Manages transient confirmation state for proposed transactions using CacheService (§5.3).
 */

const CACHE_EXPIRATION_SECONDS = 21600; // 6 hours (§5.3)

/** Shared by proposal callbacks, renames, screenshot merges and comment commits. */
function withTelegramProposalLock(operation) {
  const lock = LockService.getUserLock();
  lock.waitLock(30000);
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Saves pending proposed transactions into CacheService keyed by a short session token.
 * 
 * @param {Array<Object>} transactionsArray - Enriched proposed transactions array.
 * @return {string} Short unique session token (8 chars).
 */
function savePendingTransactions(transactionsArray, existingToken) {
  if (!Array.isArray(transactionsArray) || transactionsArray.length === 0) {
    throw new Error('savePendingTransactions requires a non-empty transactions array.');
  }

  const token = existingToken || Utilities.getUuid().substring(0, 8);
  const cache = CacheService.getScriptCache();
  const jsonPayload = JSON.stringify(transactionsArray);
  // Receipt detail can exceed CacheService's 100KB per-value limit. Keep each
  // chunk below 72KB even with four-byte characters; publish the manifest last.
  if (jsonPayload.length <= 18000) cache.put(token, jsonPayload, CACHE_EXPIRATION_SECONDS);
  else {
    if (jsonPayload.length > 720000) throw new Error('This proposal is too large. Please approve a smaller receipt batch.');
    const revision = Utilities.getUuid();
    let chunks = 0;
    for (let offset = 0; offset < jsonPayload.length;) {
      let end = Math.min(offset + 18000, jsonPayload.length);
      if (end < jsonPayload.length && /[\uD800-\uDBFF]/.test(jsonPayload[end - 1])) end--;
      cache.put(token + ':' + revision + ':' + chunks++, jsonPayload.slice(offset, end), CACHE_EXPIRATION_SECONDS);
      offset = end;
    }
    cache.put(token, JSON.stringify({ pending_chunks: chunks, revision: revision }), CACHE_EXPIRATION_SECONDS);
  }
  Logger.log(`Saved pending state with token: ${token} (${transactionsArray.length} transaction(s), expires in 6h).`);

  return token;
}

/**
 * Retrieves pending proposed transactions from CacheService by session token.
 * 
 * @param {string} token - Short session token.
 * @return {Array<Object>|null} Array of transaction objects or null if expired/missing.
 */
function getPendingTransactions(token) {
  if (!token) return null;

  const cache = CacheService.getScriptCache();
  const cachedJson = cache.get(token);

  if (!cachedJson) {
    Logger.log(`Pending state for token "${token}" not found or expired.`);
    return null;
  }

  if (cachedJson === "PROCESSED") {
    Logger.log(`Token "${token}" was already processed.`);
    return "PROCESSED";
  }

  try {
    const parsed = JSON.parse(cachedJson);
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || !Number.isInteger(parsed.pending_chunks) || parsed.pending_chunks < 1 || parsed.pending_chunks > 41 || typeof parsed.revision !== 'string') return null;
    let json = '';
    for (let i = 0; i < parsed.pending_chunks; i++) {
      const part = cache.get(token + ':' + parsed.revision + ':' + i);
      if (part === null || part === undefined) return null;
      json += part;
    }
    const transactions = JSON.parse(json);
    return Array.isArray(transactions) ? transactions : null;
  } catch (e) {
    Logger.log(`Failed to parse cached transaction state for token "${token}": ${e.message}`);
    return null;
  }
}

/**
 * Clears pending proposed transactions from CacheService for a given token.
 * 
 * @param {string} token - Short session token.
 */
function clearPendingTransactions(token) {
  if (!token) return;
  const cache = CacheService.getScriptCache();
  cache.put(token, "PROCESSED", CACHE_EXPIRATION_SECONDS);
  Logger.log(`Cleared pending state (set to PROCESSED) for token: ${token}`);
}
