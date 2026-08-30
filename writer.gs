/**
 * Budget 2026 Automation v1 - Sheet Writer Component
 * File: writer.gs
 */

/**
 * Formats a sheet cell value (string or Date object) into a DD.MM.YYYY string.
 * 
 * @param {string|Date} cellValue - Value read from column A.
 * @return {string} Formatted date string in DD.MM.YYYY.
 */
/**
 * Formats a sheet cell value (string or Date object) into a DD.MM.YYYY string.
 * 
 * @param {string|Date} cellValue - Value read from column A.
 * @return {string} Formatted date string in DD.MM.YYYY.
 */
function formatSheetDate(cellValue) {
  return typeof normalizeDateString === 'function' ? normalizeDateString(cellValue) : String(cellValue || '').trim();
}

/**
 * Appends approved transactions to the 'Transactions' sheet.
 * 
 * Enforces key invariants:
 * 1. Batch writes input columns (A-E, H-J) in a single setValues operation (§6.6).
 * 2. Writes raw SGD numerical amount to BOTH column D (Сумма) and column E (Сумма в SGD) (§4.3, §6.6).
 * 3. Does NOT compute running balances in code. Copies F:G per-cell formulas down from row above (§4.3, §6.6).
 * 4. Checks if account in column B has ever appeared in the sheet before.
 *    For the VERY FIRST row of a new account, writes literal `0` into column F instead of copying formula (§6.6).
 * 5. Idempotent: Skips rows whose dedupe_key already exists in the sheet (§6.6, §6.7).
 * 
 * @param {Array<Object>} transactionsArray - Array of enriched transaction objects.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - Optional Spreadsheet instance.
 * @param {boolean} [optDryRun] - Optional override for DRY_RUN mode.
 * @return {Object} Result summary { writtenCount, skippedCount, writtenRows, dryRun }.
 */
