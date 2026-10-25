const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/month-template.json'), 'utf8'));
const serial = date => (Date.parse(date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000;
// Captured live formula structure, with synthetic income/plan inputs; no private ledger.
module.exports = test => {
  test('Stage 6B: November preview preserves input and contains all seven exact change ranges', c => {
    const s=fixture(), before=JSON.stringify(s), p=c.buildMonthCreationPlan(s,2026,11);
    assert.equal(JSON.stringify(s),before);
    assert.equal(p.target.name,'Ноябрь'); assert.equal(p.target.days,30); assert.equal(p.source,"Октябрь'26");
    assert.deepEqual(Array.from(p.edits,e=>e.range),['B1','B3:B4','B5','B6','I38','G3:G13','I2:I32']);
    assert.equal(p.edits[0].value,46327); assert.equal(p.edits[4].formula,'=H38<=$D$1');
    assert.equal(p.salary.entries[0].amount,32360); assert.equal(p.edits[1].formulas.length,2); assert.equal(p.edits[5].formulas.length,11); assert.equal(p.edits[6].formulas.length,31);
  });
  test('Stage 6B: derives compensation from ledger income and replaces stale light-income inputs', c => {
    for (const templateValue of [99000, '#REF!', '']) {
      const s = fixture(), source = s.sheets[0];
      source.values[2][1] = templateValue;
      source.formulas[2][1] = '=99000';
      source.values[4][1] = 4000;
      source.values[5][1] = 2000;
      source.formulas[5][1] = '=1500+500';
      const before = JSON.stringify(s), plan = c.buildMonthCreationPlan(s, 2026, 11);
      const salary = plan.edits.find(edit => edit.range === 'B3:B4');
      const balance = plan.edits.find(edit => edit.range === 'B5');
      const extra = plan.edits.find(edit => edit.range === 'B6');
      assert.deepEqual(Array.from(plan.salary.entries, e => e.amount), [32360, 13220]);
      assert.equal(salary.values, undefined);
      assert.equal(salary.formulas.length, 2);
      assert.equal(balance.value, 0);
      assert.ok(extra.formula.startsWith('=IFERROR(LET('));
      assert.equal(plan.lightIncome.amount, 0);
      assert.equal(JSON.stringify(s), before);
      s.transactions[0].amountSgd = 32000;
      assert.equal(plan.salary.entries[0].amount, 32360);
    }
  });
  test('Stage 6B: salaries add employer CPF only, preserve E13 and never gross up provisional totals twice', c => {
    const s = fixture(), p = c.buildMonthCreationPlan(s, 2026, 11);
    const [valera, rita] = p.salary.entries;
    assert.equal(valera.cashAmount, 31000); assert.equal(valera.cpf.employerPercent, 17);
    assert.equal(valera.cpf.employeePercent, 20); assert.equal(valera.cpf.amount, 1360);
    assert.equal(rita.cashAmount, 12500); assert.equal(rita.cpf.employerPercent, 9);
    assert.equal(rita.cpf.employeePercent, 15); assert.equal(rita.cpf.amount, 720);
    assert.equal(valera.amount-valera.cashAmount, 1360);assert.equal(rita.amount-rita.cashAmount, 720);
    assert.ok(p.preserve.includes('D3:F13')); assert.ok(!p.edits.some(e=>e.range==='E13'));
    s.transactions = [];
    const fallback = c.buildMonthCreationPlan(s, 2026, 11);
    assert.deepEqual(Array.from(fallback.salary.entries, e=>e.amount), [30000, 12000]);
    assert.ok(fallback.salary.entries.every(e=>e.cashAmount===null));
    s.sheets[0].formulas[12][4] = '=0';
    assert.throws(()=>c.buildMonthCreationPlan(s, 2026, 11), /Unsupported CPF plan at E13/);
  });
  test('Stage 6B: B6 totals quarter-to-date light income with type aliases and signed corrections', c => {
    const s = fixture();
    const row = (day, type, amount, source='Test income') => ({row:s.transactions.length+2,date:serial(day),type,amountSgd:amount,source});
    s.transactions.push(row('2026-10-01','Доходы - лёгкие деньги',10.10));
    s.transactions.push(row('2026-10-10','Доход - Лёгкие деньги',20.20));
    s.transactions.push(row('2026-10-20',' доходы – легкие деньги ',-2.05));
    s.transactions.push(row('2026-10-25','ДОХОДЫ — ЛЁГКИЕ ДЕНЬГИ',1,'<img src=x>'));
    for(const day of ['2026-09-30','2026-10-26','2027-01-01'])s.transactions.push(row(day,'Доходы - лёгкие деньги',99999));
    for(const type of ['Доходы','Доходы - премия','Получение денег','Доходы - лёгкие деньги - премия'])s.transactions.push(row('2026-10-10',type,99999));
    const p = c.buildMonthCreationPlan(s,2026,11);
    assert.equal(p.lightIncome.amount,29.25); assert.equal(p.lightIncome.transactions.length,4);
    assert.equal(p.lightIncome.period.quarter,4); assert.equal(p.lightIncome.period.through,'2026-10-25');
    assert.ok(p.edits.find(e=>e.range==='B6').formula);
    const html = c.buildMonthCreationPreviewHtml(p);
    assert.ok(html.includes('Light income: 2026 Q4'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));
  });
  test('Stage 6B: light-income quarter boundaries, closed quarters and SGT day boundaries are exact', c => {
    for(const firstMonth of [1,4,7,10]) {
      const pad=n=>String(n).padStart(2,'0');
      const first=`2026-${pad(firstMonth)}-01`;
      const last=`2026-${pad(firstMonth+2)}-${new Date(Date.UTC(2026,firstMonth+2,0)).getUTCDate()}`;
      const tx=(date,amount)=>({row:2,date,type:'Доходы - лёгкие деньги',amountSgd:amount,source:'Test income'});
      const rows=[tx(serial(first),10),tx(serial(last),20),tx(serial(first)-1,999),tx(serial(last)+1,999)];
      assert.equal(c.buildMonthCreationLightIncome(rows,2026,firstMonth,serial('2027-01-01')).amount,30);
      assert.equal(c.buildMonthCreationLightIncome(rows,2026,firstMonth,serial(first)-1).amount,0);
    }
    const tx=date=>({row:2,date,type:'Доход - Лёгкие деньги',amountSgd:10,source:'Test income'});
    const rows=[tx(vm.runInContext("new Date('2026-09-30T16:00:00Z')",c)),tx(vm.runInContext("new Date('2026-09-30T15:59:00Z')",c))];
    assert.equal(c.buildMonthCreationLightIncome(rows,2026,11,serial('2026-10-01')).amount,10);
  });
  test('Stage 6B: malformed light-income evidence blocks the plan while empty and negative totals remain factual', c => {
    for(const amount of ['',null,'10',NaN,Infinity]) {
      const s=fixture();s.transactions.push({row:4,date:serial('2026-10-02'),type:'Доходы - лёгкие деньги',amountSgd:amount,source:'Test income'});
      const p=c.buildMonthCreationPlan(s,2026,11);
      assert.equal(p.status,'blocked');assert.equal(p.edits.length,0);
      assert.match(p.lightIncome.blockers.join(' '),/Invalid light-income SGD amount/);
    }
    const rows=[{row:2,date:serial('2026-10-02'),type:'Доходы - лёгкие деньги',amountSgd:-5,source:'Correction'}];
    assert.equal(c.buildMonthCreationLightIncome(rows,2026,11,serial('2026-10-25')).amount,-5);
    assert.equal(c.buildMonthCreationLightIncome([],2026,11,serial('2026-10-25')).amount,0);
    rows[0].date='invalid';
    assert.match(c.buildMonthCreationLightIncome(rows,2026,11,serial('2026-10-25')).blockers.join(' '),/Invalid light-income date/);
  });
  test('Stage 6B: B6 formula selects the target quarter through today using bounded SGD ledger ranges', c => {
    const f=c.monthCreationLightIncomeFormula();
    assert.match(f,/DATE\(YEAR\(\$B\$1\);INT\(\(MONTH\(\$B\$1\)-1\)\/3\)\*3\+1;1\)/);
    assert.match(f,/MIN\(EDATE\(start;3\);TODAY\(\)\+1\)/);
    assert.match(f,/\(dates>=start\)\*\(dates<end\)/);
    assert.match(f,/amounts;Transactions!\$E\$2:/);
    assert.ok(f.includes('^доходы?\\s*[-–—]\\s*легкие\\s+деньги$'));
    assert.match(f,/IF\(bad>0;NA\(\);cents\/100\)/);
  });
  test('Stage 6B: salary lookup excludes other income types, employers and calendar months', c => {
    const s = fixture(), salary = s.transactions[0];
    for (const [i, type] of ['Доходы - премия', 'Доходы - лёгкие деньги', 'Получение денег', 'Расходы'].entries()) {
      s.transactions.push({ ...salary, row: 10 + i, type, amountSgd: 99999 });
    }
    for (const date of ['2026-09-30', '2026-11-01', '2025-10-22']) s.transactions.push({ ...salary, date: serial(date), amountSgd: 99999 });
    s.transactions.push({ ...salary, source: 'NotGoogle salary', amountSgd: 99999 });
    s.transactions.push({ ...salary, source: 'Other employer', amountSgd: 99999 });
    salary.type = ' Доходы '; salary.source = 'GOOGLE Singapore';
    const p = c.buildMonthCreationPlan(s, 2026, 11);
    assert.equal(p.status, 'preview');
    assert.deepEqual(Array.from(p.salary.entries, e => e.amount), [32360, 13220]);
    assert.equal(p.salary.entries[0].transactions.length, 1);
  });
  test('Stage 6B: salary lookup sums split income and net corrections in cents', c => {
    const s = fixture(), salary = s.transactions[0];
    salary.amountSgd = 20000.10;
    s.transactions.push({ ...salary, row: 4, amountSgd: 10000.20 });
    s.transactions.push({ ...salary, row: 5, amountSgd: -100.10 });
    const p = c.buildMonthCreationPlan(s, 2026, 11);
    assert.equal(p.salary.entries[0].amount, 31260.20);
    assert.deepEqual(Array.from(p.salary.entries[0].transactions, t => t.row), [2, 4, 5]);
    const correction = fixture();
    correction.transactions.push({ ...correction.transactions[0], row: 4, amountSgd: -0.005 });
    assert.equal(c.buildMonthCreationPlan(correction, 2026, 11).salary.entries[0].amount, 32359.99);
    for (const amount of [0, -1]) {
      const rows = fixture().transactions; rows[0].amountSgd = amount;
      assert.equal(c.buildMonthCreationSalaries(rows, 2026, 11).ready, false);
    }
  });
  test('Stage 6B: salary formulas use the same month, employer, SGD and fallback policy', c => {
    const p = c.buildMonthCreationPlan(fixture(), 2026, 11);
    const [valera, rita] = p.edits[1].formulas.map(row => row[0]);
    assert.match(valera, /dates>=EDATE\(\$B\$1;-1\)/);
    assert.match(valera, /dates<\$B\$1/);
    assert.match(valera, /LOWER\(TRIM\(types\)\)="доходы"/);
    assert.ok(valera.includes('"\\bgoogle\\b"'));
    assert.ok(rita.includes('"\\bkaspersky\\b"'));
    assert.match(valera, /amounts;Transactions!\$E\$2:/);
    assert.match(valera, /sources;Transactions!\$I\$2:/);
    assert.match(valera, /IF\(count=0;3000000\/100;/);
    assert.match(rita, /IF\(count=0;1200000\/100;/);
    assert.match(valera, /\(cents\+136000\)\/100/);
    assert.match(rita, /\(cents\+72000\)\/100/);
    assert.match(valera, /IF\(bad>0;NA\(\)/);
    const entry = { ...p.salary.entries[0], fallback: { amount: 12345.67 } };
    assert.match(c.monthCreationSalaryFormula(entry), /1234567\/100/);
    delete entry.fallback;
    assert.match(c.monthCreationSalaryFormula(entry), /IF\(count=0;NA\(\);/);
  });
  test('Stage 6B: missing salary uses a visible provisional template amount until income is logged', c => {
    const s = fixture(), rita = s.transactions.pop();
    const p = c.buildMonthCreationPlan(s, 2026, 11);
    assert.equal(p.status, 'preview'); assert.equal(p.edits.length, 7);
    assert.equal(p.salary.entries[0].amount, 32360);
    assert.equal(p.salary.entries[1].amount, 12000);
    assert.equal(p.salary.entries[1].status, 'provisional');
    assert.equal(p.salary.entries[1].fallback.cell, 'B4');
    assert.equal(p.salary.provisional, true);
    assert.match(p.salary.warnings.join(' '), /Kaspersky.*2026-10.*provisional.*B4/);
    assert.match(c.buildMonthCreationPreviewHtml(p), /Provisional template amount/);
    s.transactions.push(rita);
    const updated = c.buildMonthCreationPlan(s, 2026, 11);
    assert.equal(updated.salary.entries[1].amount, 13220);
    assert.equal(updated.salary.entries[1].basis, 'ledger');
    assert.equal(updated.salary.provisional, false);
    s.transactions = [];
    assert.equal(c.buildMonthCreationPlan(s, 2026, 11).salary.entries.filter(e => e.status === 'provisional').length, 2);
    for (const invalid of ['', '#REF!', -1, Infinity]) {
      s.sheets[0].values[2][1] = invalid;
      const blocked = c.buildMonthCreationPlan(s, 2026, 11);
      assert.equal(blocked.status, 'blocked'); assert.equal(blocked.edits.length, 0);
      assert.match(c.buildMonthCreationPreviewHtml(blocked), /income lookup incomplete/);
    }
  });
  test('Stage 6B: malformed salary evidence and ambiguous employers block the plan', c => {
    for (const amount of ['', null, '31000', '#REF!', Infinity, NaN]) {
      const s = fixture(); s.transactions[0].amountSgd = amount;
      const p = c.buildMonthCreationPlan(s, 2026, 11);
      assert.equal(p.status, 'blocked'); assert.equal(p.edits.length, 0);
      assert.match(p.salary.blockers.join(' '), /Invalid salary SGD amount.*row 2/);
    }
    const s = fixture(); s.transactions[0].date = 'not a date';
    assert.match(c.buildMonthCreationPlan(s, 2026, 11).salary.blockers.join(' '), /Invalid salary date/);
    s.transactions[0].date = serial('2026-10-22'); s.transactions[0].source = 'Google / Kaspersky';
    assert.match(c.buildMonthCreationPlan(s, 2026, 11).salary.blockers.join(' '), /Ambiguous salary employer/);
    delete s.transactions;
    assert.throws(() => c.buildMonthCreationPlan(s, 2026, 11), /salary history is required/);
  });
  test('Stage 6B: salary period uses SGT dates and the immediately preceding calendar month', c => {
    const s = fixture(); s.transactions[0].date = vm.runInContext("new Date('2026-09-30T16:00:00Z')", c);
    s.transactions.push({ ...s.transactions[0], row: 4, date: vm.runInContext("new Date('2026-09-30T15:59:00Z')", c), amountSgd: 99999 });
    s.sheets[0].name = "Сентябрь'26"; s.sheets[0].anchor = 46266;
    const p = c.buildMonthCreationPlan(s, 2026, 11);
    assert.equal(p.source, "Сентябрь'26"); assert.equal(p.salary.period.month, 10);
    assert.equal(p.salary.entries[0].amount, 32360);
    const january = fixture().transactions.map(t => ({ ...t, date: serial('2025-12-31') }));
    assert.equal(c.buildMonthCreationSalaries(january, 2026, 1).period.year, 2025);
    assert.equal(c.buildMonthCreationSalaries(january, 2026, 1).ready, true);
  });
  test('Stage 6B: existing legacy and yearless targets are no-ops, even without template formulas', c => {
    for(const name of ["Октябрь'26",'Октябрь']) {
      const s=fixture();s.sheets[0].name=name;s.sheets[0].formulas=[];delete s.transactions;
      const p=c.buildMonthCreationPlan(s,2026,10);assert.equal(p.status,'exists');assert.equal(p.edits.length,0);
    }
  });
  test('Stage 6B: rejects duplicate aliases, wrong dates, cross-year and missing earlier template', c => {
    const s=fixture();s.sheets.push({...s.sheets[0],name:'Октябрь'});
    assert.throws(()=>c.buildMonthCreationPlan(s,2026,11),/Multiple tabs/);
    const wrong=fixture();wrong.sheets[0].anchor=46266;
    assert.throws(()=>c.buildMonthCreationPlan(wrong,2026,11),/mismatch/);
    assert.throws(()=>c.buildMonthCreationPlan(fixture(),2027,1),/Cross-year/);
    assert.throws(()=>c.buildMonthCreationPlan(fixture(),2026,9),/No earlier/);
    assert.throws(()=>c.buildMonthCreationPlan(fixture(),2026,13),/integer/);
  });
  test('Stage 6B: picks latest prior month and ignores named copies', c => {
    const s=fixture();const prior=JSON.parse(JSON.stringify(s.sheets[0]));prior.name="Сентябрь'26";prior.anchor=46266;
    s.sheets.unshift(prior);s.sheets.push({name:"Октябрь'26 (копия)"});
    assert.equal(c.buildMonthCreationPlan(s,2026,11).source,"Октябрь'26");
    assert.equal(c.monthCreationIdentity('Январь').month,1);assert.equal(c.monthCreationIdentity("Я'26").month,1);
    assert.equal(c.monthCreationIdentity('Calendar'),null);
  });
  test('Stage 6B: date calculations cover leap, short and long months', c => {
    assert.equal(c.monthCreationPeriod(2028,2).days,29);assert.equal(c.monthCreationPeriod(2026,2).days,28);
    assert.equal(c.monthCreationPeriod(2026,4).days,30);assert.equal(c.monthCreationPeriod(2026,12).days,31);
  });
  test('Stage 6B: drift in spending, helper, description, status and planned amounts blocks preview', c => {
    for(const mutate of [
      t=>{t.formulas[1][9]='=0';},t=>{t.formulas[38][8]='=TRUE';},
      t=>{t.formulas[1][8]='="manual"';},t=>{t.formulas[2][6]='=TRUE';},
      t=>{t.values[2][4]='';},t=>{t.values[3][3]=t.values[2][3];},
      t=>{t.values[2][0]='other';},t=>{t.values[36][7]='other';}
    ]){const s=fixture();mutate(s.sheets[0]);assert.throws(()=>c.buildMonthCreationPlan(s,2026,11));}
  });
  test('Stage 6B: status formulas expose partial/refund arithmetic, exclusions and data failures', c => {
    const p=c.buildMonthCreationPlan(fixture(),2026,11), formulas=p.edits.find(e=>e.range==='G3:G13').formulas;
    assert.match(formulas[10][0],/label;LOWER\(TRIM\(D13\)\)/);
    assert.match(formulas[10][0],/label="cpf";"Не отслеживается"/);
    assert.match(formulas[2][0],/Проверьте категорию/);
    const f=formulas[0][0];assert.match(f,/MIN\(\$D\$1;TODAY\(\)\)/);assert.match(f,/ROUND\(plan\*100;0\)-paid/);
    assert.match(f,/Частично/);assert.match(f,/Данные недоступны/);assert.match(f,/ISNUMBER\(amounts\)/);
    assert.match(f,/ROWS\(Transactions!\$A:\$A\)/);assert.match(f,/LOWER\(TRIM\(cats\)\)/);
  });
  test('Stage 6B: description formulas retain all occurrences, refunds and spending exclusions', c => {
    const f=c.monthCreationDescriptionFormula(32);
    assert.match(f,/dates=H32/);assert.match(f,/types="Расходы"/);assert.match(f,/cats<>"Отложения"/);assert.match(f,/cats<>"Аренда"/);
    assert.match(f,/H32>TODAY/);assert.match(f,/Нет расходов/);assert.match(f,/TEXTJOIN/);assert.match(f,/FILTER/);
    assert.doesNotMatch(f,/UNIQUE|SORTN|amounts>0/);
  });
  test('Stage 6B: generated formula syntax has balanced parentheses and string literals', c => {
    const p=c.buildMonthCreationPlan(fixture(),2026,11);
    for(const edit of p.edits){for(const f of (edit.formulas||[[edit.formula]]).flat().filter(Boolean)){
      let depth=0,quoted=false;
      for(let i=0;i<f.length;i++){const ch=f[i];if(ch==='"'){if(quoted&&f[i+1]==='"'){i++;continue;}quoted=!quoted;}else if(!quoted){if(ch==='(')depth++;if(ch===')')depth--;assert.ok(depth>=0,f);}}
      assert.equal(depth,0,f);assert.equal(quoted,false,f);
    }}
  });
  test('Stage 6B: read adapter and editor preview require no write-capable services', c => {
    const s=fixture(); const t=s.sheets[0];
    const headers = ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где'];
    const ledger = {getMaxRows:()=>2566, getLastRow:()=>s.transactions.length + 1,
      getRange:(...args)=>{
        if (args[0] === 'A1:I1') return {getValues:()=>[headers]};
        assert.deepEqual(args, [2, 1, s.transactions.length, 9]);
        return {getValues:()=>s.transactions.map(t=>[t.date, '', t.type, '', t.amountSgd, '', '', 'Дом', t.source])};
      }};
    const ss={getSheetByName:name=>name==='Transactions'?ledger:null,getSheets:()=>[{
      getName:()=>t.name,getSheetId:()=>t.id,getRange:a=>{assert.equal(a,'A1:L70');return {getValues:()=>t.values,getFormulas:()=>t.formulas};}
    }]};
    const p=c.previewMonthCreation(2026,11,ss);assert.equal(p.status,'preview');
    assert.equal(p.salary.entries[1].amount, 13220);
    p.salary.entries[0].transactions[0].source = '<img src=x onerror=alert(1)>';
    p.source='<script>alert(1)</script>';const html=c.buildMonthCreationPreviewHtml(p);
    assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img'));
    headers[4] = 'Сумма';
    assert.throws(()=>c.readMonthCreationSnapshot(ss), /Unsupported Transactions header/);
  });
};
