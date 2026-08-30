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
