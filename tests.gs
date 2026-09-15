/**
 * BUDGET 2026 AUTOMATION — STAGE 3 TEST HARNESS & ASSERTIONS
 * File: tests.gs
 * 
 * Provides:
 * 1. Assertion helpers without external framework:
 *    - assertEq(actual, expected, label)
 *    - assertClose(actual, expected, tolerance, label)
 *    - runAllTests()
 * 2. Hidden `_TestFixtures` sheet management:
 *    - bootstrapTestFixturesTab(optSpreadsheet)
 *    - getFixture(name, optSpreadsheet)
 * 3. Test execution context tracking pass/fail counts across all test_* functions.
 * 
 * Invariants:
 * - NO reconciler functions or business logic here.
 * - NO live sheet writes (all test targets use getTargetSpreadsheet(true) / DRY_RUN).
 */

const TEST_FIXTURES_TAB_NAME = '_TestFixtures';

// Global execution context for test runs and assertion tracking
const _testRunnerContext = {
  active: false,
  currentTestFailed: false,
  currentTestPassCount: 0,
  currentTestFailCount: 0,
  totalAssertionsPassed: 0,
  totalAssertionsFailed: 0
};

function test_transactionDerivedFormulaBuilders() {
  assertEq(transactionAmountSgdFormula(12), '=IF(D12="";"";D12)', 'Transactions E formula follows D on the same row');
  assertEq(transactionBucketFormula(12), '=IF(H12="";"";IFNA(VLOOKUP(H12;\'-\'!$B:$C;2;FALSE);"UNKNOWN"))',
    'Transactions K formula looks up H in the reference taxonomy');
}

// ============================================================================
// 1. ASSERTION HELPERS
// ============================================================================

/**
 * Asserts structural or primitive equality between actual and expected values.
 * Logs ✅ PASS or ❌ FAIL with expected vs actual details on failure.
 * 
 * @param {*} actual - Actual value produced by test.
 * @param {*} expected - Expected target value.
 * @param {string} label - Human-readable assertion description.
 * @return {boolean} True if assertion passed, false otherwise.
 */
