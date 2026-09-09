/**
 * BUDGET 2026 AUTOMATION — STAGE 3A STATEMENT RECONCILER
 * File: reconciler.gs
 * 
 * Scope: Statement parsing only. Pure data extraction without sheet writes or Telegram coupling.
 * 
 * Provides:
 * - parseStatement(fileBlob) -> { account, rows[], period: { from, to }, error? }
 * - DBS Credit Card CSV parser (handles preamble + split debit/credit columns)
 * - Citibank Credit Card CSV parser (handles 5 unnamed columns + single signed amounts)
 * - Gemini 3.7 Flash fallback for unknown CSV layouts and unencrypted PDFs
 * - PDF encryption detection (detects password-protected PDFs and fails cleanly)
 * 
 * CRITICAL INVARIANT:
 * Zero Telegram dependencies. Purchases from DBS and Citibank are standardized
 * to the SAME positive sign convention (e.g., +14.87, +100.00).
 */

/**
 * Main entry point for parsing bank statements (CSV or PDF).
 * 
 * @param {Blob|string|Object} fileBlob - Google Apps Script Blob, raw text string, or file object.
 * @return {Object} Parsed statement payload { account, rows[], period: { from, to }, error? }
 */
function assertStatementFileMime(mimeType) {
  if (String(mimeType || '').toLowerCase().startsWith('application/vnd.google-apps.')) {
    throw new Error('This file is a native Google document, not an original bank CSV/PDF. Upload the original bank CSV without converting it to Google Sheets so card sections are preserved.');
  }
}

function parseStatement(fileBlob) {
  if (!fileBlob) {
    return {
      account: null,
      rows: [],
      period: null,
      error: 'empty_input',
      message: 'No file blob or text content provided to parseStatement.'
    };
  }

  const details = extractFileBlobDetails(fileBlob);
  const mimeType = (details.mimeType || '').toLowerCase();
  const name = (details.name || '').toLowerCase();

  assertStatementFileMime(mimeType);

  // 1. PDF Path
  if (mimeType.includes('pdf') || name.endsWith('.pdf') || (details.text && details.text.startsWith('%PDF'))) {
    return parsePdfStatement(details);
  }

  // 2. CSV / Plain Text Path (Preferred)
  return parseCsvStatement(details.text, details.name);
}

// ============================================================================
// 1. CSV STATEMENT PARSERS (DBS, CITIBANK & GEMINI FALLBACK)
// ============================================================================

/**
 * Parses CSV statement content, auto-detecting bank format or falling back to Gemini.
 * 
 * @param {string} csvText - Raw CSV text content.
 * @param {string} [fileName] - Optional filename for account hint.
 * @return {Object} Parsed statement result { account, rows[], period, error? }.
 */
function parseCsvStatement(csvText, fileName) {
  if (!csvText || typeof csvText !== 'string' || !csvText.trim()) {
    return {
      account: null,
      rows: [],
      period: null,
      error: 'empty_csv',
      message: 'CSV statement content is empty.'
    };
  }

  let parsed2D;
  try {
    parsed2D = Utilities.parseCsv(csvText);
  } catch (err) {
    Logger.log(`Utilities.parseCsv error (${err.message}). Falling back to line-by-line split.`);
    parsed2D = csvText.split(/\r?\n/).map(line => line.split(','));
  }

  // Filter out completely blank trailing rows
  parsed2D = parsed2D.filter(row => row && row.some(cell => String(cell || '').trim() !== ''));

  if (parsed2D.length === 0) {
    return {
      account: null,
      rows: [],
      period: null,
      error: 'empty_csv',
      message: 'No data rows found in CSV.'
    };
  }

  // A. Attempt DBS CSV format (header with "Transaction Posting Date" / "Debit Amount")
  const dbsResult = tryParseDbsCsv(parsed2D, csvText, fileName);
  if (dbsResult) {
    Logger.log(`✅ [DBS PARSER] Successfully parsed ${dbsResult.rows.length} rows from DBS statement.`);
    return dbsResult;
  }

  // B. Attempt Citibank CSV format (5 unnamed columns, single signed amount)
  const citiResult = tryParseCitibankCsv(parsed2D, fileName);
  if (citiResult) {
    Logger.log(`✅ [CITIBANK PARSER] Successfully parsed ${citiResult.rows.length} rows from Citibank statement.`);
    return citiResult;
  }

  // C. Fallback to Gemini 3.7 Flash for unknown CSV layouts
  Logger.log('⚠️ [FALLBACK ACTIVE] CSV layout did not match DBS or Citibank templates. Falling back to gemini-3.7-flash for statement parsing.');
  return parseCsvWithGeminiFallback(csvText, fileName);
}

/**
 * Attempts to parse DBS Credit Card CSV format.
 * Format features:
 * - 0 to ~6 preamble rows before header
 * - Header row containing "Transaction Posting Date" or ("Transaction Date" & "Debit Amount")
 * - Separate "Debit Amount" and "Credit Amount" columns
 * 
 * @param {Array<Array<string>>} rows2D - 2D parsed CSV array.
 * @param {string} rawCsvText - Full raw text for preamble account scanning.
/**
 * Detects whether a row in a DBS statement is a card section marker.
 * Supports:
 * - "Card Transaction Details For:","DBS Altitude Visa Signature Card 4119-1100-9482-4320"
 * - "Supplementary Card:","DBS Altitude Visa Signature Card 4119-1100-9439-7509"
 * - "Supplementary Card:","DBS Altitude Visa Signature Card 4119-1100-9444-0465"
 * 
 * Extracts only the last 4 digits (never full card numbers).
 * 
 * @param {Array<string>} row - Raw CSV row cells.
 * @return {Object|null} Marker metadata or null if not a section marker.
 */
function detectDbsSectionMarker(row) {
  if (!Array.isArray(row) || row.length === 0) return null;
  const joined = row.map(c => String(c || '').trim()).filter(Boolean).join(' ');
  if (!joined) return null;

  const isMain = /card\s+transaction\s+details\s+for|principal\s+card|primary\s+card|main\s+card/i.test(joined);
  const isSupp = /supplementary\s+card/i.test(joined);
  if (!isMain && !isSupp) return null;

  let last4 = '';
  // Match 16-digit card pattern with hyphens/spaces
  const card16Match = joined.match(/(?:[\dX]{4}[-\s]?){3}(\d{4})\b/i);
  if (card16Match) {
    last4 = card16Match[1];
  } else {
    // Fallback: match last 4-digit token
    const match4 = joined.match(/\b(\d{4})\b/g);
    if (match4 && match4.length > 0) {
      last4 = match4[match4.length - 1];
    }
  }

  const cardType = isSupp ? 'supplementary' : 'main';
  const cardholder = typeof resolveCardholder === 'function'
    ? resolveCardholder(last4)
    : (last4 === '4320' ? 'Val' : (last4 === '7509' ? 'Rita' : (last4 === '0465' ? 'Grandparents' : '')));

  return {
    isMarker: true,
    cardType: cardType,
    last4: last4,
    cardholder: cardholder,
    markerText: joined
  };
}

/**
 * Detects whether a row in a statement is a DBS transaction table header.
 * @param {Array<string>} row - Raw CSV row cells.
 * @return {Object|null} Column indices or null if not a header row.
 */
function detectDbsHeaderRow(row) {
  if (!Array.isArray(row) || row.length === 0) return null;
  const rowLower = row.map(c => String(c || '').trim().toLowerCase());
  const hasPostingDate = rowLower.some(c => c.includes('transaction posting date') || c.includes('posting date'));
  const hasTxnDate = rowLower.some(c => c.includes('transaction date') || c === 'date');
  const hasDebit = rowLower.some(c => c.includes('debit amount') || c === 'debit');
  const hasCredit = rowLower.some(c => c.includes('credit amount') || c === 'credit');

  if ((hasPostingDate || hasTxnDate) && (hasDebit || hasCredit)) {
    const cols = {
      txnDateCol: -1,
      postingDateCol: -1,
      descCol: -1,
      debitCol: -1,
      creditCol: -1,
      cardCol: -1,
      txnTypeCol: -1
    };
    rowLower.forEach((colName, cIdx) => {
      if (colName.includes('transaction date')) {
        cols.txnDateCol = cIdx;
      } else if (colName.includes('posting date') || colName.includes('transaction posting date')) {
        cols.postingDateCol = cIdx;
      } else if (colName === 'date') {
        if (cols.txnDateCol === -1) cols.txnDateCol = cIdx;
      } else if (colName.includes('description') || colName.includes('transaction description') || colName.includes('merchant')) {
        cols.descCol = cIdx;
      } else if (colName.includes('debit amount') || colName === 'debit') {
        cols.debitCol = cIdx;
      } else if (colName.includes('credit amount') || colName === 'credit') {
        cols.creditCol = cIdx;
      } else if (colName.includes('card no') || colName.includes('card number') || colName === 'card') {
        cols.cardCol = cIdx;
      } else if (colName.includes('transaction type') || colName.includes('txn type') || colName === 'type') {
        cols.txnTypeCol = cIdx;
      }
    });
    return cols;
  }
  return null;
}

/**
 * Attempts to parse DBS Credit Card statement CSV format.
 * Supports multi-section statements with Main & Supplementary cards.
 * Detects "Card Transaction Details For:" and "Supplementary Card:" markers,
 * captures last-4 only, and tags every transaction row with card_last4 and cardholder.
 * 
 * @param {Array<Array<string>>} rows2D - Raw 2D array of parsed CSV rows.
 * @param {string} rawCsvText - Original unparsed CSV string.
 * @param {string} [fileName] - Optional filename hint.
 * @return {Object|null} Parsed result or null if not DBS format.
 */