function appendTransactions(transactionsArray, ss, optDryRun) {
  if (!Array.isArray(transactionsArray) || transactionsArray.length === 0) {
    return { writtenCount: 0, skippedCount: 0, writtenRows: [] };
  }

  const sheet = getTransactionsSheet(ss);
  const lastRow = sheet.getLastRow();

  // 1. Read existing sheet data to build Dedupe Key set & Seen Accounts set (§6.6, §6.7)
  const existingDedupeKeys = new Set();
  const seenAccounts = new Set();

  if (lastRow >= 2) {
    // Read columns A to I for existing transactions (Header is row 1)
    const existingValues = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
    
    for (let r = 0; r < existingValues.length; r++) {
      const row = existingValues[r];
      const dateStr = formatSheetDate(row[0]);
      const accountStr = String(row[1] || '').trim();
      const amountNum = Number(row[3]) || 0;
      const whereStr = String(row[8] || '').trim();

      if (accountStr) {
        seenAccounts.add(accountStr);
      }

      if (dateStr && (amountNum !== 0 || whereStr)) {
        const key = generateDedupeKey(dateStr, accountStr, amountNum, whereStr);
        existingDedupeKeys.add(key);
      }
    }
  }

  // 2. Idempotency Filtering: Filter out duplicate transactions unless force_add is set (§6.7)
  const toAppend = [];
  let skippedCount = 0;
  const categoryBucketMap = typeof getCategoryBucketMap === 'function' ? getCategoryBucketMap() : null;

  for (let i = 0; i < transactionsArray.length; i++) {
    const txn = transactionsArray[i];
    // Ensure transaction is enriched before checking key
    const enriched = txn.dedupe_key ? txn : enrichTransaction(txn, categoryBucketMap);

    const isForced = Array.isArray(enriched.flags) && enriched.flags.indexOf('force_add') !== -1;

    // Only skip if duplicate AND not explicitly forced by the user
    if (!isForced && existingDedupeKeys.has(enriched.dedupe_key)) {
      Logger.log(`Skipping duplicate row: ${enriched.where} (${enriched.amount})`);
      skippedCount++;
    } else {
      toAppend.push(enriched);
      // Track dedupe key within current batch to prevent intra-batch duplicates
      existingDedupeKeys.add(enriched.dedupe_key);
    }
  }

  if (toAppend.length === 0) {
    return { writtenCount: 0, skippedCount: skippedCount, writtenRows: [] };
  }

  // 3. Prepare 2D Array for Input Columns (§4.1, §6.6)
  // Columns: A:Дата, B:Счёт, C:Тип, D:Сумма, E:Сумма в SGD, F:BalanceBefore, G:BalanceAfter, H:Категория, I:Где, J:50/30/20
  const rows2D = [];
  const startRow = lastRow + 1;
  const newAccountsInBatch = [];

  for (let i = 0; i < toAppend.length; i++) {
    const txn = toAppend[i];
    
    // Invariant §4.3: Column D & E both receive raw numerical SGD amount
    const sgdAmount = Number(txn.amount_sgd !== undefined && txn.amount_sgd !== null ? txn.amount_sgd : txn.amount) || 0;

    // Track newly seen accounts to apply initial opening balance seed (§6.6)
    const isNewAccount = !seenAccounts.has(txn.account);
    if (isNewAccount) {
      newAccountsInBatch.push({ rowIndex: startRow + i, account: txn.account });
      seenAccounts.add(txn.account);
    }

    const notesText = formatFlagsForSheet(txn.flags, txn.notes);

    rows2D.push([
      txn.date || '',             // A: Дата
      txn.account || '',          // B: Счёт
      txn.type || 'Расходы',      // C: Тип
      sgdAmount,                  // D: Сумма (raw number)
      sgdAmount,                  // E: Сумма в SGD (raw number)
      '',                         // F: На счете до (formula / seed placeholder)
      '',                         // G: На счете после (formula placeholder)
      txn.category || 'Другое',   // H: Категория
      txn.where || '',            // I: Где / Merchant
      notesText,                  // J: Notes & Tracking Flags
      txn.bucket || 'Wants'       // K: 50/30/20 Category
    ]);
  }

  // 4. DRY_RUN Check: If DRY_RUN is active, log exact rows without touching sheet (§6.6, PRD Stage 3)
  const isDryRun = (typeof optDryRun === 'boolean')
    ? optDryRun
    : (typeof SHEET_FACTS !== 'undefined' && Boolean(SHEET_FACTS.DRY_RUN));

  if (isDryRun) {
    Logger.log(`[DRY_RUN] DRY_RUN is active. Would append ${rows2D.length} rows to "${sheet.getName()}" (starting row ${startRow}):`);
    rows2D.forEach((r, idx) => {
      Logger.log(`  [DRY_RUN Row ${idx + 1}] Date: ${r[0]} | Account: ${r[1]} | Type: ${r[2]} | Amount: ${r[3]} | SGD: ${r[4]} | Category: ${r[7]} | Where: ${r[8]} | Notes: ${r[9]} | Bucket: ${r[10]}`);
    });
    return {
      writtenCount: toAppend.length,
      skippedCount: skippedCount,
      writtenRows: toAppend,
      dryRun: true
    };
  }

  // 4. Batch Write Input Columns A-K in a single operation (§6.6)
  sheet.getRange(startRow, 1, rows2D.length, 11).setValues(rows2D);

  // 5. Formula Copying Logic: Copy F:G formulas down from the row directly above (§6.6)
  if (startRow > 1) {
    const sourceRange = sheet.getRange(startRow - 1, 6, 1, 2);
    const targetRange = sheet.getRange(startRow, 6, rows2D.length, 2);
    sourceRange.copyTo(targetRange);
  }

  // 6. New Account Seed Logic: Set literal 0 in column F for first row of unseen accounts (§6.6)
  for (let k = 0; k < newAccountsInBatch.length; k++) {
    const seedInfo = newAccountsInBatch[k];
    sheet.getRange(seedInfo.rowIndex, 6).setValue(0);
  }

  return {
    writtenCount: toAppend.length,
    skippedCount: skippedCount,
    writtenRows: toAppend
  };
}

/**
 * Checks incoming transactions against existing sheet rows and flags any matching dedupe keys
 * with 'possible_duplicate' and 'needs_review: true' before proposal rendering (§6.7).
 * Also flags intra-batch duplicates if the user submitted duplicate items in the same input.
 * 
 * @param {Array<Object>} transactions - Array of enriched transaction objects.
 * @return {Array<Object>} Transactions array with duplicate flags attached.
 */