function assertEq(actual, expected, label) {
  const isObject = (val) => val !== null && typeof val === 'object';
  const ok = (isObject(actual) || isObject(expected))
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;

  const desc = label || 'assertEq';

  if (ok) {
    Logger.log(`✅ PASS: ${desc}`);
  } else {
    Logger.log(`❌ FAIL: ${desc}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
  }

  if (_testRunnerContext.active) {
    if (ok) {
      _testRunnerContext.currentTestPassCount++;
      _testRunnerContext.totalAssertionsPassed++;
    } else {
      _testRunnerContext.currentTestFailCount++;
      _testRunnerContext.totalAssertionsFailed++;
      _testRunnerContext.currentTestFailed = true;
    }
  }

  if (!ok && !_testRunnerContext.active) {
    throw new Error('Assertion failed: ' + (label || 'unnamed assertion'));
  }
  return ok;
}

/**
 * Asserts numeric proximity (useful for currency and floating-point math).
 * Logs ✅ PASS or ❌ FAIL with expected vs actual and diff on failure.
 * 
 * @param {number|string} actual - Actual numeric value.
 * @param {number|string} expected - Expected numeric value.
 * @param {number|string} [toleranceOrLabel=0.01] - Max acceptable delta, or label if tolerance omitted.
 * @param {string} [optLabel] - Human-readable assertion description.
 * @return {boolean} True if assertion passed within tolerance, false otherwise.
 */
function assertClose(actual, expected, toleranceOrLabel, optLabel) {
  let tolerance = 0.01;
  let label = '';

  if (typeof toleranceOrLabel === 'string' && optLabel === undefined) {
    label = toleranceOrLabel;
  } else {
    tolerance = (typeof toleranceOrLabel === 'number' && !isNaN(toleranceOrLabel)) ? toleranceOrLabel : 0.01;
    label = optLabel || 'assertClose';
  }

  const numActual = Number(actual);
  const numExpected = Number(expected);
  const diff = Math.abs(numActual - numExpected);
  const ok = !isNaN(numActual) && !isNaN(numExpected) && diff <= tolerance;

  if (ok) {
    Logger.log(`✅ PASS: ${label} (actual: ${actual}, expected: ${expected} ±${tolerance})`);
  } else {
    Logger.log(`❌ FAIL: ${label}\n   expected: ${expected} (±${tolerance})\n   actual:   ${actual} (diff: ${isNaN(diff) ? 'NaN' : diff.toFixed(4)})`);
  }

  if (_testRunnerContext.active) {
    if (ok) {
      _testRunnerContext.currentTestPassCount++;
      _testRunnerContext.totalAssertionsPassed++;
    } else {
      _testRunnerContext.currentTestFailCount++;
      _testRunnerContext.totalAssertionsFailed++;
      _testRunnerContext.currentTestFailed = true;
    }
  }

  if (!ok && !_testRunnerContext.active) {
    throw new Error('Assertion failed: ' + (label || 'unnamed assertion'));
  }
  return ok;
}

/**
 * Discovers and executes all test_* functions in the project.
 * Logs per-test results and prints a final summary of passed vs failed tests.
 * 
 * @return {Object} Summary counts { total, passed, failed, totalAssertionsPassed, totalAssertionsFailed }.
 */
function runAllTests() {
  Logger.log('====================================================');
  Logger.log('             STAGE 3 TEST HARNESS RUNNER');
  Logger.log('====================================================\n');

  const globalScope = (typeof globalThis !== 'undefined')
    ? globalThis
    : ((typeof this !== 'undefined') ? this : {});

  // Find all functions starting with test_ (excluding runner/context internals)
  const excludedFunctions = new Set([
    'runAllTests',
    '_testRunnerContext'
  ]);

  const testFnNames = Object.keys(globalScope).filter(function(name) {
    return typeof globalScope[name] === 'function' &&
           name.startsWith('test_') &&
           !excludedFunctions.has(name);
  }).sort();

  const totalTests = testFnNames.length;
  let passedTests = 0;
  let failedTests = 0;

  _testRunnerContext.totalAssertionsPassed = 0;
  _testRunnerContext.totalAssertionsFailed = 0;

  if (totalTests === 0) {
    Logger.log('ℹ️ No test_* functions discovered in the project.');
  } else {
    Logger.log(`Discovered ${totalTests} test function(s):\n${testFnNames.map((n, i) => `  ${i + 1}. ${n}()`).join('\n')}\n`);
  }

  for (let i = 0; i < totalTests; i++) {
    const fnName = testFnNames[i];
    Logger.log(`----------------------------------------------------`);
    Logger.log(`▶ [${i + 1}/${totalTests}] Running: ${fnName}()`);
    Logger.log(`----------------------------------------------------`);

    _testRunnerContext.active = true;
    _testRunnerContext.currentTestFailed = false;
    _testRunnerContext.currentTestPassCount = 0;
    _testRunnerContext.currentTestFailCount = 0;

    let caughtError = null;
    let returnedResult = undefined;

    try {
      returnedResult = globalScope[fnName]();
    } catch (err) {
      caughtError = err;
    }

    const hasFailedAssertions = _testRunnerContext.currentTestFailed || _testRunnerContext.currentTestFailCount > 0;
    const returnedExplicitFalse = (returnedResult === false);

    if (caughtError) {
      Logger.log(`💥 EXCEPTION in ${fnName}(): ${caughtError.message}`);
      if (caughtError.stack) {
        Logger.log(`   Stack: ${caughtError.stack}`);
      }
      failedTests++;
    } else if (hasFailedAssertions || returnedExplicitFalse) {
      Logger.log(`❌ FAILED: ${fnName}() had failed assertions or returned false.`);
      failedTests++;
    } else {
      Logger.log(`✅ PASSED: ${fnName}() completed successfully.`);
      passedTests++;
    }
    Logger.log('');
  }

  _testRunnerContext.active = false;

  Logger.log('====================================================');
  Logger.log('                TEST SUITE SUMMARY');
  Logger.log('====================================================');
  Logger.log(`Total test functions: ${totalTests}`);
  Logger.log(`✅ Passed: ${passedTests}`);
  Logger.log(`❌ Failed: ${failedTests}`);
  Logger.log(`Assertions: ${_testRunnerContext.totalAssertionsPassed} passed, ${_testRunnerContext.totalAssertionsFailed} failed`);
  Logger.log(`Summary: (${passedTests} passed, ${failedTests} failed)`);
  Logger.log('====================================================');

  return {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    assertionsPassed: _testRunnerContext.totalAssertionsPassed,
    assertionsFailed: _testRunnerContext.totalAssertionsFailed
  };
}

// ============================================================================
// 2. TEST FIXTURES SHEET MANAGEMENT (_TestFixtures)
// ============================================================================

/**
 * Creates the hidden `_TestFixtures` tab if it does not exist.
 * Populates standard headers and seed fixture rows for CSV/PDF statement tests.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet] - Optional spreadsheet instance.
 * @return {GoogleAppsScript.Spreadsheet.Sheet} The `_TestFixtures` sheet instance.
 */
function bootstrapTestFixturesTab(optSpreadsheet) {
  const ss = optSpreadsheet || getTargetSpreadsheet(true);
  if (!ss) {
    throw new Error('No spreadsheet available to bootstrap _TestFixtures tab.');
  }

  let sheet = ss.getSheetByName(TEST_FIXTURES_TAB_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(TEST_FIXTURES_TAB_NAME);

    // Header row only: fixture_name, raw_text, format, description
    const headers = [['fixture_name', 'raw_text', 'format', 'description']];
    sheet.getRange(1, 1, 1, 4).setValues(headers);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setFrozenRows(1);

    // Hide sheet as required
    sheet.hideSheet();
    Logger.log(`✅ Created and hid "${TEST_FIXTURES_TAB_NAME}" tab (headers only).`);
  }

  return sheet;
}

/**
 * Retrieves the raw text content of a named fixture from the `_TestFixtures` tab.
 * If `_TestFixtures` tab is missing, automatically bootstraps it first.
 * 
 * @param {string} name - Fixture identifier (e.g. 'dbs_small_csv', 'citibank_csv', 'dbs_csv').
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [optSpreadsheet] - Optional spreadsheet instance.
 * @return {string} Raw statement text stored in column B for this fixture, or '' if not found.
 */
function getFixture(name, optSpreadsheet) {
  if (!name || typeof name !== 'string') {
    Logger.log('⚠️ getFixture called with invalid fixture name.');
    return '';
  }

  const targetKey = name.trim().toLowerCase();

  try {
    const ss = optSpreadsheet || getTargetSpreadsheet(true);
    if (!ss) {
      Logger.log('⚠️ No spreadsheet available in getFixture.');
      return '';
    }

    let sheet = ss.getSheetByName(TEST_FIXTURES_TAB_NAME);
    if (!sheet) {
      sheet = bootstrapTestFixturesTab(ss);
    }

    if (!sheet) {
      Logger.log(`❌ Failed to access or bootstrap "${TEST_FIXTURES_TAB_NAME}" tab.`);
      return '';
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      Logger.log(`⚠️ "${TEST_FIXTURES_TAB_NAME}" tab has no data rows.`);
      return '';
    }

    const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let r = 0; r < data.length; r++) {
      const rowKey = String(data[r][0] || '').trim().toLowerCase();
      if (rowKey === targetKey) {
        const val = String(data[r][1] || '');
        if (val) return val;
      }
    }
  } catch (err) {
    Logger.log(`⚠️ getFixture lookup error for "${name}": ${err.message}`);
  }

  Logger.log(`⚠️ Fixture "${name}" not found in "${TEST_FIXTURES_TAB_NAME}" tab.`);
  return '';
}

// ============================================================================
// 3. STAGE 3A TESTS
// ============================================================================

/**
 * STAGE 3A TEST: Statement Parser Verification (Trimmed DBS & Citibank Statements).
 * Reads `dbs_small_csv` and `citibank_csv` from `_TestFixtures`.
 * 
 * Asserts:
 * - DBS: 6 preamble rows, header on row 7, 8 columns.
 *   Row 1 = 11.08.2026 / SIMPLYGO APP SINGAPORE SGP / 30.00 / Расходы
 *   Asserts the S$12,969.24 "BILL PAYMENT - DBS INTERNET/WIRELESS" (Credit column) parses as a payment
 * - Citibank: no header, 5 columns.
 *   Row 1 = 26.08.2026 / SHELL TELOK BLANGAH / 207.32 / Расходы
 *   Asserts card number '5425504505175056' has stray single quotes stripped
 * - Real period bounds from each file's min/max dates
 * - PRINTS the first 3 parsed rows in full from each bank
 * - CRITICAL: DBS purchase (+30.00) and Citibank purchase (+207.32) share identical positive sign convention
 */
function test_parseStatement() {
  Logger.log('====================================================');
  Logger.log('       TEST: test_parseStatement() EXECUTION');
  Logger.log('====================================================\n');

  // 1. Fetch Fixtures
  const dbsCsv = getFixture('dbs_small_csv');
  const citiCsv = getFixture('citibank_csv');

  assertEq(Boolean(dbsCsv && dbsCsv.length > 0), true, 'dbs_small_csv fixture loaded');
  assertEq(Boolean(citiCsv && citiCsv.length > 0), true, 'citibank_csv fixture loaded');

  // 2. Parse DBS Statement (dbs_small_csv)
  Logger.log('\n--- 1. DBS CSV PARSE TEST (dbs_small_csv) ---');
  const dbsResult = parseStatement(dbsCsv);
  Logger.log(`DBS Parsed Account: "${dbsResult.account}" | Rows: ${dbsResult.rows.length} | Period: ${JSON.stringify(dbsResult.period)}`);

  assertEq(dbsResult.error === undefined || dbsResult.error === null, true, 'DBS parsed without error');
  assertEq(dbsResult.account, 'DBS CC SGD', 'DBS account resolved to "DBS CC SGD"');
  assertEq(dbsResult.rows.length > 0, true, `DBS statement has parsed rows (${dbsResult.rows.length} rows)`);

  // Print first 3 rows in full
  Logger.log('\n--- DBS First 3 Parsed Rows ---');
  Logger.log(JSON.stringify(dbsResult.rows.slice(0, 3), null, 2));

  if (dbsResult.rows.length > 0) {
    const firstDbs = dbsResult.rows[0];
    assertEq(firstDbs.date, '11.08.2026', 'DBS Row 1 date is 11.08.2026');
    assertEq(firstDbs.merchant.toUpperCase().includes('SIMPLYGO'), true, 'DBS Row 1 merchant contains SIMPLYGO');
    assertClose(firstDbs.amount, 30.00, 0.01, 'DBS Row 1 amount is S$30.00');
    assertEq(firstDbs.type, 'Расходы', 'DBS Row 1 type is "Расходы"');

    // Find the S$12,969.24 Bill Payment row
    const billPaymentRow = dbsResult.rows.find(r => 
      r.merchant.toUpperCase().includes('BILL PAYMENT') ||
      r.merchant.toUpperCase().includes('DBS INTERNET/WIRELESS') ||
      Math.abs(r.amount - 12969.24) < 0.05 ||
      Math.abs(r.amount + 12969.24) < 0.05
    );

    if (billPaymentRow) {
      Logger.log(`Found DBS Bill Payment row: ${billPaymentRow.merchant} | Amount: ${billPaymentRow.amount} | Type: ${billPaymentRow.type}`);
      assertEq(billPaymentRow.type, 'Получение денег', 'DBS S$12,969.24 BILL PAYMENT parsed as payment (type = Получение денег)');
      assertEq(billPaymentRow.amount < 0, true, 'DBS S$12,969.24 BILL PAYMENT parsed with negative amount');
      assertClose(billPaymentRow.amount, -12969.24, 0.05, 'DBS BILL PAYMENT amount is -12969.24');
    } else {
      Logger.log('ℹ️ Bill payment row check: not in dbs_small_csv (will be checked in test_parseStatement_full).');
    }
  }

  assertEq(Boolean(dbsResult.period && dbsResult.period.from && dbsResult.period.to), true, 'DBS period bounds derived from min/max dates');

  // 3. Parse Citibank Statement (citibank_csv)
  Logger.log('\n--- 2. CITIBANK CSV PARSE TEST (citibank_csv) ---');
  const citiResult = parseStatement(citiCsv);
  Logger.log(`Citibank Parsed Account: "${citiResult.account}" | Rows: ${citiResult.rows.length} | Period: ${JSON.stringify(citiResult.period)}`);

  assertEq(citiResult.error === undefined || citiResult.error === null, true, 'Citibank parsed without error');
  assertEq(citiResult.account, 'Citibank CC', 'Citibank account resolved to "Citibank CC"');
  assertEq(citiResult.rows.length, 13, `Citibank statement contains exactly 13 rows (got ${citiResult.rows.length})`);

  // Print first 3 rows in full
  Logger.log('\n--- Citibank First 3 Parsed Rows ---');
  Logger.log(JSON.stringify(citiResult.rows.slice(0, 3), null, 2));

  if (citiResult.rows.length > 0) {
    const firstCiti = citiResult.rows[0];
    assertEq(firstCiti.date, '26.08.2026', 'Citibank Row 1 date is 26.08.2026');
    assertEq(firstCiti.merchant.toUpperCase().includes('SHELL'), true, 'Citibank Row 1 merchant contains SHELL');
    assertClose(firstCiti.amount, 207.32, 0.01, 'Citibank Row 1 (SHELL) amount is S$207.32');
    assertEq(firstCiti.type, 'Расходы', 'Citibank Row 1 (SHELL) type is "Расходы"');

    // Assert card number quotes stripped
    if (firstCiti.card_number) {
      assertEq(firstCiti.card_number.includes("'"), false, `Citibank card number "${firstCiti.card_number}" has single quotes stripped`);
    }

    // Assert Citibank specific polarity examples from real statement:
    // 1. AUTO LATE FEE REVERSAL -> type: 'Получение денег', amount: -100.00
    const reversalRow = citiResult.rows.find(r => r.merchant.toUpperCase().includes('LATE FEE REVERSAL'));
    if (reversalRow) {
      assertEq(reversalRow.type, 'Получение денег', 'Citibank "AUTO LATE FEE REVERSAL" parsed as refund/credit (Получение денег)');
      assertClose(reversalRow.amount, -100.00, 0.01, 'Citibank "AUTO LATE FEE REVERSAL" amount is -100.00');
    }

    // 2. LATE CHARGE FEE -> type: 'Расходы', amount: +100.00
    const feeRow = citiResult.rows.find(r => r.merchant.toUpperCase().includes('LATE CHARGE FEE'));
    if (feeRow) {
      assertEq(feeRow.type, 'Расходы', 'Citibank "LATE CHARGE FEE" parsed as expense (Расходы)');
      assertClose(feeRow.amount, 100.00, 0.01, 'Citibank "LATE CHARGE FEE" amount is +100.00');
    }

    // 3. MONEYSEND VALERIY IVANOV -> type: 'Получение денег', amount: -483.23
    const moneySendRow = citiResult.rows.find(r => r.merchant.toUpperCase().includes('MONEYSEND'));
    if (moneySendRow) {
      assertEq(moneySendRow.type, 'Получение денег', 'Citibank "MONEYSEND" parsed as payment/credit (Получение денег)');
      assertClose(moneySendRow.amount, -483.23, 0.01, 'Citibank "MONEYSEND" amount is -483.23');
    }
  }

  assertEq(citiResult.period && citiResult.period.from, '11.07.2026', 'Citibank period from is 11.07.2026');
  assertEq(citiResult.period && citiResult.period.to, '26.08.2026', 'Citibank period to is 26.08.2026');

  // 4. CRITICAL SIGN CONVENTION ASSERTION
  Logger.log('\n--- 3. CRITICAL SIGN CONVENTION CROSS-CHECK ---');
  const dbsPurchasePositive = (dbsResult.rows.length > 0 && dbsResult.rows[0].amount > 0);
  const citiPurchasePositive = (citiResult.rows.length > 0 && citiResult.rows[0].amount > 0);

  assertEq(
    dbsPurchasePositive && citiPurchasePositive,
    true,
    'CRITICAL: DBS purchase (+30.00) and Citibank purchase (+207.32) share identical positive sign convention'
  );

  Logger.log('\n=== test_parseStatement() Execution Finished ===');
}

/**
 * STAGE 3A TEST: Full DBS Statement Parser Verification (Exact 253 rows).
 * Reads `dbs_csv` from `_TestFixtures`.
 */
function test_parseStatement_full() {
  Logger.log('====================================================');
  Logger.log('    TEST: test_parseStatement_full() EXECUTION');
  Logger.log('====================================================\n');

  const dbsFullCsv = getFixture('dbs_csv');
  assertEq(Boolean(dbsFullCsv && dbsFullCsv.length > 0), true, 'dbs_csv fixture loaded');

  const dbsFullResult = parseStatement(dbsFullCsv);
  Logger.log(`DBS Full Parsed Account: "${dbsFullResult.account}" | Rows: ${dbsFullResult.rows.length} | Period: ${JSON.stringify(dbsFullResult.period)}`);

  assertEq(dbsFullResult.error === undefined || dbsFullResult.error === null, true, 'dbs_csv parsed without error');
  assertEq(dbsFullResult.account, 'DBS CC SGD', 'dbs_csv account resolved to "DBS CC SGD"');
  assertEq(dbsFullResult.rows.length, 253, `dbs_csv parsed exact 253 rows (got ${dbsFullResult.rows.length})`);

  // Print first 3 rows in full
  Logger.log('\n--- DBS Full First 3 Parsed Rows ---');
  Logger.log(JSON.stringify(dbsFullResult.rows.slice(0, 3), null, 2));

  // Find and assert Bill Payment row
  const billPaymentRow = dbsFullResult.rows.find(r => 
    r.merchant.toUpperCase().includes('BILL PAYMENT') ||
    r.merchant.toUpperCase().includes('DBS INTERNET/WIRELESS') ||
    Math.abs(r.amount - 12969.24) < 0.05 ||
    Math.abs(r.amount + 12969.24) < 0.05
  );

  if (billPaymentRow) {
    Logger.log(`Found DBS Full Bill Payment: "${billPaymentRow.merchant}" | Amount: ${billPaymentRow.amount} | Type: ${billPaymentRow.type}`);
    assertEq(billPaymentRow.type, 'Получение денег', 'DBS full S$12,969.24 BILL PAYMENT parsed as payment (type = Получение денег)');
    assertEq(billPaymentRow.amount < 0, true, 'DBS full S$12,969.24 BILL PAYMENT parsed with negative amount');
  } else {
    assertEq(false, true, 'DBS full statement must contain S$12,969.24 BILL PAYMENT row');
  }

  assertEq(Boolean(dbsFullResult.period && dbsFullResult.period.from && dbsFullResult.period.to), true, 'dbs_csv period bounds derived');

  Logger.log('\n=== test_parseStatement_full() Execution Finished ===');
}

// ============================================================================
// 4. STAGE 3B TESTS
// ============================================================================

/**
 * STAGE 3B TEST: Row Normalization Verification.
 * 
 * Asserts:
 * 1. Dates normalize to canonical DD.MM.YYYY.
 * 2. Amounts normalize to float numbers (handling "S$1 234,56", comma decimals, spaces).
 * 3. Real merchant strings normalize using the shared normaliseWhere() function from Phase 1 enricher.
 * 4. CRITICAL: Two different Grab transactions with different transaction IDs normalize to the SAME merchant string ("grab").
 * 5. Sign/direction resolved consistently across banks:
 *    - Purchases (DBS & Citibank) -> positive amounts, type = 'Расходы'.
 *    - Inflows / Refunds / Payments -> negative amounts, type = 'Получение денег'.
 * 6. Edge cases: European comma decimals, negative amounts, zero amount, empty rows.
 */
function test_normalizeRows() {
  Logger.log('====================================================');
  Logger.log('       TEST: test_normalizeRows() EXECUTION');
  Logger.log('====================================================\n');

  // Input dataset with real merchant strings, different formats, and edge cases
  const inputRows = [
    // 1. Real DBS Purchase
    { date: '11/08/2026', amount: '30.00', merchant: 'SIMPLYGO APP SINGAPORE SGP', type: 'Расходы', account: 'DBS CC SGD' },
    // 2. Real DBS Payment (Credit column)
    { date: '11.08.2026', amount: '-12,969.24', merchant: 'BILL PAYMENT - DBS INTERNET/WIRELESS', type: 'Получение денег', account: 'DBS CC SGD' },
    // 3. Real Citibank Purchase
    { date: '26/08/2026', amount: '207.32', merchant: 'SHELL TELOK BLANGAH', type: 'Расходы', account: 'Citibank CC' },
    // 4. Real Citibank Fee Reversal (Inflow)
    { date: '26.08.2026', amount: '-100.00', merchant: 'AUTO LATE FEE REVERSAL', type: 'Получение денег', account: 'Citibank CC' },
    // 5. Real Citibank Fee (Expense)
    { date: '26.08.2026', amount: '100.00', merchant: 'LATE CHARGE FEE', type: 'Расходы', account: 'Citibank CC' },
    // 6. Real Citibank MoneySend Inflow
    { date: '26.08.2026', amount: '-483.23', merchant: 'MONEYSEND VALERIY IVANOV', type: 'Получение денег', account: 'Citibank CC' },
    // 7. CRITICAL: Grab Transaction 1 with transaction ID
    { date: '15/08/2026', amount: '14.20', merchant: 'GRAB* A-1234567890', account: 'DBS CC SGD' },
    // 8. CRITICAL: Grab Transaction 2 with DIFFERENT transaction ID
    { date: '16/08/2026', amount: '22.40', merchant: 'GRAB* A-9876543210', account: 'DBS CC SGD' },
    // 9. Edge Case: European comma decimal with space thousands separator ("S$1 234,56") and NETS prefix
    { date: '2026-08-20', amount: 'S$1 234,56', merchant: 'NETS*FAIRPRICE', account: 'DBS CC SGD' },
    // 10. Edge Case: Zero amount row
    { date: '22.08.2026', amount: '0.00', merchant: 'PENDING AUTHORIZATION', account: 'Citibank CC' },
    // 11. Edge Case: Empty row (must be skipped)
    {},
    null
  ];

  const normalized = normalizeRows(inputRows);
  Logger.log(`Normalized rows count: ${normalized.length} (out of ${inputRows.length} input rows)`);

  // Assert empty rows filtered out (10 valid rows out of 12 items)
  assertEq(normalized.length, 10, 'Empty and null rows are properly filtered out');

  // --- 1. Real DBS Purchase Assertions ---
  Logger.log('\n--- 1. DBS Purchase Normalization ---');
  const dbsPurchase = normalized[0];
  assertEq(dbsPurchase.date, '11.08.2026', 'DBS purchase date normalized to DD.MM.YYYY (11.08.2026)');
  assertClose(dbsPurchase.amount, 30.00, 0.001, 'DBS purchase amount is +30.00');
  assertEq(dbsPurchase.merchant, 'simplygo app', 'DBS merchant normalized (country suffix stripped)');
  assertEq(dbsPurchase.type, 'Расходы', 'DBS purchase type is "Расходы"');

  // --- 2. Real DBS Payment Assertions ---
  Logger.log('\n--- 2. DBS Payment Normalization ---');
  const dbsPayment = normalized[1];
  assertClose(dbsPayment.amount, -12969.24, 0.01, 'DBS payment amount is -12969.24');
  assertEq(dbsPayment.type, 'Получение денег', 'DBS payment type is "Получение денег"');

  // --- 3. Real Citibank Purchase Assertions ---
  Logger.log('\n--- 3. Citibank Purchase Normalization ---');
  const citiPurchase = normalized[2];
  assertEq(citiPurchase.date, '26.08.2026', 'Citibank purchase date normalized to DD.MM.YYYY (26.08.2026)');
  assertClose(citiPurchase.amount, 207.32, 0.001, 'Citibank purchase amount is +207.32');
  assertEq(citiPurchase.merchant, 'shell telok blangah', 'Citibank merchant normalized');
  assertEq(citiPurchase.type, 'Расходы', 'Citibank purchase type is "Расходы"');

  // --- 4. Real Citibank Fee Reversal Assertions ---
  Logger.log('\n--- 4. Citibank Inflow Normalization ---');
  const citiReversal = normalized[3];
  assertClose(citiReversal.amount, -100.00, 0.001, 'Citibank reversal amount is -100.00');
  assertEq(citiReversal.type, 'Получение денег', 'Citibank reversal type is "Получение денег"');

  // --- 5. CRITICAL: Grab Merchant Normalization Consistency ---
  Logger.log('\n--- 5. CRITICAL: Grab Transaction Normalization Consistency ---');
  const grabRow1 = normalized[6]; // GRAB* A-1234567890
  const grabRow2 = normalized[7]; // GRAB* A-9876543210

  Logger.log(`Grab Row 1: raw="${grabRow1.raw_merchant}" -> norm="${grabRow1.merchant}"`);
  Logger.log(`Grab Row 2: raw="${grabRow2.raw_merchant}" -> norm="${grabRow2.merchant}"`);

  assertEq(
    grabRow1.merchant === grabRow2.merchant,
    true,
    'CRITICAL: Two different Grab transactions with different transaction IDs normalize to the EXACT SAME merchant string'
  );
  assertEq(grabRow1.merchant, 'grab', 'Grab normalized merchant string is "grab"');

  // Check ledger merchant equivalence
  const ledgerGrabWhere = normaliseWhere('Grab');
  assertEq(
    grabRow1.merchant === ledgerGrabWhere,
    true,
    'CRITICAL: Statement Grab merchant matches ledger merchant ("Grab" -> "grab")'
  );

  // --- 6. Edge Case: European Comma Decimal & NETS Prefix ---
  Logger.log('\n--- 6. Edge Case: European Comma Decimal & Prefix Stripping ---');
  const euRow = normalized[8]; // S$1 234,56 | NETS*FAIRPRICE | 2026-08-20
  assertEq(euRow.date, '20.08.2026', 'ISO date "2026-08-20" normalized to "20.08.2026"');
  assertClose(euRow.amount, 1234.56, 0.01, 'Amount "S$1 234,56" normalized to 1234.56');
  assertEq(euRow.merchant, 'fairprice', 'Merchant "NETS*FAIRPRICE" prefix stripped to "fairprice"');
  assertEq(euRow.type, 'Расходы', 'European expense row type is "Расходы"');

  // --- 7. Edge Case: Zero Amount ---
  Logger.log('\n--- 7. Edge Case: Zero Amount ---');
  const zeroRow = normalized[9];
  assertClose(zeroRow.amount, 0.00, 0.001, 'Zero amount row normalized to 0.00');

  // --- 8. Cross-Bank Positive Sign Invariant ---
  Logger.log('\n--- 8. Cross-Bank Positive Sign Invariant ---');
  assertEq(
    (dbsPurchase.amount > 0) && (citiPurchase.amount > 0),
    true,
    'CRITICAL: DBS purchase (+30.00) and Citibank purchase (+207.32) both normalize to POSITIVE amounts'
  );

  assertEq(
    (dbsPayment.amount < 0) && (citiReversal.amount < 0),
    true,
    'CRITICAL: DBS payment (-12969.24) and Citibank reversal (-100.00) both normalize to NEGATIVE amounts'
  );

  Logger.log('\n=== test_normalizeRows() Execution Finished ===');
}

// ============================================================================
// 5. STAGE 3C TESTS
// ============================================================================

/**
 * STAGE 3C TEST: Pure Matching Engine Verification.
 * 
 * Asserts:
 * 1. Exact dedupe_key match -> matched (Fast Path)
 * 2. Match 4 days off (real DBS posting drift: "03 Aug 2026" posted "07 Aug 2026") -> matched (Fuzzy)
 * 3. NETS*FAIRPRICE vs Fair Price -> matched (Exact dedupe_key)
 * 3B. FAIRPRICE FINEST vs Fair Price -> matched on FAST PATH (Exact dedupe_key)
 * 4. A genuine miss -> missing
 * 5. Two same-amount same-day rows -> ambiguous (never guesses)
 * 6. Duplicate amounts in statement (with matching ledger entries) -> matched 1-to-1
 * 
 * CRITICAL ASSERTION:
 * No already-logged row may ever land in 'missing'.
 */
function test_findMissing() {
  Logger.log('====================================================');
  Logger.log('       TEST: test_findMissing() EXECUTION');
  Logger.log('====================================================\n');

  // --------------------------------------------------------------------------
  // BRANCH 1: Exact dedupe_key match
  // --------------------------------------------------------------------------
  Logger.log('--- Branch 1: Exact dedupe_key match ---');
  const b1_statement = [
    { date: '11.08.2026', amount: 30.00, merchant: 'SIMPLYGO APP', account: 'DBS CC SGD' }
  ];
  const b1_ledger = [
    { date: '11.08.2026', amount: 30.00, where: 'SIMPLYGO APP', account: 'DBS CC SGD' }
  ];
  const res1 = findMissing(b1_statement, b1_ledger);
  assertEq(res1.matched.length, 1, 'Branch 1: Exactly 1 row in matched');
  assertEq(res1.missing.length, 0, 'Branch 1: 0 rows in missing');
  assertEq(res1.ambiguous.length, 0, 'Branch 1: 0 rows in ambiguous');
  assertEq(res1.matched[0].match_type, 'exact', 'Branch 1: Match type is exact');

  // --------------------------------------------------------------------------
  // BRANCH 2: Match 4 days off (real DBS posting drift: 03 Aug posted 07 Aug)
  // --------------------------------------------------------------------------
  Logger.log('\n--- Branch 2: Match 4 days off (DBS posting drift) ---');
  const b2_statement = [
    { date: '07.08.2026', amount: 45.50, merchant: 'STARBUCKS', account: 'DBS CC SGD' }
  ];
  const b2_ledger = [
    { date: '03.08.2026', amount: 45.50, where: 'Starbucks', account: 'DBS CC SGD' }
  ];
  const res2 = findMissing(b2_statement, b2_ledger);
  assertEq(res2.matched.length, 1, 'Branch 2: Exactly 1 row in matched with 4 days drift');
  assertEq(res2.missing.length, 0, 'Branch 2: 0 rows in missing');
  assertEq(res2.ambiguous.length, 0, 'Branch 2: 0 rows in ambiguous');
  assertEq(res2.matched[0].match_type, 'canonical', 'Branch 2: Match type is canonical');

  // --------------------------------------------------------------------------
  // BRANCH 3: NETS*FAIRPRICE vs Fair Price
  // --------------------------------------------------------------------------
  Logger.log('\n--- Branch 3: NETS*FAIRPRICE vs Fair Price ---');
  const b3_statement = [
    { date: '12.08.2026', amount: 82.35, merchant: 'NETS*FAIRPRICE', account: 'DBS CC SGD' }
  ];
  const b3_ledger = [
    { date: '12.08.2026', amount: 82.35, where: 'Fair Price', account: 'DBS CC SGD' }
  ];
  const res3 = findMissing(b3_statement, b3_ledger);
  assertEq(res3.matched.length, 1, 'Branch 3: Exactly 1 row in matched for NETS*FAIRPRICE vs Fair Price');
  assertEq(res3.missing.length, 0, 'Branch 3: 0 rows in missing');
  assertEq(res3.ambiguous.length, 0, 'Branch 3: 0 rows in ambiguous');
  assertEq(res3.matched[0].match_type, 'exact', 'Branch 3: Match type is exact');

  // --------------------------------------------------------------------------
  // BRANCH 3B: FAIRPRICE FINEST vs Fair Price (Fast-path exact dedupe_key hit)
  // --------------------------------------------------------------------------
  Logger.log('\n--- Branch 3B: FAIRPRICE FINEST vs Fair Price (Fast-path exact dedupe_key hit) ---');
  const b3b_statement = [
    { date: '14.08.2026', amount: 64.20, merchant: 'FAIRPRICE FINEST', account: 'DBS CC SGD' }
  ];
  const b3b_ledger = [
    { date: '14.08.2026', amount: 64.20, where: 'Fair Price', account: 'DBS CC SGD' }
  ];
  const res3b = findMissing(b3b_statement, b3b_ledger);
  assertEq(res3b.matched.length, 1, 'Branch 3B: Exactly 1 row in matched for FAIRPRICE FINEST vs Fair Price');
  assertEq(res3b.missing.length, 0, 'Branch 3B: 0 rows in missing');
  assertEq(res3b.ambiguous.length, 0, 'Branch 3B: 0 rows in ambiguous');
  assertEq(res3b.matched[0].match_type, 'exact', 'Branch 3B: FAIRPRICE FINEST matches Fair Price on FAST PATH (exact dedupe_key)');

  // --------------------------------------------------------------------------
  // BRANCH 4: A genuine miss
  // --------------------------------------------------------------------------
  Logger.log('\n--- Branch 4: Genuine miss ---');
  const b4_statement = [
    { date: '18.08.2026', amount: 99.90, merchant: 'UNIQLO ION ORCHARD', account: 'DBS CC SGD' }
  ];
  const b4_ledger = [
    { date: '11.08.2026', amount: 30.00, where: 'SIMPLYGO APP', account: 'DBS CC SGD' },
    { date: '18.08.2026', amount: 25.00, where: 'UNIQLO ION ORCHARD', account: 'DBS CC SGD' }
  ];
  const res4 = findMissing(b4_statement, b4_ledger);
  assertEq(res4.matched.length, 0, 'Branch 4: 0 rows in matched');
  assertEq(res4.missing.length, 1, 'Branch 4: Exactly 1 row in missing');
  assertEq(res4.ambiguous.length, 0, 'Branch 4: 0 rows in ambiguous');

  // --------------------------------------------------------------------------
  // BRANCH 5: Two same-amount same-day rows (ambiguous)
  // --------------------------------------------------------------------------
  Logger.log('\n--- Branch 5: Two same-amount same-day rows (ambiguous) ---');
  const b5_statement = [
    { date: '15.08.2026', amount: 50.00, merchant: 'RESTAURANT A', account: 'DBS CC SGD' }
  ];
  const b5_ledger = [
    { date: '15.08.2026', amount: 50.00, where: 'Restaurant A', id: 'L1', account: 'DBS CC SGD' },
    { date: '15.08.2026', amount: 50.00, where: 'Restaurant A', id: 'L2', account: 'DBS CC SGD' }
  ];
  const res5 = findMissing(b5_statement, b5_ledger);
  assertEq(res5.matched.length, 0, 'Branch 5: 0 rows in matched (multiple candidates, no guess)');
  assertEq(res5.missing.length, 0, 'Branch 5: 0 rows in missing (not missing, has candidates)');
  assertEq(res5.ambiguous.length, 1, 'Branch 5: Exactly 1 row in ambiguous');

  // --------------------------------------------------------------------------
  // BRANCH 6: Duplicate amounts in the statement (1-to-1 matching)
  // --------------------------------------------------------------------------
  Logger.log('\n--- Branch 6: Duplicate amounts in the statement ---');
  const b6_statement = [
    { date: '20.08.2026', amount: 15.00, merchant: 'TOAST BOX', account: 'DBS CC SGD', id: 'S1' },
    { date: '20.08.2026', amount: 15.00, merchant: 'TOAST BOX', account: 'DBS CC SGD', id: 'S2' }
  ];
  const b6_ledger = [
    { date: '20.08.2026', amount: 15.00, where: 'Toast Box', account: 'DBS CC SGD', id: 'L1' },
    { date: '20.08.2026', amount: 15.00, where: 'Toast Box', account: 'DBS CC SGD', id: 'L2' }
  ];
  const res6 = findMissing(b6_statement, b6_ledger);
  assertEq(res6.matched.length, 2, 'Branch 6: Both duplicate amount statement rows matched 1-to-1');
  assertEq(res6.missing.length, 0, 'Branch 6: 0 rows in missing');
  assertEq(res6.ambiguous.length, 0, 'Branch 6: 0 rows in ambiguous');

  // --------------------------------------------------------------------------
  // COMBINED BATCH TEST: All branches evaluated together
  // --------------------------------------------------------------------------
  Logger.log('\n--- Combined Batch Test: All Branches Together ---');
  const combinedStatement = [
    { date: '11.08.2026', amount: 30.00, merchant: 'SIMPLYGO APP', account: 'DBS CC SGD', id: 'S_exact' },
    { date: '07.08.2026', amount: 45.50, merchant: 'STARBUCKS', account: 'DBS CC SGD', id: 'S_drift' },
    { date: '12.08.2026', amount: 82.35, merchant: 'NETS*FAIRPRICE', account: 'DBS CC SGD', id: 'S_fairprice' },
    { date: '14.08.2026', amount: 64.20, merchant: 'FAIRPRICE FINEST', account: 'DBS CC SGD', id: 'S_finest' },
    { date: '18.08.2026', amount: 99.90, merchant: 'UNIQLO ION ORCHARD', account: 'DBS CC SGD', id: 'S_miss' },
    { date: '15.08.2026', amount: 50.00, merchant: 'RESTAURANT A', account: 'DBS CC SGD', id: 'S_ambig' },
    { date: '20.08.2026', amount: 15.00, merchant: 'TOAST BOX', account: 'DBS CC SGD', id: 'S_dup1' },
    { date: '20.08.2026', amount: 15.00, merchant: 'TOAST BOX', account: 'DBS CC SGD', id: 'S_dup2' }
  ];

  const combinedLedger = [
    { date: '11.08.2026', amount: 30.00, where: 'SIMPLYGO APP', account: 'DBS CC SGD', id: 'L_exact' },
    { date: '03.08.2026', amount: 45.50, where: 'Starbucks', account: 'DBS CC SGD', id: 'L_drift' }, // 4 days drift
    { date: '12.08.2026', amount: 82.35, where: 'Fair Price', account: 'DBS CC SGD', id: 'L_fairprice' },
    { date: '14.08.2026', amount: 64.20, where: 'Fair Price', account: 'DBS CC SGD', id: 'L_finest' },
    { date: '15.08.2026', amount: 50.00, where: 'Restaurant A', account: 'DBS CC SGD', id: 'L_ambig1' }, // 2 ledger candidates
    { date: '15.08.2026', amount: 50.00, where: 'Restaurant A', account: 'DBS CC SGD', id: 'L_ambig2' },
    { date: '20.08.2026', amount: 15.00, where: 'Toast Box', account: 'DBS CC SGD', id: 'L_dup1' },
    { date: '20.08.2026', amount: 15.00, where: 'Toast Box', account: 'DBS CC SGD', id: 'L_dup2' },
    { date: '25.08.2026', amount: 120.00, where: 'Unrelated Ledger Item', account: 'DBS CC SGD', id: 'L_unrelated' }
  ];

  const combinedRes = findMissing(combinedStatement, combinedLedger);
  Logger.log(`Combined Results -> Matched: ${combinedRes.matched.length}, Missing: ${combinedRes.missing.length}, Ambiguous: ${combinedRes.ambiguous.length}`);

  assertEq(combinedRes.matched.length, 6, 'Combined: Exactly 6 matched rows (exact, drift, fairprice, finest, 2x duplicate amounts)');
  assertEq(combinedRes.missing.length, 1, 'Combined: Exactly 1 missing row (Uniqlo)');
  assertEq(combinedRes.ambiguous.length, 1, 'Combined: Exactly 1 ambiguous row (Restaurant A)');

  // CRITICAL INTEGRITY CHECK:
  // Assert that no already-logged row ever lands in 'missing'.
  const missingIds = combinedRes.missing.map(m => m.id || m.merchant);
  assertEq(missingIds.includes('S_exact'), false, 'CRITICAL: Exact match never lands in missing');
  assertEq(missingIds.includes('S_drift'), false, 'CRITICAL: 4-day drift match never lands in missing');
  assertEq(missingIds.includes('S_fairprice'), false, 'CRITICAL: Fair Price match never lands in missing');
  assertEq(missingIds.includes('S_finest'), false, 'CRITICAL: FAIRPRICE FINEST match never lands in missing');
  assertEq(missingIds.includes('S_dup1'), false, 'CRITICAL: Duplicate row 1 never lands in missing');
  assertEq(missingIds.includes('S_dup2'), false, 'CRITICAL: Duplicate row 2 never lands in missing');
  assertEq(missingIds.includes('S_ambig'), false, 'CRITICAL: Ambiguous row never lands in missing');
  assertEq(missingIds[0], 'S_miss', 'CRITICAL: Only the genuine miss lands in missing');

  Logger.log('\n=== test_findMissing() Execution Finished ===');
}

// ============================================================================
// 6. STAGE 3D TESTS
// ============================================================================

function test_feeReversalPairing() {
  const fee = { id: 'fee', date: '26.08.2026', amount: 100, type: 'Расходы',
    merchant: 'LATE CHARGE FEE', account: 'Citibank CC', currency: 'SGD', card_last4: '4320', cardholder: 'Val' };
  const credit = { ...fee, id: 'credit', amount: -100, type: 'Получение денег', merchant: 'AUTO LATE FEE REVERSAL' };
  const remains = (rows, label) => {
    for (const order of [rows, rows.slice().reverse()]) {
      const result = filterNonSpend(order);
      assertEq(result.proposals.map(row => row.id).sort(), rows.map(row => row.id).sort(), label + ': all occurrences remain reviewable');
      assertEq(result.excluded.length, 0, label + ': no false net-zero exclusion');
    }
  };
  const paired = (rows, label) => {
    for (const order of [rows, rows.slice().reverse()]) {
      const before = JSON.stringify(order);
      const result = filterNonSpend(order);
      assertEq(result.proposals.length, 0, label + ': corroborated pair cancels');
      assertEq(result.excluded.map(row => row.id).sort(), rows.map(row => row.id).sort(), label + ': both exact occurrences excluded');
      assertEq(result.excluded.every(row => row.reason === 'Fee and reversal, net zero'), true, label + ': net-zero reasons');
      assertEq(JSON.stringify(order), before, label + ': input is unchanged');
    }
  };

  remains([{ ...fee, date: '05.08.2026', merchant: 'SCHOOL TUITION FEE', account: 'DBS CC SGD' },
    { ...credit, date: '25.08.2026', account: 'DBS CC SGD' }], 'Reported tuition/late-fee counterexample');
  remains([{ ...fee, merchant: 'SCHOOL TUITION FEE' }, credit], 'Different fee identity on the same day');
  remains([fee, { ...credit, amount: 100 }], 'Same signed amounts');
  remains([fee, { ...credit, amount: -99.99 }], 'Amounts differ by one cent');
  remains([fee, { ...credit, type: 'Расходы' }], 'Contradictory credit type');
  remains([fee, { ...credit, account: 'DBS CC SGD' }], 'Different accounts');
  remains([{ ...fee, account: '' }, { ...credit, account: '' }], 'Unknown account');
  remains([fee, { ...credit, currency: 'USD' }], 'Different currencies');
  remains([fee, { ...credit, card_last4: '7509', cardholder: 'Rita' }], 'Different cards');
  remains([fee, { ...credit, cardholder: 'Rita' }], 'Conflicting named cardholders');
  remains([fee, { ...credit, card_last4: '' }], 'Incomplete card identity');
  remains([fee, { ...credit, date: '25.08.2026' }], 'Reversal precedes the fee');
  remains([fee, { ...credit, date: '03.09.2026' }], 'Reversal more than seven days later');
  remains([fee, { ...credit, date: '' }], 'Missing reversal date');
  remains([fee, { ...credit, date: '31.02.2026' }], 'Invalid reversal date');
  remains([fee, { ...fee, id: 'second-fee' }, credit], 'Two fees compete for one reversal');
  remains([fee, credit, { ...credit, id: 'second-credit' }], 'Two reversals compete for one fee');
  remains([{ ...fee, merchant: 'FEE' }, { ...credit, merchant: 'FEE REVERSAL' }], 'Unspecified fee identity');
  remains([{ ...fee, merchant: 'COFFEE' }, { ...credit, merchant: 'COFFEE REVERSAL' }], 'Fee substring inside a merchant name');
  remains([credit], 'Standalone fee reversal');
  remains([{ ...credit, merchant: 'ANNUAL FEE WAIVER' }], 'Standalone fee waiver');

  paired([fee, credit], 'Known Citi late-fee pair');
  paired([fee, { ...credit, date: '02.09.2026' }], 'Seven-day boundary across month end');
  paired([{ ...fee, merchant: 'ANNUAL FEE' }, { ...credit, merchant: 'AUTO ANNUAL FEE WAIVER' }], 'Exact annual-fee waiver');
  paired([fee, { ...credit, account: '  citibank cc  ', currency: 'sgd', cardholder: 'val' }], 'Account/currency/holder formatting');
  const normalized = normalizeRows([fee, credit]);
  normalized.forEach((row, index) => { row.id = index === 0 ? 'fee' : 'credit'; });
  paired(normalized, 'Normalized statement rows retain their original fee identity');
}

/**
 * STAGE 3D TEST: Non-Spend Line Filtering Verification.
 * 
 * Verifies that filterNonSpend() follows Option B (Smart Dual-Sided) & Choice 1:
 * 1. Excludes credit card repayment: DBS "BILL PAYMENT - DBS INTERNET/WIRELESS" S$12,969.24 (Credit) -> 'CC payoff'
 * 2. Excludes refund / transit adjustment: DBS "SPL AUTO TOPUP (ABT/RE)" S$20.19 (Credit) -> 'Refund'
 * 3. Excludes transfer to self: Citi "MONEYSEND VALERIY IVANOV" +483.23 -> 'Transfer to self'
 * 4. Excludes net-zero fee pair: Citi "LATE CHARGE FEE" +100.00 & "AUTO LATE FEE REVERSAL" -100.00 -> 'Fee and reversal, net zero'
 * 5. Passes through genuine expenses: SIMPLYGO APP S$30.00 and SHELL TELOK BLANGAH S$207.32 -> proposals
 * 6. Passes through trap cases (Choice 1 Guard Rule):
 *    - "BILL PAYMENT - SP SERVICES" +120.00 Расходы -> proposals
 *    - "GIRO CAFE" +18.50 Расходы -> proposals
 *    - "AUTOPAY - TOWN COUNCIL" +95.00 Расходы -> proposals
 * 7. Passes through legitimate external credit (Option B):
 *    - "ALLIANZ REIMBURSEMENT" -270.00 Получение денег -> proposals
 * 8. Asserts exactly 6 proposals survive and exactly 5 non-spend lines are excluded.
 * 9. Choice 1 Invariant: Asserts that no row with amount > 0 and type === 'Расходы' is ever excluded UNLESS reason is 'Fee and reversal, net zero'.
 * 10. Asserts standalone unreversed fee survives as proposal (bias towards proposing).
 */
function test_filterNonSpend() {
  Logger.log('====================================================');
  Logger.log('       TEST: test_filterNonSpend() EXECUTION');
  Logger.log('====================================================\n');

  // Input missing rows constructed from real statement fixtures and trap cases
  const inputMissing = [
    // 1. DBS CC payoff (Payment)
    {
      date: '11.08.2026',
      amount: -12969.24,
      raw_amount: '12969.24',
      merchant: 'bill payment - dbs internet/wireless',
      raw_merchant: 'BILL PAYMENT - DBS INTERNET/WIRELESS',
      type: 'Получение денег',
      transaction_type: 'PAYMENT',
      account: 'DBS CC SGD'
    },
    // 2. DBS Refund (Credit)
    {
      date: '12.08.2026',
      amount: -20.19,
      raw_amount: '20.19',
      merchant: 'spl auto topup (abt/re)',
      raw_merchant: 'SPL AUTO TOPUP (ABT/RE)',
      type: 'Получение денег',
      transaction_type: 'OTHERS',
      account: 'DBS CC SGD'
    },
    // 3. Citi Transfer to self (Moneysend)
    {
      date: '26.08.2026',
      amount: -483.23,
      raw_amount: '+483.23',
      merchant: 'moneysend valeriy ivanov',
      raw_merchant: 'MONEYSEND VALERIY IVANOV',
      type: 'Получение денег',
      account: 'Citibank CC'
    },
    // 4. Citi Fee (Late Charge)
    {
      date: '26.08.2026',
      amount: 100.00,
      raw_amount: '-100.00',
      merchant: 'late charge fee',
      raw_merchant: 'LATE CHARGE FEE',
      type: 'Расходы',
      account: 'Citibank CC'
    },
    // 5. Citi Reversal (Late Fee Reversal)
    {
      date: '26.08.2026',
      amount: -100.00,
      raw_amount: '+100.00',
      merchant: 'auto late fee reversal',
      raw_merchant: 'AUTO LATE FEE REVERSAL',
      type: 'Получение денег',
      account: 'Citibank CC'
    },
    // 6. Genuine Expense 1 (DBS purchase)
    {
      date: '11.08.2026',
      amount: 30.00,
      raw_amount: '30.00',
      merchant: 'simplygo app',
      raw_merchant: 'SIMPLYGO APP SINGAPORE SGP',
      type: 'Расходы',
      transaction_type: 'PURCHASE',
      account: 'DBS CC SGD'
    },
    // 7. Genuine Expense 2 (Citibank purchase)
    {
      date: '26.08.2026',
      amount: 207.32,
      raw_amount: '-207.32',
      merchant: 'shell telok blangah',
      raw_merchant: 'SHELL TELOK BLANGAH',
      type: 'Расходы',
      account: 'Citibank CC'
    },
    // 8. Trap Case 1: Genuine utility bill with "BILL PAYMENT" in merchant description
    {
      date: '15.08.2026',
      amount: 120.00,
      raw_amount: '120.00',
      merchant: 'bill payment - sp services',
      raw_merchant: 'BILL PAYMENT - SP SERVICES',
      type: 'Расходы',
      transaction_type: 'PURCHASE',
      account: 'DBS CC SGD'
    },
    // 9. Trap Case 2: Genuine dining expense with "GIRO" in merchant name
    {
      date: '16.08.2026',
      amount: 18.50,
      raw_amount: '18.50',
      merchant: 'giro cafe',
      raw_merchant: 'GIRO CAFE',
      type: 'Расходы',
      transaction_type: 'PURCHASE',
      account: 'DBS CC SGD'
    },
    // 10. Trap Case 3: Genuine municipal bill with "AUTOPAY" in merchant description
    {
      date: '17.08.2026',
      amount: 95.00,
      raw_amount: '95.00',
      merchant: 'autopay - town council',
      raw_merchant: 'AUTOPAY - TOWN COUNCIL',
      type: 'Расходы',
      transaction_type: 'PURCHASE',
      account: 'DBS CC SGD'
    },
    // 11. Option B Credit: Genuine insurance reimbursement
    {
      date: '18.08.2026',
      amount: -270.00,
      raw_amount: '-270.00',
      merchant: 'allianz reimbursement',
      raw_merchant: 'ALLIANZ REIMBURSEMENT',
      type: 'Получение денег',
      account: 'DBS CC SGD'
    }
  ];

  const result = filterNonSpend(inputMissing);
  Logger.log(`filterNonSpend Results -> Proposals: ${result.proposals.length}, Excluded: ${result.excluded.length}`);

  // 1. Assert proposal and exclusion counts
  assertEq(result.proposals.length, 6, 'Option B: Exactly 6 proposals survive (5 genuine expenses + 1 legitimate credit)');
  assertEq(result.excluded.length, 5, 'Option B: Exactly 5 non-spend lines are excluded');

  // 2. Assert proposals content
  const proposalMerchants = result.proposals.map(p => (p.raw_merchant || p.merchant || '').toUpperCase());
  assertEq(proposalMerchants.some(m => m.includes('SIMPLYGO')), true, 'Proposal 1: SIMPLYGO APP survived');
  assertEq(proposalMerchants.some(m => m.includes('SHELL')), true, 'Proposal 2: SHELL TELOK BLANGAH survived');
  assertEq(proposalMerchants.some(m => m.includes('SP SERVICES')), true, 'Proposal 3 (Trap case): BILL PAYMENT - SP SERVICES survived');
  assertEq(proposalMerchants.some(m => m.includes('GIRO CAFE')), true, 'Proposal 4 (Trap case): GIRO CAFE survived');
  assertEq(proposalMerchants.some(m => m.includes('TOWN COUNCIL')), true, 'Proposal 5 (Trap case): AUTOPAY - TOWN COUNCIL survived');
  assertEq(proposalMerchants.some(m => m.includes('ALLIANZ')), true, 'Proposal 6 (Option B credit): ALLIANZ REIMBURSEMENT survived');

  // Assert Option B credit details
  const allianz = result.proposals.find(p => (p.raw_merchant || p.merchant || '').toUpperCase().includes('ALLIANZ'));
  assertEq(Boolean(allianz), true, 'ALLIANZ REIMBURSEMENT found in proposals');
  assertEq(allianz.type, 'Получение денег', 'Option B: ALLIANZ credit type is "Получение денег"');
  assertEq(allianz.amount < 0, true, 'Option B: ALLIANZ credit amount is negative (-270.00)');

  // 3. Assert each exclusion carries the correct reason
  const billPay = result.excluded.find(r => (r.raw_merchant || r.merchant || '').toUpperCase().includes('BILL PAYMENT - DBS'));
  assertEq(Boolean(billPay), true, 'DBS Bill payment found in excluded');
  assertEq(billPay.reason, 'CC payoff', 'DBS Bill payment exclusion reason is "CC payoff"');

  const refund = result.excluded.find(r => (r.raw_merchant || r.merchant || '').toUpperCase().includes('SPL AUTO TOPUP'));
  assertEq(Boolean(refund), true, 'DBS SPL AUTO TOPUP found in excluded');
  assertEq(refund.reason, 'Refund', 'DBS SPL AUTO TOPUP exclusion reason is "Refund"');

  const transfer = result.excluded.find(r => (r.raw_merchant || r.merchant || '').toUpperCase().includes('MONEYSEND'));
  assertEq(Boolean(transfer), true, 'Citi MONEYSEND found in excluded');
  assertEq(transfer.reason, 'Transfer to self', 'Citi MONEYSEND exclusion reason is "Transfer to self"');

  const fee = result.excluded.find(r => (r.raw_merchant || r.merchant || '').toUpperCase().includes('LATE CHARGE FEE'));
  assertEq(Boolean(fee), true, 'Citi LATE CHARGE FEE found in excluded');
  assertEq(fee.reason, 'Fee and reversal, net zero', 'Citi LATE CHARGE FEE exclusion reason is "Fee and reversal, net zero"');

  const reversal = result.excluded.find(r => (r.raw_merchant || r.merchant || '').toUpperCase().includes('AUTO LATE FEE REVERSAL'));
  assertEq(Boolean(reversal), true, 'Citi AUTO LATE FEE REVERSAL found in excluded');
  assertEq(reversal.reason, 'Fee and reversal, net zero', 'Citi AUTO LATE FEE REVERSAL exclusion reason is "Fee and reversal, net zero"');

  // 4. CHOICE 1 INVARIANT ASSERTION:
  // No row with amount > 0 AND type === 'Расходы' may be excluded, UNLESS its reason is 'Fee and reversal, net zero'.
  Logger.log('\n--- Choice 1 Invariant: No positive Расходы row excluded unless net-zero fee pair ---');
  const invalidExcludedExpenses = result.excluded.filter(r => {
    const amt = Number(r.amount !== undefined ? r.amount : r.raw_amount) || 0;
    const type = String(r.type || '');
    return amt > 0 && type === 'Расходы' && r.reason !== 'Fee and reversal, net zero';
  });
  assertEq(invalidExcludedExpenses.length, 0, 'Choice 1 Invariant: No positive Расходы row is ever excluded unless part of net-zero fee pair');

  // 5. CRITICAL: Bias towards proposing test
  // An unreversed fee (e.g. ANNUAL FEE S$192.60 without reversal) MUST survive as proposal
  Logger.log('\n--- Bias towards proposing: Standalone unreversed fee ---');
  const standaloneFeeInput = [
    {
      date: '15.08.2026',
      amount: 192.60,
      merchant: 'annual fee',
      raw_merchant: 'ANNUAL FEE',
      type: 'Расходы',
      account: 'DBS CC SGD'
    }
  ];
  const standaloneFeeResult = filterNonSpend(standaloneFeeInput);
  assertEq(standaloneFeeResult.proposals.length, 1, 'CRITICAL: Standalone unreversed fee survives as proposal (bias towards proposing)');
  assertEq(standaloneFeeResult.excluded.length, 0, 'Standalone unreversed fee is not silently dropped');

  const invalidStandaloneExcluded = standaloneFeeResult.excluded.filter(r => {
    const amt = Number(r.amount !== undefined ? r.amount : r.raw_amount) || 0;
    const type = String(r.type || '');
    return amt > 0 && type === 'Расходы' && r.reason !== 'Fee and reversal, net zero';
  });
  assertEq(invalidStandaloneExcluded.length, 0, 'Choice 1 Invariant holds for standalone fee');

  // 6. Empty / null input safety
  const emptyResult = filterNonSpend([]);
  assertEq(emptyResult.proposals.length, 0, 'Empty input yields 0 proposals');
  assertEq(emptyResult.excluded.length, 0, 'Empty input yields 0 excluded');

  Logger.log('\n=== test_filterNonSpend() Execution Finished ===');
}

// ============================================================================
// 7. STAGE 3E TESTS
// ============================================================================

/**
 * STAGE 3E TEST: Staging Tab (_Reconcile) Generation & Ledger Invariant.
 * 
 * Verifies that Stage 3E:
 * 1. Creates/populates _Reconcile tab with exact 11 required columns:
 *    ✓ · date · account · Тип · amount · merchant · proposed category · proposed bucket · confidence · source_row · status
 * 2. Option B Dual-Sided:
 *    - Genuine expenses staged with status = 'proposed', Тип = 'Расходы', positive amount.
 *    - Legitimate external credits staged with status = 'proposed', Тип = 'Получение денег', negative amount, visually grouped.
 * 3. Ambiguous rows from findMissing are surfaced with status = 'ambiguous' and candidate ledger rows listed in source_row.
 * 4. Pre-categorisation via enricher assigns valid category and 50/30/20 bucket.
 * 5. Column 1 receives interactive checkboxes.
 * 6. End-to-end pipeline (3A -> 3E) executes against real fixture on SANDBOX sheet.
 * 7. CRITICAL INVARIANT:
 *    Transactions.getLastRow() is IDENTICAL before and after execution (Transactions is 100% untouched).
 */
function test_stageProposals() {
  Logger.log('====================================================');
  Logger.log('       TEST: test_stageProposals() EXECUTION');
  Logger.log('====================================================\n');

  const ss = (typeof getTargetSpreadsheet === 'function') ? getTargetSpreadsheet(true) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('test_stageProposals: No target spreadsheet available.');
  }

  const transSheet = ss.getSheetByName('Transactions');
  if (!transSheet) {
    throw new Error('test_stageProposals: Transactions sheet not found in target spreadsheet.');
  }

  // Record initial Transactions row count to prove it remains strictly untouched
  const transLastRowBefore = transSheet.getLastRow();
  Logger.log(`Initial Transactions.getLastRow(): ${transLastRowBefore}`);

  // --------------------------------------------------------------------------
  // PART 1: Controlled Staging Verification (Dual-Sided & Ambiguous)
  // --------------------------------------------------------------------------
  Logger.log('\n--- Part 1: Controlled Staging Verification (Dual-Sided & Ambiguous) ---');

  const mockProposals = [
    // 1. Genuine expense proposal
    {
      date: '11.08.2026',
      amount: 30.00,
      raw_amount: '30.00',
      merchant: 'simplygo app',
      raw_merchant: 'SIMPLYGO APP SINGAPORE SGP',
      type: 'Расходы',
      transaction_type: 'PURCHASE',
      account: 'DBS CC SGD'
    },
    // 2. Option B legitimate external credit proposal
    {
      date: '18.08.2026',
      amount: -270.00,
      raw_amount: '-270.00',
      merchant: 'allianz reimbursement',
      raw_merchant: 'ALLIANZ REIMBURSEMENT',
      type: 'Получение денег',
      account: 'DBS CC SGD'
    }
  ];

  const mockAmbiguous = [
    // Ambiguous row with multiple candidate ledger rows
    {
      date: '15.08.2026',
      amount: 50.00,
      raw_amount: '50.00',
      merchant: 'restaurant a',
      raw_merchant: 'RESTAURANT A',
      type: 'Расходы',
      account: 'DBS CC SGD',
      candidates: [
        { row_index: 42, date: '15.08.2026', where: 'Restaurant A', amount: 50.00 },
        { row_index: 45, date: '15.08.2026', where: 'Restaurant A', amount: 50.00 }
      ]
    }
  ];

  const stageResult = stageProposals(mockProposals, mockAmbiguous, ss);
  assertEq(stageResult.stagedCount, 3, 'Part 1: Exactly 3 rows staged (1 expense, 1 credit, 1 ambiguous)');
  assertEq(stageResult.proposalsCount, 2, 'Part 1: Proposals count is 2');
  assertEq(stageResult.ambiguousCount, 1, 'Part 1: Ambiguous count is 1');

  // Verify staging sheet existence
  const stagingSheet = ss.getSheetByName(RECONCILE_STAGING_TAB_NAME);
  assertEq(Boolean(stagingSheet), true, `Staging sheet "${RECONCILE_STAGING_TAB_NAME}" exists`);

  const stagedLastRow = stagingSheet.getLastRow();
  assertEq(stagedLastRow, 4, 'Staging sheet has exactly 4 rows (1 header + 3 data rows)');

  // A. Verify headers
  const headerRow = stagingSheet.getRange(1, 1, 1, 12).getValues()[0];
  const expectedHeaders = [
    '✓', 'date', 'account', 'Cardholder', 'Тип', 'amount', 'merchant',
    'proposed category', 'proposed bucket', 'confidence', 'source_row', 'status'
  ];
  assertEq(headerRow, expectedHeaders, 'Header row matches the exact 12 required columns');

  // B. Read staged data rows
  const stagedData = stagingSheet.getRange(2, 1, 3, 12).getValues();

  // Row 1: Clean Expense Proposal
  const expRow = stagedData[0];
  assertEq(expRow[0], false, 'Row 1: Checkbox is unchecked (false)');
  assertEq(expRow[1] instanceof Date, true, 'Row 1 date is a real date');
  assertEq(reconcileDateString(expRow[1], ss), '11.08.2026', 'Row 1 date round-trips exactly as "11.08.2026" (not shifted by timezone)');
  assertEq(expRow[2], 'DBS CC SGD', 'Row 1: Account is DBS CC SGD');
  assertEq(expRow[3], 'Unknown', 'Row 1: Missing cardholder is not guessed as Val');
  assertEq(expRow[4], 'Расходы', 'Row 1: Тип is "Расходы"');
  assertClose(Number(expRow[5]), 30.00, 0.01, 'Row 1: Amount is +30.00');
  assertEq(Boolean(expRow[7]), true, 'Row 1: Proposed category is populated');
  assertEq(Boolean(expRow[8]), true, 'Row 1: Proposed bucket is populated');
  assertEq(expRow[11], 'proposed', 'Row 1: Status is "proposed"');

  // Row 2: Option B Credit Proposal
  const creditRow = stagedData[1];
  assertEq(creditRow[0], false, 'Row 2: Checkbox is unchecked (false)');
  assertEq(creditRow[1] instanceof Date, true, 'Row 2 date is a real date');
  assertEq(reconcileDateString(creditRow[1], ss), '18.08.2026', 'Row 2 date round-trips exactly as "18.08.2026" (not shifted by timezone)');
  assertEq(creditRow[4], 'Получение денег', 'Row 2: Option B Credit Тип is "Получение денег"');
  assertClose(Number(creditRow[5]), -270.00, 0.01, 'Row 2: Amount is negative (-270.00)');
  assertEq(creditRow[11], 'proposed', 'Row 2: Status is "proposed"');

  // Row 3: Ambiguous Row
  const ambRow = stagedData[2];
  assertEq(ambRow[0], false, 'Row 3: Checkbox is unchecked (false)');
  assertEq(ambRow[1] instanceof Date, true, 'Row 3 date is a real date');
  assertEq(reconcileDateString(ambRow[1], ss), '15.08.2026', 'Row 3 date round-trips exactly as "15.08.2026" (not shifted by timezone)');
  assertEq(ambRow[11], 'ambiguous', 'Row 3: Status is "ambiguous" (surfaced without guessing)');
  const ambSource = String(ambRow[10]);
  assertEq(
    ambSource.includes('Row 42') && ambSource.includes('Row 45'),
    true,
    'Row 3: Candidate ledger rows (Row 42, Row 45) are listed in source_row'
  );

  // C. Verify Transactions invariant after Part 1
  assertEq(
    transSheet.getLastRow(),
    transLastRowBefore,
    'CRITICAL INVARIANT (Part 1): Transactions.getLastRow() is IDENTICAL before and after stageProposals()'
  );

  // --------------------------------------------------------------------------
  // PART 2: End-to-End Pipeline (3A -> 3E) Against Fixture on Sandbox Sheet
  // --------------------------------------------------------------------------
  Logger.log('\n--- Part 2: End-to-End Pipeline (3A -> 3E) Against Fixture on Sandbox ---');

  const fixtureCsv = getFixture('dbs_small_csv', ss);
  if (!fixtureCsv) {
    Logger.log('⚠️ Fixture "dbs_small_csv" not found. Skipping Part 2 fixture execution.');
  } else {
    const e2eResult = reconcileAndStage(fixtureCsv, ss);
    Logger.log(`reconcileAndStage Result: totalParsed=${e2eResult.totalParsed}, matched=${e2eResult.matchedCount}, proposals=${e2eResult.proposalsCount}, ambiguous=${e2eResult.ambiguousCount}, staged=${e2eResult.stagedCount}`);

    assertEq(e2eResult.totalParsed > 0, true, 'Part 2: 3A parsed statement rows from fixture');
    assertEq(e2eResult.stagedCount > 0, true, 'Part 2: 3E staged rows to _Reconcile tab');

    const e2eStagingSheet = ss.getSheetByName(RECONCILE_STAGING_TAB_NAME);
    assertEq(e2eStagingSheet.getLastRow(), e2eResult.stagedCount + 1, 'Part 2: Staging tab row count matches stagedCount + 1 header');

    // Check all staged rows have valid status
    const e2eData = e2eStagingSheet.getRange(2, 1, e2eResult.stagedCount, 12).getValues();
    const allStatusesValid = e2eData.every(r => r[11] === 'proposed' || r[11] === 'ambiguous');
    assertEq(allStatusesValid, true, 'Part 2: Every staged row has status "proposed" or "ambiguous"');

    // Check all staged rows have boolean checkboxes
    const allCheckboxesBoolean = e2eData.every(r => typeof r[0] === 'boolean');
    assertEq(allCheckboxesBoolean, true, 'Part 2: Every staged row has a valid checkbox (boolean)');

    // Check all staged rows contain real dates.
    const allDatesValid = e2eData.every(r => r[1] instanceof Date && !isNaN(r[1].getTime()));
    assertEq(allDatesValid, true, 'Part 2: Every staged date is a valid Date object');

    // D. Final Transactions Invariant Check
    assertEq(
      transSheet.getLastRow(),
      transLastRowBefore,
      'CRITICAL INVARIANT (Part 2): Transactions.getLastRow() is IDENTICAL after complete 3A->3E run'
    );
  }

  Logger.log('\n=== test_stageProposals() Execution Finished ===');
}

/**
 * ============================================================================
 * STAGE 3F TEST: test_commitStaged()
 * ============================================================================
 * 
 * Verifies commitStaged() following the strict 4-step testing sequence:
 * 1. DRY_RUN = true against the SANDBOX: logs exact rows to be appended; 0 writes.
 * 2. DRY_RUN = false against the SANDBOX:
 *    - J (Notes) empty, K holds the bucket
 *    - F:G formulas present and balances chain correctly
 *    - dates land on the correct calendar day (read back and confirm)
 *    - credit row Column G ADDED rather than subtracted
 *    - status updated to 'imported' in _Reconcile
 * 3. Re-run against the sandbox: imports NOTHING (idempotency).
 * 4. Safety gate: live sheet remains 100% untouched.
 */
function test_commitStaged() {
  Logger.log('====================================================');
  Logger.log('       TEST: test_commitStaged() EXECUTION');
  Logger.log('====================================================\n');

  const ss = getTargetSpreadsheet(true);

  if (!ss) {
    throw new Error('test_commitStaged: No sandbox spreadsheet available.');
  }

  const transSheet = ss.getSheetByName('Transactions');
  if (!transSheet) {
    throw new Error('test_commitStaged: Transactions sheet not found in sandbox spreadsheet.');
  }

  // --------------------------------------------------------------------------
  // PRE-TEST CLEANUP: Remove any leftover test rows from prior runs in sandbox
  // --------------------------------------------------------------------------
  const initialTransLastRow = transSheet.getLastRow();
  if (initialTransLastRow >= 2) {
    const scanCount = Math.min(initialTransLastRow - 1, 50);
    const startScanRow = initialTransLastRow - scanCount + 1;
    const tailRows = transSheet.getRange(startScanRow, 1, scanCount, 9).getValues();
    for (let i = tailRows.length - 1; i >= 0; i--) {
      const row = tailRows[i];
      const rDate = (typeof formatSheetDate === 'function') ? formatSheetDate(row[0]) : String(row[0] || '');
      const rAcc = String(row[1] || '').trim();
      const rAmt = Math.abs(Number(row[3]) || 0);
      const rWhere = String(row[8] || '').trim().toLowerCase();
      if (rAcc === 'DBS CC SGD' && (
        (rDate === '11.08.2026' && Math.abs(rAmt - 30.00) < 0.01 && (rWhere === 'simplygo app' || rWhere === 'simplygo')) ||
        (rDate === '18.08.2026' && Math.abs(rAmt - 270.00) < 0.01 && (rWhere === 'allianz reimbursement' || rWhere === 'allianz'))
      )) {
        const rowToDelete = startScanRow + i;
        Logger.log(`[Pre-test Cleanup] Deleting leftover test row ${rowToDelete} from sandbox Transactions.`);
        transSheet.deleteRow(rowToDelete);
        SpreadsheetApp.flush();
      }
    }
  }

  let transLastRowBeforeStep2 = 0;

  try {
    // --------------------------------------------------------------------------
    // SETUP: Populate sandbox _Reconcile staging tab with controlled test rows
    // --------------------------------------------------------------------------
    Logger.log('--- Setting up _Reconcile test rows on Sandbox ---');
    let stagingSheet = ss.getSheetByName(RECONCILE_STAGING_TAB_NAME);
    if (!stagingSheet) {
      stagingSheet = ss.insertSheet(RECONCILE_STAGING_TAB_NAME);
    }

    stagingSheet.clear();
    stagingSheet.clearConditionalFormatRules();
    stagingSheet.getRange(1, 2, stagingSheet.getMaxRows(), 1).setNumberFormat('@');
    SpreadsheetApp.flush();

    const headers = [
      '✓', 'date', 'account', 'Cardholder', 'Тип', 'amount', 'merchant',
      'proposed category', 'proposed bucket', 'confidence', 'source_row', 'status'
    ];
    stagingSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    stagingSheet.setFrozenRows(1);

    const initialStagingRows = [
      // Row 1: Ticked Expense Proposal
      [true, '11.08.2026', 'DBS CC SGD', 'Val', 'Расходы', 30.00, 'simplygo app', 'Транспорт', 'Needs', 1.0, 'Statement: "SIMPLYGO APP"', 'proposed'],
      // Row 2: Ticked Credit Proposal (Option B dual-sided credit)
      [true, '18.08.2026', 'DBS CC SGD', 'Rita', 'Получение денег', -270.00, 'allianz reimbursement', 'Медицина', 'Needs', 1.0, 'Statement: "ALLIANZ REIMBURSEMENT"', 'proposed'],
      // Row 3: Unticked Ambiguous row
      [false, '15.08.2026', 'DBS CC SGD', 'Grandparents', 'Расходы', 50.00, 'restaurant a', 'Рестораны', 'Wants', 0.5, 'Ambiguous (2 candidates)', 'ambiguous'],
      // Row 4: Unticked Expense proposal
      [false, '12.08.2026', 'DBS CC SGD', 'Val', 'Расходы', 15.00, 'coffee shop', 'Рестораны', 'Wants', 0.8, 'Statement: "COFFEE SHOP"', 'proposed']
    ];

    stagingSheet.getRange(2, 1, 4, 12).setValues(initialStagingRows);
    stagingSheet.getRange(2, 2, 4, 1).setNumberFormat('@');
    stagingSheet.getRange(2, 1, 4, 1).insertCheckboxes();
    stagingSheet.getRange(2, 1, 4, 1).setValues([[true], [true], [false], [false]]);
    SpreadsheetApp.flush();

    // --------------------------------------------------------------------------
    // STEP 1: DRY_RUN = true against the SANDBOX
    // --------------------------------------------------------------------------
    Logger.log('\n--- Step 1: DRY_RUN = true against the SANDBOX ---');
    const transLastRowBeforeStep1 = transSheet.getLastRow();
    Logger.log(`[Step 1] Initial Transactions.getLastRow(): ${transLastRowBeforeStep1}`);

    const step1Result = commitStaged(true, true, ss); // Reuse the verified sandbox.
    Logger.log(`[Step 1 DRY_RUN] Result: committed=${step1Result.committedCount}, skipped=${step1Result.skippedCount}, dryRun=${step1Result.dryRun}`);
    Logger.log('[Step 1 DRY_RUN] Exact rows that would be appended:');
    (step1Result.writtenRows || []).forEach((r, idx) => {
      Logger.log(`  Row ${idx + 1}: Date=${r.date} | Account=${r.account} | Type=${r.type} | Amount=${r.amount} | Cat=${r.category} | Where=${r.where} | Notes="${r.notes}" | Bucket=${r.bucket}`);
    });

    assertEq(step1Result.dryRun, true, 'Step 1: dryRun flag is true');
    assertEq(step1Result.committedCount, 2, 'Step 1: Exactly 2 ticked rows would be committed');
    assertEq(transSheet.getLastRow(), transLastRowBeforeStep1, 'Step 1: Zero writes to Transactions in dry run');

    // Guard against undefined writtenRows (Point 3)
    if (!step1Result.writtenRows || step1Result.writtenRows.length < 2) {
      throw new Error(`Step 1 assertion failed: expected at least 2 writtenRows, got ${step1Result.writtenRows ? step1Result.writtenRows.length : 0} (committed=${step1Result.committedCount}, skipped=${step1Result.skippedCount}, dryRun=${step1Result.dryRun})`);
    }
    assertEq(step1Result.writtenRows[0].where, 'SimplyGo App', 'Step 1: Row 1 clean display name is "SimplyGo App"');
    assertEq(step1Result.writtenRows[1].where, 'Allianz Reimbursement', 'Step 1: Row 2 clean display name is "Allianz Reimbursement"');

    // Verify _Reconcile statuses are untouched in dry run
    const stageDataStep1 = stagingSheet.getRange(2, 1, 4, 12).getValues();
    assertEq(stageDataStep1[0][11], 'proposed', 'Step 1: Row 1 status remains "proposed" in dry run');
    assertEq(stageDataStep1[1][11], 'proposed', 'Step 1: Row 2 status remains "proposed" in dry run');

    // --------------------------------------------------------------------------
    // STEP 2: DRY_RUN = false against the SANDBOX
    // --------------------------------------------------------------------------
    Logger.log('\n--- Step 2: DRY_RUN = false against the SANDBOX ---');
    transLastRowBeforeStep2 = transSheet.getLastRow();
    const step2Result = commitStaged(true, false, ss); // Reuse the verified sandbox.
    Logger.log(`[Step 2 NON-DRY-RUN] Result: committed=${step2Result.committedCount}, skipped=${step2Result.skippedCount}, dryRun=${step2Result.dryRun}`);

    assertEq(step2Result.dryRun, false, 'Step 2: dryRun flag is false');
    assertEq(step2Result.committedCount, 2, 'Step 2: Exactly 2 rows committed to Transactions');
    assertEq(transSheet.getLastRow(), transLastRowBeforeStep2 + 2, 'Step 2: Transactions row count increased by exactly 2');

    // Read the 2 newly appended rows
    const newRow1Idx = transLastRowBeforeStep2 + 1;
    const newRows = transSheet.getRange(newRow1Idx, 1, 2, 11).getValues();
    const newFormulas = transSheet.getRange(newRow1Idx, 6, 2, 2).getFormulas();
    const newAmountFormulas = transSheet.getRange(newRow1Idx, 5, 2, 1).getFormulas();
    const newBucketFormulas = transSheet.getRange(newRow1Idx, 11, 2, 1).getFormulas();

    // Verification 2.1: Row 1 (Expense: simplygo app S$30.00)
    const expRow = newRows[0];
    const expDateStr = (typeof formatSheetDate === 'function') ? formatSheetDate(expRow[0]) : normalizeDateString(expRow[0]);
    assertEq(expDateStr, '11.08.2026', 'Step 2: Expense date lands on correct calendar day ("11.08.2026")');
    assertEq(expRow[1], 'DBS CC SGD', 'Step 2: Expense account is "DBS CC SGD"');
    assertEq(expRow[2], 'Расходы', 'Step 2: Expense type is "Расходы"');
    assertClose(Math.abs(Number(expRow[3])), 30.00, 0.01, 'Step 2: Expense amount is 30.00');
    assertEq(expRow[7], 'Транспорт', 'Step 2: Expense category is "Транспорт"');
    assertEq(expRow[8], 'SimplyGo App', 'Step 2: Expense merchant is clean display name "SimplyGo App"');
    assertEq(expRow[9], '', 'Step 2: J (Notes) is EMPTY');
    assertEq(expRow[10], 'Needs', 'Step 2: K holds the bucket ("Needs")');
    assertEq(newAmountFormulas[0][0], transactionAmountSgdFormula(newRow1Idx), 'Step 2: Expense E derives from D');
    assertEq(newBucketFormulas[0][0], transactionBucketFormula(newRow1Idx), 'Step 2: Expense K derives from H and the reference tab');

    // Formulas present on Expense
    assertEq(newFormulas[0][0].length > 0, true, 'Step 2: Expense has formula in F (На счете до)');
    assertEq(newFormulas[0][1].length > 0, true, 'Step 2: Expense has formula in G (На счете после)');

    // Verification 2.2: Row 2 (Credit: allianz reimbursement S$270.00)
    const creditRow = newRows[1];
    const creditDateStr = (typeof formatSheetDate === 'function') ? formatSheetDate(creditRow[0]) : normalizeDateString(creditRow[0]);
    assertEq(creditDateStr, '18.08.2026', 'Step 2: Credit date lands on correct calendar day ("18.08.2026")');
    assertEq(creditRow[1], 'DBS CC SGD', 'Step 2: Credit account is "DBS CC SGD"');
    assertEq(creditRow[2], 'Получение денег', 'Step 2: Credit type is "Получение денег"');
    assertEq(creditRow[8], 'Allianz Reimbursement', 'Step 2: Credit merchant is clean display name "Allianz Reimbursement"');
    assertEq(creditRow[9], '', 'Step 2: Credit J (Notes) is EMPTY');
    assertEq(creditRow[10], 'Needs', 'Step 2: Credit K holds the bucket ("Needs")');
    assertEq(newAmountFormulas[1][0], transactionAmountSgdFormula(newRow1Idx + 1), 'Step 2: Credit E derives from D');
    assertEq(newBucketFormulas[1][0], transactionBucketFormula(newRow1Idx + 1), 'Step 2: Credit K derives from H and the reference tab');

    // Formulas present on Credit
    assertEq(newFormulas[1][0].length > 0, true, 'Step 2: Credit has formula in F (На счете до)');
    assertEq(newFormulas[1][1].length > 0, true, 'Step 2: Credit has formula in G (На счете после)');

    // Verify G ADDED rather than subtracted on Credit row
    const creditBalBefore = Number(creditRow[5]) || 0;
    const creditBalAfter = Number(creditRow[6]) || 0;
    Logger.log(`[Step 2 Balance Check] Credit row: F (before)=${creditBalBefore}, G (after)=${creditBalAfter}, diff=${creditBalAfter - creditBalBefore}`);
    assertEq(creditBalAfter > creditBalBefore, true, 'Step 2: Credit row Column G ADDED rather than subtracted (balance increased)');
    assertClose(creditBalAfter - creditBalBefore, 270.00, 0.01, 'Step 2: Credit row Column G added exact amount (S$270.00)');

    // Verification 2.3: _Reconcile tab status updates
    const stageDataStep2 = stagingSheet.getRange(2, 1, 4, 12).getValues();
    assertEq(stageDataStep2[0][11], 'imported', 'Step 2: Row 1 status marked "imported" in _Reconcile');
    assertEq(stageDataStep2[1][11], 'imported', 'Step 2: Row 2 status marked "imported" in _Reconcile');
    assertEq(stageDataStep2[2][11], 'ambiguous', 'Step 2: Row 3 unticked ambiguous status remains "ambiguous"');
    assertEq(stageDataStep2[3][11], 'proposed', 'Step 2: Row 4 unticked proposal status remains "proposed"');

    // --------------------------------------------------------------------------
    // STEP 3: Re-run against the sandbox — must import NOTHING (idempotency)
    // --------------------------------------------------------------------------
    Logger.log('\n--- Step 3: Re-run against the sandbox (Idempotency) ---');
    const transLastRowBeforeStep3 = transSheet.getLastRow();
    const step3Result = commitStaged(true, false, ss);
    Logger.log(`[Step 3 IDEMPOTENCY] Result: committed=${step3Result.committedCount}, skipped=${step3Result.skippedCount}`);

    assertEq(step3Result.committedCount, 0, 'Step 3: Idempotency re-run committed ZERO rows');
    assertEq(transSheet.getLastRow(), transLastRowBeforeStep3, 'Step 3: Transactions row count is IDENTICAL (nothing imported)');

    // --------------------------------------------------------------------------
    // STEP 4: Live Sheet Safety Gate
    // --------------------------------------------------------------------------
    Logger.log('\n--- Step 4: Live Sheet Safety Gate ---');
    assertEq(ss.getId(), String(SHEET_FACTS.TEST_SPREADSHEET_ID).trim(), 'All commit steps targeted the verified sandbox');
    Logger.log('✅ PASS: All 4 steps of Stage 3F testing sequence verified on sandbox.');
  } finally {
    // --------------------------------------------------------------------------
    // POST-TEST CLEANUP: Delete the rows appended during Step 2
    // --------------------------------------------------------------------------
    if (transSheet && transLastRowBeforeStep2 > 0) {
      const finalTransLastRow = transSheet.getLastRow();
      if (finalTransLastRow > transLastRowBeforeStep2) {
        const rowsToDelete = finalTransLastRow - transLastRowBeforeStep2;
        Logger.log(`[Post-test Cleanup] Deleting ${rowsToDelete} appended test row(s) (rows ${transLastRowBeforeStep2 + 1} to ${finalTransLastRow}) from sandbox Transactions.`);
        transSheet.deleteRows(transLastRowBeforeStep2 + 1, rowsToDelete);
        SpreadsheetApp.flush();
      }
    }
  }

  Logger.log('\n=== test_commitStaged() Execution Finished ===');
}

/**
 * Unit tests for cleanMerchantDisplayName() and toSmartTitleCase().
 * Verifies that merchant names written to Column I (Где) are clean, properly capitalized,
 * and respect brand casing/acronyms without altering dedupe keys.
 */
function test_cleanMerchantDisplayName() {
  Logger.log('====================================================');
  Logger.log('   TEST: test_cleanMerchantDisplayName() EXECUTION');
  Logger.log('====================================================\n');

  const testCases = [
    { input: 'simplygo app', expected: 'SimplyGo App' },
    { input: 'allianz reimbursement', expected: 'Allianz Reimbursement' },
    { input: 'GRAB* A-9876543210', expected: 'Grab' },
    { input: 'FAIRPRICE FINEST SINGAPORE SGP', expected: 'Fair Price' },
    { input: 'cold storage', expected: 'Cold Storage' },
    { input: 'COLD STORAGE', expected: 'Cold Storage' },
    { input: 'dbs bill payment', expected: 'DBS Bill Payment' },
    { input: 'citi phone banking', expected: 'Citibank Phone Banking' },
    { input: 'carousell sale', expected: 'Carousell Sale' },
    { input: 'amazon sg', expected: 'Amazon' },
    { input: 'sp services', expected: 'SP Services' },
    { input: 'mrt tops', expected: 'MRT Tops' },
    { input: '', expected: '' }
  ];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const actual = cleanMerchantDisplayName(tc.input);
    Logger.log(`[cleanMerchantDisplayName] "${tc.input}" -> "${actual}" (expected "${tc.expected}")`);
    assertEq(actual, tc.expected, `cleanMerchantDisplayName("${tc.input}")`);
  }

  // Confirm dedupe invariance:
  // "SimplyGo App" and "simplygo app" must produce the EXACT same normaliseWhere / compactWhere
  const norm1 = typeof normaliseWhere === 'function' ? normaliseWhere('SimplyGo App') : '';
  const norm2 = typeof normaliseWhere === 'function' ? normaliseWhere('simplygo app') : '';
  assertEq(norm1, norm2, 'Dedupe invariance: normaliseWhere("SimplyGo App") === normaliseWhere("simplygo app")');

  Logger.log('\n✅ All cleanMerchantDisplayName tests passed.');
  Logger.log('=== test_cleanMerchantDisplayName() Execution Finished ===');
}

/**
 * REGRESSION TEST: computeMerchantSimilarity threshold behaviour.
 * Validates that substring matching properly discriminates between brand-leading prefixes,
 * multi-word phrases (>= 2 words, ratio >= 0.30), substantial gateway substrings, and incidental location/sub-word tokens.
 */
function test_computeMerchantSimilarity() {
  Logger.log('====================================================');
  Logger.log('   TEST: test_computeMerchantSimilarity() EXECUTION');
  Logger.log('====================================================\n');

  // Case 1: Multi-word phrase inside truncated bank descriptor -> >= 0.80
  const scoreSplAutoTopup = computeMerchantSimilarity("SPL AUTO TOPUP CONC (C", "Auto Topup");
  Logger.log(`[Similarity] "SPL AUTO TOPUP CONC (C" vs "Auto Topup": ${scoreSplAutoTopup.toFixed(2)} (expected >= 0.80)`);
  assertEq(scoreSplAutoTopup >= 0.80, true, 'SPL AUTO TOPUP CONC (C vs Auto Topup scores >= 0.80 (multi-word phrase)');

  // Case 2: Incidental single-word location token inside hotel name -> < 0.70
  const scoreLeMeridienShort = computeMerchantSimilarity("LE MERIDIEN PHUKET BEA PHUKET TH", "Phuket");
  Logger.log(`[Similarity] "LE MERIDIEN PHUKET BEA PHUKET TH" vs "Phuket": ${scoreLeMeridienShort.toFixed(2)} (expected < 0.70)`);
  assertEq(scoreLeMeridienShort < 0.70, true, 'LE MERIDIEN PHUKET BEA PHUKET TH vs Phuket scores < 0.70 (single-word location)');

  // Case 3: Partial, unrelated shared token -> < 0.70
  const scoreCaffeFernet = computeMerchantSimilarity("CAFFE FERNET SINGAPORE", "Fernet Branca");
  Logger.log(`[Similarity] "CAFFE FERNET SINGAPORE" vs "Fernet Branca": ${scoreCaffeFernet.toFixed(2)} (expected < 0.70)`);
  assertEq(scoreCaffeFernet < 0.70, true, 'CAFFE FERNET SINGAPORE vs Fernet Branca scores < 0.70 (partial unrelated token)');

  // Case 4: Incidental location token with foreign currency string -> < 0.70
  const scoreLeMeridien = computeMerchantSimilarity("LE MERIDIEN PHUKET BEA PHUKET TH THB 14,419.20", "Phuket");
  Logger.log(`[Similarity] "LE MERIDIEN PHUKET...THB..." vs "Phuket": ${scoreLeMeridien.toFixed(2)} (expected < 0.70)`);
  assertEq(scoreLeMeridien < 0.70, true, 'Le Meridien vs Phuket scores < 0.70 (incidental location token)');

  // Case 5: Brand-leading prefix with descriptors -> >= 0.85
  const scoreMcdonalds = computeMerchantSimilarity("Mcdonald's (psa) Singapore SG", "McDonald's");
  Logger.log(`[Similarity] "Mcdonald's (psa) Singapore SG" vs "McDonald's": ${scoreMcdonalds.toFixed(2)} (expected >= 0.85)`);
  assertEq(scoreMcdonalds >= 0.85, true, 'McDonalds PSA vs McDonalds scores >= 0.85 (brand-leading prefix)');

  // Case 6: Brand-leading prefix with transaction code and country -> >= 0.85
  const scoreSpotify = computeMerchantSimilarity("Spotify P466a9dde4 Stockholm Se", "Spotify");
  Logger.log(`[Similarity] "Spotify P466a9dde4 Stockholm Se" vs "Spotify": ${scoreSpotify.toFixed(2)} (expected >= 0.85)`);
  assertEq(scoreSpotify >= 0.85, true, 'Spotify descriptor vs Spotify scores >= 0.85 (brand-leading prefix)');

  // Case 7: Gateway prefix with substantial length ratio and word boundary -> >= 0.85
  const scoreLazada = computeMerchantSimilarity("2c2*lazada", "Lazada");
  Logger.log(`[Similarity] "2c2*lazada" vs "Lazada": ${scoreLazada.toFixed(2)} (expected >= 0.85)`);
  assertEq(scoreLazada >= 0.85, true, '2c2*lazada vs Lazada scores >= 0.85 (gateway prefix with ratio >= 0.50)');

  // Case 8: Mid-word substring must NOT match -> < 0.70
  const scoreCitibankBar = computeMerchantSimilarity("Citibank Singapore", "Bar");
  Logger.log(`[Similarity] "Citibank Singapore" vs "Bar": ${scoreCitibankBar.toFixed(2)} (expected < 0.70)`);
  assertEq(scoreCitibankBar < 0.70, true, 'Citibank Singapore vs Bar scores < 0.70 (sub-word token)');

  Logger.log('\n✅ All computeMerchantSimilarity regression tests passed.');
  Logger.log('=== test_computeMerchantSimilarity() Execution Finished ===');
}

/**
 * TEST: Tier-3 Gemini Category Inference & Sampling.
 * Tests:
 * 1. sampleLedgerFewShotExamples: extracts representative merchants across distinct categories, excludes "Другое", respects validCategories.
 * 2. inferCategoriesWithGeminiBatch: enforces constrained vocabulary, rejects unauthorized categories -> "Другое", graceful degradation when apiKey missing.
 */
function test_geminiTier3() {
  Logger.log('====================================================');
  Logger.log('      TEST: test_geminiTier3() EXECUTION');
  Logger.log('====================================================\n');

  const validCategories = [
    'Продукты', 'Рестораны', 'Развлечения', 'Подписки',
    'Счётчики', 'Транспорт', 'Красота', 'Медицина', 'Дом', 'Подарки', 'НКО', 'Другое',
    'Extra fund', 'Отложения', 'Отложения (премия)', 'Лин', 'Квартира', 'Налоги',
    'Школа & Детский сад', 'Отдых', 'Кредитка', 'Авто'
  ];

  // 1. Test sampleLedgerFewShotExamples
  const mockLedger = [];
  // Add 10 FairPrice (Продукты)
  for (let i = 0; i < 10; i++) mockLedger.push({ where: 'FairPrice', category: 'Продукты' });
  // Add 8 Grab (Транспорт)
  for (let i = 0; i < 8; i++) mockLedger.push({ where: 'Grab', category: 'Транспорт' });
  // Add 6 McDonald's (Рестораны)
  for (let i = 0; i < 6; i++) mockLedger.push({ where: "McDonald's", category: 'Рестораны' });
  // Add 5 Spotify (Подписки)
  for (let i = 0; i < 5; i++) mockLedger.push({ where: 'Spotify', category: 'Подписки' });
  // Add 4 SP Services (Счётчики)
  for (let i = 0; i < 4; i++) mockLedger.push({ where: 'SP Services', category: 'Счётчики' });
  // Add 20 "Unknown Shop" (Другое) -> Must be excluded!
  for (let i = 0; i < 20; i++) mockLedger.push({ where: 'Unknown Shop', category: 'Другое' });
  // Add 10 "Fake Category Merchant" -> Must be excluded since not in validCategories!
  for (let i = 0; i < 10; i++) mockLedger.push({ where: 'Alien Merchant', category: 'НеизвестнаяКатегория' });

  const sampled = sampleLedgerFewShotExamples(mockLedger, validCategories, 30);
  Logger.log(`Sampled ${sampled.length} few-shot examples from mock ledger.`);

  const sampledCategories = new Set(sampled.map(s => s.category));
  const sampledMerchants = new Set(sampled.map(s => s.merchant));

  assertEq(sampledMerchants.has('Unknown Shop'), false, 'sampleLedgerFewShotExamples excludes "Другое"');
  assertEq(sampledMerchants.has('Alien Merchant'), false, 'sampleLedgerFewShotExamples excludes categories not in validCategories');
  assertEq(sampledMerchants.has('FairPrice'), true, 'sampleLedgerFewShotExamples includes top frequency merchant FairPrice');
  assertEq(sampledMerchants.has('Grab'), true, 'sampleLedgerFewShotExamples includes top frequency merchant Grab');
  assertEq(sampledCategories.has('Продукты'), true, 'sampleLedgerFewShotExamples spans Продукты');
  assertEq(sampledCategories.has('Транспорт'), true, 'sampleLedgerFewShotExamples spans Транспорт');
  assertEq(sampledCategories.has('Рестораны'), true, 'sampleLedgerFewShotExamples spans Рестораны');
  assertEq(sampledCategories.has('Подписки'), true, 'sampleLedgerFewShotExamples spans Подписки');
  assertEq(sampledCategories.has('Счётчики'), true, 'sampleLedgerFewShotExamples spans Счётчики');

  // 2. Test inferCategoriesWithGeminiBatch graceful degradation when no API key
  const noKeyResult = inferCategoriesWithGeminiBatch(
    [{ id: 1, raw_descriptor: 'TEST MERCHANT' }],
    validCategories,
    sampled,
    null // null API key
  );
  assertEq(typeof noKeyResult === 'object' && Object.keys(noKeyResult).length === 0, true, 'inferCategoriesWithGeminiBatch returns empty map when apiKey is missing');

  // 3. Test mock response parsing, category constraints, and clean display names
  // Temporarily stub callGeminiApiWithRetry in global scope
  const originalCallGemini = (typeof callGeminiApiWithRetry === 'function') ? callGeminiApiWithRetry : null;
  const globalScope = (typeof globalThis !== 'undefined') ? globalThis : this;

  globalScope.callGeminiApiWithRetry = function(payload, apiKey, preferredModel) {
    return {
      text: JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify([
                {
                  id: 1,
                  raw_descriptor: "LE MERIDIEN PHUKET BEA PHUKET TH THB 14,419.20",
                  clean_display_name: "Le Meridien Phuket",
                  category: "Отдых"
                },
                {
                  id: 2,
                  raw_descriptor: "SPOTIFY P466A9DDE4 STOCKHOLM SE",
                  clean_display_name: "Spotify",
                  category: "Подписки"
                },
                {
                  id: 3,
                  raw_descriptor: "WEIRD MERCHANT XYZ",
                  clean_display_name: "Weird Merchant",
                  category: "IllegalCategoryNotAllowed"
                }
              ])
            }]
          }
        }]
      })
    };
  };

  try {
    const unknownItems = [
      { id: 1, raw_descriptor: "LE MERIDIEN PHUKET BEA PHUKET TH THB 14,419.20" },
      { id: 2, raw_descriptor: "SPOTIFY P466A9DDE4 STOCKHOLM SE" },
      { id: 3, raw_descriptor: "WEIRD MERCHANT XYZ" }
    ];

    const batchRes = inferCategoriesWithGeminiBatch(unknownItems, validCategories, sampled, 'dummy_key');
    const key1 = typeof normaliseWhere === 'function' ? normaliseWhere("LE MERIDIEN PHUKET BEA PHUKET TH THB 14,419.20") : "le meridien phuket bea phuket th thb 14,419.20";
    const key2 = typeof normaliseWhere === 'function' ? normaliseWhere("SPOTIFY P466A9DDE4 STOCKHOLM SE") : "spotify p466a9dde4 stockholm se";
    const key3 = typeof normaliseWhere === 'function' ? normaliseWhere("WEIRD MERCHANT XYZ") : "weird merchant xyz";

    assertEq(batchRes[key1] && batchRes[key1].category, 'Отдых', 'Gemini classifies Le Meridien Phuket as Отдых');
    assertEq(batchRes[key1] && batchRes[key1].clean_display_name, 'Le Meridien Phuket', 'Gemini extracts clean display name "Le Meridien Phuket"');
    assertEq(batchRes[key2] && batchRes[key2].category, 'Подписки', 'Gemini classifies Spotify as Подписки');
    assertEq(batchRes[key3] && batchRes[key3].category, 'Другое', 'Gemini rejects unauthorized category to "Другое"');
    assertEq(batchRes[key3] && batchRes[key3].rejected, true, 'Gemini marks unauthorized category as rejected');
  } finally {
    if (originalCallGemini) {
      globalScope.callGeminiApiWithRetry = originalCallGemini;
    } else {
      delete globalScope.callGeminiApiWithRetry;
    }
  }

  Logger.log('Tier-3 assertions completed; see runner summary for pass/fail.');
  Logger.log('=== test_geminiTier3() Execution Finished ===');
}

/**
 * TEST: Ambiguous rows inference pipeline.
 * Asserts that ambiguous rows pass through the full Tier 1/2/3 inference pipeline:
 * - Merchant receives clean display name (e.g. from matched ledger merchant or Gemini)
 * - Category and bucket are inferred
 * - Status remains 'ambiguous'
 * - Confidence remains 0.5
 * - Candidate ledger rows remain formatted in source_row
 */
function test_ambiguousInferencePipeline() {
  Logger.log('====================================================');
  Logger.log('  TEST: test_ambiguousInferencePipeline() EXECUTION');
  Logger.log('====================================================\n');

  let stagedData = [];
  const createMockRange = () => {
    const range = {
      setNumberFormat: () => range,
      setValues: (vals) => { if (vals[0].length === 12) stagedData = vals; return range; },
      getValues: () => [],
      setBackground: () => range,
      setFontWeight: () => range,
      setFontColor: () => range,
      setHorizontalAlignment: () => range,
      setBackgrounds: () => range,
      insertCheckboxes: () => range,
      setDataValidation: () => range
    };
    return range;
  };

  const mockSpreadsheet = {
    getSheetByName: () => ({
      clear: () => {},
      clearConditionalFormatRules: () => {},
      getRange: () => createMockRange(),
      getLastRow: () => 0,
      getLastColumn: () => 0,
      getMaxRows: () => 100,
      setFrozenRows: () => {},
      setColumnWidth: () => {}
    })
  };

  const ambRows = [{
    date: '11.08.2026',
    amount: 20.00,
    raw_amount: '20.00',
    merchant: 'spl auto topup conc (c',
    raw_merchant: 'SPL AUTO TOPUP CONC (C',
    candidates: [{ row_index: 1850, date: '11.08.2026', amount: 20.00, where: 'Auto Topup' }]
  }];

  const mockLedger = [
    { where: 'Auto Topup', category: 'Транспорт' },
    { where: 'Auto Topup', category: 'Транспорт' },
    { where: 'Auto Topup', category: 'Транспорт' }
  ];

  const result = stageProposals([], ambRows, mockSpreadsheet, mockLedger);

  assertEq(result.ambiguousCount, 1, 'stageProposals staged exactly 1 ambiguous row');
  assertEq(stagedData.length, 1, 'stagedData contains 1 row');

  // Staged columns (12 columns):
  // 1:✓, 2:date, 3:account, 4:Cardholder, 5:Тип, 6:amount, 7:merchant, 8:proposed category, 9:proposed bucket, 10:confidence, 11:source_row, 12:status
  const [checked, date, account, cardholder, type, amt, merchant, cat, bucket, conf, sourceRow, status] = stagedData[0];

  assertEq(merchant, 'Auto Topup', 'Ambiguous row receives clean display name "Auto Topup"');
  assertEq(cat, 'Транспорт', 'Ambiguous row receives inferred category "Транспорт"');
  assertEq(bucket, 'Needs', 'Ambiguous row receives inferred bucket "Needs"');
  assertEq(conf, 0.5, 'Ambiguous row retains confidence 0.5');
  assertEq(status, 'ambiguous', 'Ambiguous row retains status "ambiguous"');
  assertEq(sourceRow.includes('Row 1850'), true, 'Ambiguous row retains candidates in source_row');

  Logger.log('\n✅ All test_ambiguousInferencePipeline tests passed.');
  Logger.log('=== test_ambiguousInferencePipeline() Execution Finished ===');
}

/**
 * TEST: Grab Known Ambiguity & Conflict Checks.
 * Asserts:
 * 1. Differentiated Grab normalization:
 *    - "GRAB* A-28082026", "WWW.GRAB.COM", "WWW.GRAB.COM BANGKOK" -> "grab"
 *    - "GRABFOOD", "GRAB FOOD", "GRAB* FOOD" -> "grab food"
 *    - "GRAB SUBSCRIPTION", "GRAB* SUBSCRIPTION" -> "grab subscription"
 * 2. Clean display names:
 *    - "grab" -> "Grab"
 *    - "grab food" -> "Grab Food"
 *    - "grab subscription" -> "Grab Subscription"
 * 3. Merchants tab bad alias cleanup:
 *    - cleanBadGrabAliasFromMerchantsTab deletes row with "Grab -> Рестораны"
 * 4. Ledger history drives category (Транспорт for Grab rides, Рестораны for Grab Food):
 *    - Tier 1 ledger match assigns category with confidence 0.9.
 * 5. "WWW.GRAB.COM BANGKOK" is genuinely ambiguous from descriptor alone:
 *    - Flagged with confidence 0.5 and note 'Grab Bangkok: ride vs food — verify'.
 */
function test_grabAmbiguityAndConflictCheck() {
  Logger.log('====================================================');
  Logger.log('  TEST: test_grabAmbiguityAndConflictCheck() EXECUTION');
  Logger.log('====================================================\n');

  // --- PART 1: Differentiated Grab Normalization & Clean Display Names ---
  Logger.log('--- 1. Grab Normalization & Clean Display Names ---');
  assertEq(normaliseWhere('GRAB* A-28082026'), 'grab', 'GRAB* A-... normalises to "grab"');
  assertEq(normaliseWhere('WWW.GRAB.COM'), 'grab', 'WWW.GRAB.COM normalises to "grab"');
  assertEq(normaliseWhere('WWW.GRAB.COM BANGKOK'), 'grab', 'WWW.GRAB.COM BANGKOK normalises to "grab"');
  assertEq(normaliseWhere('Grab'), 'grab', 'Grab normalises to "grab"');
  assertEq(normaliseWhere('GRABFOOD'), 'grab food', 'GRABFOOD normalises to "grab food"');
  assertEq(normaliseWhere('GRAB FOOD'), 'grab food', 'GRAB FOOD normalises to "grab food"');
  assertEq(normaliseWhere('GRAB* FOOD'), 'grab food', 'GRAB* FOOD normalises to "grab food"');
  assertEq(normaliseWhere('Grab Food'), 'grab food', 'Grab Food normalises to "grab food"');
  assertEq(normaliseWhere('GRAB SUBSCRIPTION'), 'grab subscription', 'GRAB SUBSCRIPTION normalises to "grab subscription"');
  assertEq(normaliseWhere('GRAB* SUBSCRIPTION'), 'grab subscription', 'GRAB* SUBSCRIPTION normalises to "grab subscription"');

  assertEq(cleanMerchantDisplayName('grab'), 'Grab', 'cleanMerchantDisplayName("grab") -> "Grab"');
  assertEq(cleanMerchantDisplayName('grab food'), 'Grab Food', 'cleanMerchantDisplayName("grab food") -> "Grab Food"');
  assertEq(cleanMerchantDisplayName('grab subscription'), 'Grab Subscription', 'cleanMerchantDisplayName("grab subscription") -> "Grab Subscription"');

  // --- PART 2: Clean Bad Grab Alias from Merchants Tab ---
  Logger.log('\n--- 2. Clean Bad Grab Alias from Merchants Tab ---');
  let deletedRows = [];
  const mockMerchantsSheet = {
    getLastRow: () => 3,
    getLastColumn: () => 5,
    getRange: (r, c, nr, nc) => ({
      getValues: () => [
        ['McDonald\'s', 'Рестораны', 10, '01.09.2026', ''],
        ['Grab', 'Рестораны', 1, '01.09.2026', 'GRAB* A-28082026'] // row 3 (simulating row 46)
      ]
    }),
    deleteRow: (rowNum) => {
      deletedRows.push(rowNum);
    }
  };
  const mockSsForCleanup = {
    getSheetByName: (name) => (name === 'Merchants' ? mockMerchantsSheet : null)
  };
  const cleanupResult = cleanBadGrabAliasFromMerchantsTab(mockSsForCleanup);
  assertEq(cleanupResult, true, 'cleanBadGrabAliasFromMerchantsTab detected and deleted bad alias');
  assertEq(deletedRows.includes(3), true, 'Deleted row containing "Grab -> Рестораны"');

  // --- PART 3: Ledger Drives Category (Транспорт for rides, Рестораны for food) ---
  Logger.log('\n--- 3. Ledger History Category Driving ---');
  const ledgerStats = [
    {
      rawMerchant: 'Grab',
      normMerchant: 'grab',
      categoryCounts: { 'Транспорт': 63, 'Подписки': 9 },
      bestCategory: 'Транспорт',
      topCount: 63,
      totalCount: 72
    },
    {
      rawMerchant: 'Grab Food',
      normMerchant: 'grab food',
      categoryCounts: { 'Рестораны': 34 },
      bestCategory: 'Рестораны',
      topCount: 34,
      totalCount: 34
    }
  ];

  const rideInference = inferProposalCategory('GRAB* A-28082026', ledgerStats, [], {});
  assertEq(rideInference.category, 'Транспорт', 'Grab ride infers Транспорт from ledger history');
  assertEq(rideInference.confidence, 0.9, 'Grab ride gets Tier-1 confidence 0.9');

  const foodInference = inferProposalCategory('GRABFOOD SINGAPORE', ledgerStats, [], {});
  assertEq(foodInference.category, 'Рестораны', 'Grab Food infers Рестораны from ledger history');
  assertEq(foodInference.confidence, 0.9, 'Grab Food gets Tier-1 confidence 0.9');

  // --- PART 4: Proposal Staging & WWW.GRAB.COM BANGKOK Ambiguity ---
  Logger.log('\n--- 4. Proposal Staging & Bangkok Ambiguity ---');
  let stagedData = [];
  let stagedBackgrounds = [];
  const createMockRange = () => {
    const range = {
      setNumberFormat: () => range,
      setValues: (vals) => { if (vals[0].length === 12) stagedData = vals; return range; },
      getValues: () => [],
      setBackground: () => range,
      setFontWeight: () => range,
      setFontColor: () => range,
      setHorizontalAlignment: () => range,
      setBackgrounds: (bgs) => { stagedBackgrounds = bgs; return range; },
      insertCheckboxes: () => range,
      setDataValidation: () => range
    };
    return range;
  };

  const mockSpreadsheet = {
    getSheetByName: () => ({
      clear: () => {},
      clearConditionalFormatRules: () => {},
      getRange: () => createMockRange(),
      getLastRow: () => 0,
      getLastColumn: () => 0,
      getMaxRows: () => 100,
      setFrozenRows: () => {},
      setColumnWidth: () => {}
    })
  };

  const mockLedger = [
    { where: 'Grab', category: 'Транспорт' },
    { where: 'Grab Food', category: 'Рестораны' }
  ];

  const testProposals = [
    {
      date: '28.08.2026',
      amount: 18.50,
      raw_amount: '18.50',
      merchant: 'grab* a-28082026',
      raw_merchant: 'GRAB* A-28082026',
      type: 'Расходы'
    },
    {
      date: '29.08.2026',
      amount: 32.10,
      raw_amount: '32.10',
      merchant: 'grabfood',
      raw_merchant: 'GRABFOOD',
      type: 'Расходы'
    },
    {
      date: '30.08.2026',
      amount: 45.00,
      raw_amount: '45.00',
      merchant: 'www.grab.com bangkok',
      raw_merchant: 'WWW.GRAB.COM BANGKOK',
      type: 'Расходы'
    }
  ];

  stageProposals(testProposals, [], mockSpreadsheet, mockLedger);
  assertEq(stagedData.length, 3, 'Staged 3 proposals (Ride, Food, Bangkok)');

  // Proposal 1: Ride -> Grab, Транспорт, conf 0.9
  assertEq(stagedData[0][6], 'Grab', 'Proposal 1 clean merchant is "Grab"');
  assertEq(stagedData[0][7], 'Транспорт', 'Proposal 1 category is "Транспорт"');
  assertEq(stagedData[0][9], 0.9, 'Proposal 1 confidence is 0.9 (Tier 1 ledger match)');

  // Proposal 2: Food -> Grab Food, Рестораны, conf 0.9
  assertEq(stagedData[1][6], 'Grab Food', 'Proposal 2 clean merchant is "Grab Food"');
  assertEq(stagedData[1][7], 'Рестораны', 'Proposal 2 category is "Рестораны"');
  assertEq(stagedData[1][9], 0.9, 'Proposal 2 confidence is 0.9 (Tier 1 ledger match)');

  // Proposal 3: Bangkok -> Conf 0.5, verification note
  assertEq(stagedData[2][9], 0.5, 'Proposal 3 (Bangkok) flagged with confidence 0.5 for user decision');
  assertEq(stagedData[2][10].includes('Grab Bangkok: ride vs food — verify'), true, 'Proposal 3 source_row has Grab Bangkok note');
  assertEq(stagedBackgrounds[2][0], '#fffbeb', 'Proposal 3 receives soft amber background (#fffbeb)');

  Logger.log('\n✅ All test_grabAmbiguityAndConflictCheck tests passed.');
  Logger.log('=== test_grabAmbiguityAndConflictCheck() Execution Finished ===');
}

/**
 * STAGE 3 TEST: Multi-Section DBS CSV Parsing, Cardholder Mapping & Disambiguation.
 * 
 * Asserts:
 * 1. Multi-section parsing:
 *    - Parses all 3 sections from DBS statement (Main Card 4320, Supp Card 7509, Supp Card 0465).
 *    - Captures last-4 digits only, never the full 16-digit number.
 *    - Correctly maps '4320' -> 'Val', '7509' -> 'Rita', '0465' -> 'Grandparents'.
 *    - Reports row counts per section.
 * 2. Cardholder matching disambiguation:
 *    - Two identical same-day charges on different cards (Val 4320 vs Grandparents 0465).
 *    - Matching against a Grandparents ledger row matches Grandparents and leaves Val as a proposal.
 *    - Matching against a household ledger row matches Val and leaves Grandparents as a proposal.
 *    - Ambiguous count is 0 (reduced from ambiguous).
 * 3. Grandparents column J (Notes) tagging:
 *    - Grandparents rows are tagged in staging with "[Grandparents - Card 0465]".
 *    - Val/Rita rows leave Column J empty.
 * 4. Per-card summary breakdown tallies correctly.
 */
function test_dbsMultiSectionAndCardholderMatching() {
  Logger.log('====================================================');
  Logger.log('  TEST: test_dbsMultiSectionAndCardholderMatching()');
  Logger.log('====================================================\n');

  // --- PART 1: Multi-Section DBS CSV Parser Test ---
  Logger.log('--- 1. Multi-Section DBS CSV Parser Test ---');
  const mockCsvLines = [
    'Account Details,,,,',
    'Account Type: DBS Altitude Visa Signature Card,,,,',
    '"Card Transaction Details For:","DBS Altitude Visa Signature Card 4119-1100-9482-4320",,,',
    'Transaction Date,Transaction Posting Date,Transaction Description,Debit Amount,Credit Amount',
    '15.08.2026,16.08.2026,NTUC FAIRPRICE,45.50,',
    '15.08.2026,16.08.2026,SIMPLYGO MRT,1.85,',
    '"Supplementary Card:",""',
    '"DBS Altitude Visa Signature Card 4119-1100-9439-7509",""',
    'Transaction Date,Transaction Posting Date,Transaction Description,Debit Amount,Credit Amount',
    '15.08.2026,16.08.2026,SIMPLYGO MRT,1.85,',
    '18.08.2026,19.08.2026,WATSONS,22.30,',
    '"Supplementary Card:",""',
    '',
    '"DBS Altitude Visa Signature Card 4119-1100-9444-0465",""',
    'Transaction Date,Transaction Posting Date,Transaction Description,Debit Amount,Credit Amount',
    '15.08.2026,16.08.2026,SIMPLYGO MRT,1.85,',
    '20.08.2026,21.08.2026,CLINIC CARE,85.00,'
  ];

  const mockCsvText = mockCsvLines.join('\n');
  const rows2D = (typeof Utilities !== 'undefined' && typeof Utilities.parseCsv === 'function')
    ? Utilities.parseCsv(mockCsvText)
    : mockCsvLines.map(line => line.split(',').map(c => c.replace(/^"|"$/g, '')));
  const parsed = tryParseDbsCsv(rows2D, mockCsvText, 'dbs_statement.csv');

  assertEq(Boolean(parsed && parsed.rows), true, 'tryParseDbsCsv successfully parsed multi-section statement');
  assertEq(parsed.rows.length, 6, `Parsed exact 6 rows across all 3 sections (got ${parsed.rows.length})`);
  assertEq(parsed.sections.length, 3, `Detected exact 3 sections (got ${parsed.sections.length})`);

  // Assert section metadata
  assertEq(parsed.sections[0].cardType, 'main', 'Section 1 is main card');
  assertEq(parsed.sections[0].last4, '4320', 'Section 1 last-4 is 4320');
  assertEq(parsed.sections[0].cardholder, 'Val', 'Section 1 cardholder is Val');
  assertEq(parsed.sections[0].rowCount, 2, 'Section 1 has 2 rows');

  assertEq(parsed.sections[1].cardType, 'supplementary', 'Section 2 is supplementary card');
  assertEq(parsed.sections[1].last4, '7509', 'Section 2 last-4 is 7509');
  assertEq(parsed.sections[1].cardholder, 'Rita', 'Section 2 cardholder is Rita');
  assertEq(parsed.sections[1].rowCount, 2, 'Section 2 has 2 rows');

  assertEq(parsed.sections[2].cardType, 'supplementary', 'Section 3 is supplementary card');
  assertEq(parsed.sections[2].last4, '0465', 'Section 3 last-4 is 0465');
  assertEq(parsed.sections[2].cardholder, 'Grandparents', 'Section 3 cardholder is Grandparents');
  assertEq(parsed.sections[2].rowCount, 2, 'Section 3 has 2 rows');

  // Verify rows taggings & privacy constraint (last-4 only)
  parsed.rows.forEach((r, idx) => {
    assertEq(r.card_number.length, 4, `Row ${idx + 1} card_number is exactly 4 digits: ${r.card_number}`);
    assertEq(r.card_number.includes('4119'), false, `Row ${idx + 1} never stores full 16-digit card number`);
  });

  assertEq(parsed.rows[0].cardholder, 'Val', 'Row 1 tagged with cardholder Val');
  assertEq(parsed.rows[2].cardholder, 'Rita', 'Row 3 tagged with cardholder Rita');
  assertEq(parsed.rows[4].cardholder, 'Grandparents', 'Row 5 tagged with cardholder Grandparents');

  // --- PART 2: Matching Disambiguation Test ---
  Logger.log('\n--- 2. Matching Disambiguation Test ---');
  const sRows = normalizeRows(parsed.rows);

  // Test Case A: Statement has Val (1.85) and Grandparents (1.85).
  // Ledger has ONLY Grandparents (1.85, Notes: 'Grandparents').
  const stmtSubsetA = [
    sRows[1], // 15.08.2026, SimplyGo MRT, 1.85, Val (4320)
    sRows[4]  // 15.08.2026, SimplyGo MRT, 1.85, Grandparents (0465)
  ];
  const ledgerA = [
    {
      row_index: 2,
      date: '15.08.2026',
      account: 'DBS CC SGD',
      type: 'Расходы',
      amount: 1.85,
      merchant: 'SimplyGo MRT',
      where: 'SimplyGo MRT',
      notes: 'Grandparents'
    }
  ];

  const matchResA = findMissing(stmtSubsetA, ledgerA);
  assertEq(matchResA.matched.length, 1, 'Match Case A: exactly 1 matched row');
  assertEq(matchResA.matched[0].cardholder, 'Grandparents', 'Match Case A: matched row is Grandparents');
  assertEq(matchResA.missing.length, 1, 'Match Case A: exactly 1 missing row (proposal for Val)');
  assertEq(matchResA.missing[0].cardholder, 'Val', 'Match Case A: proposal is for Val');
  assertEq(matchResA.ambiguous.length, 0, 'Match Case A: ZERO ambiguous rows (disambiguation succeeded!)');

  // Test Case B: Ledger has ONLY Household/Val (1.85, Notes: '').
  const ledgerB = [
    {
      row_index: 3,
      date: '15.08.2026',
      account: 'DBS CC SGD',
      type: 'Расходы',
      amount: 1.85,
      merchant: 'SimplyGo MRT',
      where: 'SimplyGo MRT',
      notes: ''
    }
  ];

  const matchResB = findMissing(stmtSubsetA, ledgerB);
  assertEq(matchResB.matched.length, 1, 'Match Case B: exactly 1 matched row');
  assertEq(matchResB.matched[0].cardholder, 'Val', 'Match Case B: matched row is Val');
  assertEq(matchResB.missing.length, 1, 'Match Case B: exactly 1 missing row (proposal for Grandparents)');
  assertEq(matchResB.missing[0].cardholder, 'Grandparents', 'Match Case B: proposal is for Grandparents');
  assertEq(matchResB.ambiguous.length, 0, 'Match Case B: ZERO ambiguous rows (disambiguation succeeded!)');

  // --- PART 3: Grandparents Column J (Notes) Tagging & Staging Test ---
  Logger.log('\n--- 3. Grandparents Column J (Notes) Tagging & Staging Test ---');
  let stagedData = [];
  let stagedBackgrounds = [];
  const mockRange = {
    setValues: (v) => { if (v[0].length === 12) stagedData = v; return mockRange; },
    setFontWeight: () => mockRange,
    setBackground: () => mockRange,
    setFontColor: () => mockRange,
    setHorizontalAlignment: () => mockRange,
    setNumberFormat: () => mockRange,
    insertCheckboxes: () => mockRange,
    setDataValidation: () => mockRange,
    setBackgrounds: (b) => { stagedBackgrounds = b; return mockRange; },
    getFormula: () => '=F-D',
    getValues: () => stagedData
  };

  let transData = [
    ['01.08.2026', 'DBS CC SGD', 'Расходы', 10.0, 10.0, 100.0, 90.0, 'Другое', 'Prev Row', '', 'Wants']
  ];
  const transRange = {
    getValues: () => transData,
    setValues: (v) => { transData = transData.concat(v); return transRange; },
    getFormula: () => '=F-D',
    getFormulas: () => [['=F-D', '=F-D']],
    copyTo: () => {}
  };

  const merchantsData = [];
  const merchantsRange = {
    setValues: () => merchantsRange,
    getValues: () => merchantsData,
    setFontWeight: () => merchantsRange,
    setBackground: () => merchantsRange,
    setFontColor: () => merchantsRange
  };

  const mockSs = {
    getSheetByName: (name) => {
      if (name === 'Transactions') {
        return {
          getName: () => 'Transactions',
          getLastRow: () => transData.length,
          getLastColumn: () => 11,
          getRange: () => transRange,
          deleteRow: () => {}
        };
      }
      if (name === 'Merchants') {
        return {
          getName: () => 'Merchants',
          getLastRow: () => 1,
          getLastColumn: () => 5,
          getRange: () => merchantsRange,
          deleteRow: () => {}
        };
      }
      if (name === '-' || name === 'Reference') {
        return null;
      }
      return {
        getName: () => '_Reconcile',
        clear: () => {},
        clearConditionalFormatRules: () => {},
        getRange: () => mockRange,
        getLastRow: () => stagedData.length + 1,
        getLastColumn: () => 12,
        getMaxRows: () => 100,
        setFrozenRows: () => {},
        setColumnWidth: () => {}
      };
    },
    insertSheet: (name) => mockSs.getSheetByName(name || '_Reconcile')
  };

  const gpProposal = {
    date: '15.08.2026',
    amount: 1.85,
    merchant: 'SimplyGo MRT',
    card_last4: '0465',
    cardholder: 'Grandparents',
    type: 'Расходы'
  };
  const valProposal = {
    date: '15.08.2026',
    amount: 45.50,
    merchant: 'NTUC FairPrice',
    card_last4: '4320',
    cardholder: 'Val',
    type: 'Расходы'
  };
  const ritaProposal = {
    date: '18.08.2026',
    amount: 22.30,
    merchant: 'Watsons',
    card_last4: '7509',
    cardholder: 'Rita',
    type: 'Расходы'
  };

  stageProposals([gpProposal, valProposal, ritaProposal], [], mockSs, []);
  assertEq(stagedData.length, 3, 'Staged 3 proposals (Grandparents, Val, Rita)');

  // In 12-column layout:
  // Col 1: ✓, Col 2: date, Col 3: account, Col 4: Cardholder (r[3]), Col 5: type, Col 6: amount,
  // Col 7: merchant, Col 8: category, Col 9: bucket, Col 10: confidence, Col 11: source_row (r[10]), Col 12: status
  const gpRow = stagedData.find(r => r[3] === 'Grandparents');
  const valRow = stagedData.find(r => r[3] === 'Val');
  const ritaRow = stagedData.find(r => r[3] === 'Rita');

  assertEq(Boolean(gpRow), true, 'Found Grandparents staged row');
  assertEq(Boolean(valRow), true, 'Found Val staged row');
  assertEq(Boolean(ritaRow), true, 'Found Rita staged row');

  assertEq(gpRow[3], 'Grandparents', 'Grandparents row has "Grandparents" in Column 4 (Cardholder)');
  assertEq(valRow[3], 'Val', 'Val row has "Val" in Column 4 (Cardholder)');
  assertEq(ritaRow[3], 'Rita', 'Rita row has "Rita" in Column 4 (Cardholder)');

  assertEq(gpRow[10].includes('[Grandparents - Card 0465]'), true, 'Grandparents source_row tagged with [Grandparents - Card 0465]');
  assertEq(valRow[10].includes('Grandparents'), false, 'Val source_row does NOT mention Grandparents');
  assertEq(ritaRow[10].includes('Grandparents'), false, 'Rita source_row does NOT mention Grandparents');

  // Verify distinct soft lavender tint for Grandparents row
  const gpIdx = stagedData.indexOf(gpRow);
  assertEq(stagedBackgrounds[gpIdx][0], '#f5f3ff', 'Grandparents row receives distinct soft lavender tint (#f5f3ff)');

  // --- PART 4: Per-Card Breakdown Calculation Test ---
  Logger.log('\n--- 4. Per-Card Breakdown Test ---');
  const breakdown = computeCardholderBreakdown(
    parsed.rows,
    [parsed.rows[0], parsed.rows[2]], // matched: Val, Rita
    [parsed.rows[4]],                 // proposals: Grandparents
    [],                               // ambiguous: 0
    []                                // excluded: 0
  );

  assertEq(breakdown['Val'].parsed, 2, 'Val parsed count = 2');
  assertEq(breakdown['Val'].matched, 1, 'Val matched count = 1');
  assertEq(breakdown['Rita'].parsed, 2, 'Rita parsed count = 2');
  assertEq(breakdown['Rita'].matched, 1, 'Rita matched count = 1');
  assertEq(breakdown['Grandparents'].parsed, 2, 'Grandparents parsed count = 2');
  assertEq(breakdown['Grandparents'].proposals, 1, 'Grandparents proposals count = 1');

  // --- PART 5: 68 / 63 / 25 Cardholder Table Verification ---
  Logger.log('\n--- 5. 68 / 63 / 25 Cardholder Table Verification ---');
  const mock156Rows = [];
  for (let i = 0; i < 68; i++) {
    mock156Rows.push({ cardholder: 'Val', card_last4: '4320', card_type: 'main' });
  }
  for (let i = 0; i < 63; i++) {
    mock156Rows.push({ cardholder: 'Rita', card_last4: '7509', card_type: 'supplementary' });
  }
  for (let i = 0; i < 25; i++) {
    mock156Rows.push({ cardholder: 'Grandparents', card_last4: '0465', card_type: 'supplementary' });
  }
  assertEq(mock156Rows.length, 156, 'Total simulated parsed rows = 156');

  const cb156 = computeCardholderBreakdown(mock156Rows, [], [], [], []);
  assertEq(cb156['Val'].parsed, 68, 'Val shows exactly 68 rows in per-card table');
  assertEq(cb156['Rita'].parsed, 63, 'Rita shows exactly 63 rows in per-card table');
  assertEq(cb156['Grandparents'].parsed, 25, 'Grandparents shows exactly 25 rows in per-card table');
  assertEq(cb156['Other'].parsed, 0, 'Other shows exactly 0 rows (no cards misplaced into Other)');

  // --- PART 6: End-to-End commitStaged() Dry Run & Column J Verification ---
  Logger.log('\n--- 6. End-to-End commitStaged() Dry Run & Column J Verification ---');
  // Tick all 3 staged rows for commit
  stagedData[0][0] = true;
  stagedData[1][0] = true;
  stagedData[2][0] = true;

  const commitRes = commitStaged(false, true, mockSs); // dryRun = true
  assertEq(commitRes.dryRun, true, 'commitStaged executed in DRY RUN mode');
  assertEq(commitRes.committedCount, 3, 'commitStaged committed 3 rows in dry run');
  assertEq(commitRes.rows2D.length, 3, 'commitStaged produced 3 2D rows for Transactions');

  // Locate the rows by merchant
  const gpDryTxn = commitRes.rows2D.find(r => /simplygo/i.test(r[8]));
  const valDryTxn = commitRes.rows2D.find(r => /fair\s*price/i.test(r[8]));
  const ritaDryTxn = commitRes.rows2D.find(r => /watsons/i.test(r[8]));

  assertEq(Boolean(gpDryTxn), true, 'Found Grandparents dry run row');
  assertEq(Boolean(valDryTxn), true, 'Found Val dry run row');
  assertEq(Boolean(ritaDryTxn), true, 'Found Rita dry run row');

  // Grandparents 11-column inspection:
  // [A:Дата, B:Счёт, C:Тип, D:Сумма, E:Сумма в SGD, F:До, G:После, H:Категория, I:Где, J:Notes, K:50/30/20]
  assertEq(gpDryTxn.length, 11, 'Grandparents dry-run row has exactly 11 columns');
  assertEq(gpDryTxn[0], '15.08.2026', 'GP Col A (Дата) is "15.08.2026"');
  assertEq(gpDryTxn[1], 'DBS CC SGD', 'GP Col B (Счёт) is "DBS CC SGD"');
  assertEq(gpDryTxn[2], 'Расходы', 'GP Col C (Тип) is "Расходы"');
  assertClose(Number(gpDryTxn[3]), 1.85, 0.01, 'GP Col D (Сумма) is 1.85');
  assertEq(/^=IF\(D\d+="";"";D\d+\)$/.test(gpDryTxn[4]), true, 'GP Col E (Сумма в SGD) is a row formula from D');
  assertEq(gpDryTxn[5], '', 'GP Col F (До) is empty formula placeholder');
  assertEq(gpDryTxn[6], '', 'GP Col G (После) is empty formula placeholder');
  assertEq(Boolean(gpDryTxn[7]), true, 'GP Col H (Категория) is populated');
  assertEq(gpDryTxn[8], 'SimplyGo MRT', 'GP Col I (Где) is "SimplyGo MRT"');
  assertEq(gpDryTxn[9], 'Grandparents', 'GP Col J (Notes) is TAGGED WITH "Grandparents"');
  assertEq(/^=IF\(H\d+="";"";IFNA\(VLOOKUP\(H\d+;'-'!\$B:\$C;2;FALSE\);"UNKNOWN"\)\)$/.test(gpDryTxn[10]), true,
    'GP Col K (50/30/20) is a category lookup formula');

  // Val and Rita Column J confirmation:
  assertEq(valDryTxn[9], '', 'Val Col J (Notes) is CONFIRMED EMPTY ""');
  assertEq(ritaDryTxn[9], '', 'Rita Col J (Notes) is CONFIRMED EMPTY ""');

  // Also verify dryRunCommitSample on mockSs
  const samples = dryRunCommitSample(mockSs);
  assertEq(samples.Grandparents.columns11[9], 'Grandparents', 'dryRunCommitSample Grandparents row Col J is "Grandparents"');
  assertEq(samples.Val.columns11[9], '', 'dryRunCommitSample Val row Col J is ""');
  assertEq(samples.Rita.columns11[9], '', 'dryRunCommitSample Rita row Col J is ""');

  Logger.log('\n✅ All test_dbsMultiSectionAndCardholderMatching tests passed.');
  Logger.log('=== test_dbsMultiSectionAndCardholderMatching() Execution Finished ===');
}

/**
 * UNIT TEST SUITE: Generalized Location Suffix Stripping, Gateway Prefixes,
 * Canonical Merchant Resolution, and Multi-Factor Matching.
 */
function test_locationSuffixStrippingAndMultiFactorMatching() {
  Logger.log('====================================================');
  Logger.log('  TEST: test_locationSuffixStrippingAndMultiFactorMatching()');
  Logger.log('====================================================\n');

  // --- PART 1: Country & City Suffix Stripping Regressions ---
  Logger.log('--- 1. Location & Country Suffix Normalisation ---');
  assertEq(normaliseWhere('2C2*LAZADA SINGAPORE SG'), 'lazada', 'Stripped "SINGAPORE SG" -> "lazada"');
  assertEq(normaliseWhere('SEPHORA SINGAPORE'), 'sephora', 'Stripped "SINGAPORE" -> "sephora"');
  assertEq(normaliseWhere('NTUC FAIRPRICE SGP'), 'fairprice', 'Stripped "SGP" -> "fairprice"');
  assertEq(normaliseWhere('LAZADA SG'), 'lazada', 'Stripped "SG" -> "lazada"');
  assertEq(normaliseWhere('HOTEL BANGKOK TH'), 'hotel', 'Stripped "BANGKOK TH" -> "hotel"');
  assertEq(normaliseWhere('CAFE SYDNEY AU'), 'cafe', 'Stripped "SYDNEY AU" -> "cafe"');
  assertEq(normaliseWhere('STORE BEIJING CN'), 'store', 'Stripped "CN" -> "store"');
  assertEq(normaliseWhere('PUB DUBLIN IE'), 'pub', 'Stripped "DUBLIN IE" -> "pub"');
  assertEq(normaliseWhere('RETAILER SEATTLE US'), 'retailer', 'Stripped "SEATTLE US" -> "retailer"');
  assertEq(normaliseWhere('SPOTIFY STOCKHOLM SE'), 'spotify', 'Stripped "STOCKHOLM SE" -> "spotify"');

  // Brand protection: "Toys R Us"
  assertEq(normaliseWhere('TOYS R US'), 'toys r us', 'Preserved brand "toys r us"');

  // --- PART 2: Gateway Prefix Normalisation ---
  Logger.log('\n--- 2. Gateway Prefix Normalisation ---');
  assertEq(normaliseWhere('GOPAY-GOJEK'), 'gojek', 'Stripped "GOPAY-" -> "gojek"');
  assertEq(normaliseWhere('GRABPAY*FOOD MERCHANT'), 'food merchant', 'Stripped "GRABPAY*" -> "food merchant"');
  assertEq(normaliseWhere('PAYNOW*CLINIC SERVICES'), 'clinic services', 'Stripped "PAYNOW*" -> "clinic services"');
  assertEq(normaliseWhere('2C2*LAZADA'), 'lazada', 'Stripped "2C2*" -> "lazada"');
  assertEq(normaliseWhere('SPL AUTO TOPUP (CBT)'), 'auto topup (cbt)', 'Stripped "SPL " -> "auto topup (cbt)"');

  // --- PART 3: Canonical Merchant Resolution ---
  Logger.log('\n--- 3. Canonical Merchant Resolution ---');
  assertEq(resolveCanonicalMerchant('SPL AUTO TOPUP (CBT)'), 'simplygo', 'SPL AUTO TOPUP -> "simplygo"');
  assertEq(resolveCanonicalMerchant('SimplyGo Auto Topup'), 'simplygo', 'SimplyGo Auto Topup -> "simplygo"');
  assertEq(resolveCanonicalMerchant('POPULAR-POS 1'), 'popular bookstores', 'POPULAR-POS 1 -> "popular bookstores"');
  assertEq(resolveCanonicalMerchant('Popular Bookstores'), 'popular bookstores', 'Popular Bookstores -> "popular bookstores"');
  assertEq(resolveCanonicalMerchant('JASONS MARKET PLACE-RA'), 'cold storage', 'JASONS MARKET PLACE-RA -> "cold storage"');
  assertEq(resolveCanonicalMerchant('Cold Storage'), 'cold storage', 'Cold Storage -> "cold storage"');
  assertEq(resolveCanonicalMerchant('AMZNPRIMESG MEMBERSHI'), 'amazon prime', 'AMZNPRIMESG MEMBERSHI -> "amazon prime"');
  assertEq(resolveCanonicalMerchant('Amazon Prime'), 'amazon prime', 'Amazon Prime -> "amazon prime"');

  // --- PART 4: Soft Cardholder Scoring & Compatibility ---
  Logger.log('\n--- 4. Soft Cardholder Scoring & Compatibility ---');
  const itemVal = { cardholder: 'Val' };
  const itemRita = { cardholder: 'Rita' };
  const itemGP = { cardholder: 'Grandparents' };
  const itemEmptyLedger = { cardholder: '' };

  assertEq(isCardholderCompatible(itemVal, itemEmptyLedger), true, 'Val statement compatible with empty ledger');
  assertEq(isCardholderCompatible(itemGP, itemEmptyLedger), true, 'Grandparents statement compatible with empty ledger');
  assertEq(isCardholderCompatible(itemVal, itemVal), true, 'Val statement compatible with Val ledger');
  assertEq(isCardholderCompatible(itemVal, itemRita), false, 'Val statement NOT compatible with Rita ledger');
  assertEq(isCardholderCompatible(itemGP, itemVal), false, 'Grandparents statement NOT compatible with Val ledger');

  assertClose(computeCardholderScore(itemVal, itemVal), 0.15, 0.001, 'Same cardholder scores +0.15');
  assertClose(computeCardholderScore(itemVal, itemRita), -0.20, 0.001, 'Conflicting cardholder scores -0.20');
  assertClose(computeCardholderScore(itemVal, itemEmptyLedger), 0.00, 0.001, 'Empty ledger cardholder scores neutral 0.00');
  assertClose(computeCardholderScore(itemGP, itemEmptyLedger), 0.00, 0.001, 'Grandparents vs empty ledger scores neutral 0.00');

  // --- PART 5: End-to-End Matching of the 7 Target Cases ---
  Logger.log('\n--- 5. End-to-End Matching of 7 Target Cases ---');
  const statementBatch = [
    { date: '13.08.2026', amount: 20.00, merchant: 'SPL AUTO TOPUP (CBT)', cardholder: 'Val' },
    { date: '13.08.2026', amount: 20.34, merchant: 'POPULAR-POS 1', cardholder: 'Val' },
    { date: '15.08.2026', amount: 19.98, merchant: '2C2*LAZADA SINGAPORE SG', cardholder: 'Val' },
    { date: '15.08.2026', amount: 100.99, merchant: '2C2*LAZADA SINGAPORE SG', cardholder: 'Val' },
    { date: '15.08.2026', amount: 20.80, merchant: 'GOPAY-GOJEK', cardholder: 'Val' },
    { date: '16.08.2026', amount: 101.75, merchant: 'JASONS MARKET PLACE-RA', cardholder: 'Val' },
    { date: '16.08.2026', amount: 4.99, merchant: 'AMZNPRIMESG MEMBERSHI', cardholder: 'Val' }
  ];

  const ledgerBatch = [
    { row_index: 1790, date: '13.08.2026', amount: 20.00, where: 'SimplyGo Auto Topup', category: 'Транспорт', notes: '' },
    { row_index: 1791, date: '13.08.2026', amount: 20.34, where: 'Popular Bookstores', category: 'Образование', notes: '' },
    { row_index: 1811, date: '15.08.2026', amount: 19.98, where: 'Lazada SG', category: 'Дом', notes: '' },
    { row_index: 1812, date: '15.08.2026', amount: 100.99, where: 'Lazada SG', category: 'Дом', notes: '' },
    { row_index: 1823, date: '15.08.2026', amount: 20.80, where: 'Gojek', category: 'Транспорт', notes: '' },
    { row_index: 1824, date: '16.08.2026', amount: 101.75, where: 'Cold Storage', category: 'Продукты', notes: '' },
    { row_index: 1834, date: '16.08.2026', amount: 4.99, where: 'Amazon Prime', category: 'Подписки', notes: '' }
  ];

  const matchResult = findMissing(statementBatch, ledgerBatch);

  assertEq(matchResult.matched.length, 7, 'All 7 target cases matched successfully');
  assertEq(matchResult.missing.length, 0, 'No missing rows remaining among the 7 target cases');
  assertEq(matchResult.ambiguous.length, 0, 'No ambiguous rows among the 7 target cases');

  // Verify each individual match
  const matchSimplyGo = matchResult.matched.find(m => Math.abs(m.amount - 20.00) < 0.01);
  assertEq(Boolean(matchSimplyGo && matchSimplyGo.matched_ledger.where === 'SimplyGo Auto Topup'), true, 'SPL AUTO TOPUP matched SimplyGo Auto Topup');

  const matchPopular = matchResult.matched.find(m => Math.abs(m.amount - 20.34) < 0.01);
  assertEq(Boolean(matchPopular && matchPopular.matched_ledger.where === 'Popular Bookstores'), true, 'POPULAR-POS 1 matched Popular Bookstores');

  const matchLazada1 = matchResult.matched.find(m => Math.abs(m.amount - 19.98) < 0.01);
  assertEq(Boolean(matchLazada1 && matchLazada1.matched_ledger.where === 'Lazada SG'), true, 'Lazada S$19.98 matched Lazada SG');

  const matchLazada2 = matchResult.matched.find(m => Math.abs(m.amount - 100.99) < 0.01);
  assertEq(Boolean(matchLazada2 && matchLazada2.matched_ledger.where === 'Lazada SG'), true, 'Lazada S$100.99 matched Lazada SG');

  const matchGojek = matchResult.matched.find(m => Math.abs(m.amount - 20.80) < 0.01);
  assertEq(Boolean(matchGojek && matchGojek.matched_ledger.where === 'Gojek'), true, 'GOPAY-GOJEK matched Gojek');

  const matchColdStorage = matchResult.matched.find(m => Math.abs(m.amount - 101.75) < 0.01);
  assertEq(Boolean(matchColdStorage && matchColdStorage.matched_ledger.where === 'Cold Storage'), true, 'JASONS MARKET PLACE matched Cold Storage');

  const matchAmazon = matchResult.matched.find(m => Math.abs(m.amount - 4.99) < 0.01);
  assertEq(Boolean(matchAmazon && matchAmazon.matched_ledger.where === 'Amazon Prime'), true, 'AMZNPRIMESG matched Amazon Prime');

  Logger.log('Location/matching assertions completed; see runner summary for pass/fail.');
  Logger.log('=== test_locationSuffixStrippingAndMultiFactorMatching() Finished ===');
}





/** Date storage stays sortable across months and preserves the sheet calendar day. */
function test_reconcileDateValues() {
  assertEq(reconcileDateSerial('31.08.2026') + 1, reconcileDateSerial('01.09.2026'), 'Month boundary sorts chronologically');
  assertEq(reconcileDateSerial('31.12.2026') + 1, reconcileDateSerial('01.01.2027'), 'Year boundary sorts chronologically');
  assertEq(reconcileDateSerial('28.02.2024') + 1, reconcileDateSerial('29.02.2024'), 'Leap day is retained');
  assertEq(reconcileDateString(reconcileDateSerial('09.07.2026')), '09.07.2026', 'Serial round trip preserves date');
  assertEq(reconcileDateSerial(''), '', 'Blank date stays blank');
  const singapore = { getSpreadsheetTimeZone: function() { return 'Asia/Singapore'; } };
  const losAngeles = { getSpreadsheetTimeZone: function() { return 'America/Los_Angeles'; } };
  const instant = new Date('2026-08-31T16:00:00Z');
  assertEq(reconcileDateString(instant, singapore), '01.09.2026', 'Date reads use Singapore sheet timezone');
  assertEq(reconcileDateString(instant, losAngeles), '31.08.2026', 'Date reads use western sheet timezone');
  let rejected = false;
  try { reconcileDateSerial('31.02.2026'); } catch (error) { rejected = true; }
  assertEq(rejected, true, 'Invalid dates cannot silently roll into the next month');
}