function tryParseDbsCsv(rows2D, rawCsvText, fileName) {
  if (!Array.isArray(rows2D) || rows2D.length === 0) return null;

  // 1. Initial format check: scan first 35 rows for DBS markers or headers
  let isDbsFormat = false;
  let initialHeaderCols = null;
  for (let r = 0; r < Math.min(rows2D.length, 35); r++) {
    const marker = detectDbsSectionMarker(rows2D[r]);
    if (marker) {
      isDbsFormat = true;
      break;
    }
    const hCols = detectDbsHeaderRow(rows2D[r]);
    if (hCols) {
      isDbsFormat = true;
      initialHeaderCols = hCols;
      break;
    }
  }

  if (!isDbsFormat) {
    return null;
  }

  // 2. Account determination (scan preamble & filename)
  const preambleSlice = rows2D.slice(0, 30).map(r => r.join(' ')).join('\n').toLowerCase();
  const fileLower = String(fileName || '').toLowerCase();
  let account = 'DBS CC SGD';
  if (preambleSlice.includes('citi') || fileLower.includes('citi')) {
    account = 'Citibank CC';
  } else {
    account = 'DBS CC SGD';
  }

  // 3. Multi-section parsing loop
  const sections = [];
  let currentSection = null;
  let currentCols = initialHeaderCols;
  const rows = [];

  for (let r = 0; r < rows2D.length; r++) {
    const row = rows2D[r];
    if (!row || row.length === 0) continue;

    // Check for Section Marker
    const marker = detectDbsSectionMarker(row);
    if (marker) {
      let markerLast4 = marker.last4;
      let markerHolder = marker.cardholder;
      let markerText = marker.markerText;

      // Fix: When marker row has no card number (e.g. "Supplementary Card:",""), read the NEXT non-empty row for it
      if (!markerLast4) {
        let nextR = r + 1;
        while (nextR < rows2D.length) {
          const nextRow = rows2D[nextR];
          const hasContent = nextRow && nextRow.some(c => String(c || '').trim().length > 0);
          if (hasContent) {
            const nextJoined = nextRow.map(c => String(c || '').trim()).filter(Boolean).join(' ');
            const card16Match = nextJoined.match(/(?:[\dX]{4}[-\s]?){3}(\d{4})\b/i);
            if (card16Match) {
              markerLast4 = card16Match[1];
            } else {
              const match4 = nextJoined.match(/\b(\d{4})\b/g);
              if (match4 && match4.length > 0) {
                markerLast4 = match4[match4.length - 1];
              }
            }
            if (markerLast4) {
              markerHolder = typeof resolveCardholder === 'function'
                ? resolveCardholder(markerLast4)
                : (markerLast4 === '4320' ? 'Val' : (markerLast4 === '7509' ? 'Rita' : (markerLast4 === '0465' ? 'Grandparents' : '')));
              markerText = `${markerText} | ${nextJoined}`;
              // Advance loop index r so this card number row is consumed as part of the marker
              r = nextR;
            }
            break;
          }
          nextR++;
        }
      }

      currentSection = {
        sectionIndex: sections.length + 1,
        cardType: marker.cardType,
        last4: markerLast4,
        cardholder: markerHolder || (markerLast4 === '4320' ? 'Val' : (markerLast4 === '7509' ? 'Rita' : (markerLast4 === '0465' ? 'Grandparents' : ''))),
        markerText: markerText,
        rowCount: 0
      };
      sections.push(currentSection);
      Logger.log(`💳 [DBS PARSER] Section ${currentSection.sectionIndex} detected: ${currentSection.cardType.toUpperCase()} Card ending in ${currentSection.last4} (${currentSection.cardholder || 'Unknown cardholder'})`);
      continue;
    }

    // Check for Section Header Row
    const headerCols = detectDbsHeaderRow(row);
    if (headerCols) {
      currentCols = headerCols;
      if (!currentSection) {
        // Implicit first section if marker row was missing
        let fallbackLast4 = '4320';
        let fallbackHolder = 'Val';
        const preambleCheck = rows2D.slice(0, r).map(pr => pr.join(' ')).join(' ');
        const preambleMatch = preambleCheck.match(/(?:[\dX]{4}[-\s]?){3}(\d{4})\b/i);
        if (preambleMatch) {
          fallbackLast4 = preambleMatch[1];
          fallbackHolder = typeof resolveCardholder === 'function' ? resolveCardholder(fallbackLast4) : '';
        }
        currentSection = {
          sectionIndex: 1,
          cardType: 'main',
          last4: fallbackLast4,
          cardholder: fallbackHolder || 'Val',
          markerText: 'Implicit Main Card Section',
          rowCount: 0
        };
        sections.push(currentSection);
        Logger.log(`💳 [DBS PARSER] Implicit Section 1: MAIN Card ending in ${currentSection.last4} (${currentSection.cardholder})`);
      }
      continue;
    }

    // Skip preamble before any header is encountered
    if (!currentCols) {
      continue;
    }

    // Check for footer / summary rows
    const rowStr = row.map(c => String(c || '').trim()).join(' ').toLowerCase();
    if (rowStr.startsWith('total') || rowStr.startsWith('statement summary') || rowStr.startsWith('end of statement')) {
      continue;
    }

    // Date extraction: capture both transaction date and posting date
    const rawTxnDate = (currentCols.txnDateCol !== -1 && row[currentCols.txnDateCol]) ? String(row[currentCols.txnDateCol]).trim() : '';
    const rawPostDate = (currentCols.postingDateCol !== -1 && row[currentCols.postingDateCol]) ? String(row[currentCols.postingDateCol]).trim() : '';
    const normTxnDate = rawTxnDate ? parseStatementDate(rawTxnDate) : '';
    const normPostDate = rawPostDate ? parseStatementDate(rawPostDate) : '';

    const primaryNormDate = normTxnDate || normPostDate;
    if (!primaryNormDate) {
      const hasContent = row.some(c => String(c || '').trim().length > 0);
      if (hasContent && !rowStr.includes('card transaction') && !rowStr.includes('supplementary card')) {
        Logger.log(`ℹ️ [DBS PARSER] Non-transaction row skipped: [${row.filter(Boolean).slice(0, 4).join(' | ')}]`);
      }
      continue;
    }

    // Merchant description
    const rawDesc = String(row[currentCols.descCol] || '').replace(/^['"\s]+|['"\s]+$/g, '').trim();
    if (!rawDesc && !row[currentCols.debitCol] && !row[currentCols.creditCol]) {
      continue;
    }

    // Amounts
    const debitNum = (currentCols.debitCol !== -1) ? parseStatementAmountNumber(row[currentCols.debitCol]) : null;
    const creditNum = (currentCols.creditCol !== -1) ? parseStatementAmountNumber(row[currentCols.creditCol]) : null;

    let amount = 0;
    let type = 'Расходы';

    if (creditNum !== null && creditNum !== 0) {
      amount = -Math.abs(creditNum);
      type = 'Получение денег';
    } else if (debitNum !== null && debitNum > 0) {
      amount = Math.abs(debitNum);
      type = 'Расходы';
    } else if (debitNum !== null && debitNum < 0) {
      amount = -Math.abs(debitNum);
      type = 'Получение денег';
    } else {
      Logger.log(`🚨 WARNING: DBS parser skipped row ${r + 1} (zero, missing, or unparseable amount): debit="${row[currentCols.debitCol]}" credit="${row[currentCols.creditCol]}" | Raw Row: [${row.join(' | ')}]`);
      continue;
    }

    const secLast4 = currentSection ? currentSection.last4 : '';
    const secHolder = currentSection ? currentSection.cardholder : '';
    const secType = currentSection ? currentSection.cardType : 'main';

    const txnType = (currentCols.txnTypeCol !== -1 && row[currentCols.txnTypeCol])
      ? String(row[currentCols.txnTypeCol]).replace(/^['"\s]+|['"\s]+$/g, '').trim()
      : '';

    rows.push({
      date: normTxnDate || primaryNormDate,
      posting_date: normPostDate || '',
      amount: amount,
      raw_amount: String(row[currentCols.debitCol] || row[currentCols.creditCol] || amount),
      merchant: rawDesc,
      description: rawDesc,
      where: rawDesc,
      type: type,
      transaction_type: txnType,
      currency: 'SGD',
      card_number: secLast4, // Store last-4 only, NEVER full number!
      card_last4: secLast4,
      cardholder: secHolder,
      card_type: secType,
      raw_row: row
    });

    if (currentSection) {
      currentSection.rowCount++;
    }
  }

  // 4. Report row count per section
  Logger.log('\n======================================================================');
  Logger.log(`💳 DBS MULTI-SECTION PARSE SUMMARY (${sections.length} section(s) found):`);
  sections.forEach((sec, idx) => {
    Logger.log(`  Section ${idx + 1}: [${sec.cardType.toUpperCase()}] Card *${sec.last4} (${sec.cardholder || 'Unknown'}): ${sec.rowCount} transaction rows`);
  });
  Logger.log(`  Total DBS rows parsed: ${rows.length}`);
  Logger.log('======================================================================\n');

  const period = derivePeriodFromRows(rows);

  return {
    account: account,
    rows: rows,
    period: period,
    format: 'dbs_csv',
    sections: sections
  };
}

/**
 * Attempts to parse Citibank Credit Card CSV format.
 * Format features:
 * - NO header row
 * - 5 unnamed columns per row: [Date, Description, Amount, Status/Currency, Card]
 * - Purchases are positive; payments/credits are negative or contain payment descriptions
 * 
 * @param {Array<Array<string>>} rows2D - 2D parsed CSV array.
 * @param {string} [fileName] - Optional filename hint.
 * @return {Object|null} Parsed result or null if not Citibank format.
 */
function tryParseCitibankCsv(rows2D, fileName) {
  if (rows2D.length === 0) return null;

  // Verify that data rows match Citibank pattern: ~4-5 columns, col 0 is date, col 2 is numeric amount
  let validCitiRows = 0;
  for (let r = 0; r < Math.min(rows2D.length, 10); r++) {
    const row = rows2D[r];
    if (!row || row.length < 3) continue;

    const parsedDate = parseStatementDate(row[0]);
    const parsedAmount = parseStatementAmountNumber(row[2]);
    const desc = String(row[1] || '').trim();

    if (parsedDate && parsedAmount !== null && desc.length > 0) {
      validCitiRows++;
    }
  }

  // If majority of sampled rows match the 5-unnamed-column pattern
  if (validCitiRows < Math.min(rows2D.length, 2)) {
    return null;
  }

  const fileLower = String(fileName || '').toLowerCase();
  let account = 'Citibank CC';
  if (fileLower.includes('dbs')) {
    account = 'DBS CC SGD';
  }

  const rows = [];
  for (let r = 0; r < rows2D.length; r++) {
    const row = rows2D[r];
    if (!row || row.length < 3) continue;

    const rawDate = String(row[0] || '').trim();
    const normDate = parseStatementDate(rawDate);
    if (!normDate) continue;

    const rawDesc = String(row[1] || '').replace(/^['"\s]+|['"\s]+$/g, '').trim();
    const rawAmountStr = String(row[2] || '').trim();
    const numAmount = parseStatementAmountNumber(rawAmountStr);
    if (numAmount === null) continue;

    const descUpper = rawDesc.toUpperCase();
    const isPaymentDesc = descUpper.includes('PAYMENT') || descUpper.includes('AUTOPAY') || descUpper.includes('THANK YOU');

    let amount = 0;
    let type = 'Расходы';

    if (numAmount < 0) {
      // Citibank Negative Amount in CSV = Purchase / Fee / Outflow -> Internal POSITIVE amount (Расходы)
      amount = Math.abs(numAmount);
      type = 'Расходы';
    } else if (numAmount > 0) {
      // Citibank Positive Amount in CSV = Credit / Refund / Payment / Reversal -> Internal NEGATIVE amount (Получение денег)
      amount = -Math.abs(numAmount);
      type = 'Получение денег';
    } else {
      amount = 0;
      type = 'Расходы';
    }

    let cardNum = '';
    if (row.length > 4 && row[4]) {
      cardNum = String(row[4]).replace(/^['"\s]+|['"\s]+$/g, '').trim();
    } else if (row.length > 3 && row[3]) {
      const clean3 = String(row[3]).replace(/^['"\s]+|['"\s]+$/g, '').trim();
      if (/^\d{12,19}$/.test(clean3) || clean3.length >= 15) {
        cardNum = clean3;
      }
    }

    rows.push({
      date: normDate,
      amount: amount,
      raw_amount: rawAmountStr,
      merchant: rawDesc,
      description: rawDesc,
      where: rawDesc,
      type: type,
      currency: 'SGD',
      card_number: cardNum,
      status: String(row[3] || '').replace(/^['"\s]+|['"\s]+$/g, '').trim(),
      raw_row: row
    });
  }

  const period = derivePeriodFromRows(rows);

  return {
    account: account,
    rows: rows,
    period: period,
    format: 'citibank_csv'
  };
}

/**
 * Fallback CSV parser using Gemini 3.7 Flash when CSV headers do not match known bank templates.
 * 
 * @param {string} csvText - Raw CSV content.
 * @param {string} [fileName] - Optional filename hint.
 * @return {Object} Parsed statement result.
 */
function parseCsvWithGeminiFallback(csvText, fileName) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing in Script Properties for CSV fallback parsing.');
  }

  const prompt = `You are a bank statement parser. Parse the following CSV bank statement export.
Extract all transactions and identify the bank account issuer.

CRITICAL INSTRUCTIONS:
1. Standardize all dates to "DD.MM.YYYY" format.
2. Standardize purchase amounts to POSITIVE numbers (e.g. 14.87, 100.00).
3. Standardize payments/credits/refunds to NEGATIVE numbers (e.g. -500.00) or type "Получение денег".
4. Determine account if mentioned (e.g. "DBS CC SGD", "Citibank CC", "DBS SGD"). If ambiguous, return null.
5. Return clean JSON with "account" and "transactions" array.

FILENAME: ${fileName || 'statement.csv'}
CSV CONTENT:
\`\`\`
${csvText.slice(0, 50000)}
\`\`\``;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  try {
    const apiResult = callGeminiApiWithRetry(payload, apiKey, 'gemini-3.7-flash');
    const responseText = (typeof apiResult === 'object') ? apiResult.text : apiResult;
    const responseJson = JSON.parse(responseText);
    const candidate = responseJson.candidates && responseJson.candidates[0];
    const textOutput = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0].text;
    const parsedData = JSON.parse(textOutput);

    const rawTxns = Array.isArray(parsedData) ? parsedData : (parsedData.transactions || parsedData.rows || []);
    const rows = rawTxns.map(item => {
      const normDate = parseStatementDate(item.date);
      const num = Number(item.amount) || 0;
      const isPayment = (item.type === 'Получение денег' || String(item.merchant || '').toUpperCase().includes('PAYMENT') || num < 0);
      return {
        date: normDate || item.date,
        amount: isPayment ? -Math.abs(num) : Math.abs(num),
        raw_amount: String(item.amount),
        merchant: item.merchant || item.where || item.description || '',
        description: item.description || item.merchant || '',
        where: item.where || item.merchant || '',
        type: isPayment ? 'Получение денег' : (item.type || 'Расходы'),
        currency: item.currency || 'SGD',
        raw_row: item
      };
    });

    return {
      account: parsedData.account || null,
      rows: rows,
      period: derivePeriodFromRows(rows),
      format: 'gemini_csv_fallback'
    };
  } catch (err) {
    Logger.log(`❌ Gemini CSV fallback failed: ${err.message}`);
    return {
      account: null,
      rows: [],
      period: null,
      error: 'gemini_parse_failed',
      message: err.message
    };
  }
}

// ============================================================================
// 2. PDF STATEMENT PARSER & ENCRYPTION DETECTION
// ============================================================================

/**
 * Parses PDF bank statement with encryption check and Gemini 3.7 Flash extraction.
 * 
 * @param {Object} fileDetails - File details { text, bytes, mimeType, name }.
 * @return {Object} Parsed statement result { account, rows[], period, error? }.
 */
function parsePdfStatement(fileDetails) {
  // 1. Check for PDF password protection / encryption
  if (isPdfEncrypted(fileDetails.bytes, fileDetails.text)) {
    Logger.log('🔒 Encrypted PDF detected. Returning error without failing silently.');
    return {
      account: null,
      rows: [],
      period: null,
      error: 'encrypted',
      message: 'PDF statement is password-protected. Please remove the password or export statement as CSV.'
    };
  }

  // 2. Check API key for multimodal parsing
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing in Script Properties for PDF statement parsing.');
  }

  let base64Data = '';
  if (fileDetails.bytes && fileDetails.bytes.length > 0) {
    base64Data = Utilities.base64Encode(fileDetails.bytes);
  } else if (fileDetails.text) {
    base64Data = Utilities.base64Encode(Utilities.newBlob(fileDetails.text).getBytes());
  }

  if (!base64Data) {
    return {
      account: null,
      rows: [],
      period: null,
      error: 'invalid_pdf_data',
      message: 'Could not read bytes from PDF file blob.'
    };
  }

  const prompt = `You are an expert financial bank statement parser. Extract all transactions from this bank statement PDF.

RULES:
1. Standardize all dates to "DD.MM.YYYY" format.
2. Standardize purchase amounts to POSITIVE numbers (e.g., 14.87, 100.00).
3. Standardize payments/credits/repayments to NEGATIVE numbers (e.g., -500.00).
4. Identify the bank account issuer (e.g., "DBS CC SGD", "Citibank CC", "DBS SGD"). If ambiguous, return null.
5. If the document cannot be read due to password encryption, return JSON with {"error": "encrypted"}.
6. Output JSON with fields "account", "transactions": [{"date", "amount", "merchant", "type", "currency"}]`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: base64Data
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  try {
    const apiResult = callGeminiApiWithRetry(payload, apiKey, 'gemini-3.7-flash');
    const responseText = (typeof apiResult === 'object') ? apiResult.text : apiResult;
    const responseJson = JSON.parse(responseText);
    const candidate = responseJson.candidates && responseJson.candidates[0];
    const textOutput = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0].text;
    const parsedData = JSON.parse(textOutput);

    if (parsedData.error === 'encrypted') {
      return {
        account: null,
        rows: [],
        period: null,
        error: 'encrypted',
        message: 'PDF statement is password-protected. Please remove the password or export statement as CSV.'
      };
    }

    const rawTxns = Array.isArray(parsedData) ? parsedData : (parsedData.transactions || parsedData.rows || []);
    const rows = rawTxns.map(item => {
      const normDate = parseStatementDate(item.date);
      const num = Number(item.amount) || 0;
      const isPayment = (item.type === 'Получение денег' || String(item.merchant || '').toUpperCase().includes('PAYMENT') || num < 0);
      return {
        date: normDate || item.date,
        amount: isPayment ? -Math.abs(num) : Math.abs(num),
        raw_amount: String(item.amount),
        merchant: item.merchant || item.where || item.description || '',
        description: item.description || item.merchant || '',
        where: item.where || item.merchant || '',
        type: isPayment ? 'Получение денег' : (item.type || 'Расходы'),
        currency: item.currency || 'SGD',
        raw_row: item
      };
    });

    return {
      account: parsedData.account || null,
      rows: rows,
      period: derivePeriodFromRows(rows),
      format: 'pdf_gemini'
    };
  } catch (err) {
    Logger.log(`❌ Gemini PDF statement parsing failed: ${err.message}`);
    return {
      account: null,
      rows: [],
      period: null,
      error: 'pdf_parse_failed',
      message: err.message
    };
  }
}

/**
 * Inspects PDF binary bytes / text for PDF password protection (/Encrypt dictionary).
 * 
 * @param {Array<number>|null} bytes - Raw byte array.
 * @param {string} [text] - Optional text representation.
 * @return {boolean} True if /Encrypt dictionary is present in PDF trailer/xref.
 */
function isPdfEncrypted(bytes, text) {
  if (text && (text.indexOf('/Encrypt') !== -1 || text.indexOf('/encrypt') !== -1)) {
    return true;
  }

  if (bytes && bytes.length > 0) {
    // Scan beginning and end chunks of byte array for "/Encrypt" ASCII code
    const checkBytesForEncrypt = (subArr) => {
      let str = '';
      for (let i = 0; i < subArr.length; i++) {
        str += String.fromCharCode(subArr[i]);
      }
      return str.indexOf('/Encrypt') !== -1;
    };

    const headSlice = bytes.slice(0, Math.min(bytes.length, 8192));
    if (checkBytesForEncrypt(headSlice)) return true;

    if (bytes.length > 8192) {
      const tailSlice = bytes.slice(bytes.length - 8192);
      if (checkBytesForEncrypt(tailSlice)) return true;
    }
  }

  return false;
}

// ============================================================================
// 3. UTILITY & NORMALIZATION HELPERS
// ============================================================================

/**
 * Normalizes diverse bank statement date strings into DD.MM.YYYY format.
 * Supports:
 * - DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY
 * - DD Mon YYYY (e.g. "25 Jul 2026", "25-Jul-2026")
 * - YYYY-MM-DD
 * 
 * @param {string|Date} rawDateStr - Raw date string from statement.
 * @return {string} Standardized DD.MM.YYYY date string, or empty string on failure.
 */
function parseStatementDate(rawDateStr) {
  if (!rawDateStr) return '';
  if (rawDateStr instanceof Date) {
    return Utilities.formatDate(rawDateStr, 'Asia/Singapore', 'dd.MM.yyyy');
  }

  const str = String(rawDateStr).trim();

  // 1. Format: DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/);
  if (dmyMatch) {
    const d = String(parseInt(dmyMatch[1], 10)).padStart(2, '0');
    const m = String(parseInt(dmyMatch[2], 10)).padStart(2, '0');
    let y = dmyMatch[3];
    if (y.length === 2) y = '20' + y;
    return `${d}.${m}.${y}`;
  }

  // 2. Format: DD Mon YYYY (e.g. 25 Jul 2026, 25-Jul-2026, 25 Jul 26)
  const monthMap = {
    'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'may': '05', 'jun': '06',
    'jul': '07', 'aug': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
  };
  const dMonYMatch = str.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3})[\s\-]+(\d{2,4})$/);
  if (dMonYMatch) {
    const d = String(parseInt(dMonYMatch[1], 10)).padStart(2, '0');
    const monKey = dMonYMatch[2].toLowerCase();
    const m = monthMap[monKey] || '01';
    let y = dMonYMatch[3];
    if (y.length === 2) y = '20' + y;
    return `${d}.${m}.${y}`;
  }

  // 3. Format: YYYY-MM-DD
  const ymdMatch = str.match(/^(\d{4})[\/\.\-](\d{1,2})[\/\.\-](\d{1,2})$/);
  if (ymdMatch) {
    const y = ymdMatch[1];
    const m = String(parseInt(ymdMatch[2], 10)).padStart(2, '0');
    const d = String(parseInt(ymdMatch[3], 10)).padStart(2, '0');
    return `${d}.${m}.${y}`;
  }

  return '';
}

/**
 * Parses numeric monetary amounts from currency strings, handling CR/DR suffixes and commas.
 * 
 * @param {string|number} valStr - Raw amount string.
 * @return {number|null} Parsed float number or null.
 */
function parseStatementAmountNumber(valStr) {
  if (valStr === undefined || valStr === null) return null;
  if (typeof valStr === 'number') return isNaN(valStr) ? null : valStr;

  let s = String(valStr).trim();
  if (!s) return null;

  // Remove currency prefixes (S$, $, SGD, USD)
  s = s.replace(/^(S\$|SGD|\$|USD)\s*/i, '').trim();

  let isCredit = false;
  if (/CR$/i.test(s)) {
    isCredit = true;
    s = s.replace(/CR$/i, '').trim();
  } else if (/DR$/i.test(s)) {
    s = s.replace(/DR$/i, '').trim();
  }

  // Clean thousand separator commas and multiple spaces
  s = s.replace(/\s+/g, '');
  s = /^-?\d+,\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');

  const num = parseFloat(s);
  if (isNaN(num)) return null;

  return isCredit ? -Math.abs(num) : num;
}

/**
 * Derives statement period { from, to } from an array of parsed rows by finding min and max dates.
 * 
 * @param {Array<Object>} rows - Array of parsed row objects with .date field (DD.MM.YYYY).
 * @return {Object|null} { from: 'DD.MM.YYYY', to: 'DD.MM.YYYY' } or null.
 */
function derivePeriodFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const validTimestamps = [];
  for (let i = 0; i < rows.length; i++) {
    const dStr = rows[i].date;
    if (dStr && typeof dStr === 'string') {
      const parts = dStr.split('.');
      if (parts.length === 3) {
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const year = parseInt(parts[2], 10);
        const dt = new Date(year, month, day);
        if (!isNaN(dt.getTime())) {
          validTimestamps.push({ str: dStr, time: dt.getTime() });
        }
      }
    }
  }

  if (validTimestamps.length === 0) return null;

  validTimestamps.sort((a, b) => a.time - b.time);

  return {
    from: validTimestamps[0].str,
    to: validTimestamps[validTimestamps.length - 1].str
  };
}

/**
 * Helper to normalize fileBlob into an object with text, bytes, mimeType, and name.
 * 
 * @param {Blob|string|Object} fileBlob - Input payload.
 * @return {Object} { text, bytes, mimeType, name }.
 */
function extractFileBlobDetails(fileBlob) {
  if (typeof fileBlob === 'string') {
    return {
      text: fileBlob,
      bytes: null,
      mimeType: fileBlob.startsWith('%PDF') ? 'application/pdf' : 'text/csv',
      name: fileBlob.startsWith('%PDF') ? 'statement.pdf' : 'statement.csv'
    };
  }

  let text = '';
  let bytes = null;
  let mimeType = '';
  let name = '';

  if (fileBlob && typeof fileBlob.getContentType === 'function') {
    mimeType = fileBlob.getContentType() || '';
  } else if (fileBlob && (fileBlob.contentType || fileBlob.mimeType)) {
    mimeType = fileBlob.contentType || fileBlob.mimeType;
  }

  if (fileBlob && typeof fileBlob.getName === 'function') {
    name = fileBlob.getName() || '';
  } else if (fileBlob && fileBlob.name) {
    name = fileBlob.name;
  }

  if (fileBlob && typeof fileBlob.getBytes === 'function') {
    bytes = fileBlob.getBytes();
  } else if (fileBlob && fileBlob.bytes) {
    bytes = fileBlob.bytes;
  }

  if (fileBlob && typeof fileBlob.getDataAsString === 'function') {
    try {
      text = fileBlob.getDataAsString();
    } catch (e) {
      text = '';
    }
  } else if (fileBlob && fileBlob.text) {
    text = fileBlob.text;
  } else if (bytes) {
    try {
      text = Utilities.newBlob(bytes).getDataAsString();
    } catch (e) {
      text = '';
    }
  }

  return { text, bytes, mimeType, name };
}

// ============================================================================
// 4. STAGE 3B: ROW NORMALIZATION
// ============================================================================

/**
 * STAGE 3B: Normalizes raw or parsed statement rows into standardized reconciler records.
 * 
 * Standardizes:
 * - Dates -> DD.MM.YYYY (reusing normalizeDateString from enricher.gs)
 * - Amounts -> Numbers (handles "S$1 234,56", space thousands, comma decimals, negative numbers)
 * - Merchant strings -> Normalised with normaliseWhere() from enricher.gs (shared with Phase 1)
 * - Sign/direction -> Standardized across banks (Purchases > 0 / 'Расходы', Inflows/Refunds < 0 / 'Получение денег')
 * 
 * @param {Array<Object|Array>} rows - Array of statement row objects or raw arrays.
 * @return {Array<Object>} Array of standardized normalized row objects.
 */
function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const normalizedRows = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    // Handle both object format and raw array format
    let rawDate = '';
    let rawAmount = null;
    let rawMerchant = '';
    let rawType = null;
    let account = 'DBS CC SGD';
    let cardNum = '';
    let currency = 'SGD';

    if (Array.isArray(row)) {
      if (row.length < 3) continue;
      rawDate = row[0];
      rawMerchant = row[1];
      rawAmount = row[2];
      if (row.length > 3) cardNum = String(row[3]);
    } else if (typeof row === 'object') {
      rawDate = row.date || row.raw_date || '';
      rawAmount = (row.amount !== undefined && row.amount !== null) ? row.amount : row.raw_amount;
      rawMerchant = row.merchant || row.description || row.where || row.raw_merchant || '';
      rawType = row.type || null;
      account = row.account || 'DBS CC SGD';
      cardNum = row.card_number || '';
      currency = row.currency || 'SGD';
      txnType = row.transaction_type || '';
    }

    // 1. Date Normalization -> DD.MM.YYYY
    let normDate = '';
    if (typeof normalizeDateString === 'function') {
      normDate = normalizeDateString(rawDate);
    }
    if (!normDate && typeof parseStatementDate === 'function') {
      normDate = parseStatementDate(rawDate);
    }
    if (!normDate) {
      normDate = String(rawDate || '').trim();
    }

    // 2. Amount Normalization -> Number (handles comma decimals, S$1 234,56, etc.)
    const numAmount = normalizeAmountValue(rawAmount);

    // Filter out completely empty rows (no date, no merchant, 0 amount)
    if (!normDate && !rawMerchant && numAmount === 0) {
      continue;
    }

    // 3. Merchant Normalization -> Reusing normaliseWhere() from Phase 1 enricher
    const cleanRawMerchant = String(rawMerchant || '').replace(/^['"\s]+|['"\s]+$/g, '').trim();
    let normMerchant = '';
    if (typeof normaliseWhere === 'function') {
      normMerchant = normaliseWhere(cleanRawMerchant);
    } else {
      normMerchant = cleanRawMerchant.toLowerCase().trim().replace(/\s+/g, ' ');
    }

    // 4. Sign and Transaction Type Resolution
    let type = rawType;
    let finalAmount = numAmount;

    const merchantUpper = cleanRawMerchant.toUpperCase();
    const isPaymentOrCredit = (
      merchantUpper.includes('BILL PAYMENT') ||
      merchantUpper.includes('PAYMENT RECEIVED') ||
      merchantUpper.includes('AUTOPAY') ||
      merchantUpper.includes('LATE FEE REVERSAL') ||
      merchantUpper.includes('MONEYSEND') ||
      merchantUpper.includes('REFUND') ||
      merchantUpper.includes('CASHBACK')
    );

    if (rawType) {
      // If type is already explicitly provided
      if (rawType === 'Получение денег' || rawType === 'INCOME' || isPaymentOrCredit) {
        type = 'Получение денег';
        finalAmount = -Math.abs(numAmount);
      } else {
        type = 'Расходы';
        finalAmount = Math.abs(numAmount);
      }
    } else {
      if (numAmount < 0 || isPaymentOrCredit) {
        type = 'Получение денег';
        finalAmount = -Math.abs(numAmount);
      } else {
        type = 'Расходы';
        finalAmount = Math.abs(numAmount);
      }
    }

    const rawCard = (typeof row === 'object' ? (row.card_last4 || row.card_number) : '') || cardNum || '';
    const cardLast4 = rawCard ? String(rawCard).replace(/\D/g, '').slice(-4) : '';
    const cardholder = (typeof row === 'object' && row.cardholder)
      ? row.cardholder
      : (typeof resolveCardholder === 'function' ? resolveCardholder(cardLast4) : '');
    const cardType = (typeof row === 'object' && row.card_type)
      ? row.card_type
      : (cardLast4 === '4320' ? 'main' : (cardLast4 ? 'supplementary' : ''));

    const rawPostDate = (typeof row === 'object' && row.posting_date) ? row.posting_date : '';
    let normPostDate = '';
    if (rawPostDate) {
      if (typeof normalizeDateString === 'function') normPostDate = normalizeDateString(rawPostDate);
      if (!normPostDate && typeof parseStatementDate === 'function') normPostDate = parseStatementDate(rawPostDate);
      if (!normPostDate) normPostDate = String(rawPostDate || '').trim();
    }

    normalizedRows.push({
      date: normDate,
      posting_date: normPostDate,
      amount: finalAmount,
      merchant: normMerchant,
      raw_merchant: cleanRawMerchant,
      type: type,
      transaction_type: txnType,
      account: account,
      card_number: cardLast4, // Store last-4 only, NEVER full number!
      card_last4: cardLast4,
      cardholder: cardholder,
      card_type: cardType,
      currency: currency,
      raw_row: row
    });
  }

  return normalizedRows;
}

/**
 * Robust numeric parser for statement amount values.
 * Handles space thousands separators and comma decimals (e.g. "S$1 234,56", "207,32", "-12,969.24").
 * 
 * @param {number|string} val - Raw amount value.
 * @return {number} Parsed float number.
 */
function normalizeAmountValue(val) {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') {
    return isNaN(val) ? 0 : Math.round(val * 100) / 100;
  }

  let s = String(val).trim();
  if (!s) return 0;

  // Strip currency prefixes: "S$", "SGD", "$", "USD", "EUR"
  s = s.replace(/^(S\$|SGD|\$|USD|EUR)\s*/i, '').trim();

  let isNegative = false;
  if (s.startsWith('-')) {
    isNegative = true;
    s = s.substring(1).trim();
  } else if (s.endsWith('-')) {
    isNegative = true;
    s = s.substring(0, s.length - 1).trim();
  } else if (/CR$/i.test(s)) {
    isNegative = true;
    s = s.replace(/CR$/i, '').trim();
  } else if (/DR$/i.test(s)) {
    s = s.replace(/DR$/i, '').trim();
  }

  // Remove spaces (used as thousands separator, e.g. "1 234,56")
  s = s.replace(/\s+/g, '');

  if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) {
    // Comma is decimal separator (e.g., "1234,56" or "207,32")
    s = s.replace(',', '.');
  } else if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // European format: 1.234,56 -> 1234.56
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // Standard US/SG format: 1,234.56 -> 1234.56
      s = s.replace(/,/g, '');
    }
  }

  const num = parseFloat(s);
  if (isNaN(num)) return 0;

  const result = isNegative ? -Math.abs(num) : num;
  return Math.round(result * 100) / 100;
}

// ============================================================================
// 5. STAGE 3C: MATCHING ENGINE (PURE FUNCTION)
// ============================================================================

/**
 * STAGE 3C: Reconciles statement transactions against ledger transactions.
 * 
 * Rules:
 * 1. PURE FUNCTION: Zero I/O, zero sheet reads, zero Telegram dependencies.
 * 2. Fast Path: Exact dedupe_key hit (same date, account, amount, and normalized merchant).
 * 3. Fuzzy Path:
 *    - Amount equal (±0.00)
 *    - Date within ±4 days (accommodates DBS posting drift, e.g. "03 Aug" posted "07 Aug")
 *    - Merchant similarity >= 0.70 (uses 3B normaliseWhere on both sides)
 * 4. Ambiguity: Multiple plausible matches -> lands in 'ambiguous', NEVER guesses.
 * 5. One-to-one consumption: A ledger row can only be matched once.
 * 6. CRITICAL: No already-logged row may ever land in 'missing'.
 * 
 * @param {Array<Object>} statementRows - Normalized statement rows (from Stage 3B normalizeRows).
 * @param {Array<Object>} ledgerRows - Ledger transaction rows (from Transactions tab).
 * @return {{ matched: Array<Object>, missing: Array<Object>, ambiguous: Array<Object> }}
 */
