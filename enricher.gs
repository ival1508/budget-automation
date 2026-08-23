/**
 * Budget 2026 Automation v1 - Enriched Transaction & Deduplication Logic
 * File: enricher.gs
 */

/**
 * Normalises a merchant/location string for consistent deduplication.
 * Converts string to lowercase, trims leading/trailing whitespace, and collapses multiple spaces.
 * 
 * @param {string} where - Raw or extracted merchant/location string.
 * @return {string} Normalised merchant string.
 */
function normaliseWhere(where) {
  if (!where || typeof where !== 'string') {
    return '';
  }
  return where
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Retrieves the merchant alias mapping from Script Properties.
 * @return {Object} Dictionary of normalized raw names to preferred names / category metadata.
 */
function getMerchantAliases() {
  const props = PropertiesService.getScriptProperties();
  const aliasesJson = props.getProperty('MERCHANT_ALIASES');
  if (!aliasesJson) return {};
  try {
    return JSON.parse(aliasesJson);
  } catch (e) {
    return {};
  }
}

/**
 * Saves a new merchant alias mapping and category preference to Script Properties and the Merchants sheet.
 * Records how the user renames a merchant (raw -> canonical) or changes a category for that merchant.
 * 
 * @param {string} rawName - The original merchant name or raw snippet.
 * @param {string} newName - The preferred canonical merchant name.
 * @param {string} [category] - Optional preferred category for this merchant.
 */
function saveMerchantAlias(rawName, newName, category) {
  if (!rawName && !newName) return;
  const canonicalName = (newName || rawName).trim();
  if (!canonicalName) return;

  const aliases = getMerchantAliases();
  const rawKey = normaliseWhere(rawName || canonicalName);

  aliases[rawKey] = {
    canonical: canonicalName,
    category: category || (aliases[rawKey] && aliases[rawKey].category) || null
  };

  // If rawName differs from canonicalName, also register canonicalName key
  const canonicalKey = normaliseWhere(canonicalName);
  if (category && (!aliases[canonicalKey] || aliases[canonicalKey].category !== category)) {
    aliases[canonicalKey] = {
      canonical: canonicalName,
      category: category
    };
  }

  PropertiesService.getScriptProperties().setProperty('MERCHANT_ALIASES', JSON.stringify(aliases));

  // Persist to Merchants sheet for permanent storage and auditability
  try {
    const merchantsSheet = initializeLearningStore();
    const lastRow = merchantsSheet.getLastRow();
    const todayStr = formatSheetDate(new Date());
    let found = false;

    if (lastRow >= 2) {
      const numCols = Math.max(5, merchantsSheet.getLastColumn());
      const data = merchantsSheet.getRange(2, 1, lastRow - 1, numCols).getValues();
      for (let r = 0; r < data.length; r++) {
        const mName = String(data[r][0] || '').trim();
        if (normaliseWhere(mName) === canonicalKey) {
          found = true;
          const currentCategory = category || data[r][1] || 'Другое';
          const count = (Number(data[r][2]) || 0) + 1;
          let aliasList = String(data[r][4] || '').split(',').map(s => s.trim()).filter(Boolean);
          if (rawName && normaliseWhere(rawName) !== canonicalKey && !aliasList.includes(rawName.trim())) {
            aliasList.push(rawName.trim());
          }
          merchantsSheet.getRange(r + 2, 1, 1, 5).setValues([[
            canonicalName,
            currentCategory,
            count,
            todayStr,
            aliasList.join(', ')
          ]]);
          break;
        }
      }
    }

    if (!found) {
      const aliasStr = (rawName && normaliseWhere(rawName) !== canonicalKey) ? rawName.trim() : '';
      merchantsSheet.appendRow([
        canonicalName,
        category || 'Другое',
        1,
        todayStr,
        aliasStr
      ]);
    }
  } catch (e) {
    Logger.log('Note: Failed to update Merchants sheet in saveMerchantAlias: ' + e.message);
  }
}

/**
 * Robustly normalizes any date input (Date object, ISO string, DD.MM.YYYY, DD/MM/YYYY)
 * into a canonical DD.MM.YYYY string format.
 * 
 * @param {string|Date} dateVal - Raw date value from input or sheet.
 * @return {string} Canonical date string in DD.MM.YYYY.
 */
function normalizeDateString(dateVal) {
  if (!dateVal) return '';
  if (dateVal instanceof Date) {
    try {
      return Utilities.formatDate(dateVal, 'Asia/Singapore', 'dd.MM.yyyy');
    } catch (e) {
      const d = String(dateVal.getDate()).padStart(2, '0');
      const m = String(dateVal.getMonth() + 1).padStart(2, '0');
      return `${d}.${m}.${dateVal.getFullYear()}`;
    }
  }
  const str = String(dateVal).trim();
  // Match YYYY-MM-DD, YYYY.MM.DD, or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return `${d}.${m}.${y}`;
  }
  // Match DD.MM.YYYY, DD/MM/YYYY, or DD-MM-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = dmyMatch[2].padStart(2, '0');
    const y = dmyMatch[3];
    return `${d}.${m}.${y}`;
  }
  // Match DD.MM.YY, DD/MM/YY, or DD-MM-YY (e.g. 21.08.26)
  const dmyShortMatch = str.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2})$/);
  if (dmyShortMatch) {
    const d = dmyShortMatch[1].padStart(2, '0');
    const m = dmyShortMatch[2].padStart(2, '0');
    const y = '20' + dmyShortMatch[3];
    return `${d}.${m}.${y}`;
  }
  return str;
}

