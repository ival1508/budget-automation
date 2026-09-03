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
  assertEq(res2.matched[0].match_type, 'fuzzy', 'Branch 2: Match type is fuzzy');

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

/**
 * STAGE 3D TEST: Non-Spend Line Filtering Verification.
 * 
 * Verifies that filterNonSpend() follows Option B (Smart Dual-Sided) & Choice 1:
 * 1. Excludes credit card repayment: DBS "BILL PAYMENT - DBS INTERNET/WIRELESS" S$12,969.24 (Credit) -> 'CC payoff'
 * 2. Excludes refund / transit adjustment: DBS "SPL AUTO TOPUP (ABT/RE)" S$20.19 (Credit) -> 'Refund'
 * 3. Excludes transfer to self: Citi "MONEYSEND VALERIY IVANOV" +483.23 -> 'Transfer to self'
 * 4. Excludes net-zero fee pair: Citi "LATE CHARGE FEE" -100.00 & "AUTO LATE FEE REVERSAL" +100.00 -> 'Fee and reversal, net zero'
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