function findMissing(statementRows, ledgerRows, optAliases) {
  const result = {
    matched: [],
    missing: [],
    ambiguous: []
  };

  if (!Array.isArray(statementRows) || statementRows.length === 0) {
    return result;
  }

  const safeLedgerRows = Array.isArray(ledgerRows) ? ledgerRows : [];

  // Prepare statement & ledger items for matching (normalize date, amount, merchant, dedupe_key)
  const sItems = statementRows.map((r, idx) => prepareReconcilerItem(r, idx, 'statement'));
  const lItems = safeLedgerRows.map((r, idx) => prepareReconcilerItem(r, idx, 'ledger'));

  const claimedLedgerIndices = new Set();
  const matchedStatementIndices = new Set();
  const ambiguousStatementIndices = new Set();

  // --------------------------------------------------------------------------
  // PASS 1: FAST PATH — EXACT DEDUPE KEY MATCH
  // --------------------------------------------------------------------------
  const sByKey = new Map();
  for (let i = 0; i < sItems.length; i++) {
    const s = sItems[i];
    if (!s.dedupe_key) continue;
    if (!sByKey.has(s.dedupe_key)) sByKey.set(s.dedupe_key, []);
    sByKey.get(s.dedupe_key).push(s);
  }

  const lByKey = new Map();
  for (let j = 0; j < lItems.length; j++) {
    const l = lItems[j];
    if (!l.dedupe_key) continue;
    if (!lByKey.has(l.dedupe_key)) lByKey.set(l.dedupe_key, []);
    lByKey.get(l.dedupe_key).push(l);
  }

  sByKey.forEach((sList, key) => {
    const lList = lByKey.get(key) || [];
    if (lList.length === 0) return;

    // Step 1: 1-to-1 match by exact cardholder where available
    const unassignedS = [];
    const unassignedL = [...lList];

    for (let k = 0; k < sList.length; k++) {
      const s = sList[k];
      let matchIdx = -1;
      if (s.cardholder) {
        matchIdx = unassignedL.findIndex(l => l.cardholder === s.cardholder);
      }
      if (matchIdx !== -1) {
        const matchedL = unassignedL.splice(matchIdx, 1)[0];
        claimedLedgerIndices.add(matchedL.index);
        matchedStatementIndices.add(s.index);
        result.matched.push({
          ...s.raw,
          matched_ledger: matchedL.raw,
          match_type: 'exact_cardholder'
        });
      } else {
        unassignedS.push(s);
      }
    }

    // Step 2: For remaining items in this exact group:
    if (unassignedS.length > 0 && unassignedL.length > 0) {
      if (unassignedS.length === unassignedL.length) {
        // Equal counts: check if all are cardholder-compatible
        let allCompatible = true;
        for (let k = 0; k < unassignedS.length; k++) {
          if (!isCardholderCompatible(unassignedS[k], unassignedL[k])) {
            allCompatible = false;
            break;
          }
        }
        if (allCompatible) {
          for (let k = 0; k < unassignedS.length; k++) {
            const s = unassignedS[k];
            const l = unassignedL[k];
            claimedLedgerIndices.add(l.index);
            matchedStatementIndices.add(s.index);
            result.matched.push({
              ...s.raw,
              matched_ledger: l.raw,
              match_type: 'exact'
            });
          }
          unassignedS.length = 0;
          unassignedL.length = 0;
        }
      } else if (unassignedL.length === 1) {
        // Exactly one ledger row remains: find compatible statement rows
        let compIndices = [];
        for (let k = 0; k < unassignedS.length; k++) {
          if (isCardholderCompatible(unassignedS[k], unassignedL[0])) {
            compIndices.push(k);
          }
        }
        if (compIndices.length > 1 && !unassignedL[0].cardholder) {
          // Un-noted ledger row represents household (Val/Main card) spend.
          // Prefer Main cardholder (Val) over supplementary cards (Grandparents).
          const mainIdx = compIndices.find(idx => unassignedS[idx].cardholder === 'Val' || unassignedS[idx].card_type === 'main');
          if (mainIdx !== undefined) {
            compIndices = [mainIdx];
          }
        }
        if (compIndices.length === 1) {
          // Exactly one statement row is compatible (or disambiguated) with this single ledger row!
          const matchS = unassignedS.splice(compIndices[0], 1)[0];
          const matchedL = unassignedL.pop();
          claimedLedgerIndices.add(matchedL.index);
          matchedStatementIndices.add(matchS.index);
          result.matched.push({
            ...matchS.raw,
            matched_ledger: matchedL.raw,
            match_type: 'exact_cardholder_disambiguated'
          });
        }
      }
    }

    // Step 3: Only if there are genuinely competing compatible candidates that cannot be resolved:
    if (unassignedS.length > 0 && unassignedL.length > 0) {
      for (let k = 0; k < unassignedS.length; k++) {
        const s = unassignedS[k];
        ambiguousStatementIndices.add(s.index);
        result.ambiguous.push({
          ...s.raw,
          candidates: unassignedL.map(item => item.raw),
          match_type: 'ambiguous_exact',
          reason: `Count mismatch on exact dedupe key (${sList.length} statement vs ${lList.length} ledger)`
        });
      }
      unassignedL.forEach(item => claimedLedgerIndices.add(item.index));
    }
  });

  // --------------------------------------------------------------------------
  // PASS 2: MULTI-FACTOR FUZZY MATCH (Amount equal, Date within ±4 days, Canonical & Soft Scoring)
  // --------------------------------------------------------------------------
  const remainingStatement = sItems.filter(s => !matchedStatementIndices.has(s.index) && !ambiguousStatementIndices.has(s.index));
  const remainingLedger = lItems.filter(l => !claimedLedgerIndices.has(l.index));

  // Matching is pure: callers may pass an alias snapshot, never read it here.
  const aliases = optAliases || {};

  // Build candidate map for each remaining statement row
  const sCandidateMap = new Map(); // s.index -> array of matching { ledgerItem, daysDiff, similarity, isCanonicalMatch, score }
  const lCandidateMap = new Map(); // l.index -> array of matching sItems

  remainingStatement.forEach(s => {
    const candidates = [];
    const sCanonical = resolveCanonicalMerchant(s.merchant, aliases);

    remainingLedger.forEach(l => {
      // Separate accounts and explicitly named cardholders cannot represent one purchase.
      if (s.account.trim().toLowerCase() !== l.account.trim().toLowerCase()) return;
      if (!isCardholderCompatible(s, l)) return;
      // 1. Amount equal (exact ±0.005)
      if (Math.abs(s.amount - l.amount) >= 0.005) return;

      // 2. Date within ±4 days (using transaction date OR posting date if available)
      const daysDiffTxn = (s.date && l.date) ? getDaysDifference(s.date, l.date) : 999;
      const daysDiffPost = (s.posting_date && l.date) ? getDaysDifference(s.posting_date, l.date) : 999;
      const daysDiff = Math.min(daysDiffTxn, daysDiffPost);
      if (daysDiff > 4) return;

      // 3. Resolve canonical merchants
      const lCanonical = resolveCanonicalMerchant(l.merchant, aliases);
      const originalStatementIdentity = resolveCanonicalMerchant(s.raw.raw_merchant || s.merchant, {});
      const originalLedgerIdentity = resolveCanonicalMerchant(l.merchant, {});
      const sameDayRelationship = daysDiffTxn === 0 ? reconcilerMerchantRelationship(s, l) : '';
      const isCanonicalMatch = Boolean(
        (sCanonical && lCanonical && sCanonical === lCanonical) ||
        (originalStatementIdentity && originalStatementIdentity === originalLedgerIdentity) || sameDayRelationship
      );

      // 4. Raw merchant similarity
      const rawSimilarity = computeMerchantSimilarity(s.merchant, l.merchant);
      const merchantSim = isCanonicalMatch ? 1.0 : rawSimilarity;

      // 5. Cardholder soft score (same: +0.15, conflict: -0.20, empty ledger: 0.00 neutral)
      const chScore = computeCardholderScore(s, l);

      // 6. Category corroboration
      let categoryScore = 0.0;
      if (l.category && isCanonicalMatch) {
        categoryScore = 0.10;
      }

      // Date score: closer dates receive higher weight
      const dateScore = daysDiff === 0 ? 0.35 : (daysDiff === 1 ? 0.25 : (daysDiff === 2 ? 0.18 : 0.10));

      // Merchant score: canonical match is definitive anchor, else scaled similarity
      const merchantScore = isCanonicalMatch ? 0.50 : (rawSimilarity >= 0.70 ? 0.45 * rawSimilarity : (rawSimilarity >= 0.40 ? 0.30 * rawSimilarity : 0.10 * rawSimilarity));

      const totalScore = dateScore + merchantScore + chScore + categoryScore;

      // Candidate filter: canonical match OR raw similarity >= 0.55 OR composite score >= 0.55
      // Explicit cardholder conflicts were rejected before scoring.
      if (isCanonicalMatch || rawSimilarity >= 0.55 || totalScore >= 0.55) {
        candidates.push({
          ledgerItem: l,
          merchantEvidence: sameDayRelationship || (isCanonicalMatch ? 'canonical identity' : 'merchant similarity'),
          daysDiff: daysDiff,
          similarity: merchantSim,
          rawSimilarity: rawSimilarity,
          isCanonicalMatch: isCanonicalMatch,
          score: totalScore
        });
      }
    });

    // Sort candidates by total score descending
    candidates.sort((a, b) => b.score - a.score);

    sCandidateMap.set(s.index, candidates);
    candidates.forEach(c => {
      const lIdx = c.ledgerItem.index;
      if (!lCandidateMap.has(lIdx)) lCandidateMap.set(lIdx, []);
      lCandidateMap.get(lIdx).push(s);
    });
  });

  // Process remaining statement rows
  for (let i = 0; i < remainingStatement.length; i++) {
    const s = remainingStatement[i];
    if (matchedStatementIndices.has(s.index) || ambiguousStatementIndices.has(s.index)) continue;

    const candidates = (sCandidateMap.get(s.index) || []).filter(c => !claimedLedgerIndices.has(c.ledgerItem.index));

    if (candidates.length === 0) {
      // Classify unmatched rows after all candidate decisions are complete.
      continue;
    }

    if (candidates.length === 1) {
      const singleCandidate = candidates[0].ledgerItem;
      const competingStatementRows = (lCandidateMap.get(singleCandidate.index) || [])
        .filter(compS => !matchedStatementIndices.has(compS.index) && !ambiguousStatementIndices.has(compS.index))
        .filter(compS => isCardholderCompatible(compS, singleCandidate));

      if (competingStatementRows.length === 1) {
        // Unique 1-to-1 match
        claimedLedgerIndices.add(singleCandidate.index);
        matchedStatementIndices.add(s.index);
        result.matched.push({
          ...s.raw,
          matched_ledger: singleCandidate.raw,
          match_type: candidates[0].isCanonicalMatch ? 'canonical' : 'fuzzy',
          days_diff: candidates[0].daysDiff,
          similarity: candidates[0].similarity,
          merchant_evidence: candidates[0].merchantEvidence,
          match_score: candidates[0].score
        });
      } else {
        // Multiple statement rows compete for this single ledger candidate
        // Disambiguate by comparing composite candidate scores
        const compWithScores = competingStatementRows.map(compS => {
          const cand = (sCandidateMap.get(compS.index) || []).find(c => c.ledgerItem.index === singleCandidate.index);
          return { s: compS, cand: cand, score: cand ? cand.score : 0 };
        }).sort((a, b) => b.score - a.score);

        const topComp = compWithScores[0];
        const runnerUp = compWithScores[1];

        // If top has clear lead (or exact cardholder / date priority), top wins
        if (topComp && (!runnerUp || (topComp.score - runnerUp.score >= 0.10) || (topComp.s.cardholder && topComp.s.cardholder === singleCandidate.cardholder && runnerUp.s.cardholder !== singleCandidate.cardholder))) {
          const winner = topComp.s;
          claimedLedgerIndices.add(singleCandidate.index);
          matchedStatementIndices.add(winner.index);
          result.matched.push({
            ...winner.raw,
            matched_ledger: singleCandidate.raw,
            match_type: 'fuzzy_score_disambiguated',
            days_diff: topComp.cand ? topComp.cand.daysDiff : candidates[0].daysDiff,
            similarity: topComp.cand ? topComp.cand.similarity : candidates[0].similarity,
            merchant_evidence: topComp.cand && topComp.cand.merchantEvidence,
            match_score: topComp.score
          });
        } else {
          // Still ambiguous
          competingStatementRows.forEach(compS => {
            ambiguousStatementIndices.add(compS.index);
            result.ambiguous.push({
              ...compS.raw,
              candidates: [singleCandidate.raw],
              match_type: 'ambiguous_competing_statement',
              reason: `Multiple statement rows compete for single ledger row (date: ${singleCandidate.date}, amount: ${singleCandidate.amount})`
            });
          });
          claimedLedgerIndices.add(singleCandidate.index);
        }
      }
    } else {
      // candidates.length > 1: Check if top candidate has decisive lead
      const topCand = candidates[0];
      const secondCand = candidates[1];

      if (topCand && topCand.score >= 0.70 && (topCand.score - secondCand.score >= 0.15)) {
        // Top candidate is a clear winner
        const winnerL = topCand.ledgerItem;
        claimedLedgerIndices.add(winnerL.index);
        matchedStatementIndices.add(s.index);
        result.matched.push({
          ...s.raw,
          matched_ledger: winnerL.raw,
          match_type: topCand.isCanonicalMatch ? 'canonical' : 'fuzzy',
          days_diff: topCand.daysDiff,
          similarity: topCand.similarity,
          merchant_evidence: topCand.merchantEvidence,
          match_score: topCand.score
        });
        continue;
      }

      // Check if one candidate has exact named cardholder match
      const exactCardCandidates = candidates.filter(c => c.ledgerItem.cardholder && c.ledgerItem.cardholder === s.cardholder);
      if (exactCardCandidates.length === 1) {
        const winnerL = exactCardCandidates[0].ledgerItem;
        claimedLedgerIndices.add(winnerL.index);
        matchedStatementIndices.add(s.index);
        result.matched.push({
          ...s.raw,
          matched_ledger: winnerL.raw,
          match_type: 'fuzzy_cardholder_preferred',
          days_diff: exactCardCandidates[0].daysDiff,
          similarity: exactCardCandidates[0].similarity,
          match_score: exactCardCandidates[0].score
        });
        continue;
      }

      // Check for symmetric duplicate group
      const identicalStatementRows = remainingStatement.filter(otherS => 
        !matchedStatementIndices.has(otherS.index) &&
        !ambiguousStatementIndices.has(otherS.index) &&
        otherS.account === s.account &&
        otherS.cardholder === s.cardholder &&
        otherS.date === s.date &&
        Math.abs(otherS.amount - s.amount) < 0.005 &&
        otherS.merchant === s.merchant
      );

      const firstCandidate = candidates[0].ledgerItem;
      const allCandidatesIdentical = candidates.every(c => 
        c.ledgerItem.date === firstCandidate.date &&
        Math.abs(c.ledgerItem.amount - firstCandidate.amount) < 0.005 &&
        c.ledgerItem.merchant === firstCandidate.merchant
      );

      if (allCandidatesIdentical && identicalStatementRows.length === candidates.length) {
        // Symmetric duplicate amounts matched 1-to-1
        for (let k = 0; k < identicalStatementRows.length; k++) {
          const matchedS = identicalStatementRows[k];
          const matchedL = candidates[k].ledgerItem;
          claimedLedgerIndices.add(matchedL.index);
          matchedStatementIndices.add(matchedS.index);
          result.matched.push({
            ...matchedS.raw,
            matched_ledger: matchedL.raw,
            match_type: 'fuzzy_duplicate_group',
            days_diff: candidates[k].daysDiff,
            similarity: candidates[k].similarity,
            match_score: candidates[k].score
          });
        }
      } else {
        // Multiple candidate ledger rows without 1-to-1 symmetry -> ambiguous!
        ambiguousStatementIndices.add(s.index);
        result.ambiguous.push({
          ...s.raw,
          candidates: candidates.map(c => c.ledgerItem.raw),
          match_type: 'ambiguous_multiple_ledger',
          reason: `Found ${candidates.length} plausible ledger candidates within ±4 days`
        });
      }
    }
  }

  // A merchant-name miss is not proof of a missing purchase. Surface otherwise
  // compatible same-day/same-amount ledger rows for review, never auto-match on
  // amount/date alone. Already allocated ledger occurrences remain allocated.
  for (const item of sItems) {
    if (matchedStatementIndices.has(item.index) || ambiguousStatementIndices.has(item.index)) continue;
    const possible = lItems.filter(ledger => {
      if (item.account.trim().toLowerCase() !== ledger.account.trim().toLowerCase() ||
          !isCardholderCompatible(item, ledger) ||
          Math.abs(item.amount - ledger.amount) >= 0.005 ||
          getDaysDifference(item.date, ledger.date) !== 0) return false;
      if (!claimedLedgerIndices.has(ledger.index)) return true;
      const owner = result.matched.find(match => match.matched_ledger === ledger.raw);
      // A known purchase by another cardholder is a distinct occurrence.
      if (owner && owner.cardholder && item.cardholder && owner.cardholder !== item.cardholder) return false;
      // Reusing a ledger row is never automatic. Strong same-day identity
      // collisions need multiplicity review even when the row was claimed first.
      return computeMerchantSimilarity(item.merchant, ledger.merchant) >= 0.70 ||
        resolveCanonicalMerchant(item.merchant, {}) === resolveCanonicalMerchant(ledger.merchant, {});
    });
    if (possible.length) {
      ambiguousStatementIndices.add(item.index);
      const candidates = possible.map(ledger => {
        const owner = result.matched.find(match => match.matched_ledger === ledger.raw);
        return { ...ledger.raw, already_claimed: claimedLedgerIndices.has(ledger.index),
          claimed_by: owner ? { date: owner.date, merchant: owner.raw_merchant || owner.merchant,
            cardholder: owner.cardholder || '' } : null };
      });
      const alreadyClaimed = candidates.some(candidate => candidate.already_claimed);
      result.ambiguous.push({ ...item.raw, candidates: candidates,
        match_type: alreadyClaimed ? 'ambiguous_claimed_ledger' : 'ambiguous_merchant_identity',
        reason: alreadyClaimed
          ? 'Same-day merchant/amount already in ledger, but allocated to another statement row; verify duplicate versus additional purchase.'
          : 'Same account, date and amount already in ledger; verify merchant identity before importing.' });
    }
  }

  // Every source occurrence must survive, including a row whose competitor won
  // while that losing row was being processed earlier in the loop.
  result.missing = sItems
    .filter(s => !matchedStatementIndices.has(s.index) && !ambiguousStatementIndices.has(s.index))
    .map(s => s.raw);
  return result;
}

/** Pairwise user-confirmed shared-venue/payment relationships, requiring same day. */
function reconcilerMerchantRelationship(statement, ledger) {
  const raw = normaliseWhere(String(statement.raw.raw_merchant || statement.merchant || ''));
  const where = normaliseWhere(String(ledger.merchant || ''));
  // User-confirmed descriptor relationships. These are pairwise, not aliases
  // joining every stall/vendor/pharmacy to one another, and require same txn day.
  if (/^fr\s+vivo(?:[\s-]|$)/.test(raw) && /^food\s*republic$/.test(where)) return 'Food Republic stall descriptor';
  if (/^(?:atlas vending|f&n foods)(?:\b|$)/.test(raw) && /^vending machine$/.test(where)) return 'Vending operator descriptor';
  if (/^(?:ntuc\s+)?fairprice app pay(?:\b|$)/.test(String(statement.raw.raw_merchant || '').toLowerCase().trim()) && /^unity$/.test(where)) return 'User-confirmed FairPrice app payment at Unity';
  return '';
}

/**
 * Resolves a raw or normalized merchant string to its canonical brand identity.
 * Uses known Singapore banking brand patterns and Merchants tab aliases.
 * 
 * @param {string} merchant - Merchant descriptor string.
 * @param {Object} [optAliases] - Optional merchant aliases mapping.
 * @return {string} Canonical merchant name in lowercase.
 */
function resolveCanonicalMerchant(merchant, optAliases) {
  if (!merchant || typeof merchant !== 'string') return '';

  const norm = typeof normaliseWhere === 'function' ? normaliseWhere(merchant) : merchant.toLowerCase().trim();
  if (!norm) return '';

  // Explicit snapshot only: matching helpers must not depend on live properties.
  const aliases = optAliases || {};
  if (aliases && aliases[norm] && aliases[norm].canonical) {
    // Canonical display aliases still resolve to the same matching identity.
    return resolveCanonicalMerchant(aliases[norm].canonical, {});
  }

  // Stable descriptor/display identities; keep these separate from shared venues.
  if (/^redshield\s*vpn\b/.test(norm)) return 'redshield vpn';
  if (/^(?:sp\s*(?:group|digital)|sp services)\b/.test(norm)) return 'sp group';
  if (/^(?:golden village|gv(?:\s+(?:online|vivocity)))\b/.test(norm)) return 'golden village';

  // 2. High-frequency known Singapore brands and gateway patterns
  if (/^spl\b|^simplygo\b|auto\s*topup/i.test(norm)) {
    return 'simplygo';
  }
  if (/^popular\b/i.test(norm)) {
    return 'popular bookstores';
  }
  if (/^lazada\b/i.test(norm)) {
    return 'lazada';
  }
  if (/^gojek\b|^gopay\b/i.test(norm)) {
    return 'gojek';
  }
  if (/^jasons\b|^cold\s*storage\b|^cs\s*fresh\b/i.test(norm)) {
    return 'cold storage';
  }
  if (/^amzn\s*prime|^amazon\s*prime|^amznprimesg/i.test(norm)) {
    return 'amazon prime';
  }
  if (/^amazon\b|^amzn\b/i.test(norm)) {
    return 'amazon';
  }
  if (/^fairprice\b|^ntuc\b/i.test(norm)) {
    return 'fairprice';
  }
  if (/^grab\s*food\b|^grabfood\b/i.test(norm)) {
    return 'grab food';
  }
  if (/^grab\s*subscription\b/i.test(norm)) {
    return 'grab subscription';
  }
  if (/^grab\b/i.test(norm)) {
    return 'grab';
  }
  if (/^mcdonald/i.test(norm)) {
    return 'mcdonalds';
  }
  if (/^starbucks/i.test(norm)) {
    return 'starbucks';
  }
  if (/^shopee/i.test(norm)) {
    return 'shopee';
  }
  if (/^spotify/i.test(norm)) {
    return 'spotify';
  }
  if (/^circles\.?life/i.test(norm)) {
    return 'circles life';
  }
  if (/^breadtalk/i.test(norm)) {
    return 'breadtalk';
  }
  if (/^sephora/i.test(norm)) {
    return 'sephora';
  }
  if (/^guzman/i.test(norm)) {
    return 'guzman y gomez';
  }
  if (/^cheers/i.test(norm)) {
    return 'cheers';
  }
  if (/^chagee/i.test(norm)) {
    return 'chagee';
  }
  if (/^raffles\s*children/i.test(norm)) {
    return 'raffles children';
  }
  if (/^watson/i.test(norm)) {
    return 'watsons';
  }
  if (/^guardian/i.test(norm)) {
    return 'guardian';
  }

  return norm;
}

/**
 * Evaluates whether a statement item and a ledger item are cardholder-compatible for matching.
 * Un-noted ledger rows (empty Column J) are ALWAYS compatible (neutral).
 * Only returns false when BOTH sides have explicitly different named individuals.
 * 
 * @param {Object} s - Prepared statement item.
 * @param {Object} l - Prepared ledger item.
 * @return {boolean} True if cardholders are compatible.
 */
function isCardholderCompatible(s, l) {
  const sHolder = (s && s.cardholder) ? s.cardholder : '';
  const lHolder = (l && l.cardholder) ? l.cardholder : '';

  // If ledger has no cardholder note (Column J empty), ALWAYS compatible
  if (!lHolder) return true;
  if (!sHolder) return true;

  // Both sides have distinct names: must match exactly
  return sHolder === lHolder;
}

/**
 * Computes a soft scoring signal for cardholder corroboration.
 * +0.15 if same named cardholder (positive corroboration)
 * -0.20 if different named cardholder (mild negative conflict)
 *  0.00 if ledger has no cardholder note (neutral, never penalizes un-noted ledger rows)
 * 
 * @param {Object} s - Prepared statement item.
 * @param {Object} l - Prepared ledger item.
 * @return {number} Score adjustment.
 */
function computeCardholderScore(s, l) {
  const sHolder = (s && s.cardholder) ? s.cardholder : '';
  const lHolder = (l && l.cardholder) ? l.cardholder : '';

  if (!lHolder || !sHolder) return 0.0;
  if (sHolder === lHolder) return 0.15;
  return -0.20;
}

/**
 * Normalizes an input row for the matching engine.
 * Standardizes date to DD.MM.YYYY, amount to float, merchant with normaliseWhere(), and dedupe_key.
 * Resolves cardholder and card_last4 on both statement and ledger sides.
 * 
 * @param {Object|Array} r - Input statement or ledger row.
 * @param {number} idx - Index in source array.
 * @param {string} source - 'statement' or 'ledger'.
 * @return {Object} Prepared matching item.
 */
function prepareReconcilerItem(r, idx, source) {
  if (!r) {
    return { index: idx, date: '', amount: 0, merchant: '', account: '', dedupe_key: '', card_last4: '', cardholder: '', card_type: '', raw: r };
  }

  let rawDate = '';
  let rawAmount = null;
  let rawMerchant = '';
  let account = 'DBS CC SGD';
  let dedupeKey = '';
  let cardLast4 = '';
  let cardholder = '';
  let cardType = '';

  if (Array.isArray(r)) {
    rawDate = r[0] || '';
    rawMerchant = r[1] || '';
    rawAmount = r[2];
    if (r.length > 3) account = r[3] || account;
  } else if (typeof r === 'object') {
    rawDate = r.date || r.raw_date || '';
    rawAmount = (r.amount !== undefined && r.amount !== null) ? r.amount : r.raw_amount;
    rawMerchant = r.merchant || r.description || r.where || r.raw_merchant || '';
    account = r.account || account;
    dedupeKey = r.dedupe_key || '';

    if (source === 'statement') {
      const rawCard = r.card_last4 || r.card_number || '';
      cardLast4 = rawCard ? String(rawCard).replace(/\D/g, '').slice(-4) : '';
      cardholder = r.cardholder || (typeof resolveCardholder === 'function' ? resolveCardholder(cardLast4) : '');
      cardType = r.card_type || (cardLast4 === '4320' ? 'main' : (cardLast4 ? 'supplementary' : ''));
    } else if (source === 'ledger') {
      const notes = String(r.notes || '').trim();
      if (/grandparents|бабушка|дедушка|0465/i.test(notes)) {
        cardholder = 'Grandparents';
        cardLast4 = '0465';
        cardType = 'supplementary';
      } else if (/rita|рита|7509/i.test(notes)) {
        cardholder = 'Rita';
        cardLast4 = '7509';
        cardType = 'supplementary';
      } else if (/val|валь|4320/i.test(notes)) {
        cardholder = 'Val';
        cardLast4 = '4320';
        cardType = 'main';
      } else {
        cardholder = '';
      }
    }
  }

  const normDate = typeof normalizeDateString === 'function' ? normalizeDateString(rawDate) : String(rawDate || '').trim();
  const numAmount = typeof normalizeAmountValue === 'function' ? normalizeAmountValue(rawAmount) : parseFloat(rawAmount || 0);
  const normMerchant = typeof normaliseWhere === 'function' ? normaliseWhere(rawMerchant) : String(rawMerchant || '').toLowerCase().trim();

  if (!dedupeKey && typeof generateDedupeKey === 'function') {
    dedupeKey = generateDedupeKey(normDate, account, numAmount, normMerchant);
  }

  const postingDate = (typeof r === 'object' && r.posting_date) ? String(r.posting_date).trim() : '';
  const category = (typeof r === 'object' && r.category) ? String(r.category).trim() : '';

  return {
    index: idx,
    date: normDate,
    posting_date: postingDate,
    amount: numAmount,
    merchant: normMerchant,
    category: category,
    account: account,
    dedupe_key: dedupeKey,
    source: source,
    card_last4: cardLast4,
    cardholder: cardholder,
    card_type: cardType,
    raw: r
  };
}

/**
 * Computes calendar day difference between two date strings (DD.MM.YYYY, ISO, or Date objects).
 * Pure in-memory date math using UTC midnight to prevent DST/timezone errors.
 * 
 * @param {string|Date} date1 - First date.
 * @param {string|Date} date2 - Second date.
 * @return {number} Absolute difference in calendar days (or 999 if invalid).
 */
function getDaysDifference(date1, date2) {
  const d1 = parseToDateObj(date1);
  const d2 = parseToDateObj(date2);
  if (!d1 || !d2) return 999;
  const msPerDay = 1000 * 60 * 60 * 24;
  const utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
  const utc2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
  return Math.abs(Math.round((utc1 - utc2) / msPerDay));
}

function parseToDateObj(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  const s = String(val).trim();
  // DD.MM.YYYY or DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/);
  if (dmy) {
    return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  }
  // YYYY-MM-DD or YYYY.MM.DD
  const ymd = s.match(/^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/);
  if (ymd) {
    return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  }
  return null;
}

/**
 * Computes a similarity score between 0.0 and 1.0 for two merchant strings.
 * Evaluates normalized representations, compact representations, prefix/substring containment,
 * token Jaccard similarity, and bigram Dice coefficient.
 * 
 * @param {string} str1 - First merchant string.
 * @param {string} str2 - Second merchant string.
 * @return {number} Similarity score between 0.0 and 1.0.
 */
function computeMerchantSimilarity(str1, str2) {
  if (!str1 && !str2) return 1.0;
  if (!str1 || !str2) return 0.0;

  const s1 = (typeof normaliseWhere === 'function' ? normaliseWhere(str1) : String(str1).toLowerCase()).trim();
  const s2 = (typeof normaliseWhere === 'function' ? normaliseWhere(str2) : String(str2).toLowerCase()).trim();

  if (s1 === s2) return 1.0;

  const c1 = (typeof compactWhere === 'function' ? compactWhere(s1) : s1.replace(/[^a-z0-9а-яё]/gi, ''));
  const c2 = (typeof compactWhere === 'function' ? compactWhere(s2) : s2.replace(/[^a-z0-9а-яё]/gi, ''));

  if (c1 === c2) return 1.0;

  const minLen = Math.min(c1.length, c2.length);
  const maxLen = Math.max(c1.length, c2.length);
  const ratio = maxLen > 0 ? (minLen / maxLen) : 0;

  // 1. Prefix Match: Brand is at the start of the string (e.g. "McDonald's ...", "Spotify ...")
  const isPrefix = (c1.startsWith(c2) || c2.startsWith(c1));
  const isWordPrefix = (s1.startsWith(s2 + ' ') || s2.startsWith(s1 + ' ') || s1 === s2);

  if (minLen >= 4 && isPrefix) {
    // Aligns on word boundary at start OR substantial length ratio
    if (isWordPrefix || ratio >= 0.50) {
      return 0.90;
    }
    // Prefix without word boundary
    return 0.80;
  }

  // 2. Mid-String Substring Match (contained inside, but NOT at the start)
  const isSubstring = (c1.includes(c2) || c2.includes(c1));
  if (minLen >= 4 && isSubstring) {
    const shorter = s1.length <= s2.length ? s1 : s2;
    const longer = s1.length <= s2.length ? s2 : s1;
    const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp('(?:^|\\s)' + escaped + '(?:\\s|$)', 'i');
    const isWordMatch = wordRegex.test(longer);

    const shorterWords = shorter.split(/\s+/).filter(w => w.length > 0);
    const isMultiWord = shorterWords.length >= 2;

    // Multi-word phrase (e.g. "Auto Topup") with word boundary and ratio >= 0.30 -> qualify
    if (isWordMatch && isMultiWord && ratio >= 0.30) {
      return 0.85;
    }

    // Single word (e.g. "Phuket") requires ratio >= 0.50
    if (isWordMatch && !isMultiWord && ratio >= 0.50) {
      return 0.85;
    }

    // Otherwise, mid-string substring scores strictly below 0.70 (scaled between 0.30 and 0.65)
    return Math.min(0.65, parseFloat((0.30 + 0.40 * ratio).toFixed(2)));
  }

  // Token-based Jaccard similarity
  const tokens1 = s1.split(/\s+/).filter(t => t.length > 1);
  const tokens2 = s2.split(/\s+/).filter(t => t.length > 1);

  if (tokens1.length > 0 && tokens2.length > 0) {
    const set2 = new Set(tokens2);
    let intersection = 0;
    tokens1.forEach(t => { if (set2.has(t)) intersection++; });
    const union = new Set([...tokens1, ...tokens2]).size;
    const jaccard = union > 0 ? (intersection / union) : 0;
    if (jaccard >= 0.5) return jaccard;

    // If primary brand token matches and is >= 4 chars
    if (tokens1[0] === tokens2[0] && tokens1[0].length >= 4) {
      return 0.80;
    }
  }

  // Bigram Dice coefficient
  return calculateBigramSimilarity(c1, c2);
}