function flagExistingDuplicates(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return transactions;
  }

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return transactions;
    const sheet = spreadsheet.getSheetByName('Transactions');
    if (!sheet) return transactions;

    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return transactions;

    // Read full sheet or up to recent 1000 rows
    const startRow = Math.max(2, lastRow - 1000);
    const numRows = lastRow - startRow + 1;

    // Read Date (Col A), Account (Col B), Amount (Col D), Where (Col I)
    const existingValues = sheet.getRange(startRow, 1, numRows, 9).getValues();
    const existingExactKeys = new Set();
    const existingFuzzyKeys = new Map();

    for (let i = 0; i < existingValues.length; i++) {
      const row = existingValues[i];
      const dateStr = formatSheetDate(row[0]);
      const accountStr = String(row[1] || '').trim();
      const amountNum = Number(row[3]) || 0;
      const whereStr = String(row[8] || '').trim();

      if (dateStr && (amountNum !== 0 || whereStr)) {
        const exactKey = generateDedupeKey(dateStr, accountStr, amountNum, whereStr);
        existingExactKeys.add(exactKey);

        const fuzzyKeys = generateFuzzyDedupeKeys(dateStr, accountStr, amountNum, whereStr);
        fuzzyKeys.forEach(k => {
          if (!existingFuzzyKeys.has(k)) {
            existingFuzzyKeys.set(k, { date: dateStr, account: accountStr, amount: amountNum, where: whereStr });
          }
        });
      }
    }

    // Intra-batch sets to catch duplicates in the same batch/message
    const seenInBatchExact = new Set();
    const seenInBatchFuzzy = new Set();

    // Check incoming transactions against existing sheet keys & intra-batch duplicates
    for (let j = 0; j < transactions.length; j++) {
      const item = transactions[j];
      // Always recompute current dedupe key from current fields
      const itemExactKey = generateDedupeKey(item.date, item.account, item.amount, item.where);
      item.dedupe_key = itemExactKey;
      const itemFuzzyKeys = generateFuzzyDedupeKeys(item.date, item.account, item.amount, item.where);

      let isDuplicate = false;
      let matchedInfo = null;

      // 1. Check against sheet database
      if (existingExactKeys.has(itemExactKey)) {
        isDuplicate = true;
      } else {
        for (let k = 0; k < itemFuzzyKeys.length; k++) {
          if (existingFuzzyKeys.has(itemFuzzyKeys[k])) {
            isDuplicate = true;
            matchedInfo = existingFuzzyKeys.get(itemFuzzyKeys[k]);
            break;
          }
        }
      }

      // 2. Check for intra-batch duplicate (same message / receipt)
      if (!isDuplicate) {
        if (seenInBatchExact.has(itemExactKey)) {
          isDuplicate = true;
        } else {
          for (let k = 0; k < itemFuzzyKeys.length; k++) {
            if (seenInBatchFuzzy.has(itemFuzzyKeys[k])) {
              isDuplicate = true;
              break;
            }
          }
        }
      }

      // Record in batch trackers
      seenInBatchExact.add(itemExactKey);
      itemFuzzyKeys.forEach(k => seenInBatchFuzzy.add(k));

      item.flags = item.flags || [];
      const isForced = item.flags.includes('force_add');

      if (isDuplicate && !isForced) {
        if (!item.flags.includes('possible_duplicate')) {
          item.flags.push('possible_duplicate');
        }
        item.needs_review = true;
        Logger.log(`⚠️ Duplicate flagged: ${item.where} (S$${item.amount} on ${item.date})`);
      } else if (!isDuplicate && !isForced) {
        // Clear stale possible_duplicate flag if user edited item to no longer match
        item.flags = item.flags.filter(f => f !== 'possible_duplicate');
        
        const hasOtherFlags = item.flags.length > 0;
        const hasLowConf = item.confidence && (item.confidence.category < 0.8 || item.confidence.amount < 0.9);
        const isForeign = item.currency && item.currency !== 'SGD';
        if (!hasOtherFlags && !hasLowConf && !isForeign) {
          item.needs_review = false;
        }
      }
    }
  } catch (e) {
    Logger.log('Error checking duplicates: ' + e.toString());
  }

  return transactions;
}

/**
 * Formats tracking flags into a readable notes string for Column J (§6.6).
 * 
 * @param {Array<string>} [flags] - Array of flag identifiers.
 * @param {string} [existingNotes] - Additional user notes.
 * @return {string} Combined notes string.
 */
function formatFlagsForSheet(flags, existingNotes) {
  if (!flags || !Array.isArray(flags) || flags.length === 0) return existingNotes || '';

  const tagMap = {
    'reimbursable': '[🔁 Reimbursable]',
    'papa_charge': '[👨‍👦 Papa Charge]',
    'foreign_currency': '[💱 Foreign Currency]',
    'possible_duplicate': '[⚠️ Forced Duplicate]',
    'force_add': '[⚠️ Forced Duplicate]',
    'cc_payoff': '[💳 CC Payoff]'
  };

  const tags = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (tagMap[flag]) {
      tags.push(tagMap[flag]);
    }
  }

  const tagString = tags.join(' ');
  if (!tagString) return existingNotes || '';

  // Combine formatted tags with any existing notes Gemini might have extracted
  return existingNotes ? (tagString + ' — ' + existingNotes) : tagString;
}
