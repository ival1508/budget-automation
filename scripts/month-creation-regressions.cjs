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
    assert.equal(p.salary.entries[0].amount,32360); assert.equal(p.edits[1].formulas.length,2); assert.equal(p.edits[5].values.length,11); assert.equal(p.edits[6].formulas.length,31);
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
  test('Stage 6B: B6 totals its own month-to-date income with type aliases and signed corrections', c => {
    const s = fixture();s.asOf=serial('2026-11-25');
    const row = (day, type, amount, source='Test income') => ({row:s.transactions.length+2,date:serial(day),type,amountSgd:amount,source});
    s.transactions.push(row('2026-11-01','Доходы - лёгкие деньги',10.10));
    s.transactions.push(row('2026-11-10','Доход - Лёгкие деньги',20.20));
    s.transactions.push(row('2026-11-20',' доходы – легкие деньги ',-2.05));
    s.transactions.push(row('2026-11-25','ДОХОДЫ — ЛЁГКИЕ ДЕНЬГИ',1,'<img src=x>'));
    for(const day of ['2026-10-31','2026-11-26','2026-12-01','2025-11-10'])s.transactions.push(row(day,'Доходы - лёгкие деньги',99999));
    for(const type of ['Доходы','Доходы - премия','Получение денег','Доходы - лёгкие деньги - премия'])s.transactions.push(row('2026-11-10',type,99999));
    const p = c.buildMonthCreationPlan(s,2026,11);
    assert.equal(p.lightIncome.amount,29.25); assert.equal(p.lightIncome.transactions.length,4);
    assert.equal(p.lightIncome.period.month,11); assert.equal(p.lightIncome.period.through,'2026-11-25');
    assert.ok(p.edits.find(e=>e.range==='B6').formula);
    const html = c.buildMonthCreationPreviewHtml(p);
    assert.ok(html.includes('Light income: 2026-11'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));
  });
  test('Stage 6B: light-income month boundaries, closed months and SGT day boundaries are exact', c => {
    for(const month of [1,2,3,4,5,6,7,8,9,10,11,12]) {
      const pad=n=>String(n).padStart(2,'0');
      const first=`2026-${pad(month)}-01`;
      const last=`2026-${pad(month)}-${new Date(Date.UTC(2026,month,0)).getUTCDate()}`;
      const tx=(date,amount)=>({row:2,date,type:'Доходы - лёгкие деньги',amountSgd:amount,source:'Test income'});
      const rows=[tx(serial(first),10),tx(serial(last),20),tx(serial(first)-1,999),tx(serial(last)+1,999)];
      assert.equal(c.buildMonthCreationLightIncome(rows,2026,month,serial('2027-01-01')).amount,30);
      const early=c.buildMonthCreationLightIncome(rows,2026,month,serial(first)-1);
      assert.equal(early.amount,0);assert.equal(early.period.through,null);
    }
    const tx=date=>({row:2,date,type:'Доход - Лёгкие деньги',amountSgd:10,source:'Test income'});
    const rows=[tx(vm.runInContext("new Date('2026-09-30T16:00:00Z')",c)),tx(vm.runInContext("new Date('2026-09-30T15:59:00Z')",c))];
    assert.equal(c.buildMonthCreationLightIncome(rows,2026,10,serial('2026-10-01')).amount,10);
    assert.equal(c.buildMonthCreationLightIncome(rows,2026,11,serial('2026-11-01')).amount,0);
    const leap=[tx(serial('2028-02-29'))];
    assert.equal(c.buildMonthCreationLightIncome(leap,2028,2,serial('2028-03-01')).amount,10);
  });
  test('Stage 6B: November B6 starts at zero and excludes October even when salary uses October', c => {
    const s=fixture();
    s.transactions.push({row:4,date:serial('2026-10-20'),type:'Доходы - лёгкие деньги',amountSgd:500,source:'October income'});
    const early=c.buildMonthCreationPlan(s,2026,11);
    assert.equal(early.salary.period.month,10);assert.equal(early.lightIncome.period.month,11);
    assert.equal(early.lightIncome.amount,0);
    s.asOf=serial('2026-11-30');
    s.transactions.push({row:5,date:serial('2026-11-20'),type:'Доходы - лёгкие деньги',amountSgd:350,source:'November income'});
    assert.equal(c.buildMonthCreationPlan(s,2026,11).lightIncome.amount,350);
  });
  test('Stage 6B: malformed light-income evidence blocks the plan while empty and negative totals remain factual', c => {
    for(const amount of ['',null,'10',NaN,Infinity]) {
      const s=fixture();s.asOf=serial('2026-11-25');s.transactions.push({row:4,date:serial('2026-11-02'),type:'Доходы - лёгкие деньги',amountSgd:amount,source:'Test income'});
      const p=c.buildMonthCreationPlan(s,2026,11);
      assert.equal(p.status,'blocked');assert.equal(p.edits.length,0);
      assert.match(p.lightIncome.blockers.join(' '),/Invalid light-income SGD amount/);
    }
    const rows=[{row:2,date:serial('2026-11-02'),type:'Доходы - лёгкие деньги',amountSgd:-5,source:'Correction'}];
    assert.equal(c.buildMonthCreationLightIncome(rows,2026,11,serial('2026-11-25')).amount,-5);
    assert.equal(c.buildMonthCreationLightIncome([],2026,11,serial('2026-11-25')).amount,0);
    rows[0].date='invalid';
    assert.match(c.buildMonthCreationLightIncome(rows,2026,11,serial('2026-11-25')).blockers.join(' '),/Invalid light-income date/);
  });
  test('Stage 6B: B6 formula selects the tab month through today using bounded SGD ledger ranges', c => {
    const f=c.monthCreationLightIncomeFormula();
    assert.match(f,/start;\$B\$1;/);
    assert.match(f,/MIN\(EDATE\(start;1\);TODAY\(\)\+1\)/);
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
  test('Stage 6B: G3:G13 is cleared to blank in plan while status formula builder retains partial/refund arithmetic', c => {
    const p=c.buildMonthCreationPlan(fixture(),2026,11), values=p.edits.find(e=>e.range==='G3:G13').values;
    assert.equal(values.length, 11);
    assert.ok(values.every(row => row[0] === ''));
    assert.match(c.monthCreationStatusFormula(13, 'CPF'),/label;LOWER\(TRIM\(D13\)\)/);
    assert.match(c.monthCreationStatusFormula(13, 'CPF'),/label="cpf";"Не отслеживается"/);
    assert.match(c.monthCreationStatusFormula(5, 'Родители'),/Проверьте категорию/);
    const f=c.monthCreationStatusFormula(3, 'Квартира');assert.match(f,/MIN\(\$D\$1;TODAY\(\)\)/);assert.match(f,/ROUND\(plan\*100;0\)-paid/);
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

  function buildSandboxWorkbook(c, s) {
    const headers = ['Дата', 'Счёт', 'Тип', 'Сумма', 'Сумма в SGD', 'На счете до', 'На счете после', 'Категория', 'Где'];
    let nextSheetId = 5000;
    const deletedNames = [];
    const parseA1 = a1 => {
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
      assert.ok(m, 'Unsupported A1 range in mock: ' + a1);
      const col = letters => letters.charCodeAt(0) - 64;
      const c1 = col(m[1]), r1 = Number(m[2]);
      const c2 = m[3] ? col(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1;
      return { r1, c1, rows: r2 - r1 + 1, cols: c2 - c1 + 1 };
    };
    const makeSheet = raw => {
      const state = {
        id: raw.id || (nextSheetId++),
        name: raw.name,
        values: JSON.parse(JSON.stringify(raw.values)),
        formulas: JSON.parse(JSON.stringify(raw.formulas)),
        notes: {},
        wraps: {},
        clearedValidations: [],
        renameHistory: [raw.name]
      };
      const sheetObj = {
        _state: state,
        getName: () => state.name,
        getSheetId: () => state.id,
        getLastRow: () => state.values.length,
        getLastColumn: () => (state.values[0] || []).length,
        setName: newName => {
          if (state.failOnFinalRename && !newName.startsWith('_MonthCreate_')) {
            throw new Error('Simulated rename failure');
          }
          state.name = newName;
          state.renameHistory.push(newName);
          return sheetObj;
        },
        copyTo: targetSs => {
          const clone = makeSheet({
            id: nextSheetId++,
            name: 'Copy of ' + state.name,
            values: state.values,
            formulas: state.formulas
          });
          clone._state.notes = JSON.parse(JSON.stringify(state.notes));
          if (state.onCopyMutate) state.onCopyMutate(clone);
          targetSs._sheets.push(clone);
          return clone;
        },
        getRange: (...args) => {
          const a1 = typeof args[0] === 'string' ? args[0] : null;
          if (a1 === 'A1:L70') {
            return {
              getValues: () => JSON.parse(JSON.stringify(state.values)),
              getFormulas: () => JSON.parse(JSON.stringify(state.formulas))
            };
          }
          const { r1, c1, rows, cols } = a1
            ? parseA1(a1)
            : { r1: Number(args[0]), c1: Number(args[1]), rows: Number(args[2] || 1), cols: Number(args[3] || 1) };
          const sliceValues = () => {
            const out = [];
            for (let r = 0; r < rows; r++) {
              const srcRow = state.values[r1 - 1 + r] || [];
              const rowArr = [];
              for (let colIdx = 0; colIdx < cols; colIdx++) {
                rowArr.push(srcRow[c1 - 1 + colIdx] !== undefined ? srcRow[c1 - 1 + colIdx] : '');
              }
              out.push(rowArr);
            }
            return out;
          };
          const sliceFormulas = () => {
            const out = [];
            for (let r = 0; r < rows; r++) {
              const srcRow = state.formulas[r1 - 1 + r] || [];
              const rowArr = [];
              for (let colIdx = 0; colIdx < cols; colIdx++) {
                rowArr.push(srcRow[c1 - 1 + colIdx] || '');
              }
              out.push(rowArr);
            }
            return out;
          };
          return {
            getValue: () => sliceValues()[0][0],
            getDisplayValue: () => String(sliceValues()[0][0] ?? ''),
            getValues: () => sliceValues(),
            getDisplayValues: () => sliceValues().map(r => r.map(v => String(v ?? ''))),
            getFormulas: () => sliceFormulas(),
            setValue: val => {
              state.values[r1 - 1][c1 - 1] = val;
              state.formulas[r1 - 1][c1 - 1] = '';
            },
            setValues: matrix => {
              for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                  state.values[r1 - 1 + r][c1 - 1 + c] = matrix[r][c];
                  state.formulas[r1 - 1 + r][c1 - 1 + c] = '';
                }
              }
            },
            setFormula: formula => {
              state.formulas[r1 - 1][c1 - 1] = formula;
              if (a1 === 'B6') state.values[r1 - 1][c1 - 1] = 0;
              if (a1 === 'I38') state.values[r1 - 1][c1 - 1] = true;
            },
            setFormulas: matrix => {
              for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                  const f = matrix[r][c];
                  state.formulas[r1 - 1 + r][c1 - 1 + c] = f;
                  if (a1 === 'B3:B4') {
                    state.values[r1 - 1 + r][c1 - 1 + c] = r === 0 ? 32360 : 13220;
                  } else if (a1 === 'G3:G13') {
                    state.values[r1 - 1 + r][c1 - 1 + c] = r === 10 ? 'Не отслеживается' : 'Не оплачено · осталось S$100.00';
                  } else if (a1 === 'I2:I32') {
                    state.values[r1 - 1 + r][c1 - 1 + c] = '';
                  }
                }
              }
            },
            clearDataValidations: () => { state.clearedValidations.push(a1); },
            setWrap: flag => { state.wraps[a1] = flag; },
            setNote: note => { state.notes[a1] = note; },
            clearNote: () => { delete state.notes[a1]; }
          };
        }
      };
      return sheetObj;
    };
    const sheets = s.sheets.map(makeSheet);
    const ledger = {
      getMaxRows: () => 2566,
      getLastRow: () => s.transactions.length + 1,
      getRange: (...args) => {
        if (args[0] === 'A1:I1') return { getValues: () => [headers] };
        return {
          getValues: () => s.transactions.map(t => [t.date, '', t.type, '', t.amountSgd, '', '', 'Дом', t.source])
        };
      }
    };
    const ss = {
      _sheets: sheets,
      _deletedNames: deletedNames,
      getId: () => vm.runInContext('SHEET_FACTS.TEST_SPREADSHEET_ID', c),
      getSheetByName: name => name === 'Transactions' ? ledger : (sheets.find(sh => sh.getName() === name) || null),
      getSheets: () => sheets.slice(),
      deleteSheet: sheetObj => {
        const idx = sheets.indexOf(sheetObj);
        if (idx >= 0) {
          deletedNames.push(sheetObj.getName());
          sheets.splice(idx, 1);
        }
      }
    };
    return ss;
  }

  test('Stage 6C: createMonthTab clones template under temp name, applies 7 edits, strips G checkboxes, wraps text and chains to December', c => {
    const s = fixture();
    // Make Rita's October salary missing so B4 is provisional (gets a review note) while B3 is ready (clears stale note).
    const ritaOct = s.transactions.pop();
    const ss = buildSandboxWorkbook(c, s);
    ss._sheets[0]._state.notes.B3 = 'Stale note from October';
    const octBefore = JSON.stringify(ss._sheets[0]._state.values);

    const res = c.createMonthTab(2026, 11, ss);
    assert.equal(res.status, 'created');
    assert.equal(res.created, true);
    assert.equal(res.sheetName, 'Ноябрь');
    assert.equal(res.source, "Октябрь'26");

    const nov = ss.getSheetByName('Ноябрь');
    assert.ok(nov);
    assert.ok(nov._state.renameHistory[1].startsWith('_MonthCreate_2026_11_'));
    assert.equal(nov._state.renameHistory[2], 'Ноябрь');
    assert.deepEqual(nov._state.clearedValidations, ['G3:G13']);
    assert.equal(nov._state.wraps['G3:G13'], undefined);
    assert.equal(nov._state.wraps['I2:I32'], true);
    assert.equal(nov._state.notes.B3, undefined);
    assert.match(nov._state.notes.B4, /Provisional salary baseline.*Kaspersky.*2026-10/);
    assert.equal(nov._state.values[0][1], 46327);
    assert.equal(nov._state.values[4][1], 0);
    assert.equal(nov._state.formulas[37][8], '=H38<=$D$1');
    assert.equal(JSON.stringify(ss._sheets[0]._state.values), octBefore);

    // Repeat call is an idempotent no-op.
    const repeat = c.createMonthTab(2026, 11, ss);
    assert.equal(repeat.status, 'exists');
    assert.equal(repeat.created, false);
    assert.equal(repeat.sheetName, 'Ноябрь');
    assert.equal(ss.getSheets().length, 2);

    // Chaining: create December using the generated v2 November tab as template!
    s.transactions.push(ritaOct);
    s.transactions.push({ row: 10, date: serial('2026-11-24'), type: 'Доходы', amountSgd: 31500, source: 'Google Singapore' });
    s.transactions.push({ row: 11, date: serial('2026-11-25'), type: 'Доходы', amountSgd: 12800, source: 'Kaspersky Lab' });
    const dec = c.createMonthTab(2026, 12, ss);
    assert.equal(dec.status, 'created');
    assert.equal(dec.source, 'Ноябрь');
    assert.equal(dec.sheetName, 'Декабрь');
    assert.equal(ss.getSheets().length, 3);

    // Partial or corrupted v2 formula in a generated template still blocks downstream creation.
    const decSheet = ss.getSheetByName('Декабрь');
    decSheet._state.formulas[5][6] = '=TRUE';
    assert.throws(() => c.validateMonthCreationTemplate({
      name: 'Декабрь',
      values: decSheet._state.values,
      formulas: decSheet._state.formulas
    }), /Unsupported existing G status at row 6/);
  });

  test('Stage 6C: enforces sandbox while creationEnabled is false, handles lock contention, and cleans up temp tab on failure without touching user tabs', c => {
    const s = fixture();
    const ss = buildSandboxWorkbook(c, s);
    const origEnabled = vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled', c);
    vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = false;', c);
    try {
      // Live creation explicitly refused while creationEnabled === false.
      assert.throws(() => c.createMonthTab(2026, 11, { spreadsheet: ss, sandbox: false }), /Live month creation is disabled/);

      // Wrong spreadsheet ID rejected before lock or sheet access.
      const wrongSs = { getId: () => 'live-id-not-sandbox', getSheetByName: () => { throw new Error('Should not read'); } };
      assert.throws(() => c.createMonthTab(2026, 11, wrongSs), /Sandbox spreadsheet identity does not match TEST_SPREADSHEET_ID/);

      // Blocked plan (malformed salary) throws without copying a sheet.
      const badSalary = fixture();
      badSalary.transactions[0].amountSgd = 'invalid';
      const badSs = buildSandboxWorkbook(c, badSalary);
      assert.throws(() => c.createMonthTab(2026, 11, badSs), /Month creation blocked/);
      assert.equal(badSs.getSheets().length, 1);
      assert.equal(badSs._deletedNames.length, 0);

      // Failure during verification (e.g. formula evaluation error '#VALUE!') deletes only the temp sheet.
      const errSs = buildSandboxWorkbook(c, fixture());
      errSs._sheets[0]._state.onCopyMutate = clone => {
        const origGetRange = clone.getRange;
        clone.getRange = a1 => {
          const r = origGetRange(a1);
          if (a1 === 'A1:L70') {
            return {
              getValues: () => {
                const v = r.getValues();
                v[2][1] = '#VALUE!';
                return v;
              },
              getFormulas: () => r.getFormulas()
            };
          }
          return r;
        };
      };
      assert.throws(() => c.createMonthTab(2026, 11, errSs), /Formula evaluation error at B3/);
      assert.equal(errSs.getSheets().length, 1);
      assert.equal(errSs.getSheets()[0].getName(), "Октябрь'26");
      assert.equal(errSs._deletedNames.length, 1);
      assert.match(errSs._deletedNames[0], /^_MonthCreate_2026_11_/);

      // Failure during final rename also cleans up temp sheet and never deletes an existing target tab.
      const raceSs = buildSandboxWorkbook(c, fixture());
      raceSs._sheets[0]._state.onCopyMutate = clone => {
        clone._state.failOnFinalRename = true;
      };
      assert.throws(() => c.createMonthTab(2026, 11, raceSs), /Simulated rename failure/);
      assert.equal(raceSs.getSheets().length, 1);
      assert.equal(raceSs._deletedNames.length, 1);

      // Concurrent target appearance before final rename cleans up only the temp tab and preserves the concurrent target tab.
      const concurrentSs = buildSandboxWorkbook(c, fixture());
      const userCreatedNov = { getName: () => 'Ноябрь', getSheetId: () => 9999 };
      concurrentSs._sheets[0]._state.onCopyMutate = () => {
        concurrentSs._sheets.push(userCreatedNov);
      };
      assert.throws(() => c.createMonthTab(2026, 11, concurrentSs), /Target sheet was created concurrently: Ноябрь/);
      assert.ok(concurrentSs.getSheets().includes(userCreatedNov));
      assert.equal(concurrentSs._deletedNames.length, 1);
      assert.match(concurrentSs._deletedNames[0], /^_MonthCreate_2026_11_/);

      // Lock contention rejects before any sheet reads or copies.
      const origLock = c.LockService;
      try {
        c.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => false, releaseLock: () => {} }) };
        assert.throws(() => c.createMonthTab(2026, 11, ss), /Budget write is busy/);
      } finally {
        c.LockService = origLock;
      }
    } finally {
      vm.runInContext(`SHEET_FACTS.monthTemplate.creationEnabled = ${Boolean(origEnabled)};`, c);
    }
  });

  test('Stage 6D: resolveMonthSheet and readers support yearless Ноябрь, reject B1 year mismatch and duplicate aliases, and reject status error strings in strict mandatory reads', c => {
    const ss = buildSandboxWorkbook(c, fixture());
    c.createMonthTab(2026, 11, ss);
    const novDate = vm.runInContext("new Date('2026-11-15T04:00:00Z')", c);

    // 1. resolveMonthSheet and getActiveMonthTab resolve yearless 'Ноябрь'
    const resolved = c.resolveMonthSheet(ss, novDate);
    assert.equal(resolved.tabName, 'Ноябрь');
    assert.ok(resolved.sheet);
    const active = c.getActiveMonthTab(ss, novDate);
    assert.equal(active.exists, true);
    assert.equal(active.tabName, 'Ноябрь');
    assert.equal(active.status, 'ACTIVE');

    // 2. getDailyPacing and getMandatoryExpenses read cleanly from yearless 'Ноябрь'
    const pacing = c.getDailyPacing(novDate, ss);
    assert.equal(pacing.error, undefined);
    assert.equal(pacing.days_left, 16);
    const mandatory = c.getMandatoryExpenses(ss, novDate, true);
    assert.equal(mandatory.length, 11);
    assert.equal(mandatory[0].is_checked, false);
    assert.equal(mandatory[10].label.toLowerCase(), 'cpf');
    assert.equal(mandatory[10].is_checked, true);

    // 3. Strict mandatory reader rejects Stage 6 status formula error strings ('Данные недоступны' / 'Проверьте категорию')
    const novSheet = ss.getSheetByName('Ноябрь');
    const savedG3 = novSheet._state.values[2][6];
    for (const badStatus of ['Данные недоступны', 'Проверьте категорию', '#NA']) {
      novSheet._state.values[2][6] = badStatus;
      assert.throws(() => c.getMandatoryExpenses(ss, novDate, true), /Unreadable mandatory completion flag/);
      const nonStrict = c.getMandatoryExpenses(ss, novDate, false);
      assert.equal(nonStrict[0].is_checked, false);
    }
    novSheet._state.values[2][6] = savedG3;

    // 4. B1 year mismatch on yearless tab is rejected
    novSheet._state.values[0][1] = serial('2025-11-01');
    assert.throws(() => c.resolveMonthSheet(ss, novDate), /Month tab name\/date mismatch: Ноябрь/);
    novSheet._state.values[0][1] = serial('2026-11-01');

    // 5. Duplicate legacy + yearless aliases for the same month are rejected
    ss._sheets.push({ getName: () => "Ноябрь'26", getSheetId: () => 8888 });
    assert.throws(() => c.resolveMonthSheet(ss, novDate), /Multiple tabs represent month 11/);
  });

  function setClock(c, iso) {
    if (!c.monthlyTestClockInstalled) {
      vm.runInContext(`const MonthlyOriginalDate = Date;
        Date = class extends MonthlyOriginalDate {
          constructor(...args) { super(...(args.length ? args : [monthlyTestEpoch])); }
          static now() { return monthlyTestEpoch; }
        };`, c);
      c.monthlyTestClockInstalled = true;
    }
    c.monthlyTestEpoch = Date.parse(iso);
  }

  test('Stage 6D: ensureMonthTab is disabled by default, recovers only the current SGT operational month when enabled, and keeps historical reads strictly read-only', c => {
    const ss = buildSandboxWorkbook(c, fixture());
    const prevEpoch = c.monthlyTestEpoch;
    setClock(c, '2026-11-15T04:00:00Z');
    const fixedNov15 = vm.runInContext("new Date('2026-11-15T04:00:00Z')", c);
    const sep15 = vm.runInContext("new Date('2026-09-15T04:00:00Z')", c);
    const dec15 = vm.runInContext("new Date('2026-12-15T04:00:00Z')", c);
    const propStore = {};
    const origProps = c.PropertiesService;

    try {
      c.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: k => propStore[k] || null,
          setProperty: (k, v) => { propStore[k] = String(v); },
          deleteProperty: k => { delete propStore[k]; }
        })
      };

      // 1. Default creationEnabled === false: getActiveMonthTab does not create Ноябрь
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = false;', c);
      const missingNov = c.getActiveMonthTab(ss, fixedNov15);
      assert.equal(missingNov.exists, false);
      assert.equal(ss.getSheetByName('Ноябрь'), null);

      // 2. Enable creationEnabled === true: historical and future months still never auto-create
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = true;', c);
      const missingSep = c.getActiveMonthTab(ss, sep15);
      assert.equal(missingSep.exists, false);
      assert.equal(ss.getSheetByName('Сентябрь'), null);
      assert.throws(() => c.getMandatoryExpenses(ss, sep15, true), /Mandatory plan sheet is unavailable/);
      const monthlySep = c.buildMonthlyCoachPayload(ss, sep15);
      assert.equal(monthlySep.error, 'missing_month');
      assert.equal(ss.getSheetByName('Сентябрь'), null);

      const missingDec = c.getActiveMonthTab(ss, dec15);
      assert.equal(missingDec.exists, false);
      assert.equal(ss.getSheetByName('Декабрь'), null);

      // 3. Read-only current month query also does not auto-create
      const readOnlyNov = c.getActiveMonthTab(ss, fixedNov15, { readOnly: true });
      assert.equal(readOnlyNov.exists, false);
      assert.equal(ss.getSheetByName('Ноябрь'), null);

      // 4. Operational current-month read (getActiveMonthTab / getDailyPacing) self-heals by creating Ноябрь
      const createdNov = c.getActiveMonthTab(ss, fixedNov15);
      assert.equal(createdNov.exists, true);
      assert.equal(createdNov.tabName, 'Ноябрь');
      assert.ok(ss.getSheetByName('Ноябрь'));
      assert.equal(propStore['month_created_2026-11'], 'Ноябрь');
    } finally {
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = true;', c);
      c.monthlyTestEpoch = prevEpoch;
      c.PropertiesService = origProps;
    }
  });

  test('Stage 6D: runScheduledMonthCreation creates next month as soon as the last day of the previous month starts in SGT, recovers missed current month, and skips cross-year', c => {
    const s = fixture();
    // Add November salaries so December can also be created on 30 November
    s.transactions.push(
      { row: 10, date: serial('2026-11-23'), type: 'Доходы', amountSgd: 31000, source: 'Google' },
      { row: 11, date: serial('2026-11-24'), type: 'Доходы', amountSgd: 12500, source: 'Kaspersky' }
    );
    const ss = buildSandboxWorkbook(c, s);
    const propStore = {};
    const origProps = c.PropertiesService;

    const oct30LateSgt = vm.runInContext("new Date('2026-10-30T15:59:00Z')", c);  // 2026-10-30 23:59 SGT (not last day)
    const oct31StartSgt = vm.runInContext("new Date('2026-10-30T16:00:00Z')", c); // 2026-10-31 00:00 SGT (start of last day!)
    const oct31NextHeartbeat = vm.runInContext("new Date('2026-10-30T16:15:00Z')", c); // 2026-10-31 00:15 SGT
    const nov30StartSgt = vm.runInContext("new Date('2026-11-29T16:00:00Z')", c); // 2026-11-30 00:00 SGT (start of last day of Nov)
    const dec31StartSgt = vm.runInContext("new Date('2026-12-30T16:00:00Z')", c); // 2026-12-31 00:00 SGT (start of last day of Dec)

    try {
      c.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: k => propStore[k] || null,
          setProperty: (k, v) => { propStore[k] = String(v); },
          deleteProperty: k => { delete propStore[k]; }
        })
      };

      // 1. Disabled when creationEnabled is false
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = false;', c);
      const disabledRes = c.runScheduledMonthCreation(oct31StartSgt, ss);
      assert.equal(disabledRes.status, 'disabled');
      assert.equal(ss.getSheetByName('Ноябрь'), null);

      // 2. Enabled: on 30 Oct 23:59 SGT (not yet the last day), does NOT create Ноябрь
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = true;', c);
      const oct30Res = c.runScheduledMonthCreation(oct30LateSgt, ss);
      assert.equal(oct30Res.status, 'ok');
      assert.equal(oct30Res.actions.length, 0);
      assert.equal(ss.getSheetByName('Ноябрь'), null);

      // 3. On 31 Oct 00:00 SGT (as soon as the last day of October starts), creates Ноябрь!
      const oct31Res = c.runScheduledMonthCreation(oct31StartSgt, ss);
      assert.equal(oct31Res.status, 'ok');
      assert.equal(oct31Res.actions.length, 1);
      assert.equal(oct31Res.actions[0].trigger, 'last_day_rollover');
      assert.equal(oct31Res.actions[0].status, 'created');
      assert.equal(oct31Res.actions[0].sheetName, 'Ноябрь');
      assert.ok(ss.getSheetByName('Ноябрь'));
      assert.equal(propStore['month_created_2026-11'], 'Ноябрь');

      // 4. Subsequent 15-minute heartbeats on 31 Oct are idempotent no-ops
      const repeatRes = c.runScheduledMonthCreation(oct31NextHeartbeat, ss);
      assert.equal(repeatRes.actions.length, 1);
      assert.equal(repeatRes.actions[0].status, 'exists');
      assert.equal(repeatRes.actions[0].created, false);

      // 5. On 30 Nov 00:00 SGT (as soon as the last day of November starts), chains from Ноябрь to create Декабрь
      const nov30Res = c.runScheduledMonthCreation(nov30StartSgt, ss);
      assert.equal(nov30Res.actions.length, 1);
      assert.equal(nov30Res.actions[0].trigger, 'last_day_rollover');
      assert.equal(nov30Res.actions[0].status, 'created');
      assert.equal(nov30Res.actions[0].sheetName, 'Декабрь');
      assert.equal(nov30Res.actions[0].source, 'Ноябрь');
      assert.ok(ss.getSheetByName('Декабрь'));
      assert.equal(propStore['month_created_2026-12'], 'Декабрь');

      // 6. On 31 Dec 00:00 SGT, skips cross-year January 2027 cleanly
      const dec31Res = c.runScheduledMonthCreation(dec31StartSgt, ss);
      assert.equal(dec31Res.actions.length, 1);
      assert.equal(dec31Res.actions[0].status, 'cross_year_skipped');
      assert.equal(dec31Res.actions[0].created, false);

      // 7. If 31 Oct rollover was missed and 1 Nov 00:05 SGT arrives without Ноябрь, current_month_recovery creates it
      const missedSs = buildSandboxWorkbook(c, fixture());
      const nov1StartSgt = vm.runInContext("new Date('2026-10-31T16:05:00Z')", c); // 2026-11-01 00:05 SGT
      const recoveryRes = c.runScheduledMonthCreation(nov1StartSgt, missedSs);
      assert.equal(recoveryRes.actions.length, 1);
      assert.equal(recoveryRes.actions[0].trigger, 'current_month_recovery');
      assert.equal(recoveryRes.actions[0].status, 'created');
      assert.equal(recoveryRes.actions[0].sheetName, 'Ноябрь');
      assert.ok(missedSs.getSheetByName('Ноябрь'));
    } finally {
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = true;', c);
      c.PropertiesService = origProps;
    }
  });

  test('Stage 6D: dispatch() invokes runScheduledMonthCreation on last-day heartbeat and isolates creation errors from Telegram deliveries', c => {
    const ss = buildSandboxWorkbook(c, fixture());
    const prevEpoch = c.monthlyTestEpoch;
    const origGetActiveSs = c.SpreadsheetApp.getActiveSpreadsheet;
    const origUsers = c.getActiveTelegramUsers;
    const origDeliver = c.deliverScheduledMessage;
    const origAlerts = c.runMandatorySameDayAlerts;
    const origScan = c.scanConfiguredStatementInbox;
    const deliveredKeys = [];

    try {
      setClock(c, '2026-10-30T16:00:00Z'); // 2026-10-31 00:00 SGT
      c.SpreadsheetApp.getActiveSpreadsheet = () => ss;
      c.getActiveTelegramUsers = () => [{ name: 'Val', chat_id: '96069960', morning_time: '08:00' }];
      c.deliverScheduledMessage = key => { deliveredKeys.push(key); return true; };
      c.runMandatorySameDayAlerts = () => {};
      c.scanConfiguredStatementInbox = () => {};
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = true;', c);

      // 1. At 00:00 SGT on 31 Oct, dispatch() creates Ноябрь
      c.dispatch();
      assert.ok(ss.getSheetByName('Ноябрь'));

      // 2. If runScheduledMonthCreation throws during 08:05 SGT heartbeat, dispatch() logs and still delivers morning coach
      setClock(c, '2026-10-31T00:05:00Z'); // 2026-10-31 08:05 SGT
      const origScheduled = c.runScheduledMonthCreation;
      c.runScheduledMonthCreation = () => { throw new Error('Simulated creation error'); };
      try {
        c.dispatch();
      } finally {
        c.runScheduledMonthCreation = origScheduled;
      }
      assert.ok(deliveredKeys.includes('morning_coach_96069960'));

      // 3. Manual menu trigger (createNextMonthFromMenu) creates next month in the active main workbook even while creationEnabled is false
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = false;', c);
      setClock(c, '2026-10-25T05:00:00Z'); // 2026-10-25 13:00 SGT
      const liveMainSs = buildSandboxWorkbook(c, fixture());
      liveMainSs.getId = () => '1ufn6CoHqxEUPwqBf--RX2H2DR_C1t1CfyG6QxSUVvR8';
      let activatedSheet = null;
      liveMainSs.setActiveSheet = sh => { activatedSheet = sh; };
      c.SpreadsheetApp.getActiveSpreadsheet = () => liveMainSs;
      const menuRes = c.createNextMonthFromMenu();
      assert.equal(menuRes.status, 'created');
      assert.equal(menuRes.sheetName, 'Ноябрь');
      assert.ok(liveMainSs.getSheetByName('Ноябрь'));
      assert.equal(activatedSheet && activatedSheet.getName(), 'Ноябрь');
    } finally {
      vm.runInContext('SHEET_FACTS.monthTemplate.creationEnabled = true;', c);
      c.monthlyTestEpoch = prevEpoch;
      c.SpreadsheetApp.getActiveSpreadsheet = origGetActiveSs;
      c.getActiveTelegramUsers = origUsers;
      c.deliverScheduledMessage = origDeliver;
      c.runMandatorySameDayAlerts = origAlerts;
      c.scanConfiguredStatementInbox = origScan;
    }
  });
};
