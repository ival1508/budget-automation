/** User-reported false proposals: run directly or through runAllTests(). No I/O. */
function test_reportedMerchantDuplicates() {
  const cases = [
    ['17.08.2026', 15.74, 'REDSHIELDVPN REDSHIELDVPN. NY USD 11.90', 'Redshield VPN (autorenew is off)'],
    ['17.08.2026', 8.90, 'FR VIVO WESTERN BOY SINGAPORE SG', 'Food republic'],
    ['18.08.2026', 375.66, 'SP DIGITAL PL-UTILITIE SINGAPORE SG', 'SPGroup'],
    ['18.08.2026', 8.90, 'FR VIVO-RUI FENG KOREA SINGAPORE SG', 'Food republic'],
    ['19.08.2026', 12.00, 'FR VIVO-SERGENT CHICKE SINGAPORE SG', 'Food republic'],
    ['20.08.2026', 2.10, 'F&N FOODS PTE LTD SINGAPORE SG', 'Vending machine'],
    ['20.08.2026', 1.70, 'ATLAS VENDING SINGAPORE SG', 'Vending machine'],
    ['21.08.2026', 108.78, 'NTUC FAIRPRICE APP PAY SINGAPORE SG', 'Unity'],
    ['21.08.2026', 30.50, 'GV ONLINE SINGAPORE SG', 'Golden Village'],
    ['21.08.2026', 31.80, 'GV VIVOCITY SINGAPORE SG', 'Golden Village']
  ];
  const statements = cases.map((r, i) => ({ id: i, date: r[0], amount: r[1], merchant: r[2], raw_merchant: r[2], account: 'DBS CC SGD', cardholder: i === 7 ? 'Val' : 'Rita' }));
  const ledger = cases.map((r, i) => ({ row_index: i + 2, date: r[0], amount: r[1], where: r[3], account: 'DBS CC SGD', notes: '' }));
  for (const rows of [statements, statements.slice().reverse(), normalizeRows(statements).map((row, id) => ({ ...row, id }))]) {
    const result = findMissing(rows, ledger, {});
    assertEq(result.matched.length, cases.length, 'All ten reported duplicates match in raw, reversed and normalized input');
    assertEq(result.missing.length, 0, 'None of the reported duplicates become proposals');
    assertEq(result.ambiguous.length, 0, 'Confirmed relationships resolve these unique occurrences');
    result.matched.forEach(match => assertEq(match.matched_ledger.row_index, match.id + 2, 'Correct ledger occurrence, not just correct count'));
  }
  const stmt = statements[1];
  const crossAccount = findMissing([stmt], [{ ...ledger[1], account: 'Citibank CC' }]);
  assertEq(crossAccount.matched.length, 0, 'Venue relationship cannot cross accounts');
  assertEq(crossAccount.missing.length, 1, 'Other-account purchase remains missing');
  const conflict = findMissing([stmt], [{ ...ledger[1], notes: 'Val' }]);
  assertEq(conflict.matched.length, 0, 'Venue relationship cannot cross named cardholders');
  const competing = findMissing([stmt, { ...stmt, id: 99, raw_merchant: 'FR VIVO-OTHER STALL', merchant: 'FR VIVO-OTHER STALL' }], [ledger[1]]);
  assertEq(competing.matched.length, 0, 'Two stalls cannot claim one Food Republic ledger row');
  assertEq(competing.ambiguous.length, 2, 'Competing stalls require review');
  const unknown = findMissing([{ ...stmt, merchant: 'Unrecognized vendor', raw_merchant: 'Unrecognized vendor' }], [ledger[1]]);
  assertEq(unknown.matched.length, 0, 'Date and amount alone never auto-match');
  assertEq(unknown.ambiguous.length, 1, 'Unknown same-day merchant surfaces as possible duplicate');
  assertEq(unknown.ambiguous[0].candidates[0].row_index, 3, 'Possible duplicate includes ledger row reference');
  const wrongAmount = findMissing([{ ...stmt, amount: 9.90 }], [ledger[1]]);
  assertEq(wrongAmount.missing.length, 1, 'Different amount remains genuinely missing');
  const otherDay = findMissing([{ ...statements[7], date: '22.08.2026' }], [ledger[7]]);
  assertEq(otherDay.matched.length, 0, 'Unity app-pay relationship requires exact transaction day');
  assertEq(resolveCanonicalMerchant('Unity'), 'unity', 'Unity is not globally renamed FairPrice');
}

/** Identical FlashPay names must match before category/display enrichment. */
function test_netsFlashpayDuplicate() {
  const statement = { date: '28.08.2026', account: 'DBS CC SGD', amount: 50, cardholder: 'Val',
    merchant: 'NETS FLASHPAY TOP-UP SINGAPORE SGP', raw_merchant: 'NETS FLASHPAY TOP-UP SINGAPORE SGP', type: 'Расходы' };
  const ledger = { date: '28.08.2026', account: 'DBS CC SGD', amount: 50, where: 'NETS Flashpay Top-up', notes: '', row_index: 1900 };
  for (const rows of [[statement], normalizeRows([statement])]) {
    const result = findMissing(rows, [ledger], {});
    assertEq(result.matched.length, 1, 'FlashPay matches the existing ledger occurrence');
    assertEq(result.missing.length, 0, 'FlashPay is never proposed when the occurrence is available');
  }
}

/** A same-merchant candidate must stay visible after another row claims it. */
function test_claimedLedgerDuplicateReview() {
  const ledger = { date: '28.08.2026', account: 'DBS CC SGD', amount: 50, where: 'NETS Flashpay Top-up', row_index: 1900 };
  const exact = { date: ledger.date, account: ledger.account, amount: 50, cardholder: 'Val', merchant: ledger.where };
  const variant = { ...exact, merchant: 'NETS Flashpay Top-up purchase' };
  for (const rows of [[exact, variant], [variant, exact]]) {
    const result = findMissing(rows, [ledger]);
    assertEq(result.matched.length, 1, 'One ledger occurrence is matched only once');
    assertEq(result.missing.length, 0, 'A claimed same-day merchant collision is not a clean proposal');
    assertEq(result.ambiguous.length, 1, 'Extra possible duplicate is retained for review');
    assertEq(result.ambiguous[0].match_type, 'ambiguous_claimed_ledger', 'Allocation conflict has an explicit reason');
    assertEq(result.ambiguous[0].candidates[0].already_claimed, true, 'Reviewer sees the prior allocation');
    assertEq(result.ambiguous[0].candidates[0].claimed_by.merchant, exact.merchant, 'Reviewer sees which statement row claimed the ledger row');
  }
}

/** Missing card metadata must stop DBS reconciliation before any sheet access. */
function test_statementCardIdentityGuard() {
  let rejectedNative = false;
  try { assertStatementFileMime('application/vnd.google-apps.spreadsheet'); }
  catch (e) { rejectedNative = /original bank CSV/.test(e.message); }
  assertEq(rejectedNative, true, 'Reject implicit Google Sheets export');
  let rejectedMissingCards = false;
  const sheet = { getSheetByName: function() { throw new Error('Unexpected sheet access'); } };
  try {
    reconcileAndStage({ account: 'DBS CC SGD', rows: [
      { date: '09.09.2026', amount: 10, merchant: 'Merchant', account: 'DBS CC SGD' }
    ] }, sheet);
  } catch (e) { rejectedMissingCards = /no card number/.test(e.message); }
  assertEq(rejectedMissingCards, true, 'Reject DBS rows without card identity before sheet reads/writes');
}
