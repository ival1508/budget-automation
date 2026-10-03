const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/month-template.json'), 'utf8'));
// Captured live formula structure, with synthetic income/plan inputs; no private ledger.
module.exports = test => {
  test('Stage 6B: November preview preserves input and contains all six exact change ranges', c => {
    const s=fixture(), before=JSON.stringify(s), p=c.buildMonthCreationPlan(s,2026,11);
    assert.equal(JSON.stringify(s),before);
    assert.equal(p.target.name,'Ноябрь'); assert.equal(p.target.days,30); assert.equal(p.source,"Октябрь'26");
    assert.deepEqual(Array.from(p.edits,e=>e.range),['B1','B3:B4','B5:B6','I38','G3:G13','I2:I32']);
    assert.equal(p.edits[0].value,46327); assert.equal(p.edits[3].formula,'=H38<=$D$1');
    assert.equal(p.edits[1].values[0][0],30000); assert.equal(p.edits[4].formulas.length,11); assert.equal(p.edits[5].formulas.length,31);
  });
  test('Stage 6B: existing legacy and yearless targets are no-ops, even without template formulas', c => {
    for(const name of ["Октябрь'26",'Октябрь']) {
      const s=fixture();s.sheets[0].name=name;s.sheets[0].formulas=[];
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
      t=>{t.values[2][1]='#REF!';},t=>{t.values[36][7]='other';}
    ]){const s=fixture();mutate(s.sheets[0]);assert.throws(()=>c.buildMonthCreationPlan(s,2026,11));}
  });
  test('Stage 6B: status formulas expose partial/refund arithmetic, exclusions and data failures', c => {
    const p=c.buildMonthCreationPlan(fixture(),2026,11), formulas=p.edits[4].formulas;
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
    const ss={getSheetByName:name=>name==='Transactions'?{getMaxRows:()=>2566}:null,getSheets:()=>[{
      getName:()=>t.name,getSheetId:()=>t.id,getRange:a=>{assert.equal(a,'A1:L70');return {getValues:()=>t.values,getFormulas:()=>t.formulas};}
    }]};
    const p=c.previewMonthCreation(2026,11,ss);assert.equal(p.status,'preview');
    p.source='<script>alert(1)</script>';const html=c.buildMonthCreationPreviewHtml(p);
    assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  });
};