function calculateBigramSimilarity(s1, s2) {
  if (s1.length < 2 || s2.length < 2) return 0;
  const bigrams1 = new Map();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.substring(i, i + 2);
    bigrams1.set(bg, (bigrams1.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.substring(i, i + 2);
    const count = bigrams1.get(bg) || 0;
    if (count > 0) {
      bigrams1.set(bg, count - 1);
      intersection++;
    }
  }
  const total = (s1.length - 1) + (s2.length - 1);
  return (2.0 * intersection) / total;
}

/**
 * STAGE 3D: Filters non-spend lines from missing statement transactions.
 * Follows Option B (Smart Dual-Sided Reconciler):
 * Excludes:
 * - credit-card autopay / repayments (the Кредитка pair) -> reason: 'CC payoff'
 * - internal transfers between own accounts -> reason: 'Transfer to self'
 * - fee and reversal net-zero pairs -> reason: 'Fee and reversal, net zero'
 * - transit auto-topup adjustments -> reason: 'Refund'
 * - standalone fee reversals / waivers -> reason: 'Fee and reversal, net zero'
 * - interest credit lines -> reason: 'Interest / FX'
 * 
 * Proposes:
 * - Genuine expenses (amount > 0, type === 'Расходы')
 * - Legitimate external credits (merchant refunds, Allianz reimbursements, Carousell sales)
 *   with type 'Получение денег' and negative amount.
 * 
 * GUARD RULE:
 * isCcPayoff, isInternalTransfer, and isTransitAdjustment/isRefund rules must FIRST require
 * the row to be a credit (amount < 0 || type === 'Получение денег').
 * If amount > 0 && type === 'Расходы', skip those rules entirely so real expenses
 * (e.g. "BILL PAYMENT - SP SERVICES", "GIRO CAFE", "AUTOPAY - TOWN COUNCIL") are never dropped.
 * 
 * CHOICE 1 INVARIANT:
 * No row with amount > 0 && type === 'Расходы' may be excluded,
 * UNLESS its reason is 'Fee and reversal, net zero'.
 * 
 * @param {Array<Object>} missing - Array of missing statement rows from findMissing().
 * @return {{ proposals: Array<Object>, excluded: Array<Object> }} Proposals and excluded items with reasons.
 */
function filterNonSpend(missing) {
  if (!Array.isArray(missing) || missing.length === 0) {
    return { proposals: [], excluded: [] };
  }

  const proposals = [];
  const excluded = [];

  // Map of index -> reason for paired exclusions (e.g. fee & reversal net zero)
  const pairedExcludedMap = new Map();

  // PASS 1: Identify Fee and Reversal Net-Zero Pairs
  // e.g. Citi "LATE CHARGE FEE" (+100 or -100 raw) and "AUTO LATE FEE REVERSAL" (-100 or +100 raw)
  for (let i = 0; i < missing.length; i++) {
    if (pairedExcludedMap.has(i)) continue;
    const r1 = missing[i];
    if (!r1) continue;

    const desc1 = String(r1.raw_merchant || r1.merchant || r1.description || r1.where || '').toUpperCase();
    const isFee1 = desc1.includes('LATE CHARGE') || desc1.includes('LATE FEE') || (desc1.includes('FEE') && !desc1.includes('REVERSAL') && !desc1.includes('WAIVER'));
    if (!isFee1) continue;

    const amt1 = Math.abs(Number(r1.amount !== undefined ? r1.amount : r1.raw_amount) || 0);
    if (amt1 === 0) continue;

    for (let j = 0; j < missing.length; j++) {
      if (i === j || pairedExcludedMap.has(j)) continue;
      const r2 = missing[j];
      if (!r2) continue;

      const desc2 = String(r2.raw_merchant || r2.merchant || r2.description || r2.where || '').toUpperCase();
      const isReversal2 = desc2.includes('REVERSAL') || desc2.includes('WAIVER');
      if (!isReversal2) continue;

      const amt2 = Math.abs(Number(r2.amount !== undefined ? r2.amount : r2.raw_amount) || 0);

      if (Math.abs(amt1 - amt2) < 0.01) {
        pairedExcludedMap.set(i, 'Fee and reversal, net zero');
        pairedExcludedMap.set(j, 'Fee and reversal, net zero');
        break;
      }
    }
  }

  // PASS 2: Evaluate Each Row Against Rules
  for (let idx = 0; idx < missing.length; idx++) {
    const row = missing[idx];
    if (!row) continue;

    // 1. Paired Fee & Reversal Net-Zero (Pass 1)
    if (pairedExcludedMap.has(idx)) {
      excluded.push({
        ...row,
        reason: pairedExcludedMap.get(idx),
        exclusion_category: 'fee_reversal'
      });
      continue;
    }

    const desc = String(row.raw_merchant || row.merchant || row.description || row.where || '').trim();
    const descUpper = desc.toUpperCase();
    const rawTxnType = String(row.transaction_type || row.raw_type || '').toUpperCase();
    const type = String(row.type || '');
    const amt = Number(row.amount !== undefined ? row.amount : row.raw_amount) || 0;

    // GUARD RULE & CHOICE 1:
    // If row has amount > 0 AND type === 'Расходы', it is a genuine positive expense.
    // By Choice 1, no positive expense may be excluded unless it was paired in Pass 1.
    // Skip CC payoff, internal transfer, and refund checks entirely.
    const isExpense = (amt > 0 && type === 'Расходы');
    if (isExpense) {
      proposals.push(row);
      continue;
    }

    // From here on, row is a credit (amt < 0 or type === 'Получение денег')
    const isCredit = (amt < 0 || type === 'Получение денег');

    if (isCredit) {
      // 2. Credit Card Autopay / Repayment (the Кредитка pair / CC payoff)
      // Strong signal: DBS Transaction Type === 'PAYMENT'
      const isCcPayoff = (
        rawTxnType === 'PAYMENT' ||
        descUpper.includes('BILL PAYMENT') ||
        descUpper.includes('AUTOPAY') ||
        descUpper.includes('GIRO') ||
        descUpper.includes('PAYMENT RECEIVED') ||
        descUpper.includes('INTERNET PAYMENT') ||
        descUpper.includes('CREDIT CARD PAYMENT') ||
        descUpper.includes('DBS INTERNET/WIRELESS') ||
        descUpper.includes('IBANK PAYMENT') ||
        descUpper.includes('PAYMENT - THANK YOU') ||
        descUpper.includes('CARD PAYMENT')
      );

      if (isCcPayoff) {
        excluded.push({
          ...row,
          reason: 'CC payoff',
          exclusion_category: 'cc_payoff'
        });
        continue;
      }

      // 3. Internal Transfers between own accounts (e.g. Citi "MONEYSEND VALERIY IVANOV")
      const isInternalTransfer = (
        descUpper.includes('MONEYSEND') ||
        descUpper.includes('VALERIY IVANOV') ||
        descUpper.includes('MARGARITA') ||
        descUpper.includes('INTERNAL TRANSFER') ||
        descUpper.includes('TRANSFER TO SELF') ||
        descUpper.includes('FUNDS TRANSFER')
      );

      if (isInternalTransfer) {
        excluded.push({
          ...row,
          reason: 'Transfer to self',
          exclusion_category: 'transfer_to_self'
        });
        continue;
      }

      // 4. Transit auto-topup adjustments / internal reloads (e.g. DBS "SPL AUTO TOPUP (ABT/RE)")
      const isTransitAdjustment = (
        descUpper.includes('TOPUP (ABT/RE)') ||
        descUpper.includes('SPL AUTO TOPUP')
      );

      if (isTransitAdjustment) {
        excluded.push({
          ...row,
          reason: 'Refund',
          exclusion_category: 'refund'
        });
        continue;
      }

      // 5. Standalone Fee Reversals / Waivers without matched fee
      const isFeeWaiver = (
        descUpper.includes('LATE FEE REVERSAL') ||
        descUpper.includes('FEE REVERSAL') ||
        descUpper.includes('FEE WAIVER')
      );

      if (isFeeWaiver) {
        excluded.push({
          ...row,
          reason: 'Fee and reversal, net zero',
          exclusion_category: 'fee_reversal'
        });
        continue;
      }

      // 6. FX and Interest Credit Lines
      const isInterestCredit = (
        descUpper.includes('INTEREST CREDIT') ||
        descUpper.includes('CREDIT INTEREST')
      );

      if (isInterestCredit) {
        excluded.push({
          ...row,
          reason: 'Interest / FX',
          exclusion_category: 'interest_or_fx'
        });
        continue;
      }

      // OPTION B: Legitimate external credits (merchant refunds, Allianz reimbursements,
      // Carousell sales) are PROPOSED with type 'Получение денег' and negative amount.
      proposals.push(row);
      continue;
    }

    // Default fallback for any remaining rows
    proposals.push(row);
  }

  return { proposals, excluded };
}

// ============================================================================
// 4. STAGE 3E: STAGING REVIEW (_Reconcile TAB)
// ============================================================================

const RECONCILE_STAGING_TAB_NAME = '_Reconcile';

/**
 * Reads historical transactions from the "Transactions" tab without modifying anything.
 * Captures row indices (1-indexed), dates, accounts, types, amounts, categories, and merchants.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet] - Target spreadsheet instance.
 * @return {Array<Object>} Standardized ledger rows.
 */
function readLedgerRowsForReconciliation(optSpreadsheet) {
  const spreadsheet = optSpreadsheet || (typeof getTargetSpreadsheet === 'function' ? getTargetSpreadsheet(true) : null) || (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.TEST_SPREADSHEET_ID ? SpreadsheetApp.openById(SHEET_FACTS.TEST_SPREADSHEET_ID) : null) || (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getActiveSpreadsheet ? SpreadsheetApp.getActiveSpreadsheet() : null);
  if (!spreadsheet) return [];

  const sheet = spreadsheet.getSheetByName('Transactions');
  if (!sheet) {
    Logger.log('⚠️ Warning: Sheet "Transactions" not found in readLedgerRowsForReconciliation.');
    return [];
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const numCols = Math.max(sheet.getLastColumn(), 11);
  const data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  const ledgerRows = [];

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const dateVal = row[0];
    const dateStr = typeof formatSheetDate === 'function'
      ? formatSheetDate(dateVal)
      : (typeof normalizeDateString === 'function' ? normalizeDateString(dateVal) : String(dateVal || '').trim());
    const accountStr = String(row[1] || '').trim();
    const typeStr = String(row[2] || '').trim();
    const amountVal = typeof parseAmountNumber === 'function'
      ? parseAmountNumber(row[4] !== undefined && row[4] !== '' ? row[4] : row[3])
      : (parseFloat(row[4] || row[3]) || 0);
    const categoryStr = String(row[7] || '').trim();
    const whereStr = String(row[8] || '').trim();
    const notesStr = String(row[9] || '').trim();
    const bucketStr = String(row[10] || '').trim();

    if (dateStr || whereStr || amountVal !== 0) {
      ledgerRows.push({
        row_index: r + 2, // 1-indexed row number in Transactions sheet
        date: dateStr,
        account: accountStr,
        type: typeStr,
        amount: amountVal,
        category: categoryStr,
        where: whereStr,
        merchant: whereStr,
        notes: notesStr,
        bucket: bucketStr
      });
    }
  }

  return ledgerRows;
}

/**
 * Builds an aggregated merchant category statistics store from ledger rows.
 * Groups historical transactions by unique normalized merchant and tallies category frequencies.
 * Determines the most frequent category for each merchant (ignoring 'Другое' unless all were 'Другое').
 * 
 * @param {Array<Object>} [ledgerRows] - Historical transactions from Transactions tab.
 * @return {Array<Object>} Array of { rawMerchant, normMerchant, bestCategory, topCount, totalCount }
 */
function buildLedgerMerchantCategoryStats(ledgerRows) {
  if (!Array.isArray(ledgerRows) || ledgerRows.length === 0) return [];

  const map = new Map();

  for (let i = 0; i < ledgerRows.length; i++) {
    const row = ledgerRows[i];
    const where = String(row.where || row.merchant || '').trim();
    const cat = String(row.category || '').trim();
    if (!where) continue;

    const norm = typeof normaliseWhere === 'function' ? normaliseWhere(where) : where.toLowerCase().trim();
    if (!norm) continue;

    if (!map.has(norm)) {
      map.set(norm, {
        rawMerchant: where,
        normMerchant: norm,
        categoryCounts: {},
        totalCount: 0
      });
    }

    const stat = map.get(norm);
    stat.totalCount++;
    if (cat) {
      stat.categoryCounts[cat] = (stat.categoryCounts[cat] || 0) + 1;
    }
  }

  const aggregated = [];
  map.forEach(stat => {
    let bestCat = '';
    let maxCount = 0;
    let fallbackDrugoeCount = 0;

    Object.keys(stat.categoryCounts).forEach(cat => {
      const count = stat.categoryCounts[cat];
      if (cat === 'Другое') {
        fallbackDrugoeCount = count;
      } else if (count > maxCount) {
        maxCount = count;
        bestCat = cat;
      }
    });

    if (!bestCat && fallbackDrugoeCount > 0) {
      bestCat = 'Другое';
      maxCount = fallbackDrugoeCount;
    }

    aggregated.push({
      rawMerchant: stat.rawMerchant,
      normMerchant: stat.normMerchant,
      categoryCounts: stat.categoryCounts,
      bestCategory: bestCat,
      topCount: maxCount,
      totalCount: stat.totalCount
    });
  });

  return aggregated;
}

/**
 * Deletes the bad "Grab -> Рестораны" alias from the Merchants sheet tab (and Script Properties if present).
 * Lets the ledger history drive Grab classification (Grab -> Транспорт for rides, Grab Food -> Рестораны).
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet]
 * @return {boolean} True if bad alias was found and deleted.
 */
function cleanBadGrabAliasFromMerchantsTab(optSpreadsheet) {
  const ss = optSpreadsheet || (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getActiveSpreadsheet ? SpreadsheetApp.getActiveSpreadsheet() : null);
  let deletedCount = 0;

  // 1. Check and clean Merchants sheet tab
  if (ss) {
    const sheet = ss.getSheetByName('Merchants');
    if (sheet) {
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const numCols = Math.max(sheet.getLastColumn(), 5);
        const data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
        // Traverse backwards so deleting rows does not disrupt index
        for (let r = data.length - 1; r >= 0; r--) {
          const rowNum = r + 2;
          const merchant = String(data[r][0] || '').trim().toLowerCase();
          const cat = String(data[r][1] || '').trim();

          // Match canonical Grab mapped to Рестораны
          if (merchant === 'grab' && cat === 'Рестораны') {
            Logger.log(`🗑️ [MERCHANTS TAB] Deleting row ${rowNum}: "${data[r][0]} -> ${cat}" from Merchants tab.`);
            sheet.deleteRow(rowNum);
            deletedCount++;
          }
        }
      }
    }
  }

  // 2. Check and clean Script Properties MERCHANT_ALIASES
  if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
    try {
      const props = PropertiesService.getScriptProperties();
      const aliasesJson = props.getProperty('MERCHANT_ALIASES');
      if (aliasesJson) {
        const aliases = JSON.parse(aliasesJson);
        let propModified = false;
        if (aliases['grab'] && (aliases['grab'].category === 'Рестораны' || aliases['grab'].canonical === 'Grab')) {
          delete aliases['grab'];
          propModified = true;
          Logger.log('🗑️ [SCRIPT PROPERTIES] Removed bad "grab" alias from MERCHANT_ALIASES.');
        }
        if (propModified) {
          props.setProperty('MERCHANT_ALIASES', JSON.stringify(aliases));
        }
      }
    } catch (e) {
      Logger.log(`⚠️ [MERCHANTS CLEANUP] Error checking Script Properties: ${e.message}`);
    }
  }

  if (deletedCount > 0) {
    Logger.log(`✅ [MERCHANTS CLEANUP] Successfully removed ${deletedCount} bad Grab alias row(s) from Merchants tab.`);
  } else {
    Logger.log('ℹ️ [MERCHANTS CLEANUP] No bad "Grab -> Рестораны" alias row found on Merchants tab.');
  }
  return deletedCount > 0;
}

/**
 * Direct user runner to delete the bad Grab alias from the Merchants tab.
 */
function deleteBadGrabAlias() {
  return cleanBadGrabAliasFromMerchantsTab();
}

/**
 * Reads learned merchant records from the 'Merchants' sheet tab.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [spreadsheet]
 * @return {Array<Object>} Array of { merchant, category, count, aliases }
 */
function readMerchantsSheetTab(spreadsheet) {
  if (!spreadsheet) return [];
  const sheet = spreadsheet.getSheetByName('Merchants');
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const numCols = Math.max(sheet.getLastColumn(), 5);
  const data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  const list = [];

  for (let i = 0; i < data.length; i++) {
    const m = String(data[i][0] || '').trim();
    const cat = String(data[i][1] || '').trim();
    const count = Number(data[i][2]) || 1;
    const rawAliases = data[i].length > 4 ? String(data[i][4] || '').split(',').map(s => s.trim()).filter(Boolean) : [];

    if (m && cat && cat !== 'Другое') {
      list.push({
        merchant: m,
        category: cat,
        count: count,
        aliases: rawAliases
      });
    }
  }

  return list;
}

/**
 * Infers proposal category using the 4-step hierarchy:
 * 1. Prior Ledger Rows (similarity >= 0.85, most frequent category) -> Conf 0.9
 * 2. Merchants Tab (similarity >= 0.85 against merchant or aliases) -> Conf 0.7
 * 3. Script Properties MERCHANT_ALIASES (similarity >= 0.85) -> Conf 0.7
 * 4. Fallback 'Другое' -> Conf 0.3
 * 
 * @param {string} rawMerchant - Raw statement merchant string.
 * @param {Array<Object>} ledgerStats - Aggregated ledger stats from buildLedgerMerchantCategoryStats.
 * @param {Array<Object>} merchantsTabRows - Rows from Merchants tab from readMerchantsSheetTab.
 * @param {Object} scriptAliases - Dictionary from ScriptProperties.
 * @return {Object} { category, matchedMerchant, similarity, source, confidence }
 */
function inferProposalCategory(rawMerchant, ledgerStats, merchantsTabRows, scriptAliases) {
  const cleanRaw = String(rawMerchant || '').trim();
  if (!cleanRaw) {
    return { category: 'Другое', matchedMerchant: null, similarity: 0, source: 'fallback', confidence: 0.3 };
  }

  // --------------------------------------------------------------------------
  // 1. PRIOR LEDGER ROWS (Similarity >= 0.85, most frequent category) -> Conf: 0.9
  // --------------------------------------------------------------------------
  if (Array.isArray(ledgerStats) && ledgerStats.length > 0) {
    const scoredMerchants = [];
    const normRaw = (typeof normaliseWhere === 'function') ? normaliseWhere(cleanRaw) : cleanRaw.toLowerCase().trim();

    let highestSimilarity = 0;
    let hasExactNormMatch = false;

    for (let i = 0; i < ledgerStats.length; i++) {
      const stat = ledgerStats[i];
      const isNormExact = (normRaw && normRaw === stat.normMerchant);

      const sim1 = (typeof computeMerchantSimilarity === 'function')
        ? computeMerchantSimilarity(cleanRaw, stat.rawMerchant)
        : 0;
      const sim2 = (typeof computeMerchantSimilarity === 'function')
        ? computeMerchantSimilarity(cleanRaw, stat.normMerchant)
        : 0;
      let maxSim = Math.max(sim1, sim2);
      if (isNormExact) {
        maxSim = 1.0;
        hasExactNormMatch = true;
      }

      if (maxSim >= 0.85) {
        if (maxSim > highestSimilarity) highestSimilarity = maxSim;
        scoredMerchants.push({
          stat: stat,
          similarity: maxSim,
          isExact: isNormExact
        });
      }
    }

    // Filter to top-tier matches:
    // If an exact normalized match exists (e.g. "grab food" === "grab food"), use ONLY exact matches
    // so that broader/unrelated prefix matches (e.g. "grab" 0.90) cannot overpower it.
    const matchingMerchants = [];
    const pooledCategoryCounts = {};
    let fallbackDrugoeCount = 0;

    for (let i = 0; i < scoredMerchants.length; i++) {
      const item = scoredMerchants[i];
      if (hasExactNormMatch && !item.isExact) {
        continue;
      }
      if (!hasExactNormMatch && item.similarity < highestSimilarity - 0.05) {
        continue;
      }

      const stat = item.stat;
      matchingMerchants.push({
        merchant: stat.rawMerchant,
        similarity: item.similarity,
        topCount: stat.topCount,
        totalCount: stat.totalCount
      });

      // Pool category frequencies across top matching ledger rows
      const counts = stat.categoryCounts || {};
      Object.keys(counts).forEach(cat => {
        const count = counts[cat];
        if (cat === 'Другое') {
          fallbackDrugoeCount += count;
        } else {
          pooledCategoryCounts[cat] = (pooledCategoryCounts[cat] || 0) + count;
        }
      });
    }

    if (matchingMerchants.length > 0) {
      let bestCat = '';
      let highestCatCount = 0;

      Object.keys(pooledCategoryCounts).forEach(cat => {
        if (pooledCategoryCounts[cat] > highestCatCount) {
          highestCatCount = pooledCategoryCounts[cat];
          bestCat = cat;
        }
      });

      if (!bestCat && fallbackDrugoeCount > 0) {
        bestCat = 'Другое';
      }

      if (bestCat && bestCat !== 'Другое') {
        // Pick top matched merchant for logging and display
        matchingMerchants.sort((a, b) => {
          if (Math.abs(b.similarity - a.similarity) > 0.01) {
            return b.similarity - a.similarity;
          }
          return b.totalCount - a.totalCount;
        });
        const topMatch = matchingMerchants[0];

        return {
          category: bestCat,
          matchedMerchant: topMatch.merchant,
          similarity: topMatch.similarity,
          source: 'ledger',
          confidence: 0.9
        };
      }
    }
  }

  // --------------------------------------------------------------------------
  // 2. MERCHANTS SHEET TAB (Similarity >= 0.85 against merchant or aliases) -> Conf: 0.7
  // --------------------------------------------------------------------------
  if (Array.isArray(merchantsTabRows) && merchantsTabRows.length > 0) {
    const tabCandidates = [];
    for (let j = 0; j < merchantsTabRows.length; j++) {
      const m = merchantsTabRows[j];
      let bestSim = (typeof computeMerchantSimilarity === 'function')
        ? computeMerchantSimilarity(cleanRaw, m.merchant)
        : 0;

      if (Array.isArray(m.aliases)) {
        for (let a = 0; a < m.aliases.length; a++) {
          const aSim = (typeof computeMerchantSimilarity === 'function')
            ? computeMerchantSimilarity(cleanRaw, m.aliases[a])
            : 0;
          if (aSim > bestSim) bestSim = aSim;
        }
      }

      if (bestSim >= 0.85) {
        tabCandidates.push({
          merchant: m.merchant,
          category: m.category,
          similarity: bestSim,
          count: m.count || 1
        });
      }
    }

    if (tabCandidates.length > 0) {
      tabCandidates.sort((a, b) => {
        if (Math.abs(b.similarity - a.similarity) > 0.01) {
          return b.similarity - a.similarity;
        }
        return (b.count || 0) - (a.count || 0);
      });
      const top = tabCandidates[0];

      // CRITICAL GUARANTEE (Requirement 2): The ledger MUST win over a Merchants tab row / alias when they conflict!
      if (Array.isArray(ledgerStats) && ledgerStats.length > 0) {
        const normTop = (typeof normaliseWhere === 'function' ? normaliseWhere(top.merchant) : top.merchant.toLowerCase()).trim();
        const ledgerMatchForTop = ledgerStats.find(s => s.normMerchant === normTop || s.rawMerchant.toLowerCase() === top.merchant.toLowerCase());
        if (ledgerMatchForTop && ledgerMatchForTop.bestCategory && ledgerMatchForTop.bestCategory !== 'Другое') {
          if (ledgerMatchForTop.bestCategory !== top.category) {
            Logger.log(`ℹ️ [TIER 1 OVERRIDE] Ledger history for "${top.merchant}" (${ledgerMatchForTop.bestCategory}, count: ${ledgerMatchForTop.topCount}) overrides Merchants tab alias (${top.category}).`);
          }
          return {
            category: ledgerMatchForTop.bestCategory,
            matchedMerchant: ledgerMatchForTop.rawMerchant,
            similarity: top.similarity,
            source: 'ledger',
            confidence: 0.9
          };
        }
      }

      return {
        category: top.category,
        matchedMerchant: top.merchant,
        similarity: top.similarity,
        source: 'alias',
        confidence: 0.7
      };
    }
  }

  // --------------------------------------------------------------------------
  // 3. SCRIPT PROPERTIES ALIASES -> Conf: 0.7
  // --------------------------------------------------------------------------
  if (scriptAliases && typeof scriptAliases === 'object') {
    const aliasCandidates = [];
    const keys = Object.keys(scriptAliases);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const item = scriptAliases[key];
      const cat = typeof item === 'object' && item ? item.category : null;
      const canonical = typeof item === 'object' && item ? (item.canonical || key) : item;
      if (!cat || cat === 'Другое') continue;

      let sim = (typeof computeMerchantSimilarity === 'function')
        ? computeMerchantSimilarity(cleanRaw, canonical)
        : 0;
      const keySim = (typeof computeMerchantSimilarity === 'function')
        ? computeMerchantSimilarity(cleanRaw, key)
        : 0;
      sim = Math.max(sim, keySim);

      if (sim >= 0.85) {
        aliasCandidates.push({
          merchant: canonical || key,
          category: cat,
          similarity: sim
        });
      }
    }

    if (aliasCandidates.length > 0) {
      aliasCandidates.sort((a, b) => b.similarity - a.similarity);
      const top = aliasCandidates[0];

      // CRITICAL GUARANTEE (Requirement 2): The ledger MUST win over a Script Property alias when they conflict!
      if (Array.isArray(ledgerStats) && ledgerStats.length > 0) {
        const normTop = (typeof normaliseWhere === 'function' ? normaliseWhere(top.merchant) : top.merchant.toLowerCase()).trim();
        const ledgerMatchForTop = ledgerStats.find(s => s.normMerchant === normTop || s.rawMerchant.toLowerCase() === top.merchant.toLowerCase());
        if (ledgerMatchForTop && ledgerMatchForTop.bestCategory && ledgerMatchForTop.bestCategory !== 'Другое') {
          if (ledgerMatchForTop.bestCategory !== top.category) {
            Logger.log(`ℹ️ [TIER 1 OVERRIDE] Ledger history for "${top.merchant}" (${ledgerMatchForTop.bestCategory}, count: ${ledgerMatchForTop.topCount}) overrides Script Property alias (${top.category}).`);
          }
          return {
            category: ledgerMatchForTop.bestCategory,
            matchedMerchant: ledgerMatchForTop.rawMerchant,
            similarity: top.similarity,
            source: 'ledger',
            confidence: 0.9
          };
        }
      }

      return {
        category: top.category,
        matchedMerchant: top.merchant,
        similarity: top.similarity,
        source: 'alias',
        confidence: 0.7
      };
    }
  }

  // --------------------------------------------------------------------------
  // 4. FALLBACK: 'Другое' -> Conf: 0.3
  // --------------------------------------------------------------------------
  return {
    category: 'Другое',
    matchedMerchant: null,
    similarity: 0,
    source: 'fallback',
    confidence: 0.3
  };
}

