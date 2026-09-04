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
 * @param {string} [fileName] - Optional filename hint.
 * @return {Object|null} Parsed result or null if not DBS format.
 */
function tryParseDbsCsv(rows2D, rawCsvText, fileName) {
  let headerIndex = -1;
  let txnDateCol = -1;
  let postingDateCol = -1;
  let descCol = -1;
  let debitCol = -1;
  let creditCol = -1;
  let cardCol = -1;
  let txnTypeCol = -1;

  for (let r = 0; r < Math.min(rows2D.length, 25); r++) {
    const row = rows2D[r].map(c => String(c || '').trim().toLowerCase());
    
    // Check for signature DBS header labels
    const hasPostingDate = row.some(c => c.includes('transaction posting date') || c.includes('posting date'));
    const hasTxnDate = row.some(c => c.includes('transaction date') || c === 'date');
    const hasDebit = row.some(c => c.includes('debit amount') || c === 'debit');

    if ((hasPostingDate || hasTxnDate) && (hasDebit || row.some(c => c.includes('credit amount')))) {
      headerIndex = r;
      row.forEach((colName, cIdx) => {
        if (colName.includes('transaction date')) {
          txnDateCol = cIdx;
        } else if (colName.includes('posting date') || colName.includes('transaction posting date')) {
          postingDateCol = cIdx;
        } else if (colName === 'date') {
          if (txnDateCol === -1) txnDateCol = cIdx;
        } else if (colName.includes('description') || colName.includes('transaction description') || colName.includes('merchant')) {
          descCol = cIdx;
        } else if (colName.includes('debit amount') || colName === 'debit') {
          debitCol = cIdx;
        } else if (colName.includes('credit amount') || colName === 'credit') {
          creditCol = cIdx;
        } else if (colName.includes('card no') || colName.includes('card number') || colName === 'card') {
          cardCol = cIdx;
        } else if (colName.includes('transaction type') || colName.includes('txn type') || colName === 'type') {
          txnTypeCol = cIdx;
        }
      });
      break;
    }
  }

  const primaryDateCol = (txnDateCol !== -1) ? txnDateCol : postingDateCol;

  if (headerIndex === -1 || primaryDateCol === -1 || (debitCol === -1 && creditCol === -1)) {
    return null;
  }

  // Account determination (scan preamble & filename)
  const preambleSlice = rows2D.slice(0, headerIndex).map(r => r.join(' ')).join('\n').toLowerCase();
  const fileLower = String(fileName || '').toLowerCase();
  let account = null;

  if (preambleSlice.includes('dbs') || preambleSlice.includes('posb') || fileLower.includes('dbs') || fileLower.includes('posb')) {
    account = 'DBS CC SGD';
  } else if (preambleSlice.includes('citi') || fileLower.includes('citi')) {
    account = 'Citibank CC';
  } else {
    // Default to DBS CC SGD if standard DBS columns matched
    account = 'DBS CC SGD';
  }

  const rows = [];
  for (let r = headerIndex + 1; r < rows2D.length; r++) {
    const row = rows2D[r];
    const rawDate = String((txnDateCol !== -1 && row[txnDateCol]) || (postingDateCol !== -1 && row[postingDateCol]) || row[primaryDateCol] || '').trim();
    const normDate = parseStatementDate(rawDate);
    if (!normDate) continue;

    const rawDesc = String(row[descCol] || '').replace(/^['"\s]+|['"\s]+$/g, '').trim();
    if (!rawDesc && !row[debitCol] && !row[creditCol]) continue;

    // Stop if encountering footer total lines
    const descLower = rawDesc.toLowerCase();
    if (descLower.startsWith('total') || descLower.startsWith('statement summary') || descLower.startsWith('end of statement')) {
      continue;
    }

    const debitNum = parseAmountNumber(row[debitCol]);
    const creditNum = (creditCol !== -1) ? parseAmountNumber(row[creditCol]) : null;

    let amount = 0;
    let type = 'Расходы';

    if (debitNum !== null && debitNum > 0) {
      // Purchase / Expense -> POSITIVE amount
      amount = debitNum;
      type = 'Расходы';
    } else if (creditNum !== null && creditNum > 0) {
      // Payment / Credit -> NEGATIVE amount
      amount = -creditNum;
      type = 'Получение денег';
    } else if (debitNum !== null && debitNum < 0) {
      amount = debitNum;
      type = 'Получение денег';
    } else {
      continue; // Skip zero/invalid entries
    }

    const cardNum = (cardCol !== -1 && row[cardCol])
      ? String(row[cardCol]).replace(/^['"\s]+|['"\s]+$/g, '').trim()
      : '';
    const txnType = (txnTypeCol !== -1 && row[txnTypeCol])
      ? String(row[txnTypeCol]).replace(/^['"\s]+|['"\s]+$/g, '').trim()
      : '';

    rows.push({
      date: normDate,
      amount: amount,
      raw_amount: String(row[debitCol] || row[creditCol] || amount),
      merchant: rawDesc,
      description: rawDesc,
      where: rawDesc,
      type: type,
      transaction_type: txnType,
      currency: 'SGD',
      card_number: cardNum,
      raw_row: row
    });
  }

  const period = derivePeriodFromRows(rows);

  return {
    account: account,
    rows: rows,
    period: period,
    format: 'dbs_csv'
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
    const parsedAmount = parseAmountNumber(row[2]);
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
    const numAmount = parseAmountNumber(rawAmountStr);
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
function parseAmountNumber(valStr) {
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
  s = s.replace(/,/g, '').replace(/\s+/g, '');

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

    normalizedRows.push({
      date: normDate,
      amount: finalAmount,
      merchant: normMerchant,
      raw_merchant: cleanRawMerchant,
      type: type,
      transaction_type: txnType,
      account: account,
      card_number: cardNum ? String(cardNum).replace(/^['"\s]+|['"\s]+$/g, '') : '',
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
function findMissing(statementRows, ledgerRows) {
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

    if (sList.length === lList.length) {
      // 1-to-1 match for all items in this exact group
      for (let k = 0; k < sList.length; k++) {
        const s = sList[k];
        const l = lList[k];
        claimedLedgerIndices.add(l.index);
        matchedStatementIndices.add(s.index);
        result.matched.push({
          ...s.raw,
          matched_ledger: l.raw,
          match_type: 'exact'
        });
      }
    } else {
      // Unequal count: ambiguous! Multiple candidates or statement rows competing without 1-to-1 clarity
      for (let k = 0; k < sList.length; k++) {
        const s = sList[k];
        ambiguousStatementIndices.add(s.index);
        result.ambiguous.push({
          ...s.raw,
          candidates: lList.map(item => item.raw),
          match_type: 'ambiguous_exact',
          reason: `Count mismatch on exact dedupe key (${sList.length} statement vs ${lList.length} ledger)`
        });
      }
      // Claim ledger rows so they cannot be matched fuzzily to other rows
      lList.forEach(item => claimedLedgerIndices.add(item.index));
    }
  });

  // --------------------------------------------------------------------------
  // PASS 2: FUZZY MATCH (Amount equal, Date within ±4 days, Merchant similarity >= 0.70)
  // --------------------------------------------------------------------------
  const remainingStatement = sItems.filter(s => !matchedStatementIndices.has(s.index) && !ambiguousStatementIndices.has(s.index));
  const remainingLedger = lItems.filter(l => !claimedLedgerIndices.has(l.index));

  // Build candidate map for each remaining statement row
  const sCandidateMap = new Map(); // s.index -> array of matching { ledgerItem, daysDiff, similarity }
  const lCandidateMap = new Map(); // l.index -> array of matching sItems

  remainingStatement.forEach(s => {
    const candidates = [];
    remainingLedger.forEach(l => {
      // 1. Amount equal (exact ±0.005)
      if (Math.abs(s.amount - l.amount) >= 0.005) return;

      // 2. Date within ±4 days
      const daysDiff = getDaysDifference(s.date, l.date);
      if (daysDiff > 4) return;

      // 3. Merchant similarity >= 0.70
      const similarity = computeMerchantSimilarity(s.merchant, l.merchant);
      if (similarity < 0.70) return;

      candidates.push({ ledgerItem: l, daysDiff: daysDiff, similarity: similarity });
    });

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
      // Genuine Miss: No match in ledger
      result.missing.push(s.raw);
      continue;
    }

    if (candidates.length === 1) {
      const singleCandidate = candidates[0].ledgerItem;
      const competingStatementRows = (lCandidateMap.get(singleCandidate.index) || [])
        .filter(compS => !matchedStatementIndices.has(compS.index) && !ambiguousStatementIndices.has(compS.index));

      if (competingStatementRows.length === 1) {
        // Unique 1-to-1 match
        claimedLedgerIndices.add(singleCandidate.index);
        matchedStatementIndices.add(s.index);
        result.matched.push({
          ...s.raw,
          matched_ledger: singleCandidate.raw,
          match_type: 'fuzzy',
          days_diff: candidates[0].daysDiff,
          similarity: candidates[0].similarity
        });
      } else {
        // Multiple statement rows compete for this single ledger candidate -> ambiguous!
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
    } else {
      // candidates.length > 1: Check for symmetric duplicate group
      const identicalStatementRows = remainingStatement.filter(otherS => 
        !matchedStatementIndices.has(otherS.index) &&
        !ambiguousStatementIndices.has(otherS.index) &&
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
            similarity: candidates[k].similarity
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

  return result;
}

/**
 * Normalizes an input row for the matching engine.
 * Standardizes date to DD.MM.YYYY, amount to float, merchant with normaliseWhere(), and dedupe_key.
 * 
 * @param {Object|Array} r - Input statement or ledger row.
 * @param {number} idx - Index in source array.
 * @param {string} source - 'statement' or 'ledger'.
 * @return {Object} Prepared matching item.
 */
function prepareReconcilerItem(r, idx, source) {
  if (!r) {
    return { index: idx, date: '', amount: 0, merchant: '', account: '', dedupe_key: '', raw: r };
  }

  let rawDate = '';
  let rawAmount = null;
  let rawMerchant = '';
  let account = 'DBS CC SGD';
  let dedupeKey = '';

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
  }

  const normDate = typeof normalizeDateString === 'function' ? normalizeDateString(rawDate) : String(rawDate || '').trim();
  const numAmount = typeof normalizeAmountValue === 'function' ? normalizeAmountValue(rawAmount) : parseFloat(rawAmount || 0);
  const normMerchant = typeof normaliseWhere === 'function' ? normaliseWhere(rawMerchant) : String(rawMerchant || '').toLowerCase().trim();

  if (!dedupeKey && typeof generateDedupeKey === 'function') {
    dedupeKey = generateDedupeKey(normDate, account, numAmount, normMerchant);
  }

  return {
    index: idx,
    date: normDate,
    amount: numAmount,
    merchant: normMerchant,
    account: account,
    dedupe_key: dedupeKey,
    source: source,
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

  // Prefix / substring containment if min length is meaningful (>= 4 chars)
  const minLen = Math.min(c1.length, c2.length);
  if (minLen >= 4 && (c1.startsWith(c2) || c2.startsWith(c1))) {
    return 0.90;
  }
  if (minLen >= 4 && (c1.includes(c2) || c2.includes(c1))) {
    return 0.85;
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
  const spreadsheet = optSpreadsheet || SpreadsheetApp.getActiveSpreadsheet();
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
 * Builds a lookup map from normalized merchant to most frequently / recently used category in the ledger.
 * Enables automatic pre-categorization of statement rows based on past user transactions.
 * 
 * @param {Array<Object>} [ledgerRows] - Historical transactions from Transactions tab.
 * @return {Map<string, string>} Map of normalized merchant -> category.
 */
function buildMerchantCategoryLookup(ledgerRows) {
  const map = new Map();
  if (!Array.isArray(ledgerRows)) return map;

  for (let i = 0; i < ledgerRows.length; i++) {
    const row = ledgerRows[i];
    const merchantNorm = typeof normaliseWhere === 'function'
      ? normaliseWhere(row.where || row.merchant || '')
      : String(row.where || '').toLowerCase().trim();
    const category = String(row.category || '').trim();

    if (merchantNorm && category && category !== 'Другое') {
      map.set(merchantNorm, category);
    }
  }

  return map;
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
function stageProposals(proposals, ambiguous, optSpreadsheet, optLedgerRows) {
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

  // 2. Clear existing sheet contents and validations
  sheet.clear();
  sheet.clearConditionalFormatRules();

  // Enforce plain text '@' format across entire Column B (date) so Sheets never coerces date strings to Date objects
  sheet.getRange(1, 2, sheet.getMaxRows(), 1).setNumberFormat('@');
  SpreadsheetApp.flush();

  // 3. Define 11 required columns
  const headers = [
    '✓',
    'date',
    'account',
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
    Logger.log(`ℹ️ stageProposals: No rows to stage. Initialized empty "${RECONCILE_STAGING_TAB_NAME}" tab.`);
    return { stagedCount: 0, proposalsCount: 0, ambiguousCount: 0, sheet: sheet };
  }

  // 4. Load runtime category bucket map and learned merchant category lookup
  const catMap = typeof getCategoryBucketMap === 'function' ? getCategoryBucketMap(spreadsheet) : {};
  const merchantCatMap = buildMerchantCategoryLookup(optLedgerRows);

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

  const numRows = stagingQueue.length;
  const rows2D = [];
  const backgrounds = [];

  for (let i = 0; i < numRows; i++) {
    const entry = stagingQueue[i];
    const r = entry.item;
    const status = entry.status;
    const isCredit = entry.isCredit;

    const dateStr = typeof normalizeDateString === 'function'
      ? normalizeDateString(r.date || r.raw_date)
      : String(r.date || '').trim();
    const accountStr = String(r.account || (typeof DEFAULT_ACCOUNT !== 'undefined' ? DEFAULT_ACCOUNT : 'DBS CC SGD')).trim();
    const typeStr = isCredit ? 'Получение денег' : (r.type || 'Расходы');

    // Amount: negative for credits, positive for expenses
    let numAmt = Number(r.amount !== undefined ? r.amount : r.raw_amount) || 0;
    if (isCredit && numAmt > 0) numAmt = -numAmt;
    if (!isCredit && numAmt < 0) numAmt = Math.abs(numAmt);

    const rawMerchant = String(r.merchant || r.raw_merchant || r.where || '').trim();
    const normMerchant = typeof normaliseWhere === 'function'
      ? normaliseWhere(rawMerchant)
      : rawMerchant.toLowerCase();
    const merchantStr = typeof cleanMerchantDisplayName === 'function'
      ? cleanMerchantDisplayName(rawMerchant)
      : rawMerchant;

    // Determine category:
    // 1. Existing category on row
    // 2. Learned category from ledger
    // 3. Category from merchant aliases
    // 4. Fallback to enricher / 'Другое'
    let proposedCat = r.category || r.proposed_category || '';
    if (!proposedCat && merchantCatMap.has(normMerchant)) {
      proposedCat = merchantCatMap.get(normMerchant);
    }
    if (!proposedCat && typeof getMerchantAliases === 'function') {
      const aliases = getMerchantAliases();
      const alias = aliases[normMerchant];
      if (alias && typeof alias === 'object' && alias.category) {
        proposedCat = alias.category;
      }
    }
    if (!proposedCat) {
      proposedCat = 'Другое';
    }

    // Determine bucket via enricher or catMap
    let proposedBucket = catMap ? catMap[proposedCat] : undefined;
    if (!proposedBucket || proposedBucket === 'UNKNOWN') {
      proposedBucket = (typeof CATEGORY_TO_BUCKET !== 'undefined' && CATEGORY_TO_BUCKET[proposedCat])
        ? CATEGORY_TO_BUCKET[proposedCat]
        : 'Wants';
    }

    // Confidence: 1.0 for confident proposals, 0.8 for default category, 0.5 for ambiguous
    let confidenceVal = 1.0;
    if (status === 'ambiguous') {
      confidenceVal = 0.5;
    } else if (proposedCat === 'Другое') {
      confidenceVal = 0.8;
    }

    // Source Row: List candidates for ambiguous, or statement metadata for proposals
    let sourceRowStr = '';
    if (status === 'ambiguous') {
      const candidates = r.candidates || [];
      const candList = candidates.map((c, cIdx) => {
        const cRow = c.row_index ? `Row ${c.row_index}` : `Cand ${cIdx + 1}`;
        const cDate = c.date || '';
        const cAmt = Number(c.amount || 0).toFixed(2);
        const cWhere = c.where || c.merchant || '';
        return `[${cRow}: ${cDate} S$${cAmt} "${cWhere}"]`;
      }).join(', ');
      sourceRowStr = `Ambiguous (${candidates.length} candidates): ${candList}`;
    } else {
      const rawTxnType = r.transaction_type ? ` (${r.transaction_type})` : '';
      sourceRowStr = r.raw_merchant ? `Statement: "${r.raw_merchant}"${rawTxnType}` : `Statement row`;
    }

    // Row layout:
    // 1:✓, 2:date, 3:account, 4:Тип, 5:amount, 6:merchant, 7:proposed category, 8:proposed bucket, 9:confidence, 10:source_row, 11:status
    rows2D.push([
      false,               // 1. ✓ (checkbox unchecked)
      dateStr,             // 2. date
      accountStr,          // 3. account
      typeStr,             // 4. Тип
      numAmt,              // 5. amount
      merchantStr,         // 6. merchant
      proposedCat,         // 7. proposed category
      proposedBucket,      // 8. proposed bucket
      confidenceVal,       // 9. confidence
      sourceRowStr,        // 10. source_row
      status               // 11. status
    ]);

    // Visual separation:
    // - Credit rows: soft mint green (#f0fdf4)
    // - Ambiguous rows: soft amber yellow (#fffbeb)
    // - Expense proposals: clean white (#ffffff)
    let rowBg = '#ffffff';
    if (isCredit) {
      rowBg = '#f0fdf4';
    } else if (status === 'ambiguous') {
      rowBg = '#fffbeb';
    }
    backgrounds.push(new Array(headers.length).fill(rowBg));
  }

  // Set Date column (Col 2) format to plain text '@' BEFORE setValues to prevent Sheets date coercion
  sheet.getRange(2, 2, numRows, 1).setNumberFormat('@');

  // 6. Batch write values and background colors
  const dataRange = sheet.getRange(2, 1, numRows, headers.length);
  dataRange.setValues(rows2D);
  dataRange.setBackgrounds(backgrounds);

  // Re-affirm plain text format on Date column
  sheet.getRange(2, 2, numRows, 1).setNumberFormat('@');

  // 7. Checkbox validation on Column 1
  sheet.getRange(2, 1, numRows, 1).insertCheckboxes();

  // 8. Number formatting on Column 5 (amount)
  sheet.getRange(2, 5, numRows, 1).setNumberFormat('#,##0.00;[Red]-#,##0.00');

  // 9. Alignments
  sheet.getRange(2, 1, numRows, 1).setHorizontalAlignment('center'); // ✓
  sheet.getRange(2, 2, numRows, 1).setHorizontalAlignment('center'); // date
  sheet.getRange(2, 4, numRows, 1).setHorizontalAlignment('center'); // Тип
  sheet.getRange(2, 5, numRows, 1).setHorizontalAlignment('right');  // amount
  sheet.getRange(2, 8, numRows, 1).setHorizontalAlignment('center'); // proposed bucket
  sheet.getRange(2, 9, numRows, 1).setHorizontalAlignment('center'); // confidence
  sheet.getRange(2, 11, numRows, 1).setHorizontalAlignment('center'); // status

  // 10. Inline Category Dropdown Validation on Column 7 (proposed category)
  if (typeof CATEGORIES !== 'undefined' && Array.isArray(CATEGORIES)) {
    const catRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(CATEGORIES, true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(2, 7, numRows, 1).setDataValidation(catRule);
  }

  // 11. Set clean, readable column widths
  const colWidths = [40, 95, 110, 130, 95, 220, 160, 110, 90, 320, 95];
  for (let c = 0; c < colWidths.length; c++) {
    sheet.setColumnWidth(c + 1, colWidths[c]);
  }

  SpreadsheetApp.flush();

  Logger.log(`✅ [STAGE 3E] Staged ${numRows} rows into "${RECONCILE_STAGING_TAB_NAME}" (${cleanProposals.length} proposals, ${ambiguousRows.length} ambiguous).`);

  return {
    stagedCount: numRows,
    proposalsCount: cleanProposals.length,
    ambiguousCount: ambiguousRows.length,
    sheet: sheet
  };
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

  // 3C: Read Transactions ledger and match (PURE READ)
  const ledgerRows = readLedgerRowsForReconciliation(ss);
  const matchResult = findMissing(normalizedStatementRows, ledgerRows);

  // 3D: Filter non-spend rows (Option B dual-sided)
  const filterResult = filterNonSpend(matchResult.missing);

  // 3E: Stage proposals & ambiguous rows
  const stageResult = stageProposals(filterResult.proposals, matchResult.ambiguous, ss, ledgerRows);

  return {
    account: parsed.account,
    period: parsed.period,
    totalParsed: (parsed.rows || []).length,
    normalizedCount: normalizedStatementRows.length,
    matchedCount: matchResult.matched.length,
    proposalsCount: filterResult.proposals.length,
    ambiguousCount: matchResult.ambiguous.length,
    excludedCount: filterResult.excluded.length,
    stagedCount: stageResult.stagedCount
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
function commitStaged(useTestSheet, optDryRun) {
  const ss = (typeof getTargetSpreadsheet === 'function')
    ? getTargetSpreadsheet(Boolean(useTestSheet))
    : SpreadsheetApp.getActiveSpreadsheet();

  if (!ss) {
    throw new Error('commitStaged: No spreadsheet instance available.');
  }

  const isDryRun = (typeof optDryRun === 'boolean')
    ? optDryRun
    : (typeof SHEET_FACTS !== 'undefined' && Boolean(SHEET_FACTS.DRY_RUN));

  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(30000);
  if (!hasLock) {
    throw new Error('commitStaged: Could not acquire script lock within 30 seconds.');
  }

  try {
    const stagingSheet = ss.getSheetByName(RECONCILE_STAGING_TAB_NAME);
    if (!stagingSheet) {
      Logger.log(`ℹ️ commitStaged: No "${RECONCILE_STAGING_TAB_NAME}" staging tab found.`);
      return { committedCount: 0, skippedCount: 0, dryRun: isDryRun, writtenRows: [] };
    }

    const lastRow = stagingSheet.getLastRow();
    if (lastRow <= 1) {
      Logger.log(`ℹ️ commitStaged: Staging tab "${RECONCILE_STAGING_TAB_NAME}" has no data rows.`);
      return { committedCount: 0, skippedCount: 0, dryRun: isDryRun, writtenRows: [] };
    }

    // Read 11 columns across all data rows (Row 2 to lastRow)
    // 1:✓, 2:date, 3:account, 4:Тип, 5:amount, 6:merchant, 7:proposed category, 8:proposed bucket, 9:confidence, 10:source_row, 11:status
    const numRows = lastRow - 1;
    const stagingData = stagingSheet.getRange(2, 1, numRows, 11).getValues();

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
      const status = String(row[10] || '').trim().toLowerCase();

      // Skip unticked rows
      if (!isTicked) {
        continue;
      }

      // Skip already imported rows (Idempotency safeguard)
      if (status === 'imported') {
        Logger.log(`[commitStaged] Row ${r + 2} skipped: already marked 'imported'.`);
        continue;
      }

      const dateStr = String(row[1] || '').trim();
      const accountStr = String(row[2] || (typeof DEFAULT_ACCOUNT !== 'undefined' ? DEFAULT_ACCOUNT : 'DBS CC SGD')).trim();
      const typeStr = String(row[3] || 'Расходы').trim();
      let rawAmt = Number(row[4]) || 0;
      const rawMerchant = String(row[5] || '').trim();
      const merchantStr = typeof cleanMerchantDisplayName === 'function'
        ? cleanMerchantDisplayName(rawMerchant)
        : rawMerchant;
      const catStr = String(row[6] || 'Другое').trim();
      const bucketStr = String(row[7] || 'Wants').trim();

      const isCredit = (typeStr === 'Получение денег' || rawAmt < 0);

      // Amount handling for Transactions:
      // If credit, ensure amount sign matches formula expectation so G adds to running balance
      let finalAmt = rawAmt;
      if (isCredit) {
        // If formula branches on type (+ D), amount should be positive.
        // If formula is pure subtraction (F - D), amount should be negative.
        finalAmt = gFormulaAddExpected ? Math.abs(rawAmt) : -Math.abs(rawAmt);
      } else {
        finalAmt = Math.abs(rawAmt);
      }

      toAppend.push({
        date: dateStr,
        account: accountStr,
        type: isCredit ? 'Получение денег' : 'Расходы',
        amount: finalAmt,
        amount_sgd: finalAmt,
        category: catStr,
        where: merchantStr,
        bucket: bucketStr,
        notes: '',    // J (Notes) explicitly empty
        flags: []     // No flags to keep Notes empty
      });

      candidateRowIndices.push(r + 2); // 1-based row in stagingSheet
    }

    if (toAppend.length === 0) {
      Logger.log('ℹ️ commitStaged: No eligible ticked rows to commit.');
      return { committedCount: 0, skippedCount: 0, dryRun: isDryRun, writtenRows: [] };
    }

    Logger.log(`[commitStaged] Preparing to commit ${toAppend.length} row(s) (dryRun=${isDryRun})...`);

    // Call existing Phase-1 writer (appendTransactions)
    const writeResult = appendTransactions(toAppend, ss, isDryRun);

    // If not dry-run and rows were written, mark rows as 'imported' in _Reconcile
    if (!isDryRun && writeResult.writtenCount > 0) {
      for (let i = 0; i < candidateRowIndices.length; i++) {
        const rowIdx = candidateRowIndices[i];
        stagingSheet.getRange(rowIdx, 11).setValue('imported');
      }
      SpreadsheetApp.flush();
      Logger.log(`✅ [commitStaged] Marked ${candidateRowIndices.length} row(s) as 'imported' in "${RECONCILE_STAGING_TAB_NAME}".`);
    }

    return {
      committedCount: writeResult.writtenCount,
      skippedCount: writeResult.skippedCount,
      dryRun: isDryRun,
      writtenRows: writeResult.writtenRows || []
    };
  } finally {
    lock.releaseLock();
  }
}

