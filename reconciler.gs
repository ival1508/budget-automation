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

    rows.push({
      date: normDate,
      amount: amount,
      raw_amount: String(row[debitCol] || row[creditCol] || amount),
      merchant: rawDesc,
      description: rawDesc,
      where: rawDesc,
      type: type,
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