/**
 * Samples top ~30 representative merchants by frequency from the user's Transactions ledger,
 * spanning as many distinct categories as possible to provide authentic few-shot examples for Gemini.
 * 
 * Invariants:
 * - Hand-picking is strictly prohibited; samples derive purely from the user's historical transactions.
 * - Categories are restricted strictly to validCategories (read dynamically from the '-' tab).
 * - "Другое" is excluded from few-shot examples.
 * 
 * @param {Array<Object>} ledgerRows - Historical transactions from Transactions tab.
 * @param {Array<string>} validCategories - Dynamic category list from '-' tab.
 * @param {number} [maxCount=30] - Maximum target few-shot examples.
 * @return {Array<Object>} Array of { merchant: string, category: string, frequency: number }
 */
function sampleLedgerFewShotExamples(ledgerRows, validCategories, maxCount) {
  const targetCount = (typeof maxCount === 'number' && maxCount > 0) ? maxCount : 30;
  if (!Array.isArray(ledgerRows) || ledgerRows.length === 0) return [];

  const allowedCatSet = new Set(Array.isArray(validCategories) ? validCategories : []);

  // 1. Group ledger rows by normalized merchant and count frequencies per category
  const merchantMap = new Map();

  for (let i = 0; i < ledgerRows.length; i++) {
    const row = ledgerRows[i];
    const where = String(row.where || row.merchant || '').trim();
    const cat = String(row.category || '').trim();

    if (!where || !cat || cat === 'Другое') continue;
    if (allowedCatSet.size > 0 && !allowedCatSet.has(cat)) continue;

    const norm = typeof normaliseWhere === 'function' ? normaliseWhere(where) : where.toLowerCase().trim();
    if (!norm) continue;

    if (!merchantMap.has(norm)) {
      merchantMap.set(norm, {
        rawName: where,
        norm: norm,
        totalCount: 0,
        categoryCounts: {}
      });
    }

    const item = merchantMap.get(norm);
    item.totalCount++;
    item.categoryCounts[cat] = (item.categoryCounts[cat] || 0) + 1;
    // Prefer cleaner display casing
    if (where.length > item.rawName.length || (where !== where.toLowerCase() && item.rawName === item.rawName.toLowerCase())) {
      item.rawName = where;
    }
  }

  // 2. Identify dominant category for each merchant and group by category
  const categoryBuckets = {};

  merchantMap.forEach(item => {
    let dominantCat = '';
    let maxFreq = 0;
    Object.keys(item.categoryCounts).forEach(c => {
      if (item.categoryCounts[c] > maxFreq) {
        maxFreq = item.categoryCounts[c];
        dominantCat = c;
      }
    });

    if (dominantCat && maxFreq > 0) {
      if (!categoryBuckets[dominantCat]) {
        categoryBuckets[dominantCat] = [];
      }
      categoryBuckets[dominantCat].push({
        merchant: item.rawName,
        category: dominantCat,
        frequency: maxFreq,
        total: item.totalCount
      });
    }
  });

  // Sort merchants inside each category bucket by frequency descending
  Object.keys(categoryBuckets).forEach(cat => {
    categoryBuckets[cat].sort((a, b) => b.frequency - a.frequency);
  });

  // 3. Round-robin sample across distinct categories to ensure broad category coverage
  const selected = [];
  const selectedMerchants = new Set();
  const categoriesWithItems = Object.keys(categoryBuckets);

  // Pass 1: Take 1 top merchant from every available category
  for (const cat of categoriesWithItems) {
    if (selected.length >= targetCount) break;
    const bucket = categoryBuckets[cat];
    if (bucket && bucket.length > 0) {
      const top = bucket[0];
      selected.push(top);
      selectedMerchants.add(top.merchant);
    }
  }

  // Pass 2: Take a second merchant from categories that have more
  if (selected.length < targetCount) {
    for (const cat of categoriesWithItems) {
      if (selected.length >= targetCount) break;
      const bucket = categoryBuckets[cat];
      if (bucket && bucket.length > 1) {
        const second = bucket[1];
        if (!selectedMerchants.has(second.merchant)) {
          selected.push(second);
          selectedMerchants.add(second.merchant);
        }
      }
    }
  }

  // Pass 3: Fill remaining slots by highest overall frequency across all remaining candidates
  if (selected.length < targetCount) {
    const remaining = [];
    for (const cat of categoriesWithItems) {
      const bucket = categoryBuckets[cat];
      for (let k = 2; k < bucket.length; k++) {
        if (!selectedMerchants.has(bucket[k].merchant)) {
          remaining.push(bucket[k]);
        }
      }
    }
    remaining.sort((a, b) => b.frequency - a.frequency);
    for (const rem of remaining) {
      if (selected.length >= targetCount) break;
      selected.push(rem);
      selectedMerchants.add(rem.merchant);
    }
  }

  return selected;
}

/**
 * Tier-3 Category Inference: Calls Gemini in ONE batched API call to classify all unknown merchants
 * that were not matched by prior ledger rows (Tier 1) or Merchants tab/aliases (Tier 2).
 * 
 * Invariants:
 * - Constrained vocabulary: Only categories present in validCategories (from '-' tab) are accepted.
 * - Strict rejection: Any category returned by Gemini not in validCategories is rejected -> 'Другое'.
 * - Clean display name: Extracts human-readable merchant name (stripping location/currency/terminal noise).
 * - Graceful degradation: If Gemini fails (network, quota, parse error), falls back to 'Другое' (0.3) without throwing.
 * 
 * @param {Array<Object>} unknownItems - Array of { id: number, raw_descriptor: string }
 * @param {Array<string>} validCategories - Allowed categories from '-' tab.
 * @param {Array<Object>} fewShotExamples - Sampled few-shot examples from user's ledger.
 * @param {string} [apiKey] - Gemini API Key.
 * @return {Object<string, Object>} Map of normaliseWhere(raw_descriptor) -> { category: string, clean_display_name: string }
 */
function inferCategoriesWithGeminiBatch(unknownItems, validCategories, fewShotExamples, apiKey) {
  if (!Array.isArray(unknownItems) || unknownItems.length === 0) {
    return {};
  }

  // Omitted key uses configuration; explicit null/empty disables inference.
  const effectiveKey = apiKey !== undefined ? apiKey : (
    typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties
      ? PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')
      : null
  );

  if (!effectiveKey) {
    Logger.log('⚠️ [GEMINI TIER 3] No API key supplied or configured. Skipping Gemini tier.');
    return {};
  }

  const allowedCatList = (Array.isArray(validCategories) && validCategories.length > 0)
    ? validCategories
    : (typeof CATEGORIES !== 'undefined' && Array.isArray(CATEGORIES) ? CATEGORIES : []);
  const allowedCatSet = new Set(allowedCatList);

  const examples = Array.isArray(fewShotExamples) ? fewShotExamples : [];
  const examplesPromptText = examples.length > 0
    ? examples.map(ex => `- "${ex.merchant}" -> Category: "${ex.category}"`).join('\n')
    : `- "FairPrice" -> Category: "Продукты"\n- "Grab" -> Category: "Транспорт"\n- "McDonald's" -> Category: "Рестораны"`;

  const prompt = `You are a financial transaction categorization and merchant entity extractor for a personal budget system in Singapore.

CONSTRAINED CATEGORIES (Choose EXACTLY one of these 22 categories for each transaction; NO other category is permitted):
${allowedCatList.map(c => `- ${c}`).join('\n')}

LEARNED CONVENTIONS & EXAMPLES FROM THE USER'S OWN LEDGER:
${examplesPromptText}

INSTRUCTIONS:
1. For each input transaction descriptor, select the most accurate category from the 22 categories above.
   - If an item is a hotel, flight, or holiday/travel booking, categorize as "Отдых".
   - If an item is public transport, taxi, or ride-hailing (e.g. Grab, Gojek, SimplyGo, MRT), categorize as "Транспорт".
   - If an item is supermarket or groceries (e.g. FairPrice, Cold Storage, Sheng Siong), categorize as "Продукты".
   - If an item is restaurants, cafes, bars, or food delivery (e.g. McDonald's, Starbucks, GrabFood, Deliveroo), categorize as "Рестораны".
   - If you are genuinely uncertain, return "Другое".
2. Extract a clean, professional, human-readable merchant display name (clean_display_name):
   - Strip city/country suffixes (e.g. SG, SINGAPORE, TH, STOCKHOLM SE, USA).
   - Strip payment gateway prefixes (e.g. SPL, NETS*, 2C2*, VISA*).
   - Strip foreign currency settled amounts (e.g. THB 14,419.20, USD 25.00).
   - Strip terminal numbers, store IDs, and trailing transaction codes (e.g. P466A9DDE4, BEA, SUNTEC SG).
   - Convert ALL-CAPS names to clean Title Case or proper brand casing (e.g. "LE MERIDIEN PHUKET" -> "Le Meridien Phuket").

INPUT TRANSACTIONS:
${JSON.stringify(unknownItems, null, 2)}

OUTPUT SCHEMA:
Return a JSON array of objects with the exact structure:
[
  {
    "id": 1,
    "raw_descriptor": "...",
    "clean_display_name": "...",
    "category": "..."
  }
]
Only valid JSON matching this schema, no markdown code fences or other commentary.`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const resultsMap = {};

  const defaultModel = typeof GEMINI_MODEL_ID !== 'undefined' ? GEMINI_MODEL_ID : 'gemini-3.5-flash-lite';
  const startTime = Date.now();

  try {
    Logger.log(`🤖 [GEMINI TIER 3] Calling Gemini batch inference for ${unknownItems.length} unknown merchant(s) (Target: ${defaultModel})...`);
    const apiResult = (typeof callGeminiApiWithRetry === 'function')
      ? callGeminiApiWithRetry(payload, effectiveKey, defaultModel)
      : null;

    if (!apiResult) {
      Logger.log('⚠️ [GEMINI TIER 3] callGeminiApiWithRetry not available or returned null. Gracefully falling back to Tier 4.');
      return {};
    }

    const responseText = (typeof apiResult === 'object') ? apiResult.text : apiResult;
    const modelUsed = (typeof apiResult === 'object' && apiResult.modelUsed) ? apiResult.modelUsed : defaultModel;
    const elapsedMs = (typeof apiResult === 'object' && apiResult.elapsedTimeMs) ? apiResult.elapsedTimeMs : (Date.now() - startTime);
    const responseJson = JSON.parse(responseText);
    const candidate = responseJson.candidates && responseJson.candidates[0];
    const textOutput = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0].text;

    if (!textOutput) {
      Logger.log('⚠️ [GEMINI TIER 3] No text output returned by Gemini. Gracefully falling back to Tier 4.');
      return {};
    }

    const parsedArray = JSON.parse(textOutput);
    const items = Array.isArray(parsedArray) ? parsedArray : (parsedArray.transactions || parsedArray.items || [parsedArray]);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rawDesc = String(it.raw_descriptor || '').trim();
      const rawCat = String(it.category || '').trim();
      const cleanName = String(it.clean_display_name || '').trim();

      // Enforce constrained vocabulary: reject any category not in allowedCatSet
      const isAllowed = allowedCatSet.has(rawCat) && rawCat !== 'Другое';
      const finalCat = isAllowed ? rawCat : 'Другое';

      const norm = typeof normaliseWhere === 'function' ? normaliseWhere(rawDesc) : rawDesc.toLowerCase().trim();
      if (norm) {
        resultsMap[norm] = {
          id: it.id,
          category: finalCat,
          clean_display_name: cleanName || (typeof cleanMerchantDisplayName === 'function' ? cleanMerchantDisplayName(rawDesc) : rawDesc),
          rejected: !isAllowed && rawCat !== 'Другое',
          originalProposed: rawCat
        };
      }
    }

    Logger.log(`✅ [GEMINI TIER 3] Successfully classified ${Object.keys(resultsMap).length} unknown merchant(s) via batch using model: ${modelUsed} in ${elapsedMs}ms.`);
  } catch (err) {
    Logger.log(`⚠️ [GEMINI TIER 3] Error during Gemini batch inference (${err.message}). Gracefully falling back to Tier 4.`);
  }

  return resultsMap;
}

/**
 * Batch-persists newly learned merchants to the 'Merchants' sheet tab.
 * Ensures that future reconciliation runs recognise these merchants at Tier 2 (Conf: 0.7).
 * 
 * Columns in 'Merchants' tab:
 * [merchant, category, count, last_seen, aliases]
 * 
 * @param {Array<Object>} newMerchants - Array of { cleanName: string, category: string, rawDescriptor: string }
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [spreadsheet]
 * @return {number} Number of merchants persisted/updated.
 */
function persistLearnedMerchantsBatch(newMerchants, spreadsheet) {
  if (!Array.isArray(newMerchants) || newMerchants.length === 0) return 0;
  const ss = spreadsheet || (typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp.getActiveSpreadsheet() : null);
  if (!ss) return 0;

  try {
    const merchantsSheet = (typeof initializeLearningStore === 'function')
      ? initializeLearningStore(ss)
      : ss.getSheetByName('Merchants');

    if (!merchantsSheet) return 0;

    const lastRow = merchantsSheet.getLastRow();
    const todayStr = (typeof formatSheetDate === 'function')
      ? formatSheetDate(new Date())
      : Utilities.formatDate(new Date(), 'GMT+8', 'dd.MM.yyyy');

    // Read existing merchants to deduplicate
    const existingMap = new Map();
    let numCols = Math.max(5, merchantsSheet.getLastColumn());

    if (lastRow >= 2) {
      const data = merchantsSheet.getRange(2, 1, lastRow - 1, numCols).getValues();
      for (let r = 0; r < data.length; r++) {
        const mName = String(data[r][0] || '').trim();
        const norm = typeof normaliseWhere === 'function' ? normaliseWhere(mName) : mName.toLowerCase().trim();
        if (norm) {
          existingMap.set(norm, {
            rowIndex: r + 2,
            merchant: mName,
            category: String(data[r][1] || '').trim(),
            count: Number(data[r][2]) || 1,
            lastSeen: data[r][3],
            aliases: String(data[r][4] || '').split(',').map(s => s.trim()).filter(Boolean)
          });
        }
      }
    }

    const rowsToAppend = [];
    const rowsToUpdate = [];
    const processedKeys = new Set();

    for (let i = 0; i < newMerchants.length; i++) {
      const item = newMerchants[i];
      const cleanName = String(item.cleanName || '').trim();
      const cat = String(item.category || '').trim();
      const rawDesc = String(item.rawDescriptor || '').trim();

      if (!cleanName || !cat || cat === 'Другое') continue;

      const norm = typeof normaliseWhere === 'function' ? normaliseWhere(cleanName) : cleanName.toLowerCase().trim();
      if (!norm || processedKeys.has(norm)) continue;
      processedKeys.add(norm);

      if (existingMap.has(norm)) {
        const existing = existingMap.get(norm);
        existing.count += 1;
        existing.lastSeen = todayStr;
        if (rawDesc && rawDesc !== cleanName && !existing.aliases.includes(rawDesc)) {
          existing.aliases.push(rawDesc);
        }
        rowsToUpdate.push(existing);
      } else {
        const aliasStr = (rawDesc && rawDesc !== cleanName) ? rawDesc : '';
        rowsToAppend.push([
          cleanName,
          cat,
          1,
          todayStr,
          aliasStr
        ]);
      }
    }

    // Apply updates
    for (const upd of rowsToUpdate) {
      merchantsSheet.getRange(upd.rowIndex, 1, 1, 5).setValues([[
        upd.merchant,
        upd.category,
        upd.count,
        todayStr,
        upd.aliases.join(', ')
      ]]);
    }

    // Apply appends
    if (rowsToAppend.length > 0) {
      const startRow = merchantsSheet.getLastRow() + 1;
      merchantsSheet.getRange(startRow, 1, rowsToAppend.length, 5).setValues(rowsToAppend);
    }

    Logger.log(`💾 [MERCHANTS STORE] Persisted ${rowsToAppend.length} new and updated ${rowsToUpdate.length} existing merchant(s) in 'Merchants' tab.`);
    return rowsToAppend.length + rowsToUpdate.length;
  } catch (err) {
    Logger.log(`⚠️ [MERCHANTS STORE] Failed to persist learned merchants: ${err.message}`);
    return 0;
  }
}

/**
 * STAGE 3E: Writes proposals and ambiguous rows to the _Reconcile staging tab.
 * Invariant: Transactions stays 100% UNTOUCHED.
 * 
 * Columns:
 * ✓ (checkbox) · date · account · Тип · amount · merchant · proposed category · proposed bucket · confidence · source_row · status
 * 
 * Option B Dual-Sided Features:
 * - Expenses (positive amount, type 'Расходы')
 * - Credits (negative amount, type 'Получение денег' — Allianz, Carousell, returns)
 * - Ambiguous rows surfaced with status 'ambiguous' and candidate rows in source_row
 * - Inline category dropdown validation
 * - Soft mint green tint on credit rows, soft amber tint on ambiguous rows
 * 
 * @param {Array<Object>} proposals - Proposed transactions from filterNonSpend.
 * @param {Array<Object>} [ambiguous] - Ambiguous transactions from findMissing.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet] - Target spreadsheet instance.
 * @param {Array<Object>} [optLedgerRows] - Optional pre-read ledger rows for merchant category learning.
 * @return {Object} Summary { stagedCount, proposalsCount, ambiguousCount, sheet }.
 */
function applyReconcileDropdowns(sheet, categories) {
  const rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  // G is always free text, including cells below the currently populated rows.
  sheet.getRange(2, 7, rows, 1).setDataValidation(null);
  if (typeof SpreadsheetApp === 'undefined' || typeof SpreadsheetApp.newDataValidation !== 'function') return;
  const typeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ALL_TYPES, true).setAllowInvalid(false).build();
  sheet.getRange(2, 5, rows, 1).setDataValidation(typeRule);
  const categoryRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(categories, true).setAllowInvalid(true).build();
  sheet.getRange(2, 8, rows, 1).setDataValidation(categoryRule);
}

/** Preview ticked rows through the actual commit/writer path; never append. */
function previewReconcileCommit() {
  return commitStaged(false, true);
}

/** Repair an existing review in place; preserve its values, ticks and statuses. */
function repairReconcileDropdowns() {
  return withBudgetWriteLock(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(RECONCILE_STAGING_TAB_NAME);
    if (!sheet) throw new Error('_Reconcile tab not found.');
    const header = sheet.getRange(1, 1, 1, 12).getValues()[0];
    if (header[4] !== 'Тип' || String(header[6]).toLowerCase() !== 'merchant') {
      throw new Error('Unexpected staging columns; run reconciliation to create the current 12-column layout.');
    }
    applyReconcileDropdowns(sheet, Object.keys(getCategoryBucketMap(ss)));
    Logger.log('Repaired _Reconcile: E type dropdown, G free text, H category dropdown. Existing review values preserved.');
  });
}

function stageProposals(proposals, ambiguous, optSpreadsheet, optLedgerRows) {
  return withBudgetWriteLock(() => stageProposalsUnlocked(proposals, ambiguous, optSpreadsheet, optLedgerRows));
}

