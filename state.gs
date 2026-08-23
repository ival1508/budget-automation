/**
 * Budget 2026 Automation v1 - Telegram Confirmation State Store
 * File: state.gs
 * 
 * Manages transient confirmation state for proposed transactions using CacheService (§5.3).
 */

const CACHE_EXPIRATION_SECONDS = 21600; // 6 hours (§5.3)

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

  cache.put(token, jsonPayload, CACHE_EXPIRATION_SECONDS);
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
    return JSON.parse(cachedJson);
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
