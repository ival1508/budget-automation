/**
 * Budget 2026 Automation v1 - Phase 1 Verification Suite
 * File: testPhase1.gs
 * 
 * Run this test directly inside Google Apps Script editor using runPhase1Tests().
 */

function runPhase1Tests() {
  Logger.log('=== Starting Phase 1 Integration Tests ===');

  // Step 1: Initialize Learning Store
  Logger.log('[1/4] Initializing Merchants Learning Store...');
  const merchantsSheet = initializeLearningStore();
  Logger.log(`✅ Learning Store initialized. Merchants sheet name: "${merchantsSheet.getName()}", isHidden: ${merchantsSheet.isSheetHidden()}`);

  // Step 2: Define mock test transactions
  const mockTransactions = [
    {
      date: '25.07.2026',
      account: 'DBS CC SGD',
      type: TYPES.EXPENSE,
      amount: 14.87,
      currency: 'SGD',
      where: 'NETS*FAIRPRICE',
      category: 'Продукты',
      source: 'test'
    },
    {
      date: '25.07.2026',
      account: 'DBS SGD',
      type: TYPES.INCOME_EASY, // Exact string: "Доходы - лёгкие деньги"
      amount: 22.00,
      currency: 'SGD',
      where: 'PayNow Refund',
      category: 'Другое',
      source: 'test'
    },
    {
      date: '25.07.2026',
      account: 'Citibank CC', // New account test
      type: TYPES.EXPENSE,
      amount: 100.00,
      currency: 'SGD',
      where: 'Amazon',
      category: 'Дом',
      source: 'test'
    }
  ];

  // Step 3: Enrich mock transactions
  Logger.log('[2/4] Enriching transactions with 50/30/20 buckets & dedupe keys...');
  const categoryBucketMap = typeof getCategoryBucketMap === 'function' ? getCategoryBucketMap() : null;
  const enrichedTransactions = mockTransactions.map((txn, index) => {
    const enriched = enrichTransaction(txn, categoryBucketMap);
    Logger.log(`  Row ${index + 1}: Category "${enriched.category}" -> Bucket "${enriched.bucket}" | Key: ${enriched.dedupe_key.substring(0, 12)}...`);
    return enriched;
  });

  // Step 4: Write to Transactions sheet
  Logger.log('[3/4] Writing enriched transactions to sheet...');
  const result = appendTransactions(enrichedTransactions);
  Logger.log(`✅ Write completed! Written: ${result.writtenCount}, Skipped (Duplicates): ${result.skippedCount}`);

  // Step 5: Log Manual Verification Instructions
  Logger.log('=== Phase 1 Execution Finished ===');
  Logger.log('[4/4] MANUAL VERIFICATION INSTRUCTIONS:');
  Logger.log('Please open your Google Sheet ("Budget 2026") and verify the following:');
  Logger.log('  1. Check tab "Merchants": Must be created and hidden with headers ["merchant", "category", "count", "last_seen"].');
  Logger.log('  2. Check tab "Transactions" new rows:');
  Logger.log('     - Columns D (Сумма) and E (Сумма в SGD) MUST contain numeric values (e.g. 14.87, 22, 100).');
  Logger.log('     - Formulas in F (На счете до) and G (На счете после) copied down from the row above.');
  Logger.log('     - Check Row 3 ("Citibank CC"): Column F MUST have literal value 0 (seed balance) instead of formula, and Column G MUST have a valid formula.');
  Logger.log('  3. Re-run runPhase1Tests(): Verification that idempotency skips all 3 rows (Written: 0, Skipped: 3).');
}