/**
 * Normalises a merchant string by stripping non-alphanumeric noise for robust comparison.
 * 
 * @param {string} where - Merchant / location string.
 * @return {string} Compact alphanumeric merchant string.
 */
function compactWhere(where) {
  if (!where || typeof where !== 'string') return '';
  return where
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]/gi, '');
}

/**
 * Generates a deterministic deduplication key for a transaction.
 * Specification (§6.7): hash(date, account, round(amount,2), normalise(where))
 * 
 * @param {string|Date} date - Date string or Date object.
 * @param {string} account - Account name (e.g., 'DBS CC SGD').
 * @param {number} amount - Transaction amount.
 * @param {string} where - Merchant / location description.
 * @return {string} SHA-256 hex string deduplication key.
 */
function generateDedupeKey(date, account, amount, where) {
  const normDate = normalizeDateString(date);
  const normAccount = (account || DEFAULT_ACCOUNT).toLowerCase().trim();
  const roundedAmount = Number(amount || 0).toFixed(2);
  const compWhere = compactWhere(where);
  const rawKey = `${normDate}|${normAccount}|${roundedAmount}|${compWhere}`;

  // In Google Apps Script, Utilities.computeDigest generates SHA-256 byte array
  const rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    rawKey,
    Utilities.Charset.UTF_8
  );

  return rawHash
    .map(byte => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generates candidate keys for fuzzy duplicate detection across accounts & settlement dates.
 * 
 * @param {string|Date} date - Date string or Date object.
 * @param {string} account - Account name.
 * @param {number} amount - Transaction amount.
 * @param {string} where - Merchant / location description.
 * @return {Array<string>} Array of candidate match signatures.
 */
function generateFuzzyDedupeKeys(date, account, amount, where) {
  const normDate = normalizeDateString(date);
  const roundedAmount = Number(amount || 0).toFixed(2);
  const compWhere = compactWhere(where);

  if (!normDate || !compWhere || Number(roundedAmount) === 0) return [];

  const keys = [
    `${normDate}|any_acc|${roundedAmount}|${compWhere}`
  ];

  return keys;
}

/**
 * Deterministically enriches a parsed transaction object with 50/30/20 bucket,
 * currency calculations, default inferences, and a deduplication key.
 * 
 * @param {Object} parsedRow - The raw/parsed transaction object from LLM or input parser.
 * @return {Object} The enriched transaction object ready for confirmation / writing.
 * @throws {Error} If category is invalid/unmapped (strictly no fallback guessing).
 */
function enrichTransaction(parsedRow) {
  if (!parsedRow || typeof parsedRow !== 'object') {
    throw new Error('enrichTransaction requires a valid transaction object.');
  }

  // 1. Merchant Aliases & Learned Naming / Category Recovery
  let where = parsedRow.where || '';
  parsedRow.raw_where = parsedRow.raw_where || where;

  const aliases = getMerchantAliases();
  const rawNorm = normaliseWhere(where);
  const rawSnippetNorm = normaliseWhere(parsedRow.raw_snippet || '');
  const aliasMatch = aliases[rawNorm] || (rawSnippetNorm ? aliases[rawSnippetNorm] : null);

  if (aliasMatch) {
    const canonicalName = typeof aliasMatch === 'string' ? aliasMatch : (aliasMatch.canonical || aliasMatch.name);
    if (canonicalName) {
      where = canonicalName;
      parsedRow.where = where;
    }
    if (typeof aliasMatch === 'object' && aliasMatch.category && (!parsedRow.category || parsedRow.category === 'Другое')) {
      parsedRow.category = aliasMatch.category;
    }
  }

  // 2. Deterministic 50/30/20 Bucket Assignment (§4.6, §6.3)
  const category = parsedRow.category || (aliasMatch && typeof aliasMatch === 'object' && aliasMatch.category) || 'Другое';
  if (!category || !(category in CATEGORY_TO_BUCKET_MAP)) {
    throw new Error(
      `Invalid or unmapped category: "${category}". Fallback bucket guessing is disallowed.`
    );
  }
  const bucket = CATEGORY_TO_BUCKET_MAP[category];

  // 3. Currency & SGD Amount Calculation (§4.5, §6.2)
  const currency = (parsedRow.currency || 'SGD').toUpperCase();
  const amount = Number(parsedRow.amount) || 0;
  let amountSgd = parsedRow.amount_sgd;
  let needsReview = Boolean(parsedRow.needs_review);
  const flags = Array.isArray(parsedRow.flags) ? [...parsedRow.flags] : [];

  if (currency === 'SGD') {
    amountSgd = amount;
  } else {
    needsReview = true;
    if (!flags.includes('foreign_currency')) {
      flags.push('foreign_currency');
    }
  }

  // 4. Defaults & Inferences
  const date = parsedRow.date || '';
  const account = parsedRow.account || DEFAULT_ACCOUNT;
  let type = parsedRow.type || TRANSACTION_TYPES.EXPENSE;

  // GUARDRAIL: Enforce Fixed Expense rule strictly by category
  const isFixedType = (type === TRANSACTION_TYPES.FIXED_EXPENSE || type === 'Обязательные расходы\t');
  if (isFixedType && !FIXED_EXPENSE_CATEGORIES.includes(category)) {
    type = TRANSACTION_TYPES.EXPENSE;
  }

  // Programmatic guarantee: All independent papa charges must be marked reimbursable AND set to "Снятие денег"
  if (flags.indexOf('papa_charge') !== -1) {
    if (flags.indexOf('reimbursable') === -1) {
      flags.push('reimbursable');
    }
    // Hard override to exclude from monthly budget
    type = TRANSACTION_TYPES.PASS_THROUGH || 'Снятие денег';
  }

  // 4. Deduplication Key Generation (§6.7)
  const dedupeKey = generateDedupeKey(date, account, amount, where);

  return {
    ...parsedRow,
    date: date,
    account: account,
    type: type,
    amount: amount,
    currency: currency,
    amount_sgd: amountSgd,
    where: where,
    category: category,
    bucket: bucket,
    confidence: parsedRow.confidence || { amount: 1.0, date: 1.0, category: 1.0 },
    needs_review: needsReview,
    flags: flags,
    source: parsedRow.source || 'unknown',
    raw_snippet: parsedRow.raw_snippet || '',
    dedupe_key: dedupeKey
  };
}

/**
 * Helper to fetch existing deduplication keys from the "Transactions" tab.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @return {Set<string>} Set of existing deduplication keys.
 */
function getExistingDedupeKeysFromSheet(ss) {
  const existingSet = new Set();
  try {
    const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return existingSet;

    const sheet = spreadsheet.getSheetByName('Transactions');
    if (!sheet) return existingSet;

    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return existingSet;

    // Read range A2:I (Col A: Date, Col B: Account, Col D: Amount, Col E: Amount SGD, Col I: Where)
    const rawValues = sheet.getRange(2, 1, lastRow - 1, 9).getValues();

    for (let r = 0; r < rawValues.length; r++) {
      const dateStr = normalizeDateString(rawValues[r][0]);
      const accountStr = String(rawValues[r][1] || DEFAULT_ACCOUNT).trim();
      const amountVal = parseFloat(rawValues[r][4]) || parseFloat(rawValues[r][3]) || 0;
      const whereStr = String(rawValues[r][8] || '').trim();

      if (dateStr && (amountVal > 0 || whereStr)) {
        const key = generateDedupeKey(dateStr, accountStr, amountVal, whereStr);
        existingSet.add(key);
        const fuzzyKeys = generateFuzzyDedupeKeys(dateStr, accountStr, amountVal, whereStr);
        fuzzyKeys.forEach(k => existingSet.add(k));
      }
    }
  } catch (e) {
    Logger.log(`Error in getExistingDedupeKeysFromSheet: ${e.message}`);
  }
  return existingSet;
}

/**
 * Reconciles extracted transactions against existing sheet data (UC-5).
 * Generates Phase 1 dedupe keys for extracted transactions and compares them
 * against a Set of existing dedupe keys from the sheet.
 * 
 * @param {Array<Object>} extractedTransactions - Array of extracted transaction objects.
 * @param {Array<Object>|Array<string>|Set<string>} [existingSheetData] - Optional existing sheet data or dedupe key set.
 * @return {Array<Object>} Array containing ONLY the missing transactions not yet in the sheet.
 */
function getMissingTransactions(extractedTransactions, existingSheetData) {
  if (!Array.isArray(extractedTransactions)) {
    return [];
  }

  let existingKeysSet = new Set();

  if (existingSheetData instanceof Set) {
    existingKeysSet = existingSheetData;
  } else if (Array.isArray(existingSheetData)) {
    existingSheetData.forEach(item => {
      if (typeof item === 'string') {
        existingKeysSet.add(item);
      } else if (item && typeof item === 'object') {
        if (item.dedupe_key) {
          existingKeysSet.add(item.dedupe_key);
        } else {
          const date = item.date || '';
          const account = item.account || DEFAULT_ACCOUNT;
          const amount = item.amount || 0;
          const where = item.where || item.description || '';
          const key = generateDedupeKey(date, account, amount, where);
          existingKeysSet.add(key);
        }
      }
    });
  } else {
    // Fetch directly from sheet if not explicitly provided
    existingKeysSet = getExistingDedupeKeysFromSheet();
  }

  const missing = [];

  for (let i = 0; i < extractedTransactions.length; i++) {
    const txn = extractedTransactions[i];
    const date = txn.date || '';
    const account = txn.account || DEFAULT_ACCOUNT;
    const amount = txn.amount || 0;
    const where = txn.where || txn.description || '';

    const key = txn.dedupe_key || generateDedupeKey(date, account, amount, where);

    if (!existingKeysSet.has(key)) {
      txn.dedupe_key = key;
      missing.push(txn);
    }
  }

  return missing;
}