function stageProposalsUnlocked(proposals, ambiguous, optSpreadsheet, optLedgerRows) {
  const spreadsheet = optSpreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('stageProposals: No spreadsheet instance available.');
  }

  const cleanProposals = Array.isArray(proposals) ? proposals : [];
  const ambiguousRows = Array.isArray(ambiguous) ? ambiguous : [];

  // 1. Get or create the _Reconcile staging tab
  let sheet = spreadsheet.getSheetByName(RECONCILE_STAGING_TAB_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(RECONCILE_STAGING_TAB_NAME);
  }

  // Preserve the complete previous review (including edits, ticks and statuses).
  // Copy must succeed before clearing; a failed archive leaves the review intact.
  if (sheet.getLastRow() > 1) {
    const archive = sheet.copyTo(spreadsheet);
    archive.setName('_Reconcile_' + Utilities.getUuid());
    Logger.log('Previous reconciliation review preserved in ' + archive.getName());
  }

  // 2. Clear existing sheet contents and validations
  sheet.clear();
  sheet.clearConditionalFormatRules();

  // Enforce plain text '@' format across entire Column B (date) so Sheets never coerces date strings to Date objects
  sheet.getRange(1, 2, sheet.getMaxRows(), 1).setNumberFormat('@');
  if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.flush === 'function') {
    SpreadsheetApp.flush();
  }

  // 3. Define 12 columns (Cardholder near account for quick scanning)
  const headers = [
    '✓',
    'date',
    'account',
    'Cardholder',
    'Тип',
    'amount',
    'merchant',
    'proposed category',
    'proposed bucket',
    'confidence',
    'source_row',
    'status'
  ];

  // Set headers in row 1
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#1e293b')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  if (cleanProposals.length === 0 && ambiguousRows.length === 0) {
    applyReconcileDropdowns(sheet, Object.keys(getCategoryBucketMap(spreadsheet)));
    Logger.log(`ℹ️ stageProposals: No rows to stage. Initialized empty "${RECONCILE_STAGING_TAB_NAME}" tab.`);
    return { stagedCount: 0, proposalsCount: 0, ambiguousCount: 0, sheet: sheet };
  }

  // 4. Load runtime category bucket map, ledger stats, and merchants stores
  const catMap = typeof getCategoryBucketMap === 'function' ? getCategoryBucketMap(spreadsheet) : {};
  const validCategories = Object.keys(catMap).filter(c => c && c !== 'UNKNOWN');
  const effectiveLedgerRows = (Array.isArray(optLedgerRows) && optLedgerRows.length > 0)
    ? optLedgerRows
    : (typeof readLedgerRowsForReconciliation === 'function' ? readLedgerRowsForReconciliation(spreadsheet) : []);

  const ledgerStats = buildLedgerMerchantCategoryStats(effectiveLedgerRows);
  const merchantsTabRows = readMerchantsSheetTab(spreadsheet);
  const scriptAliases = (typeof getMerchantAliases === 'function') ? getMerchantAliases() : {};
  const proposalInferenceLogs = [];

  // 5. Separate proposals into Expenses and Credits for clear visual and structural grouping
  const expenseProposals = [];
  const creditProposals = [];

  for (let i = 0; i < cleanProposals.length; i++) {
    const p = cleanProposals[i];
    const amt = Number(p.amount !== undefined ? p.amount : p.raw_amount) || 0;
    const type = String(p.type || '');
    if (amt < 0 || type === 'Получение денег') {
      creditProposals.push(p);
    } else {
      expenseProposals.push(p);
    }
  }

  // Sorter by date ascending
  const dateSorter = (a, b) => {
    const da = typeof parseToDateObj === 'function' ? parseToDateObj(a.date) : null;
    const db = typeof parseToDateObj === 'function' ? parseToDateObj(b.date) : null;
    if (da && db) return da.getTime() - db.getTime();
    return String(a.date || '').localeCompare(String(b.date || ''));
  };

  expenseProposals.sort(dateSorter);
  creditProposals.sort(dateSorter);
  const sortedAmbiguous = [...ambiguousRows].sort(dateSorter);

  // Combine into structured staging queue
  const stagingQueue = [];
  for (const p of expenseProposals) stagingQueue.push({ item: p, status: 'proposed', isCredit: false });
  for (const p of creditProposals) stagingQueue.push({ item: p, status: 'proposed', isCredit: true });
  for (const amb of sortedAmbiguous) {
    const isAmbCredit = (Number(amb.amount) < 0 || amb.type === 'Получение денег');
    stagingQueue.push({ item: amb, status: 'ambiguous', isCredit: isAmbCredit });
  }

  // 6. Pre-evaluate Tier 1 (prior ledger rows) & Tier 2 (Merchants tab / aliases)
  const unresolvedEntries = [];
  const unknownMap = new Map();
  let unknownCounter = 1;

  for (let i = 0; i < stagingQueue.length; i++) {
    const entry = stagingQueue[i];
    const r = entry.item;
    const rawMerchant = String(r.raw_merchant || r.merchant || r.description || r.where || '').trim();
    entry.rawMerchant = rawMerchant;

    let proposedCat = '';
    let catInference = null;

    if (r.category && r.category !== 'Другое') {
      proposedCat = r.category;
      catInference = { category: proposedCat, matchedMerchant: rawMerchant, similarity: 1.0, source: 'existing', confidence: 0.9 };
    } else if (r.proposed_category && r.proposed_category !== 'Другое') {
      proposedCat = r.proposed_category;
      catInference = { category: proposedCat, matchedMerchant: rawMerchant, similarity: 1.0, source: 'existing', confidence: 0.9 };
    } else {
      catInference = inferProposalCategory(rawMerchant, ledgerStats, merchantsTabRows, scriptAliases);
      proposedCat = catInference.category;
    }

    entry.catInference = catInference;
    entry.proposedCat = proposedCat;

    // If unresolved (category is 'Другое'), collect for Tier-3 Gemini (both proposals AND ambiguous rows)
    if ((entry.status === 'proposed' || entry.status === 'ambiguous') && proposedCat === 'Другое' && rawMerchant) {
      unresolvedEntries.push(entry);
      const normM = typeof normaliseWhere === 'function' ? normaliseWhere(rawMerchant) : rawMerchant.toLowerCase().trim();
      if (normM && !unknownMap.has(normM)) {
        unknownMap.set(normM, {
          id: unknownCounter++,
          raw_descriptor: rawMerchant,
          norm: normM
        });
      }
    }
  }

  // 7. Execute Tier-3 Gemini Batch Categorization for unresolved proposals & ambiguous rows
  if (unknownMap.size > 0) {
    const apiKey = (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties)
      ? PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')
      : null;

    if (apiKey) {
      const allowedCategories = (validCategories.length > 0)
        ? validCategories
        : (typeof CATEGORIES !== 'undefined' && Array.isArray(CATEGORIES) ? CATEGORIES : Object.keys(catMap));

      const fewShotExamples = sampleLedgerFewShotExamples(effectiveLedgerRows, allowedCategories, 30);
      const unknownList = Array.from(unknownMap.values()).map(u => ({
        id: u.id,
        raw_descriptor: u.raw_descriptor
      }));

      Logger.log(`🤖 [STAGE 3E] Running Tier-3 Gemini batch for ${unknownList.length} unique unknown merchant(s)...`);
      const geminiResults = inferCategoriesWithGeminiBatch(unknownList, allowedCategories, fewShotExamples, apiKey);

      for (let u = 0; u < unresolvedEntries.length; u++) {
        const uEntry = unresolvedEntries[u];
        const normM = typeof normaliseWhere === 'function' ? normaliseWhere(uEntry.rawMerchant) : uEntry.rawMerchant.toLowerCase().trim();
        const gem = geminiResults[normM];

        if (gem && gem.category && gem.category !== 'Другое' && allowedCategories.includes(gem.category)) {
          uEntry.proposedCat = gem.category;
          uEntry.catInference = {
            category: gem.category,
            matchedMerchant: gem.clean_display_name,
            similarity: 1.0,
            source: 'gemini',
            confidence: (uEntry.status === 'ambiguous') ? 0.5 : 0.6
          };
          uEntry.geminiCleanName = gem.clean_display_name;

        }
      }
    }
  }

  // 8. Build 2D values and backgrounds for sheet staging
  const numRows = stagingQueue.length;
  const rows2D = [];
  const backgrounds = [];

  for (let i = 0; i < numRows; i++) {
    const entry = stagingQueue[i];
    const r = entry.item;
    const status = entry.status;
    const isCredit = entry.isCredit;
    const rawMerchant = entry.rawMerchant;
    const catInference = entry.catInference;
    const proposedCat = entry.proposedCat;

    const dateStr = typeof normalizeDateString === 'function'
      ? normalizeDateString(r.date || r.raw_date)
      : String(r.date || '').trim();
    const accountStr = String(r.account || (typeof DEFAULT_ACCOUNT !== 'undefined' ? DEFAULT_ACCOUNT : 'DBS CC SGD')).trim();
    const typeStr = isCredit ? 'Получение денег' : (r.type || 'Расходы');

    // Amount: negative for credits, positive for expenses
    let numAmt = Number(r.amount !== undefined ? r.amount : r.raw_amount) || 0;
    if (isCredit && numAmt > 0) numAmt = -numAmt;
    if (!isCredit && numAmt < 0) numAmt = Math.abs(numAmt);

    // Determine clean merchant display name across all tiers:
    // 1. Gemini clean display name if classified by Tier 3
    // 2. Matched merchant from Tier 1 (ledger) or Tier 2 (merchants tab/aliases) if available
    // 3. Fallback to cleanMerchantDisplayName(rawMerchant)
    let merchantStr = entry.geminiCleanName;
    if (!merchantStr && catInference && catInference.matchedMerchant && catInference.source !== 'fallback') {
      merchantStr = catInference.matchedMerchant;
    }
    if (!merchantStr) {
      merchantStr = (typeof cleanMerchantDisplayName === 'function')
        ? cleanMerchantDisplayName(rawMerchant)
        : rawMerchant;
    }

    // Determine bucket via enricher or catMap
    let proposedBucket = catMap ? catMap[proposedCat] : undefined;
    if (proposedBucket === undefined || proposedBucket === null || proposedBucket === '' || proposedBucket === 'UNKNOWN') {
      proposedBucket = (typeof CATEGORY_TO_BUCKET !== 'undefined' && CATEGORY_TO_BUCKET[proposedCat])
        ? CATEGORY_TO_BUCKET[proposedCat]
        : 'Wants';
    }

    // Confidence:
    // Ambiguous rows ALWAYS 0.5 (requires manual review)
    // Proposals: ledger = 0.9, alias = 0.7, gemini = 0.6, fallback 'Другое' = 0.3
    let confidenceVal = (status === 'ambiguous') ? 0.5 : catInference.confidence;

    // Check KNOWN AMBIGUOUS MERCHANTS:
    // Only "WWW.GRAB.COM BANGKOK" is genuinely ambiguous from the descriptor alone (ride vs food)
    const isGrabBangkok = /www\.grab\.com.*bangkok|grab.*bangkok/i.test(rawMerchant);

    if (isGrabBangkok) {
      confidenceVal = 0.5;
    }

    // Track proposal inference logs for summary output
    proposalInferenceLogs.push({
      status: status,
      rawMerchant: rawMerchant,
      cleanMerchant: merchantStr,
      matchedMerchant: catInference.matchedMerchant,
      similarity: catInference.similarity,
      category: proposedCat,
      source: catInference.source,
      confidence: confidenceVal
    });

    // Assign back to proposal object so memory references retain category & confidence
    r.merchant = merchantStr;
    r.category = proposedCat;
    r.proposed_category = proposedCat;
    r.bucket = proposedBucket;
    r.proposed_bucket = proposedBucket;
    r.confidence = confidenceVal;

    // Source Row: List candidates for ambiguous, or statement metadata for proposals
    let sourceRowStr = '';
    if (status === 'ambiguous') {
      const candidates = r.candidates || [];
      const candList = candidates.map((c, cIdx) => {
        const cRow = c.row_index ? `Row ${c.row_index}` : `Cand ${cIdx + 1}`;
        const cDate = c.date || '';
        const cAmt = Number(c.amount || 0).toFixed(2);
        const cWhere = c.where || c.merchant || '';
        const allocation = c.already_claimed
          ? (c.claimed_by ? `; already matched to ${c.claimed_by.date} "${c.claimed_by.merchant}" (${c.claimed_by.cardholder || 'unknown cardholder'})` : '; reserved for another ambiguous statement row')
          : '';
        return `[${cRow}: ${cDate} S$${cAmt} "${cWhere}"${allocation}]`;
      }).join(', ');
      sourceRowStr = `${r.reason ? r.reason + " | " : ""}Ambiguous (${candidates.length} candidates): ${candList}`;
    } else {
      const rawTxnType = r.transaction_type ? ` (${r.transaction_type})` : '';
      sourceRowStr = r.raw_merchant ? `Statement: "${r.raw_merchant}"${rawTxnType}` : `Statement row`;
    }

    if (isGrabBangkok) {
      const grabNote = 'Grab Bangkok: ride vs food — verify';
      sourceRowStr = sourceRowStr ? `${grabNote} | ${sourceRowStr}` : grabNote;
    }

    // Cardholder determination: Val / Rita / Grandparents
    let cardholderStr = r.cardholder || (r.statement_row && r.statement_row.cardholder) || '';
    if (!cardholderStr) {
      const last4 = r.card_last4 || (r.statement_row && r.statement_row.card_last4) || '';
      if (last4) {
        cardholderStr = typeof resolveCardholder === 'function' ? resolveCardholder(last4) : '';
      }
    }
    if (!cardholderStr) {
      cardholderStr = 'Unknown';
      sourceRowStr = 'Cardholder missing: verify original statement | ' + sourceRowStr;
    }

    // Task 4: Tag Grandparents rows with [Grandparents - Card 0465] and set r.notes = 'Grandparents'
    const isGrandparents = (cardholderStr === 'Grandparents' || r.cardholder === 'Grandparents' || r.card_last4 === '0465' || (r.statement_row && (r.statement_row.cardholder === 'Grandparents' || r.statement_row.card_last4 === '0465')));
    if (isGrandparents) {
      r.notes = 'Grandparents';
      const gpNote = '[Grandparents - Card 0465]';
      sourceRowStr = sourceRowStr ? `${gpNote} ${sourceRowStr}` : gpNote;
    } else {
      r.notes = '';
    }

    // Row layout (12 columns):
    // 1:✓, 2:date, 3:account, 4:Cardholder, 5:Тип, 6:amount, 7:merchant, 8:proposed category, 9:proposed bucket, 10:confidence, 11:source_row, 12:status
    rows2D.push([
      false,               // 1. ✓ (checkbox unchecked)
      dateStr,             // 2. date
      accountStr,          // 3. account
      cardholderStr,       // 4. Cardholder (Val / Rita / Grandparents)
      typeStr,             // 5. Тип
      numAmt,              // 6. amount
      merchantStr,         // 7. merchant
      proposedCat,         // 8. proposed category
      proposedBucket,      // 9. proposed bucket
      confidenceVal,       // 10. confidence
      sourceRowStr,        // 11. source_row
      status               // 12. status
    ]);

    // Visual separation:
    // - Credit rows: soft mint green (#f0fdf4)
    // - Grandparents settlement rows: soft lavender/purple (#f5f3ff)
    // - Ambiguous rows & Grab Bangkok: soft amber yellow (#fffbeb)
    // - Expense proposals: clean white (#ffffff)
    let rowBg = '#ffffff';
    if (isCredit) {
      rowBg = '#f0fdf4';
    } else if (isGrandparents || cardholderStr === 'Grandparents') {
      rowBg = '#f5f3ff';
    } else if (status === 'ambiguous' || isGrabBangkok) {
      rowBg = '#fffbeb';
    }
    backgrounds.push(new Array(headers.length).fill(rowBg));
  }

  // --------------------------------------------------------------------------
  // BATCH CONFLICT CHECK (Requirement 3):
  // If the same canonical merchant resolves to different categories within one batch,
  // log a LOUD warning listing both descriptors and both categories.
  // --------------------------------------------------------------------------
  const canonicalMap = new Map();
  for (let i = 0; i < stagingQueue.length; i++) {
    const entry = stagingQueue[i];
    const r = entry.item;
    const canonName = r.merchant || entry.geminiCleanName || 
      (entry.catInference && entry.catInference.matchedMerchant) || 
      (typeof cleanMerchantDisplayName === 'function' ? cleanMerchantDisplayName(entry.rawMerchant) : entry.rawMerchant);
    const normCanon = (typeof normaliseWhere === 'function' ? normaliseWhere(canonName) : canonName.toLowerCase()).trim() || canonName.toLowerCase().trim();

    if (!canonicalMap.has(normCanon)) {
      canonicalMap.set(normCanon, {
        canonicalName: canonName,
        instances: []
      });
    }
    canonicalMap.get(normCanon).instances.push({
      rowNum: i + 2,
      rawMerchant: entry.rawMerchant,
      category: r.category,
      source: (entry.catInference && entry.catInference.source) || 'unknown',
      confidence: r.confidence
    });
  }

  canonicalMap.forEach((group, normKey) => {
    const categoriesFound = new Set(group.instances.map(inst => inst.category).filter(c => c && c !== 'Другое'));
    if (categoriesFound.size > 1) {
      Logger.log('\n🚨 ======================================================================');
      Logger.log(`🚨 [LOUD WARNING] CATEGORY CONFLICT IN BATCH FOR "${group.canonicalName.toUpperCase()}":`);
      Logger.log(`🚨 Canonical merchant "${group.canonicalName}" resolved to ${categoriesFound.size} different categories: [${Array.from(categoriesFound).join(', ')}]`);
      group.instances.forEach(inst => {
        Logger.log(`   - Row ${inst.rowNum}: "${inst.rawMerchant}" -> Category: "${inst.category}" [Source: ${inst.source}, Conf: ${inst.confidence}]`);
      });
      Logger.log('🚨 ======================================================================\n');
    }
  });

  // Set Date column (Col 2) format to plain text '@' BEFORE setValues to prevent Sheets date coercion
  sheet.getRange(2, 2, numRows, 1).setNumberFormat('@');

  // 9. Batch write values and background colors
  const dataRange = sheet.getRange(2, 1, numRows, headers.length);
  dataRange.setValues(rows2D);
  dataRange.setBackgrounds(backgrounds);

  // Re-affirm plain text format on Date column
  sheet.getRange(2, 2, numRows, 1).setNumberFormat('@');

  // 10. Checkbox validation on Column 1
  sheet.getRange(2, 1, numRows, 1).insertCheckboxes();

  // 11. Number formatting on Column 6 (amount) and Column 10 (confidence)
  sheet.getRange(2, 6, numRows, 1).setNumberFormat('#,##0.00;[Red]-#,##0.00');
  sheet.getRange(2, 10, numRows, 1).setNumberFormat('0.0');

  // 12. Alignments
  sheet.getRange(2, 1, numRows, 1).setHorizontalAlignment('center'); // ✓
  sheet.getRange(2, 2, numRows, 1).setHorizontalAlignment('center'); // date
  sheet.getRange(2, 4, numRows, 1).setHorizontalAlignment('center'); // Cardholder
  sheet.getRange(2, 5, numRows, 1).setHorizontalAlignment('center'); // Тип
  sheet.getRange(2, 6, numRows, 1).setHorizontalAlignment('right');  // amount
  sheet.getRange(2, 9, numRows, 1).setHorizontalAlignment('center'); // proposed bucket
  sheet.getRange(2, 10, numRows, 1).setHorizontalAlignment('center'); // confidence
  sheet.getRange(2, 12, numRows, 1).setHorizontalAlignment('center'); // status

  // Apply type/category dropdowns and remove obsolete merchant validation.
  applyReconcileDropdowns(sheet, validCategories);

  // 14. Set clean, readable column widths (12 columns)
  const colWidths = [40, 95, 110, 110, 130, 95, 220, 160, 110, 90, 320, 95];
  for (let c = 0; c < colWidths.length; c++) {
    sheet.setColumnWidth(c + 1, colWidths[c]);
  }

  if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.flush === 'function') {
    SpreadsheetApp.flush();
  }

  // Inference is provisional. The approved ledger becomes the learning source
  // after commit; staging must not persist unreviewed merchant/category guesses.

  Logger.log(`✅ [STAGE 3E] Staged ${numRows} rows into "${RECONCILE_STAGING_TAB_NAME}" (${cleanProposals.length} proposals, ${ambiguousRows.length} ambiguous).`);

  // Log category inference for the first 15 staged rows (proposals & ambiguous)
  const logLimit = Math.min(proposalInferenceLogs.length, 15);
  if (logLimit > 0) {
    Logger.log('\n======================================================================');
    Logger.log(`🏷️ INFERENCE BREAKDOWN (First ${logLimit} Staged Rows):`);
    Logger.log('======================================================================');
    for (let k = 0; k < logLimit; k++) {
      const pLog = proposalInferenceLogs[k];
      const tag = pLog.status === 'ambiguous' ? '[Ambiguous]' : `[Proposal ${k + 1}]`;
      if (pLog.source === 'gemini') {
        Logger.log(`  ${tag} "${pLog.rawMerchant}" -> Gemini: "${pLog.cleanMerchant}" -> Cat: "${pLog.category}" [Source: gemini, Conf: ${pLog.confidence}]`);
      } else if (pLog.matchedMerchant) {
        Logger.log(`  ${tag} "${pLog.rawMerchant}" -> Matched: "${pLog.cleanMerchant}" (sim: ${pLog.similarity ? pLog.similarity.toFixed(2) : '1.00'}) -> Cat: "${pLog.category}" [Source: ${pLog.source}, Conf: ${pLog.confidence}]`);
      } else {
        Logger.log(`  ${tag} "${pLog.rawMerchant}" -> No Match -> Cat: "${pLog.category}" [Source: ${pLog.source}, Conf: ${pLog.confidence}]`);
      }
    }
    Logger.log('======================================================================\n');
  }

  return {
    stagedCount: numRows,
    proposalsCount: cleanProposals.length,
    ambiguousCount: ambiguousRows.length,
    sheet: sheet
  };
}

/**
 * Computes a per-cardholder breakdown of reconciliation results.
 * Tallies parsed, matched, proposals, ambiguous, and excluded counts.
 * 
 * @param {Array<Object>} parsedRows - All parsed statement rows.
 * @param {Array<Object>} matchedRows - Matched statement rows.
 * @param {Array<Object>} proposalRows - Proposal rows.
 * @param {Array<Object>} ambiguousRows - Ambiguous statement rows.
 * @param {Array<Object>} excludedRows - Excluded non-spend rows.
 * @return {Object} Breakdown object keyed by cardholder name.
 */
function computeCardholderBreakdown(parsedRows, matchedRows, proposalRows, ambiguousRows, excludedRows) {
  const holders = {
    'Val': { last4: '4320', type: 'Main', parsed: 0, matched: 0, proposals: 0, ambiguous: 0, excluded: 0 },
    'Rita': { last4: '7509', type: 'Supplementary', parsed: 0, matched: 0, proposals: 0, ambiguous: 0, excluded: 0 },
    'Grandparents': { last4: '0465', type: 'Supplementary', parsed: 0, matched: 0, proposals: 0, ambiguous: 0, excluded: 0 },
    'Other': { last4: 'N/A', type: 'Other', parsed: 0, matched: 0, proposals: 0, ambiguous: 0, excluded: 0 }
  };

  const getHolderKey = (r) => {
    if (!r) return 'Other';
    const h = r.cardholder || (r.card_last4 ? resolveCardholder(r.card_last4) : '');
    if (h && holders[h]) return h;
    const l4 = r.card_last4 || (r.card_number ? String(r.card_number).replace(/\D/g, '').slice(-4) : '');
    if (l4 === '4320') return 'Val';
    if (l4 === '7509') return 'Rita';
    if (l4 === '0465') return 'Grandparents';
    return 'Other';
  };

  (parsedRows || []).forEach(r => { holders[getHolderKey(r)].parsed++; });
  (matchedRows || []).forEach(r => { holders[getHolderKey(r)].matched++; });
  (proposalRows || []).forEach(r => { holders[getHolderKey(r)].proposals++; });
  (ambiguousRows || []).forEach(r => {
    const item = r.statement_row || r;
    holders[getHolderKey(item)].ambiguous++;
  });
  (excludedRows || []).forEach(r => { holders[getHolderKey(r)].excluded++; });

  return holders;
}

/**
 * End-to-end execution of Stages 3A -> 3E.
 * Takes statement input, matches against the ledger, filters non-spend, and stages to _Reconcile.
 * 
 * CRITICAL INVARIANT:
 * Transactions tab remains 100% UNTOUCHED.
 * 
 * @param {Blob|string|Object} statementInput - Bank statement Blob, CSV text, or parsed payload.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet] - Target spreadsheet instance.
 * @return {Object} Reconciliation summary.
 */
function reconcileAndStage(statementInput, optSpreadsheet) {
  const ss = optSpreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('reconcileAndStage: No spreadsheet available.');
  }

  // 3A: Parse statement
  const parsed = (statementInput && typeof statementInput === 'object' && Array.isArray(statementInput.rows))
    ? statementInput
    : parseStatement(statementInput);

  if (parsed.error && (!parsed.rows || parsed.rows.length === 0)) {
    throw new Error(`reconcileAndStage: Statement parsing failed: ${parsed.message || parsed.error}`);
  }

  // 3B: Normalize statement rows
  const normalizedStatementRows = normalizeRows(parsed.rows || []);

  // Never reconcile a household DBS statement after its card sections were lost.
  const unidentifiedDbsRows = normalizedStatementRows.filter(row =>
    (row.account || parsed.account) === 'DBS CC SGD' &&
    String(row.card_last4 || row.card_number || '').replace(/\D/g, '').slice(-4).length !== 4);
  if (unidentifiedDbsRows.length) {
    throw new Error(`${unidentifiedDbsRows.length} DBS row(s) have no card number. Import the original bank CSV with main/supplementary card sections; reconciliation stopped before staging.`);
  }

  // 3C: Read Transactions ledger and match (PURE READ)
  const ledgerRows = readLedgerRowsForReconciliation(ss);
  const matchResult = findMissing(normalizedStatementRows, ledgerRows, getMerchantAliases());
  Logger.log(`[Reconcile input] Spreadsheet: ${ss.getName ? ss.getName() : 'unknown'} | ID: ${ss.getId ? ss.getId() : 'unknown'} | ledger rows: ${ledgerRows.length}`);
  for (const item of matchResult.ambiguous) {
    if (item.match_type === 'ambiguous_claimed_ledger') {
      Logger.log('[Allocation review] ' + JSON.stringify({ date: item.date, amount: item.amount,
        merchant: item.raw_merchant || item.merchant, candidates: item.candidates }));
    }
  }

  // 3D: Filter non-spend rows (Option B dual-sided)
  const filterResult = filterNonSpend(matchResult.missing);

  // 3E: Stage proposals & ambiguous rows
  const stageResult = stageProposals(filterResult.proposals, matchResult.ambiguous, ss, ledgerRows);

  // Per-card breakdown (Task 5)
  const cardholderBreakdown = computeCardholderBreakdown(
    parsed.rows || [],
    matchResult.matched || [],
    filterResult.proposals || [],
    matchResult.ambiguous || [],
    filterResult.excluded || []
  );

  return {
    account: parsed.account,
    period: parsed.period,
    totalParsed: (parsed.rows || []).length,
    normalizedCount: normalizedStatementRows.length,
    matchedCount: matchResult.matched.length,
    proposalsCount: filterResult.proposals.length,
    ambiguousCount: matchResult.ambiguous.length,
    excludedCount: filterResult.excluded.length,
    stagedCount: stageResult.stagedCount,
    cardholderBreakdown: cardholderBreakdown,
    proposals: filterResult.proposals,
    ambiguous: matchResult.ambiguous,
    excluded: filterResult.excluded,
    matched: matchResult.matched,
    sections: parsed.sections || []
  };
}

/**
 * STAGE 3F: Commit ticked rows from _Reconcile to Transactions.
 * 
 * The ONLY step in Stage 3 authorized to write to Transactions.
 * Reads ticked rows (✓ = true) from the _Reconcile staging tab and appends them
 * via the existing Phase-1 writer (appendTransactions in writer.gs).
 * 
 * Invariants:
 * 1. Transactions Column A continues to store Date objects (writer.gs unchanged).
 * 2. Credits (Получение денег) are written with correct type and magnitude so Column G adds to balance.
 * 3. Notes (Col J) remains empty, Bucket (Col K) populated.
 * 4. Successfully imported rows in _Reconcile are marked status = 'imported'.
 * 5. Idempotent: rows with status = 'imported' are skipped on re-run.
 * 6. Ambiguous rows are skipped unless explicitly ticked by the user.
 * 
 * @param {boolean} [useTestSheet=false] - If true, targets the sandbox spreadsheet.
 * @param {boolean} [optDryRun] - Optional override for DRY_RUN mode.
 * @return {Object} Commit summary { committedCount, skippedCount, dryRun, writtenRows }.
 */
