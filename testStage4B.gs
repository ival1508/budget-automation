/** PRD Part B acceptance fixture; no spreadsheet or external services needed. */
function test_mandatoryMatching() {
  const expected = [
    { name: 'Квартира', planned_amount: 2000 },
    { name: 'Авто', planned_amount: 800 },
    { name: 'CPF', planned_amount: 500 },
    { name: 'Родители', planned_amount: 0 }
  ];
  const logged = [{ category: 'Квартира', description: 'Mortgage payment', actual_amount: 2000 }];
  const result = matchMandatoryPayments(expected, logged);
  if (result.paid !== 1 || result.unpaid !== 1 || result.excluded !== 2 ||
      result.items.find(item => item.status === 'unpaid').name !== 'Авто') {
    throw new Error('Part B fixture failed: expected exactly one unpaid item (Авто).');
  }
  Logger.log('PASS test_mandatoryMatching: one paid, one unpaid, CPF and zero-planned Родители excluded.');
  return result;
}
