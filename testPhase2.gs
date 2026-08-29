/**
 * Budget 2026 Automation v1 - Phase 2 AI Extraction Verification Suite
 * File: testPhase2.gs
 * 
 * Run this test directly inside Google Apps Script editor using runPhase2Tests().
 * Before running: ensure Script Properties has GEMINI_API_KEY set.
 */

function runPhase2Tests() {
  Logger.log('=== Starting Phase 2 Integration Tests (AI Extraction Layer) ===');

  // 1. Check GEMINI_API_KEY prerequisite
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error(
      'MISSING GEMINI_API_KEY!\n' +
      'Please go to Google Apps Script Editor -> Project Settings (gear icon) -> Script Properties,\n' +
      'and add property key "GEMINI_API_KEY" with your Google AI Studio API key.'
    );
  }
  Logger.log('✅ GEMINI_API_KEY is present in Script Properties.');

  // 2. Build SGT Date Test Context
  const now = new Date();
  const sgtOffset = 8 * 60 * 60 * 1000;
  const sgtDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + sgtOffset);
  const day = String(sgtDate.getDate()).padStart(2, '0');
  const month = String(sgtDate.getMonth() + 1).padStart(2, '0');
  const year = sgtDate.getFullYear();
  const todayStr = `${day}.${month}.${year}`;

  const testContext = {
    todayDate: todayStr,
    defaultAccount: 'DBS CC SGD'
  };
  Logger.log(`Context initialized. Target Today Date: ${todayStr}`);

  // --------------------------------------------------------------------------
  // TEST CASE 1: Multi-transaction Text Dump (§3 S3, §6.1)
  // --------------------------------------------------------------------------
  Logger.log('\n--- TEST CASE 1: Text Dump Parsing ("grab 14.20 needs, lunch guzman 22, spotify 12.10, dbs cc") ---');
  const textInput1 = 'grab 14.20 needs, lunch guzman 22, spotify 12.10, dbs cc';
  
  const results1 = extractTransactions([textInput1], testContext);
  Logger.log(`Test Case 1 Extracted Output:\n${JSON.stringify(results1, null, 2)}`);

  // Assertions for Test Case 1
  Logger.log('\n[Verifications - Test Case 1]:');
  Logger.log(`  - Returned item count: ${results1.length} (Expected: 3) -> ${results1.length === 3 ? '✅ PASS' : '❌ FAIL'}`);

  results1.forEach((txn, i) => {
    Logger.log(`  - Item ${i + 1} (${txn.where}):`);
    Logger.log(`      Currency: "${txn.currency}" (Expected: "SGD") -> ${txn.currency === 'SGD' ? '✅ PASS' : '❌ FAIL'}`);
    Logger.log(`      Date: "${txn.date}" (Expected: "${todayStr}") -> ${txn.date === todayStr ? '✅ PASS' : '❌ FAIL'}`);
    Logger.log(`      Category: "${txn.category}"`);
    Logger.log(`      50/30/20 Bucket: "${txn.bucket}" (Determined via enrichTransaction) -> ${txn.bucket ? '✅ PASS' : '❌ FAIL'}`);
    Logger.log(`      Dedupe Key: "${txn.dedupe_key.substring(0, 16)}..." -> ${txn.dedupe_key ? '✅ PASS' : '❌ FAIL'}`);
  });

  // --------------------------------------------------------------------------
  // TEST CASE 2: Foreign Currency & Reimbursable Flag (§4.4, §4.5)
  // --------------------------------------------------------------------------
  Logger.log('\n--- TEST CASE 2: Foreign Currency & Reimbursable Flag ("hotel tokyo 15000 JPY (вернуть с Wise)") ---');
  const textInput2 = 'hotel tokyo 15000 JPY (вернуть с Wise)';

  const results2 = extractTransactions([textInput2], testContext);
  Logger.log(`Test Case 2 Extracted Output:\n${JSON.stringify(results2, null, 2)}`);

  // Assertions for Test Case 2
  Logger.log('\n[Verifications - Test Case 2]:');
  if (results2.length > 0) {
    const edgeTxn = results2[0];
    Logger.log(`  - Currency: "${edgeTxn.currency}" (Expected: "JPY") -> ${edgeTxn.currency === 'JPY' ? '✅ PASS' : '❌ FAIL'}`);
    Logger.log(`  - Needs Review: ${edgeTxn.needs_review} (Expected: true) -> ${edgeTxn.needs_review === true ? '✅ PASS' : '❌ FAIL'}`);
    Logger.log(`  - Flags: ${JSON.stringify(edgeTxn.flags)}`);
    const hasReimbursableFlag = edgeTxn.flags && (edgeTxn.flags.includes('reimbursable') || edgeTxn.flags.includes('foreign_currency'));
    Logger.log(`  - Reimbursable/Foreign Flag Present -> ${hasReimbursableFlag ? '✅ PASS' : '❌ FAIL'}`);
    Logger.log(`  - 50/30/20 Bucket: "${edgeTxn.bucket}" -> ${edgeTxn.bucket ? '✅ PASS' : '❌ FAIL'}`);
  } else {
    Logger.log('  ❌ FAIL: Test Case 2 returned no items.');
  }

  Logger.log('\n=== Phase 2 AI Extraction Tests Completed ===');
}