function commitStaged(useTestSheet, optDryRun, optSpreadsheet) {
  const ss = optSpreadsheet || ((typeof getTargetSpreadsheet === 'function')
    ? getTargetSpreadsheet(Boolean(useTestSheet))
    : SpreadsheetApp.getActiveSpreadsheet());

  if (!ss) {
    throw new Error('commitStaged: No spreadsheet instance available.');
  }

  const isDryRun = (typeof optDryRun === 'boolean')
    ? optDryRun
    : (typeof SHEET_FACTS !== 'undefined' && Boolean(SHEET_FACTS.DRY_RUN));

  let lock = null;
  if (typeof LockService !== 'undefined' && typeof LockService.getScriptLock === 'function') {
    lock = LockService.getScriptLock();
    const hasLock = lock.tryLock(30000);
    if (!hasLock) {
      throw new Error('commitStaged: Could not acquire script lock within 30 seconds.');
    }
  }

  try {
    const stagingSheet = ss.getSheetByName(RECONCILE_STAGING_TAB_NAME);
    if (!stagingSheet) {
      Logger.log(`ℹ️ commitStaged: No "${RECONCILE_STAGING_TAB_NAME}" staging tab found.`);
      return { committedCount: 0, skippedCount: 0, dryRun: isDryRun, writtenRows: [], rows2D: [] };
    }

    const lastRow = stagingSheet.getLastRow();
    if (lastRow <= 1) {
      Logger.log(`ℹ️ commitStaged: Staging tab "${RECONCILE_STAGING_TAB_NAME}" has no data rows.`);
      return { committedCount: 0, skippedCount: 0, dryRun: isDryRun, writtenRows: [], rows2D: [] };
    }

    const lastCol = stagingSheet.getLastColumn();
    const headerVals = stagingSheet.getRange(1, 1, 1, Math.max(lastCol, 12)).getValues()[0] || [];
    const hasCardholderCol = (headerVals[3] === 'Cardholder') || (lastCol >= 12);
    const readCols = hasCardholderCol ? 12 : 11;
    const stagingData = stagingSheet.getRange(2, 1, lastRow - 1, readCols).getValues();

    // Inspect Column G formula in Transactions to determine credit magnitude handling
    const transSheet = ss.getSheetByName('Transactions');
    let gFormulaAddExpected = true;
    if (transSheet && transSheet.getLastRow() >= 2) {
      const sampleGFormula = String(transSheet.getRange(transSheet.getLastRow(), 7).getFormula() || '').toUpperCase();
      Logger.log(`[commitStaged] Sample Column G formula in Transactions: "${sampleGFormula}"`);
      // If formula is standard `=F - D` without type checking, negative amount is required for F - (-D) = F + D.
      // If formula branches on type (e.g. IF(C="Получение денег", F + D, ...)), positive amount is required.
      if (sampleGFormula.includes('ПОЛУЧЕНИЕ ДЕНЕГ') || sampleGFormula.includes('ДОХОД')) {
        gFormulaAddExpected = true;
      } else if (sampleGFormula.includes('-D') || sampleGFormula.includes('-E') || sampleGFormula.includes('- D') || sampleGFormula.includes('- E')) {
        gFormulaAddExpected = false;
      }
    }

    const toAppend = [];
    const candidateRowIndices = []; // 1-based row index in stagingSheet for status update

    for (let r = 0; r < stagingData.length; r++) {
      const row = stagingData[r];
      const isTicked = (row[0] === true);

      let dateStr, accountStr, cardholderStr, typeStr, rawAmt, rawMerchant, catStr, bucketStr, confVal, sourceRowStr, status;
      if (hasCardholderCol) {
        dateStr = String(row[1] || '').trim();
        accountStr = String(row[2] || (typeof DEFAULT_ACCOUNT !== 'undefined' ? DEFAULT_ACCOUNT : 'DBS CC SGD')).trim();
        cardholderStr = String(row[3] || '').trim();
        typeStr = String(row[4] || 'Расходы').trim();
        rawAmt = Number(row[5]) || 0;
        rawMerchant = String(row[6] || '').trim();
        catStr = String(row[7] || 'Другое').trim();
        bucketStr = String(row[8] || 'Wants').trim();
        confVal = Number(row[9]) || 0;
        sourceRowStr = String(row[10] || '');
        status = String(row[11] || '').trim().toLowerCase();
      } else {
        dateStr = String(row[1] || '').trim();
        accountStr = String(row[2] || (typeof DEFAULT_ACCOUNT !== 'undefined' ? DEFAULT_ACCOUNT : 'DBS CC SGD')).trim();
        cardholderStr = '';
        typeStr = String(row[3] || 'Расходы').trim();
        rawAmt = Number(row[4]) || 0;
        rawMerchant = String(row[5] || '').trim();
        catStr = String(row[6] || 'Другое').trim();
        bucketStr = String(row[7] || 'Wants').trim();
        confVal = Number(row[8]) || 0;
        sourceRowStr = String(row[9] || '');
        status = String(row[10] || '').trim().toLowerCase();
      }

      // Skip unticked rows
      if (!isTicked) {
        continue;
      }

      // Skip already imported rows (Idempotency safeguard)
      if (status === 'imported') {
        Logger.log(`[commitStaged] Row ${r + 2} skipped: already marked 'imported'.`);
        continue;
      }

      const merchantStr = typeof cleanMerchantDisplayName === 'function'
        ? cleanMerchantDisplayName(rawMerchant)
        : rawMerchant;

      if (!ALL_TYPES.includes(typeStr)) throw new Error(`Invalid transaction type at staging row ${r + 2}: ${typeStr}`);
      const isCredit = [TRANSACTION_TYPES.INCOME, TRANSACTION_TYPES.INCOME_BONUS, TRANSACTION_TYPES.INCOME_EASY, TRANSACTION_TYPES.RECEIVED].includes(typeStr);

      // Amount handling for Transactions:
      let finalAmt = rawAmt;
      if (isCredit) {
        finalAmt = gFormulaAddExpected ? Math.abs(rawAmt) : -Math.abs(rawAmt);
      } else {
        finalAmt = Math.abs(rawAmt);
      }

      const isGrandparents = (cardholderStr === 'Grandparents' || /grandparents|0465/i.test(sourceRowStr));
      const notesVal = isGrandparents ? 'Grandparents' : '';

      toAppend.push({
        date: dateStr,
        account: accountStr,
        type: typeStr,
        reviewed_type: true,
        amount: finalAmt,
        amount_sgd: finalAmt,
        category: catStr,
        where: merchantStr,
        bucket: bucketStr,
        notes: notesVal,    // J (Notes): 'Grandparents' for Grandparents rows; '' for Val/Rita
        flags: []
      });

      candidateRowIndices.push(r + 2); // 1-based row in stagingSheet
    }

    if (toAppend.length === 0) {
      Logger.log('ℹ️ commitStaged: No eligible ticked rows to commit.');
      return { committedCount: 0, skippedCount: 0, dryRun: isDryRun, writtenRows: [], rows2D: [] };
    }

    Logger.log(`[commitStaged] Preparing to commit ${toAppend.length} row(s) (dryRun=${isDryRun})...`);

    // Call existing Phase-1 writer (appendTransactions)
    const writeResult = appendTransactions(toAppend, ss, isDryRun);

    // If not dry-run and rows were written, mark rows as 'imported' in _Reconcile
    const statusCol = hasCardholderCol ? 12 : 11;
    if (!isDryRun) {
      const outcomes = writeResult.rowOutcomes || [];
      for (const outcome of outcomes) {
        const rowIdx = candidateRowIndices[outcome.inputIndex];
        if (!rowIdx) throw new Error('Writer returned an invalid staging row index.');
        stagingSheet.getRange(rowIdx, statusCol).setValue(outcome.status);
      }
      if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.flush === 'function') {
        SpreadsheetApp.flush();
      }
      Logger.log(`[commitStaged] ${writeResult.writtenCount} imported; ${writeResult.skippedCount} duplicate(s) retained for review.`);
    }

    return {
      committedCount: writeResult.writtenCount,
      skippedCount: writeResult.skippedCount,
      dryRun: isDryRun,
      writtenRows: writeResult.writtenRows || [],
      rows2D: writeResult.rows2D || []
    };
  } finally {
    if (lock) {
      lock.releaseLock();
    }
  }
}

/**
 * Performs a DRY RUN of commitStaged to inspect the exact 11 columns that would be
 * appended to the Transactions sheet for Grandparents, Val, and Rita rows.
 * 
 * INVARIANT: Does NOT write to Transactions sheet (100% DRY RUN).
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet]
 * @return {Object} Sample rows per cardholder with full 11-column breakdown.
 */
function dryRunCommitSample(optSpreadsheet) {
  const ss = optSpreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('dryRunCommitSample: No spreadsheet available.');

  const stagingSheet = ss.getSheetByName(RECONCILE_STAGING_TAB_NAME);
  if (!stagingSheet) throw new Error(`dryRunCommitSample: No "${RECONCILE_STAGING_TAB_NAME}" tab found.`);

  const lastRow = stagingSheet.getLastRow();
  if (lastRow <= 1) throw new Error(`dryRunCommitSample: "${RECONCILE_STAGING_TAB_NAME}" is empty.`);

  const numRows = lastRow - 1;
  const data = stagingSheet.getRange(2, 1, numRows, 12).getValues();

  const samples = {
    Grandparents: null,
    Val: null,
    Rita: null
  };

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const cardholder = String(row[3] || '').trim();
    if (samples[cardholder] === null) {
      const isCredit = (String(row[4] || '') === 'Получение денег' || Number(row[5]) < 0);
      const amt = Number(row[5]) || 0;
      const finalAmt = isCredit ? -Math.abs(amt) : Math.abs(amt);
      const isGrandparents = (cardholder === 'Grandparents' || /grandparents|0465/i.test(String(row[10] || '')));
      const notes = isGrandparents ? 'Grandparents' : '';

      const colA_date = String(row[1] || '').trim();
      const colB_account = String(row[2] || '').trim();
      const colC_type = isCredit ? 'Получение денег' : 'Расходы';
      const colD_amount = finalAmt;
      const colE_amountSgd = finalAmt;
      const colF_balanceBefore = '';
      const colG_balanceAfter = '';
      const colH_category = String(row[7] || 'Другое').trim();
      const colI_where = String(row[6] || '').trim();
      const colJ_notes = notes;
      const colK_bucket = String(row[8] || 'Wants').trim();

      samples[cardholder] = {
        stagingRowNum: r + 2,
        cardholder: cardholder,
        columns11: [
          colA_date,
          colB_account,
          colC_type,
          colD_amount,
          colE_amountSgd,
          colF_balanceBefore,
          colG_balanceAfter,
          colH_category,
          colI_where,
          colJ_notes,
          colK_bucket
        ]
      };
    }
  }

  Logger.log('\n=============================================================================================');
  Logger.log('🔍 DRY RUN: EXACT 11-COLUMN TRANSACTIONS ROWS PER CARDHOLDER');
  Logger.log('=============================================================================================');
  Logger.log('Columns: [A:Дата, B:Счёт, C:Тип, D:Сумма, E:Сумма SGD, F:До, G:После, H:Категория, I:Где, J:Notes, K:50/30/20]');
  Logger.log('---------------------------------------------------------------------------------------------');

  ['Grandparents', 'Val', 'Rita'].forEach(holder => {
    const s = samples[holder];
    if (s) {
      Logger.log(`\n👉 CARDHOLDER: ${holder} (Staging Row ${s.stagingRowNum})`);
      Logger.log(`   Col A (Дата):         "${s.columns11[0]}"`);
      Logger.log(`   Col B (Счёт):         "${s.columns11[1]}"`);
      Logger.log(`   Col C (Тип):          "${s.columns11[2]}"`);
      Logger.log(`   Col D (Сумма):        ${s.columns11[3]}`);
      Logger.log(`   Col E (Сумма в SGD):  ${s.columns11[4]}`);
      Logger.log(`   Col F (На счете до):  "${s.columns11[5]}" (formula copied from row above)`);
      Logger.log(`   Col G (На счете после): "${s.columns11[6]}" (formula copied from row above)`);
      Logger.log(`   Col H (Категория):    "${s.columns11[7]}"`);
      Logger.log(`   Col I (Где):          "${s.columns11[8]}"`);
      Logger.log(`   Col J (Notes):        "${s.columns11[9]}"  <-- ${holder === 'Grandparents' ? 'TAGGED WITH "Grandparents"' : 'CONFIRMED EMPTY ""'}`);
      Logger.log(`   Col K (50/30/20):     "${s.columns11[10]}"`);
      Logger.log(`   Full 11-Array: ${JSON.stringify(s.columns11)}`);
    } else {
      Logger.log(`\nℹ️ No rows found for ${holder}`);
    }
  });
  Logger.log('=============================================================================================\n');

  return samples;
}

/**
 * ============================================================================
 * LIVE RECONCILIATION WRAPPER
 * ============================================================================
 * 
 * Runs Stages 3A -> 3E against the LIVE Transactions ledger:
 * 1. Reads a DBS or Citibank statement (CSV/PDF) from Google Drive by file ID.
 * 2. Parses (3A), normalizes (3B), matches against live ledger (3C),
 *    filters non-spend rows (3D), and stages proposals into _Reconcile (3E).
 * 3. Verifies Transactions is 100% untouched (read-only guarantee).
 * 4. Logs a detailed breakdown (parsed, matched, proposals, ambiguous)
 *    and previews the first proposals for eyeball review.
 * 
 * @param {string} driveFileId - Google Drive file ID of the statement file.
 * @return {Object} Reconciliation summary payload.
 */
function runLiveReconcile(driveFileId) {
  Logger.log('======================================================================');
  Logger.log('             🚀 STARTING LIVE RECONCILIATION (3A -> 3E)');
  Logger.log('======================================================================\n');

  if (!driveFileId || (typeof driveFileId === 'string' && (!driveFileId.trim() || driveFileId.trim() === 'PASTE_DRIVE_FILE_ID_HERE'))) {
    throw new Error('runLiveReconcile: Please provide a valid Google Drive file ID. Usage: runLiveReconcile("YOUR_DRIVE_FILE_ID")');
  }

  let fileBlob;
  let fileName = '';
  let mimeType = '';
  let fileSize = 0;

  if (typeof driveFileId === 'object' && driveFileId !== null && typeof driveFileId.getBlob === 'function') {
    // Drive File object
    assertStatementFileMime(driveFileId.getMimeType());
    fileBlob = driveFileId.getBlob();
    fileName = driveFileId.getName();
    mimeType = driveFileId.getMimeType();
    fileSize = driveFileId.getSize();
  } else if (typeof driveFileId === 'object' && driveFileId !== null && (typeof driveFileId.getDataAsString === 'function' || typeof driveFileId.getBytes === 'function')) {
    // Blob object
    fileBlob = driveFileId;
    fileName = (typeof fileBlob.getName === 'function' && fileBlob.getName()) ? fileBlob.getName() : 'statement.csv';
    mimeType = (typeof fileBlob.getContentType === 'function' && fileBlob.getContentType()) ? fileBlob.getContentType() : 'text/csv';
    fileSize = (typeof fileBlob.getBytes === 'function' && fileBlob.getBytes()) ? fileBlob.getBytes().length : 0;
  } else {
    const cleanFileId = String(driveFileId).trim();
    Logger.log(`📂 Fetching file from Google Drive (ID: ${cleanFileId})...`);
    let file;
    try {
      file = DriveApp.getFileById(cleanFileId);
    } catch (err) {
      throw new Error(`runLiveReconcile: Unable to access Drive file with ID "${cleanFileId}": ${err.message}`);
    }
    fileName = file.getName();
    mimeType = file.getMimeType();
    fileSize = file.getSize();
    assertStatementFileMime(mimeType);
    fileBlob = file.getBlob();
  }

  Logger.log(`📄 Statement File: "${fileName}" | MIME: ${mimeType} | Size: ${fileSize} bytes`);

  // 2. Obtain LIVE spreadsheet and verify safety baseline
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('runLiveReconcile: No active spreadsheet found. Must be executed from the budget spreadsheet.');
  }

  const transSheet = ss.getSheetByName('Transactions');
  if (!transSheet) {
    throw new Error('runLiveReconcile: "Transactions" sheet not found in active spreadsheet.');
  }

  const transLastRowBefore = transSheet.getLastRow();
  Logger.log(`🔒 Transactions baseline row count: ${transLastRowBefore} (READ-ONLY protection active)`);

  // 3. Run Pipeline 3A -> 3E via reconcileAndStage
  Logger.log('\n⚙️ Executing Stages 3A -> 3E against LIVE ledger...');
  const result = reconcileAndStage(fileBlob, ss);

  // 4. Verify safety constraint: Transactions was NEVER modified
  SpreadsheetApp.flush();
  const transLastRowAfter = transSheet.getLastRow();
  if (transLastRowAfter !== transLastRowBefore) {
    throw new Error(`🚨 SAFETY VIOLATION: Transactions sheet row count changed from ${transLastRowBefore} to ${transLastRowAfter}!`);
  }
  Logger.log(`✅ Safety Confirmed: Transactions sheet untouched (${transLastRowAfter} rows).`);

  // 5. Log comprehensive summary
  const periodStr = result.period ? `${result.period.from} to ${result.period.to}` : 'N/A';
  Logger.log('\n======================================================================');
  Logger.log('📊 LIVE RECONCILIATION SUMMARY');
  Logger.log('======================================================================');
  Logger.log(`Statement File:      ${fileName}`);
  Logger.log(`Detected Account:    ${result.account || 'Unknown'}`);
  Logger.log(`Statement Period:    ${periodStr}`);
  Logger.log(`Total Rows Parsed:   ${result.totalParsed}`);
  Logger.log(`Normalized (3B):     ${result.normalizedCount}`);
  Logger.log(`Already in Ledger:   ${result.matchedCount}`);
  Logger.log(`Excluded Non-Spend:  ${result.excludedCount} (CC repayments, self-transfers, net-zero fees)`);
  Logger.log(`Proposals (3D):      ${result.proposalsCount} (unlogged expenses & legitimate credits)`);
  Logger.log(`Ambiguous (3C):      ${result.ambiguousCount} (multiple ledger matches, requires manual review)`);
  Logger.log(`Staged into Sheet:   ${result.stagedCount} rows written to "${RECONCILE_STAGING_TAB_NAME}"`);
  Logger.log('======================================================================\n');

  // 5b. Log per-cardholder breakdown (Task 5)
  const cb = result.cardholderBreakdown || computeCardholderBreakdown(
    [],
    result.matched || [],
    result.proposals || [],
    result.ambiguous || [],
    result.excluded || []
  );

  Logger.log('=============================================================================================');
  Logger.log('💳 PER-CARD RECONCILIATION BREAKDOWN');
  Logger.log('=============================================================================================');
  Logger.log('Cardholder        Card Last-4  Type           Parsed  Matched  Proposals  Ambiguous  Excluded');
  Logger.log('---------------------------------------------------------------------------------------------');
  ['Val', 'Rita', 'Grandparents', 'Other'].forEach(name => {
    const b = cb[name];
    if (b && (b.parsed > 0 || name !== 'Other')) {
      const cName = (name + '               ').slice(0, 16);
      const cLast4 = (b.last4 + '             ').slice(0, 12);
      const cType = (b.type + '               ').slice(0, 14);
      const cParsed = String(b.parsed).padStart(6, ' ');
      const cMatched = String(b.matched).padStart(8, ' ');
      const cProposals = String(b.proposals).padStart(10, ' ');
      const cAmbiguous = String(b.ambiguous).padStart(10, ' ');
      const cExcluded = String(b.excluded).padStart(9, ' ');
      Logger.log(`${cName}  ${cLast4}  ${cType}  ${cParsed}  ${cMatched}  ${cProposals}  ${cAmbiguous}  ${cExcluded}`);
    }
  });
  Logger.log('---------------------------------------------------------------------------------------------');
  const totParsed = String(result.totalParsed).padStart(6, ' ');
  const totMatched = String(result.matchedCount).padStart(8, ' ');
  const totProposals = String(result.proposalsCount).padStart(10, ' ');
  const totAmbiguous = String(result.ambiguousCount).padStart(10, ' ');
  const totExcluded = String(result.excludedCount).padStart(9, ' ');
  Logger.log(`TOTAL                                     ${totParsed}  ${totMatched}  ${totProposals}  ${totAmbiguous}  ${totExcluded}`);
  Logger.log('=============================================================================================\n');

  // 6. Preview the first few proposals for eyeballing
  const previewCount = Math.min((result.proposals || []).length, 5);
  if (previewCount > 0) {
    Logger.log(`🔍 PREVIEW OF FIRST ${previewCount} PROPOSAL(S) FOR EYEBALLING:`);
    for (let i = 0; i < previewCount; i++) {
      const p = result.proposals[i];
      const sign = p.type === 'Получение денег' ? '-' : '+';
      const cleanMerchant = typeof cleanMerchantDisplayName === 'function'
        ? cleanMerchantDisplayName(p.merchant || p.where)
        : (p.merchant || p.where);
      Logger.log(`  [Proposal ${i + 1}] Date: ${p.date} | ${p.type} | ${sign}S$${Math.abs(p.amount).toFixed(2)} | Where: "${cleanMerchant}" | Cat: ${p.category || 'Другое'} (${p.bucket || 'Wants'}) | Conf: ${p.confidence || 1.0}`);
    }
    if (result.proposals.length > previewCount) {
      Logger.log(`  ... and ${result.proposals.length - previewCount} more proposal(s) staged in "${RECONCILE_STAGING_TAB_NAME}".`);
    }
  } else {
    Logger.log('ℹ️ No new spend proposals found in this statement.');
  }

  // 7. Preview ambiguous rows if any
  const ambCount = Math.min((result.ambiguous || []).length, 5);
  if (ambCount > 0) {
    Logger.log(`\n⚠️ PREVIEW OF AMBIGUOUS ROW(S) (Unticked in staging, requires review):`);
    for (let j = 0; j < ambCount; j++) {
      const a = result.ambiguous[j];
      const stmtRow = a.statement_row || a;
      const candidatesCount = (a.candidates || []).length;
      const displayWhere = a.merchant || (typeof cleanMerchantDisplayName === 'function' ? cleanMerchantDisplayName(stmtRow.where || stmtRow.merchant) : (stmtRow.where || stmtRow.merchant));
      const displayCat = a.proposed_category || a.category || 'Другое';
      const displayBucket = a.proposed_bucket || a.bucket || 'Wants';
      Logger.log(`  [Ambiguous ${j + 1}] Date: ${stmtRow.date} | S$${Math.abs(stmtRow.amount).toFixed(2)} | Where: "${displayWhere}" | Cat: ${displayCat} (${displayBucket}) | Conf: 0.5 (${candidatesCount} ledger candidates)`);
    }
  }

  // 8. Audit full Merchants tab and Grab ledger history (Requirement 1 & Audit)
  logMerchantsTabAudit(ss);

  Logger.log('\n----------------------------------------------------------------------');
  // 8. Dry run preview of exact 11-column Transactions row per cardholder
  try {
    dryRunCommitSample(ss);
  } catch (err) {
    Logger.log(`ℹ️ dryRunCommitSample notice: ${err.message}`);
  }

  Logger.log('👉 NEXT STEPS:');
  Logger.log(`1. Switch to the "${RECONCILE_STAGING_TAB_NAME}" tab in your live Google Sheet.`);
  Logger.log('2. Eyeball the rows and tick (✓) the checkboxes for rows you want to import.');
  Logger.log('3. When satisfied, run commitStaged() to import only the ticked rows.');
  Logger.log('----------------------------------------------------------------------\n');

  return result;
}

/**
 * Quick runner helper for runLiveReconcile from the Apps Script Run dropdown.
 * Paste your Google Drive file ID into the variable below and click Run.
 */
function runLiveReconcile_runner() {
  const driveFileId = SHEET_FACTS.STATEMENT_FILE_ID;
  return runLiveReconcile(driveFileId);
}

/**
 * Quick runner helper to preview exact 11-column dry run rows from _Reconcile staging tab.
 * Select and run from the Apps Script dropdown.
 */
function dryRunCommitSample_runner() {
  return dryRunCommitSample();
}

/**
 * ============================================================================
 * DIAGNOSTIC TOOL: EXPLAIN NO-MATCH
 * ============================================================================
 * 
 * Explains why a specific statement row failed to match against Transactions.
 * Queries the live Transactions sheet, searches within ±7 days, and prints
 * a forensic breakdown of Pass 1 (exact dedupe key) and Pass 2 (fuzzy matching).
 * 
 * @param {Object} stmtRow - Statement transaction query: { date, amount, merchant, [account] }
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet] - Optional spreadsheet instance.
 */