/**
 * Test Runner: Simulates Gemini PDF extraction and verifies 
 * deduplication diff logic against the active ledger.
 */
function testReconcilerDiffEngine() {
  Logger.log('=== Running testReconcilerDiffEngine() ===');
  
  // Helper for date formatting
  const formatTestDate = (cellDate) => {
    if (cellDate instanceof Date) {
      return Utilities.formatDate(cellDate, 'Asia/Singapore', 'dd.MM.yyyy');
    }
    return String(cellDate || '').trim();
  };

  // 1. Dynamically pull a REAL transaction from your sheet to test the duplicate catcher
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Transactions');
  const lastRow = sheet ? sheet.getLastRow() : 0;
  let realRowData = ['15.07.2026', 'DBS CC SGD', 'Расходы', 10.0, 10.0, '', '', 'Extra fund', 'NETS*FAIRPRICE'];
  if (sheet && lastRow > 1) {
    realRowData = sheet.getRange(lastRow, 1, 1, 9).getValues()[0];
  }
  
  // Extract values using existing helpers
  const realDate = formatTestDate(realRowData[0]); 
  const realAccount = String(realRowData[1] || 'DBS CC SGD').trim();
  const realAmount = Number(realRowData[3]) || Number(realRowData[4]) || 0;
  const realWhere = String(realRowData[8] || realRowData[7] || 'Unknown').trim();
  
  Logger.log(`Simulating PDF Extraction of real row: ${realDate} | ${realAccount} | $${realAmount} | ${realWhere}`);

  // 2. Mock extracted transactions
  const mockExtractedFromPdf = [
    {
      // This should be caught as a DUPLICATE and filtered out
      date: realDate,
      account: realAccount,
      type: 'Расход', 
      amount: realAmount,
      currency: 'SGD',
      where: realWhere,
      category: 'Extra fund' 
    },
    {
      // This should be caught as MISSING and flagged for review
      date: '28.07.2026',
      account: 'DBS CC SGD',
      type: 'Расход',
      amount: 999.99,
      currency: 'SGD',
      where: 'MOCK MISSING MERCHANT STORE', 
      category: 'Extra fund' 
    }
  ];

  // 3. Enrich mock items to generate dedupe keys
  const categoryBucketMap = typeof getCategoryBucketMap === 'function' ? getCategoryBucketMap() : null;
  const enrichedMock = mockExtractedFromPdf.map(item => enrichTransaction(item, categoryBucketMap));
  
  // 4. Run Diff Engine
  const missingTransactions = getMissingTransactions(enrichedMock);
  
  Logger.log(`Total Extracted: ${enrichedMock.length}`);
  Logger.log(`Missing Items Identified: ${missingTransactions.length}`);
  
  // 5. Assertions
  if (missingTransactions.length === 1 && missingTransactions[0].where === 'MOCK MISSING MERCHANT STORE') {
    Logger.log('✅ PASS: Diff engine successfully filtered out the real transaction and caught the fake one!');
  } else {
    Logger.log('❌ FAIL: Diff engine output did not match expected count/item.');
    Logger.log('Missing Payload:\n' + JSON.stringify(missingTransactions, null, 2));
  }
}