function explainNoMatch(stmtRow, optSpreadsheet) {
  const ss = optSpreadsheet || (typeof getTargetSpreadsheet === 'function' ? getTargetSpreadsheet(true) : null) || (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.TEST_SPREADSHEET_ID ? SpreadsheetApp.openById(SHEET_FACTS.TEST_SPREADSHEET_ID) : null) || (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getActiveSpreadsheet ? SpreadsheetApp.getActiveSpreadsheet() : null);
  if (!ss) throw new Error('explainNoMatch: No spreadsheet available.');

  const rawDate = stmtRow.date || '';
  const rawAmt = stmtRow.amount || 0;
  const rawMerchant = stmtRow.merchant || stmtRow.where || '';
  const account = stmtRow.account || 'DBS CC SGD';

  const normDate = typeof normalizeDateString === 'function' ? normalizeDateString(rawDate) : String(rawDate);
  const numAmt = typeof normalizeAmountValue === 'function' ? normalizeAmountValue(rawAmt) : parseFloat(rawAmt);
  const normMerchant = typeof normaliseWhere === 'function' ? normaliseWhere(rawMerchant) : rawMerchant.toLowerCase().trim();
  const compWhere = typeof compactWhere === 'function' ? compactWhere(normMerchant) : normMerchant.replace(/[^a-z0-9а-яё]/gi, '');
  const dedupeKey = typeof generateDedupeKey === 'function' ? generateDedupeKey(normDate, account, numAmt, normMerchant) : 'N/A';

  const stmtPrepared = typeof prepareReconcilerItem === 'function'
    ? prepareReconcilerItem(stmtRow, 0, 'statement')
    : { cardholder: stmtRow.cardholder || '', card_last4: stmtRow.card_last4 || '' };

  Logger.log('======================================================================');
  Logger.log(`🔍 EXPLAIN NO-MATCH DIAGNOSTIC: "${rawMerchant}"`);
  Logger.log('======================================================================');
  Logger.log(`Statement Date:         ${normDate}`);
  Logger.log(`Statement Amount:       S$${Math.abs(numAmt).toFixed(2)} (${numAmt < 0 ? 'Credit' : 'Debit'})`);
  Logger.log(`Statement Account:      ${account}`);
  Logger.log(`Statement Cardholder:   "${stmtPrepared.cardholder || 'none'}" (Last4: ${stmtPrepared.card_last4 || 'none'})`);
  Logger.log(`Raw Merchant:           "${rawMerchant}"`);
  Logger.log(`Normalised Merchant:    "${normMerchant}"`);
  Logger.log(`Compact Where:          "${compWhere}"`);
  Logger.log(`Dedupe Key (SHA-256):   ${dedupeKey}`);
  Logger.log('----------------------------------------------------------------------');

  // 1. Read all rows from Transactions tab
  const ledgerRows = typeof readLedgerRowsForReconciliation === 'function'
    ? readLedgerRowsForReconciliation(ss)
    : [];

  Logger.log(`Total rows in Transactions: ${ledgerRows.length}`);

  // 2. Search for candidates within ±7 days
  const exactAmtCandidates = [];
  const nearMerchantCandidates = [];

  for (let i = 0; i < ledgerRows.length; i++) {
    const l = ledgerRows[i];
    const daysDiff = typeof getDaysDifference === 'function' ? getDaysDifference(normDate, l.date) : 999;
    const isAmtEqual = Math.abs(l.amount - numAmt) < 0.005;
    const similarity = typeof computeMerchantSimilarity === 'function' ? computeMerchantSimilarity(rawMerchant, l.where) : 0;

    if (daysDiff <= 7 && isAmtEqual) {
      exactAmtCandidates.push({ ...l, daysDiff, similarity });
    } else if (similarity >= 0.60 && daysDiff <= 14) {
      nearMerchantCandidates.push({ ...l, daysDiff, similarity });
    }
  }

  // 3. Report Exact Amount Candidates
  if (exactAmtCandidates.length === 0) {
    Logger.log(`\n❌ RESULT: NO LEDGER ROWS FOUND with amount S$${Math.abs(numAmt).toFixed(2)} within ±7 days.`);
    Logger.log(`👉 CONCLUSION: This transaction was NEVER logged in Transactions in this date window.`);
    Logger.log(`   The proposal is a genuine unlogged expense.\n`);
  } else {
    Logger.log(`\n⚠️ RESULT: Found ${exactAmtCandidates.length} candidate row(s) in Transactions within ±7 days:`);

    exactAmtCandidates.forEach((c, idx) => {
      const ledgPrepared = typeof prepareReconcilerItem === 'function'
        ? prepareReconcilerItem(c, c.row_index, 'ledger')
        : { cardholder: '' };
      const isCompat = typeof isCardholderCompatible === 'function'
        ? isCardholderCompatible(stmtPrepared, ledgPrepared)
        : true;

      Logger.log(`\n--- Candidate #${idx + 1} (Sheet Row ${c.row_index}) ---`);
      Logger.log(`  Ledger Date:        ${c.date} (Diff: ${c.daysDiff} day(s) from statement ${normDate})`);
      Logger.log(`  Ledger Account:     "${c.account}"`);
      Logger.log(`  Ledger Where:       "${c.where}" (Similarity: ${c.similarity.toFixed(4)})`);
      Logger.log(`  Ledger Amount:      S$${Math.abs(c.amount).toFixed(2)} | Type: ${c.type} | Cat: ${c.category}`);
      Logger.log(`  Ledger Column J:    "${c.notes || ''}"`);
      Logger.log(`  Ledger Cardholder:  "${ledgPrepared.cardholder || 'none'}"`);
      Logger.log(`  Cardholder Compat:  ${isCompat ? '✅ COMPATIBLE' : '❌ INCOMPATIBLE'}`);

      const lCompWhere = typeof compactWhere === 'function' ? compactWhere(typeof normaliseWhere === 'function' ? normaliseWhere(c.where) : c.where) : '';
      const lDedupeKey = typeof generateDedupeKey === 'function' ? generateDedupeKey(c.date, c.account, c.amount, c.where) : '';

      // Pass 1 Check
      if (dedupeKey === lDedupeKey) {
        Logger.log(`  [Pass 1 Exact Dedupe]: ✅ MATCH`);
      } else {
        const diffs = [];
        if (normDate !== c.date) diffs.push(`Date mismatch ("${normDate}" vs "${c.date}")`);
        if (account.toLowerCase().trim() !== String(c.account || '').toLowerCase().trim()) diffs.push(`Account mismatch ("${account}" vs "${c.account}")`);
        if (compWhere !== lCompWhere) diffs.push(`Merchant mismatch ("${compWhere}" vs "${lCompWhere}")`);
        Logger.log(`  [Pass 1 Exact Dedupe]: ❌ REJECTED (${diffs.join(', ')})`);
      }

      // Pass 2 Fuzzy Check
      const rejectReasons = [];
      if (c.daysDiff > 4) rejectReasons.push(`Date diff (${c.daysDiff}d) > 4d limit`);
      if (c.similarity < 0.70) rejectReasons.push(`Similarity (${c.similarity.toFixed(2)}) < 0.70`);
      if (!isCompat) rejectReasons.push(`Cardholder incompatible (Stmt: "${stmtPrepared.cardholder || ''}" vs Ledger: "${ledgPrepared.cardholder || ''}")`);

      if (rejectReasons.length === 0) {
        Logger.log(`  [Pass 2 Fuzzy Match]: ✅ CRITERIA MET`);
        Logger.log(`     Note: If this was unmatched in live run, it was either claimed by an earlier row or landed in Ambiguous.`);
      } else {
        Logger.log(`  [Pass 2 Fuzzy Match]: ❌ REJECTED (${rejectReasons.join(', ')})`);
      }
    });
  }

  // 4. Report Similar Merchant Rows if exact amount didn't hit
  if (exactAmtCandidates.length === 0 && nearMerchantCandidates.length > 0) {
    Logger.log(`ℹ️ SIMILAR MERCHANTS FOUND IN TRANSACTIONS (different amount or date):`);
    nearMerchantCandidates.slice(0, 5).forEach(nm => {
      Logger.log(`  - Row ${nm.row_index}: Date ${nm.date} (${nm.daysDiff}d diff) | S$${Math.abs(nm.amount).toFixed(2)} | Where: "${nm.where}" | Cat: ${nm.category}`);
    });
  }
  Logger.log('======================================================================\n');
}

/**
 * Runner helper to execute explainNoMatch on the real McDonald's & Spotify rows.
 * Select this function in the Apps Script Run dropdown and click Run.
 */
function runDiagnostic_McDonalds_and_Spotify() {
  Logger.log('\n======================================================================');
  Logger.log('        RUNNING DIAGNOSTIC ON McDONALD\'S & SPOTIFY PROPOSALS');
  Logger.log('======================================================================\n');

  Logger.log('\n--- DIAGNOSTIC 1: McDONALD\'S ---');
  explainNoMatch({
    date: '04.09.2026',
    amount: 33.95,
    merchant: "Mcdonald's (psa) Singapore SG",
    account: 'DBS CC SGD'
  });

  Logger.log('\n--- DIAGNOSTIC 2: SPOTIFY ---');
  explainNoMatch({
    date: '03.09.2026',
    amount: 12.10,
    merchant: "Spotify P466a9dde4 Stockholm Se",
    account: 'DBS CC SGD'
  });
}

/**
 * Runner helper to execute explainNoMatch on the 7 missed duplicate cases.
 * Select this function in the Apps Script Run dropdown and click Run.
 */
function runDiagnostic_SevenMissedDuplicates() {
  Logger.log('\n======================================================================');
  Logger.log('        RUNNING DIAGNOSTIC ON 7 MISSED DUPLICATE PROPOSALS');
  Logger.log('======================================================================\n');

  const cases = [
    { date: '13.08.2026', amount: 20.00, merchant: 'SPL AUTO TOPUP (CBT)', account: 'DBS CC SGD' },
    { date: '13.08.2026', amount: 20.34, merchant: 'POPULAR-POS 1', account: 'DBS CC SGD' },
    { date: '15.08.2026', amount: 19.98, merchant: '2C2*LAZADA', account: 'DBS CC SGD' },
    { date: '15.08.2026', amount: 100.99, merchant: '2C2*LAZADA', account: 'DBS CC SGD' },
    { date: '15.08.2026', amount: 20.80, merchant: 'GOPAY-GOJEK', account: 'DBS CC SGD' },
    { date: '16.08.2026', amount: 101.75, merchant: 'JASONS MARKET PLACE-RA', account: 'DBS CC SGD' },
    { date: '16.08.2026', amount: 4.99, merchant: 'AMZNPRIMESG MEMBERSHI', account: 'DBS CC SGD' }
  ];

  cases.forEach((c, idx) => {
    Logger.log(`\n>>> [CASE ${idx + 1}/7] Checking "${c.merchant}" S$${c.amount.toFixed(2)} on ${c.date}...`);
    explainNoMatch(c);
  });
}

/**
 * Executes a forensic diagnostic on the real Lazada statement and ledger rows,
 * and quantifies the exact impact of cardholder filtering on live reconciliation.
 */
function runDiagnostic_Lazada_And_CardholderQuantification() {
  const driveFileId = SHEET_FACTS.STATEMENT_FILE_ID;
  const ss = (typeof getTargetSpreadsheet === 'function' ? getTargetSpreadsheet(true) : null)
    || (typeof SHEET_FACTS !== 'undefined' && SHEET_FACTS.TEST_SPREADSHEET_ID ? SpreadsheetApp.openById(SHEET_FACTS.TEST_SPREADSHEET_ID) : null)
    || (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getActiveSpreadsheet ? SpreadsheetApp.getActiveSpreadsheet() : null);

  if (!ss) throw new Error('runDiagnostic_Lazada_And_CardholderQuantification: No spreadsheet available');

  Logger.log('======================================================================');
  Logger.log('🔍 1. REAL DATA DIAGNOSTIC: LAZADA ROW IN LIVE STATEMENT & LEDGER');
  Logger.log('======================================================================\n');

  // Load statement from Drive
  const file = DriveApp.getFileById(driveFileId);
  const csvText = file.getBlob().getDataAsString();
  const rows2D = Utilities.parseCsv(csvText);
  const parsedStmt = tryParseDbsCsv(rows2D, csvText, file.getName());
  const stmtRows = parsedStmt.rows || [];
  const ledgerRows = readLedgerRowsForReconciliation(ss);

  Logger.log(`Parsed ${stmtRows.length} statement rows from "${file.getName()}".`);
  Logger.log(`Read ${ledgerRows.length} ledger rows from Transactions.`);

  // Find Lazada statement rows
  const lazadaStmtRows = stmtRows.filter(r => /lazada/i.test(r.merchant) || (Math.abs(r.amount - 19.98) < 0.01) || (Math.abs(r.amount - 100.99) < 0.01));
  Logger.log(`\nFound ${lazadaStmtRows.length} matching/Lazada statement rows:`);
  lazadaStmtRows.forEach((sr, idx) => {
    Logger.log(`\n----------------------------------------------------------------------`);
    Logger.log(`[Statement Row #${idx + 1}]`);
    Logger.log(`  Date:        ${sr.date}`);
    Logger.log(`  Merchant:    "${sr.merchant}"`);
    Logger.log(`  Amount:      S$${Math.abs(sr.amount).toFixed(2)}`);
    Logger.log(`  Cardholder:  "${sr.cardholder || 'none'}" (Last4: ${sr.card_last4 || sr.card_number || 'none'})`);
    Logger.log(`  Card Type:   "${sr.card_type || 'none'}"`);
    Logger.log(`  Raw Row:     [${sr.raw_row ? sr.raw_row.join(' | ') : 'none'}]`);

    explainNoMatch(sr, ss);
  });

  // Find Lazada ledger rows
  const lazadaLedgerRows = ledgerRows.filter(r => /lazada/i.test(r.where) || (Math.abs(r.amount - 19.98) < 0.01) || (Math.abs(r.amount - 100.99) < 0.01));
  Logger.log(`\nFound ${lazadaLedgerRows.length} matching/Lazada ledger rows in Transactions:`);
  lazadaLedgerRows.forEach((lr, idx) => {
    const lPrep = prepareReconcilerItem(lr, lr.row_index, 'ledger');
    Logger.log(`  Ledger Row ${lr.row_index}: Date ${lr.date} | S$${Math.abs(lr.amount).toFixed(2)} | Where: "${lr.where}" | Cat: "${lr.category}" | Col J (Notes): "${lr.notes}" | Cardholder: "${lPrep.cardholder}"`);
  });

  // --------------------------------------------------------------------------
  // 2. QUANTIFY THE COST OF CARDHOLDER FILTERING
  // --------------------------------------------------------------------------
  Logger.log('\n======================================================================');
  Logger.log('📊 2. QUANTIFYING COST OF CARDHOLDER FILTERING ON LIVE DATA');
  Logger.log('======================================================================\n');

  // Run 1: Normal findMissing (with isCardholderCompatible active)
  const resWithFilter = findMissing(stmtRows, ledgerRows);

  // Run 2: Bypassed findMissing
  const originalIsCompat = isCardholderCompatible;
  let resBypassed;
  try {
    isCardholderCompatible = function(s, l) { return true; };
    resBypassed = findMissing(stmtRows, ledgerRows);
  } finally {
    isCardholderCompatible = originalIsCompat;
  }

  // 3. Diagnose the 7 specific cases against real ledger
  const targetCases = [
    { queryMerchant: 'SPL AUTO TOPUP (CBT)', queryAmount: 20.00, queryDate: '13.08.2026', expectedWhere: 'SimplyGo Auto Topup' },
    { queryMerchant: 'POPULAR-POS 1', queryAmount: 20.34, queryDate: '13.08.2026', expectedWhere: 'Popular Bookstores' },
    { queryMerchant: '2C2*LAZADA', queryAmount: 19.98, queryDate: '15.08.2026', expectedWhere: 'Lazada SG' },
    { queryMerchant: '2C2*LAZADA', queryAmount: 100.99, queryDate: '15.08.2026', expectedWhere: 'Lazada SG' },
    { queryMerchant: 'GOPAY-GOJEK', queryAmount: 20.80, queryDate: '15.08.2026', expectedWhere: 'Gojek' },
    { queryMerchant: 'JASONS MARKET PLACE-RA', queryAmount: 101.75, queryDate: '16.08.2026', expectedWhere: 'Cold Storage' },
    { queryMerchant: 'AMZNPRIMESG MEMBERSHI', queryAmount: 4.99, queryDate: '16.08.2026', expectedWhere: 'Amazon Prime' }
  ];

  const diagnosticResults = targetCases.map((tc, idx) => {
    // Find matching statement row
    const sMatch = stmtRows.find(sr => Math.abs(sr.amount - tc.queryAmount) < 0.01 && (computeMerchantSimilarity(sr.merchant, tc.queryMerchant) >= 0.80 || sr.merchant.includes(tc.queryMerchant.slice(0, 8))));
    // Find candidate ledger rows
    const lCandidates = ledgerRows.filter(lr => {
      const isAmt = Math.abs(lr.amount - tc.queryAmount) < 0.01;
      const days = sMatch ? getDaysDifference(sMatch.date, lr.date) : (lr.date ? getDaysDifference(tc.queryDate, lr.date) : 999);
      const isWhere = lr.where && (lr.where.toLowerCase().includes(tc.expectedWhere.toLowerCase().slice(0, 6)) || computeMerchantSimilarity(lr.where, tc.expectedWhere) >= 0.50);
      return (isAmt && days <= 14) || isWhere;
    }).map(lr => {
      const lPrep = prepareReconcilerItem(lr, lr.row_index, 'ledger');
      const sPrep = sMatch ? prepareReconcilerItem(sMatch, 0, 'statement') : null;
      const sim = sMatch ? computeMerchantSimilarity(sMatch.merchant, lr.where) : 0;
      const daysDiff = sMatch ? getDaysDifference(sMatch.date, lr.date) : 999;
      const isCompat = sPrep ? isCardholderCompatible(sPrep, lPrep) : true;
      return {
        row_index: lr.row_index,
        date: lr.date,
        where: lr.where,
        amount: lr.amount,
        category: lr.category,
        colJ_notes: lr.notes,
        cardholder: lPrep.cardholder,
        similarity: sim,
        daysDiff: daysDiff,
        isCardholderCompatible: isCompat,
        pass1_match: sPrep ? (sPrep.dedupe_key === lPrep.dedupe_key) : false,
        pass2_eligible: daysDiff <= 4 && sim >= 0.70 && isCompat
      };
    });

    let statusWithFilter = 'not_in_statement';
    let statusBypassed = 'not_in_statement';
    let matchedWith = null;

    if (sMatch) {
      const match1 = resWithFilter.matched.find(m => m.date === sMatch.date && Math.abs(m.amount - sMatch.amount) < 0.005 && m.merchant === sMatch.merchant);
      if (match1) {
        statusWithFilter = 'matched';
        matchedWith = match1.matched_ledger ? match1.matched_ledger.where : 'matched';
      } else {
        const ambig1 = resWithFilter.ambiguous.find(a => a.date === sMatch.date && Math.abs(a.amount - sMatch.amount) < 0.005 && a.merchant === sMatch.merchant);
        statusWithFilter = ambig1 ? 'ambiguous' : 'missing';
      }

      const match2 = resBypassed.matched.find(m => m.date === sMatch.date && Math.abs(m.amount - sMatch.amount) < 0.005 && m.merchant === sMatch.merchant);
      if (match2) {
        statusBypassed = 'matched';
      } else {
        const ambig2 = resBypassed.ambiguous.find(a => a.date === sMatch.date && Math.abs(a.amount - sMatch.amount) < 0.005 && a.merchant === sMatch.merchant);
        statusBypassed = ambig2 ? 'ambiguous' : 'missing';
      }
    }

    return {
      caseId: idx + 1,
      expected: tc,
      statementFound: sMatch ? {
        date: sMatch.date,
        merchant: sMatch.merchant,
        amount: sMatch.amount,
        cardholder: sMatch.cardholder,
        card_last4: sMatch.card_last4,
        card_type: sMatch.card_type,
        raw_row: sMatch.raw_row
      } : null,
      statusWithFilter: statusWithFilter,
      statusBypassed: statusBypassed,
      matchedWith: matchedWith,
      candidates: lCandidates
    };
  });

  const normalizedStmtRows = normalizeRows(parsedStmt.rows || []);
  const resNormalized = findMissing(normalizedStmtRows, ledgerRows);
  const filterNorm = filterNonSpend(resNormalized.missing);

  const normMatchedKeys = new Set((resNormalized.matched || []).map(m => `${m.date}_${Math.abs(m.amount).toFixed(2)}_${normaliseWhere(m.merchant || m.raw_merchant || '')}`));
  const diagMatchedKeys = new Set((resWithFilter.matched || []).map(m => `${m.date}_${Math.abs(m.amount).toFixed(2)}_${normaliseWhere(m.merchant || m.raw_merchant || '')}`));

  const inNormNotDiag = (resNormalized.matched || []).filter(m => !diagMatchedKeys.has(`${m.date}_${Math.abs(m.amount).toFixed(2)}_${normaliseWhere(m.merchant || m.raw_merchant || '')}`));
  const inDiagNotNorm = (resWithFilter.matched || []).filter(m => !normMatchedKeys.has(`${m.date}_${Math.abs(m.amount).toFixed(2)}_${normaliseWhere(m.merchant || m.raw_merchant || '')}`));

  return {
    rawStatementMatchCounts: {
      matched: resWithFilter.matched.length,
      missing: resWithFilter.missing.length,
      ambiguous: resWithFilter.ambiguous.length
    },
    normalizedStatementMatchCounts: {
      matched: resNormalized.matched.length,
      missing: resNormalized.missing.length,
      ambiguous: resNormalized.ambiguous.length,
      proposalsAfterFilter: filterNorm.proposals.length,
      excludedAfterFilter: filterNorm.excluded.length
    },
    cardholderFilterImpact: {
      withFilter: { matched: resWithFilter.matched.length, missing: resWithFilter.missing.length, ambiguous: resWithFilter.ambiguous.length },
      bypassed: { matched: resBypassed.matched.length, missing: resBypassed.missing.length, ambiguous: resBypassed.ambiguous.length },
      deltaMatched: resBypassed.matched.length - resWithFilter.matched.length
    },
    discrepancyExplained: {
      countInNormNotDiag: inNormNotDiag.length,
      countInDiagNotNorm: inDiagNotNorm.length,
      sampleDifferences: inNormNotDiag.map(m => ({
        date: m.date,
        amount: m.amount,
        merchant: m.merchant,
        raw_merchant: m.raw_merchant,
        match_type: m.match_type,
        matched_where: m.matched_ledger ? m.matched_ledger.where : ''
      }))
    },
    diagnosticSevenCases: diagnosticResults
  };
}


/**
 * Logs the FULL Merchants sheet tab (merchant, category, count, aliases)
 * and audits Grab occurrences in both the Merchants tab and Transactions ledger.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet]
 * @return {Object} Summary of merchants tab and Grab ledger stats.
 */
function logMerchantsTabAudit(optSpreadsheet) {
  const ss = optSpreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    Logger.log('⚠️ logMerchantsTabAudit: No active spreadsheet available.');
    return { merchants: [], grabMerchants: [], grabLedgerCounts: {}, totalGrabRows: 0 };
  }

  Logger.log('\n======================================================================');
  Logger.log('📋 FULL MERCHANTS TAB AUDIT');
  Logger.log('======================================================================');

  const merchantsSheet = ss.getSheetByName('Merchants');
  const merchantsList = [];
  const grabMerchantsRows = [];

  if (!merchantsSheet) {
    Logger.log('ℹ️ Sheet "Merchants" does not exist yet.');
  } else {
    const lastRow = merchantsSheet.getLastRow();
    if (lastRow <= 1) {
      Logger.log('ℹ️ Sheet "Merchants" is empty (header only).');
    } else {
      const numCols = Math.max(merchantsSheet.getLastColumn(), 5);
      const data = merchantsSheet.getRange(2, 1, lastRow - 1, numCols).getValues();
      Logger.log(`Total Learned Merchants in Tab: ${data.length}\n`);
      Logger.log('Row | Merchant (Canonical)      | Category         | Count | Last Seen  | Aliases');
      Logger.log('----+---------------------------+------------------+-------+------------+---------------------------');
      for (let r = 0; r < data.length; r++) {
        const mName = String(data[r][0] || '').trim();
        const cat = String(data[r][1] || '').trim();
        const cnt = Number(data[r][2]) || 1;
        const lastSeen = data[r][3] ? (typeof formatSheetDate === 'function' ? formatSheetDate(data[r][3]) : String(data[r][3])) : '';
        const aliasesStr = String(data[r][4] || '').trim();

        merchantsList.push({
          row: r + 2,
          merchant: mName,
          category: cat,
          count: cnt,
          lastSeen: lastSeen,
          aliases: aliasesStr
        });

        const padM = (mName + '                            ').substring(0, 25);
        const padC = (cat + '                  ').substring(0, 16);
        const padCnt = (String(cnt) + '     ').substring(0, 5);
        const padLS = (lastSeen + '          ').substring(0, 10);
        Logger.log(`${String(r + 2).padStart(3, ' ')} | ${padM} | ${padC} | ${padCnt} | ${padLS} | ${aliasesStr || '-'}`);

        if (mName.toLowerCase().includes('grab') || aliasesStr.toLowerCase().includes('grab')) {
          grabMerchantsRows.push({
            row: r + 2,
            merchant: mName,
            category: cat,
            count: cnt,
            aliases: aliasesStr
          });
        }
      }
    }
  }
  Logger.log('======================================================================\n');

  // Grab Specific Audit: Merchants Tab Rows
  Logger.log('======================================================================');
  Logger.log('🚕 GRAB AUDIT: MERCHANTS TAB ENTRIES');
  Logger.log('======================================================================');
  if (grabMerchantsRows.length === 0) {
    Logger.log('  No rows in "Merchants" tab with canonical name or alias containing "Grab".');
  } else {
    grabMerchantsRows.forEach(gm => {
      Logger.log(`  - Row ${gm.row}: Canonical: "${gm.merchant}" | Cat: "${gm.category}" | Count: ${gm.count} | Aliases: [${gm.aliases}]`);
    });
  }
  Logger.log('======================================================================\n');

  // Grab Specific Audit: Transactions Ledger Rows
  Logger.log('======================================================================');
  Logger.log('🚕 GRAB AUDIT: HISTORICAL LEDGER (TRANSACTIONS) ROWS');
  Logger.log('======================================================================');
  const transSheet = ss.getSheetByName('Transactions');
  const grabLedgerCounts = {};
  const grabLedgerSampleRows = [];
  let totalGrabRows = 0;

  if (!transSheet) {
    Logger.log('⚠️ Sheet "Transactions" not found.');
  } else {
    const lastRow = transSheet.getLastRow();
    if (lastRow > 1) {
      const numCols = Math.max(transSheet.getLastColumn(), 10);
      const data = transSheet.getRange(2, 1, lastRow - 1, numCols).getValues();
      for (let r = 0; r < data.length; r++) {
        const where = String(data[r][8] || '').trim(); // Col I
        const cat = String(data[r][7] || '').trim();   // Col H
        const dateStr = typeof formatSheetDate === 'function' ? formatSheetDate(data[r][0]) : String(data[r][0] || '');
        const amt = Number(data[r][4] || data[r][3] || 0);

        const norm = typeof normaliseWhere === 'function' ? normaliseWhere(where) : where.toLowerCase().trim();
        const isGrab = (norm === 'grab' || norm.startsWith('grab ') || norm.startsWith('grab*') || where.toLowerCase().includes('grab'));

        if (isGrab) {
          totalGrabRows++;
          const effectiveCat = cat || 'Uncategorized';
          grabLedgerCounts[effectiveCat] = (grabLedgerCounts[effectiveCat] || 0) + 1;

          if (grabLedgerSampleRows.length < 15) {
            grabLedgerSampleRows.push({
              row: r + 2,
              date: dateStr,
              amount: amt,
              where: where,
              category: effectiveCat
            });
          }
        }
      }
    }
  }

  Logger.log(`Total "Grab" transactions found in Transactions ledger: ${totalGrabRows}`);
  if (totalGrabRows > 0) {
    Logger.log('\nCategory Breakdown:');
    Object.keys(grabLedgerCounts).sort((a, b) => grabLedgerCounts[b] - grabLedgerCounts[a]).forEach(cat => {
      const pct = ((grabLedgerCounts[cat] / totalGrabRows) * 100).toFixed(1);
      Logger.log(`  - ${cat}: ${grabLedgerCounts[cat]} rows (${pct}%)`);
    });

    Logger.log(`\nSample Historical Rows in Ledger (First ${grabLedgerSampleRows.length}):`);
    grabLedgerSampleRows.forEach(sr => {
      Logger.log(`  - Row ${sr.row}: ${sr.date} | S$${Math.abs(sr.amount).toFixed(2)} | Where: "${sr.where}" | Cat: "${sr.category}"`);
    });
  } else {
    Logger.log('  No Grab rows found in Transactions ledger.');
  }
  Logger.log('======================================================================\n');

  return {
    merchants: merchantsList,
    grabMerchants: grabMerchantsRows,
    grabLedgerCounts: grabLedgerCounts,
    totalGrabRows: totalGrabRows
  };
}

/**
 * Runner helper to audit Grab and print the full Merchants sheet tab.
 * Select this function in the Apps Script Run dropdown and click Run.
 */
function runDiagnostic_GrabAndMerchants() {
  Logger.log('\n======================================================================');
  Logger.log('        RUNNING DIAGNOSTIC ON GRAB & MERCHANTS STORE');
  Logger.log('======================================================================\n');
  logMerchantsTabAudit();
}



