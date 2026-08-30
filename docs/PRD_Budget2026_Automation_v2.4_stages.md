# PRD — Budget 2026 Automation · Phase 2 (v2.4, staged by cadence)

**Owner:** Val · **Users:** Val & Rita (two‑user household) · **Version:** v2.4 (reconciler split + test harness; UC‑4 before UC‑6) · **Date:** 29 Aug 2026
**Build environment:** Antigravity (Gemini agent) → Google Apps Script + Telegram
**Data source:** Google Sheet `Budget 2026` (Phase‑1 live: `Transactions`, `Merchants`; users configured in `SHEET_FACTS.USERS` in `config.gs`, not a sheet tab. Read targets: monthly `<Month>'26` tabs, `50/30/20`, `-` reference)
**Model:** **`gemini-3.7-flash`** (default; GA 13 Aug 2026 — an algorithmic refinement of 3.6 Flash at the **same price**, with better coding, agent and **document‑comprehension** performance; 1M context, native PDF/image/audio). `gemini-3.5-flash-lite` remains available for high‑volume sub‑tasks.
> Note the document‑comprehension gain is directly relevant to Stage 3's PDF/CSV statement parsing. Introductory pricing ($0.75/$3.75 per 1M tokens) runs to 31 Dec 2026, then doubles — worth re‑checking before Phase 3.

> **Supersedes v2.1.** Same content, reorganized around **cadence** (daily → weekly → monthly) per Val's direction, with UC‑6 expanded into a weekly payment‑calendar feature and a new month‑tab‑creation use case added.

---

## How to run this doc in Antigravity

A **staged build spec**. Each stage is self‑contained: **Objective → Build → Acceptance criteria → Checkpoint**. Feed the stages to the agent **one at a time, in order**. Don't start a stage until the previous checkpoint passes.

Two hard rules for the agent:
1. **Stage 0 is a discovery gate.** Later stages depend on facts about the live sheet that must be *read*, not assumed (exact cells, whether a column is a formula or a checkbox, real tab names, the monthly‑tab template). Stage 0 freezes these into `SHEET_FACTS`. Unknown fact ⇒ stop and ask Val; never guess.
2. **Read the sheet's own numbers; never recompute them.** The sheet already computes saldo, 50/30/20 ratios, and paid/unpaid state. The bot reads and narrates them so the brief and the sheet always agree.
3. **One sub‑stage per prompt; test before advancing.** Large stages fed to the agent wholesale have produced poor results (Stage 3 especially). Where a stage is split into sub‑stages, each is a **separate prompt** with its own test that must pass before the next begins.
4. **Nothing writes to `Transactions` until a step explicitly says so.** Build read‑only first, stage proposals second, commit last — and keep `DRY_RUN = true` plus a **sandbox copy of the sheet** until the output has been eyeballed.

**Phase‑1 assets to reuse:** Telegram webhook (`webhook.gs`), the `extract_transactions` Gemini response schema, the sequential confirm/duplicate wizard UI, the `LockService` write path, `dedupe_key = hash(date, account, round(amount,2), normalise(where))`, and the user/allowlist config in **`SHEET_FACTS.USERS` (`config.gs`)** — note there is **no `Config` sheet tab**; users live in code, and `AUTHORIZED_CHAT_IDS` / `WEBHOOK_SECRET` in Script Properties.

> ⚠️ **Webhook gotcha (cost a day of debugging, 23 Aug):** `doPost` validates `e.parameter.secret` against the `WEBHOOK_SECRET` script property. Any re‑registration **must** embed the secret in the URL, encoded: `setWebhook?url=<EXEC_URL>%3Fsecret%3D<WEBHOOK_SECRET>`. A plain `setWebhook` makes the bot silently return "Unauthorized" with a 200 and no reply. Also: `clasp push` is **not** a deploy — use Deploy → Manage deployments → ✏️ → New version, never "New deployment" (which mints a new URL).

---

## Verified data model (Stage 0 findings — confirmed against the live sheet)

Everything here was verified against `Budget 2026` on 23 Aug 2026. Stage 1's reader must implement it exactly.

### Transactions schema (11 columns — corrected)
`A Дата · B Счёт · C Тип · D Сумма · E Сумма в SGD · F На счете до · G На счете после · H Категория · I Где · J Notes · K 50/30/20 category`

> **Correction to earlier versions of this PRD:** a `Notes` column was added at **J**, pushing the 50/30/20 bucket to **K**. `writer.gs` correctly writes 11 columns with the bucket in K.

### Daily coach math (verified arithmetically)
Three cells/columns in the monthly tab, each answering a different question:
```
D17      = flat daily pacing (monthly budget ÷ days in month)
K(n)     = L(n-1) + D17        # cumulative budget available today
L(n)     = K(n) − Траты(n)     # saldo after today's spend
D19      = total budget left for the month ÷ days left   # realistic go-forward daily allowance
```
- **K = the reality check** — how far ahead/behind accumulated overspend has put you.
- **D19 = what's actually spendable per day** from here.
- **Zero-spend recovery** — when K < 0, each zero-spend day adds D17, so `days_to_positive = ceil(|K| / D17)`. Also offer the softer form ("or stay under S$X/day for N days"), since total abstinence is rarely the real plan.

> **`Траты` (column J of the daily tracker) counts `Тип = "Расходы"` ONLY** — verified: 01.07.2026 J = S$279,66 = the six `Расходы` rows that day across both accounts; the S$7,592 mortgage (`Обязательные расходы`) and S$372 `Снятие денег` are excluded. This is the concrete expression of "the monthly budget treats Обязательные расходы separately from daily spend."

### Category taxonomy (three overlapping sets)

**1. Transaction categories — 22**, the `-` tab column B, selectable in `Transactions` column H:
`Продукты · Рестораны · Развлечения · Подписки · Счётчики · Транспорт · Красота · Медицина · Дом · Подарки · НКО · Другое · Extra fund · Отложения · Отложения (премия) · Лин · Квартира · Налоги · Школа & Детский сад · Отдых · Кредитка · Авто`

⚠️ **Import `CATEGORY_TO_BUCKET_MAP` from the `-` tab at runtime — never hardcode.** The taxonomy has already evolved (`Аренда`→`Квартира`, `Детский сад`→`Школа & Детский сад`, `Авто` added as a Wants category distinct from `Транспорт` in Needs).

**2. Обязательные расходы — 11**, the monthly tab's `D3:D13` (matches discovery's "Found 11 items"):
`Квартира · Авто · Родители · НКО · Лин · Налоги · Школа & Детский сад · Extra fund · Отдых · Отложения · CPF`
These are *planned* ahead of the month, but the same categories can also carry ordinary `Расходы`.

**3. The `50/30/20` tab — 19 rows:** Needs 8 · Savings 1 · Wants 10.

**Reconciliation: 19 + 3 = 22.** Exactly three transaction categories are excluded from the 50/30/20 tab:
| Excluded | Why |
|---|---|
| `Налоги` | only after‑tax amounts are budgeted |
| `Отложения (премия)` | bonus/vesting spikes would distort the distribution |
| `Кредитка` | technical — a transfer, not spend |

**Column K can therefore hold five values** — `Needs`, `Wants`, `Savings`, `Taxes` (Налоги), `-` (Кредитка) — while the 50/30/20 **tab reports only three**. `Отложения (премия)` is tagged **`Savings`** in column K (so full‑savings YTD totals incl. bonus/equity remain computable later) but has no row in the tab.

> **Consequence for the coach:** read the **50/30/20 tab's own computed numbers**; do not recompute buckets from `Transactions`. Recomputing means re‑implementing these exclusions by hand, and they will drift.

### Special cases
- **`Родители`** — not a transaction category; kept in the monthly tab as a **visible planned S$0 line**. Stage 3 must treat a S$0 planned line as *satisfied* and never raise an "unpaid" alert for it. Log any one‑off support under `Другое`.
- **`CPF`** — `Обязательные расходы` only; never appears in `Transactions` (it moves pre‑account). Belongs in `NON_LEDGER_MANDATORY` so Stage 3 never expects a match; excluded from 50/30/20. Visible in the monthly tab purely so the family sees the monthly outflow. *(Annual top‑ups will likely come from money‑market funds — a Phase 3 concern, out of scope here.)*
- **`Кредитка`** — CC bill payment; a transfer. Excluded from spend analysis everywhere.

### Open item
**50/30/20 targets (`AE`)** — the header read "Target month (June 2026)" at discovery; Val has since adjusted AE to represent the overall target month. Stage 1 should read AE as the current target column and **surface the header text in the coach payload** so a stale target is visible rather than silently wrong.

---

## Scope of Phase 2 (by cadence)

| Cadence | UC | Name | Stage | Priority |
|---|---|---|---|---|
| **Daily** | UC‑3 | Daily Budget Coach (morning brief: saldo, pacing, advice) | Stage 2 | **P0** |
| **Anytime** | UC‑4 | Statement Reconciler — upload any time (PDF/CSV), runnable **without Telegram**; split into 6 testable sub‑stages | Stage 3 | P1 |
| **Weekly** | UC‑6 | Mandatory‑payment calendar + weekly reminder + missed‑date alerts | Stage 4 | P1 |
| **Monthly** | UC‑5 | Monthly Budget Coach | Stage 5 | P2 |
| **Monthly** | UC‑7 | Auto‑create next month's tab (rollover) | Stage 6 | P2 |
| **Anytime + Monthly** | UC‑8 | Line‑item receipt intelligence (capture items → find overconsumption) | Stage 7 | P2 |

**Cadence → scheduler summary**
- **Daily:** morning coach at each user's `morning_time` (both currently **08:00 SGT**) (P0); 21:00 SGT nudge (Phase‑1, existing).
- **Weekly:** Mon 09:00 SGT mandatory‑payment brief (configurable day/time).
- **Anytime (event‑driven, no schedule):** statement upload → reconciliation. Accepted from either user on any date; the month‑end message is only a reminder.
- **Monthly (on month rollover):** reconciler *prompt* → monthly coach → next‑month‑tab creation, sequenced off one daily trigger that checks `tomorrow.getMonth() !== today.getMonth()` (Apps Script has no native "last day of month" trigger).

**Non‑goals (Phase 2):** assets/NAV/investment tracking (V3); bill‑*paying* (read/track only); rewriting sheet calculation formulas (we read/append; the only writes are appended transactions, the optional mandatory‑checkbox flip in Stage 3, and the new‑tab clone in Stage 6).

**Success metrics:** reconciliation ≤ 5 min/account · missing‑transaction catch 100% · fixed‑payment late rate 0% · morning‑brief read rate ≥ 90% · zero forgotten mandatory payments.

**Multi‑user (from v0.3):** daily/weekly/monthly briefs go to **both** Val and Rita; **either** can run a reconciliation. Per‑user times apply (`morning_time` in `SHEET_FACTS.USERS`; both currently 08:00 SGT). The allowlist gate is `SHEET_FACTS.USERS` + the `AUTHORIZED_CHAT_IDS` script property.

---

# FOUNDATION

## STAGE 0 — Discovery & `SHEET_FACTS` ✅ **COMPLETE (23 Aug 2026)**

> **Status: closed.** `config.gs` + `runDiscovery()` are built and have been run against the live sheet. Verified: all 8 month tabs (incl. `Август'26`, confirming the Jan–Apr letters / May+ full-names convention, Sep–Dec correctly absent); `Transactions` 11 cols with J=Notes, K=50/30/20; mandatory range `D3:G13` (11 items); daily tracker H/J/K/L; `D19` saldo cell. The taxonomy and coach math are captured in **Verified data model** above. **Remaining open item:** whether mandatory column **G** is a formula or a manual checkbox — run `showMandatory()` (below) before Stage 3, since Stage 3 branches on it.

```javascript
function showMandatory() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Август'26");
  const r = s.getRange('D3:G13');
  const v = r.getDisplayValues(), f = r.getFormulas();
  v.forEach((row, i) => Logger.log(
    `${i+3}: D="${row[0]}" | E="${row[1]}" | G="${row[3]}" | G-formula="${f[i][3]}"`));
}
```
Empty `G-formula` ⇒ manual checkbox ⇒ Stage 3 **Path B**. A formula ⇒ Stage 3 **Path A** (much simpler).

<details>
<summary>Original Stage 0 spec (for reference)</summary>

**Objective.** Resolve every sheet‑dependent unknown by reading the live sheet and freeze the answers into one config the later stages import. The monthly tabs are irregular; a wrong assumption here silently corrupts downstream features.

**Build.**
1. `config.gs` exporting `SHEET_FACTS`, plus a one‑off `runDiscovery()` that inspects the sheet and prints proposed values for Val to confirm.
2. **Month‑tab map + naming convention (critical).** Tabs are **not** consistently named — Jan–Apr are single Cyrillic letters (`Я/Ф/М/А`), May onward are **full Russian month names** (`Май/Июнь/Июль`). **Important: Val keeps monthly tabs only up to the current month — future‑month tabs usually don't exist yet** (they're created just‑in‑time; Stage 6 automates this). So do **not** require future tabs to exist and do **not** treat their absence as an error.
   - **Verify** the past + current tabs against an explicit map (these must exist):
     ```js
     MONTH_TABS_EXISTING = {1:"Я'26", 2:"Ф'26", 3:"М'26", 4:"А'26", 5:"Май'26", 6:"Июнь'26", 7:"Июль'26"}
     ```
   - **Derive future names by convention.** Since May+ use full month names, the forward pattern is the full Russian month name + `'26` (CONFIRM):
     ```js
     MONTH_TABS_FUTURE = {8:"Август'26", 9:"Сентябрь'26", 10:"Октябрь'26", 11:"Ноябрь'26", 12:"Декабрь'26"}
     ```
     Store the convention itself (`full Russian month name + 'YY`) so Stage 6 can name new tabs correctly. Collision note: `А'26` already means **April**, so August must be `Август'26`, never `А'26`.
   - `runDiscovery()` verifies the existing tabs, reports which months are present, and asks Val to **confirm the future‑month naming convention** — not the future tabs themselves, which may not exist yet.
3. **Mandatory block location & semantics.** Per monthly tab, the fixed‑cost block is **D (label) · E (amount) · F (%) · G (TRUE/FALSE)** over ~rows 3–13. Report, for the active tab: the exact D‑label row range, and **whether column G is a formula or a manual checkbox** (`getFormula()` on a G cell — non‑empty ⇒ formula). This one fact decides Stage 3's paid/unpaid approach.
4. **Daily‑saldo cell.** Locate the exact cell holding the *current* daily allowance (`Текущий бюджет на день`) and the running `Сальдо` in the monthly tab. Store `SHEET_FACTS.saldoCell`. **Read it; never recompute.**
5. **50/30/20 read map.** In the `50/30/20` tab, locate **actual** and **target** cells for **Needs / Wants / Savings / Taxes** (four buckets — the `-` sheet maps `Налоги`→Taxes, `Отложения`→Savings). Store A1 refs.
6. **Category canon.** Import the `-` tab's `Категория → 50/30/20` map into `SHEET_FACTS.categoryBucket` at runtime.
7. **Monthly‑tab template map (for Stage 6).** For a representative monthly tab, enumerate which ranges are **structural / carry‑forward** (income rows e.g. `Зарплата В/Р`, mandatory D/E labels+amounts, budget‑per‑day formulas, the right‑hand `Date Increment` helper table) vs **transient / reset** (the daily table's траты/сальдо cells, the mandatory **G** flags, the `01.MM.YYYY … end‑of‑month` date range in the header). Store `SHEET_FACTS.monthTemplate = {structuralRanges, transientRanges, dateHeaderCells}`.

**Acceptance.** `SHEET_FACTS` holds: verified `MONTH_TABS_EXISTING` (present months only), the confirmed **future‑month naming convention**, mandatory block range, `mandatoryColumnGType ∈ {formula, checkbox}`, `saldoCell`, 50/30/20 actual+target refs (incl. Taxes), `categoryBucket`, and `monthTemplate`. `runDiscovery()` prints findings and **lists unconfirmed values**; a missing *future* tab is reported as normal, not an error.

**Checkpoint (ask Val):** the **future‑month naming convention** — since future tabs usually don't exist yet, confirm the forms (`Август'26 … Декабрь'26`) rather than the tabs; is **column G** a formula or checkbox; the exact **daily‑saldo cell** and **50/30/20 target cells**; a quick sanity‑check of the `monthTemplate` transient‑vs‑structural split.

</details>

---

## STAGE 1 — Read layer (`reader.gs`)

**Objective.** One tested module returning clean JSON from the sheet; every later stage consumes it, none re‑implements sheet reading.

**Build** — pure read functions, each returning JSON, each using `SHEET_FACTS` and the **Verified data model** above:
- `getActiveMonthTab()` → correct tab via the month map. **If the current month's tab doesn't exist yet** (Val creates them just‑in‑time), return a clear "current‑month tab missing" signal rather than erroring: until Stage 6 exists this prompts Val to create it by hand; once Stage 6 exists, this call routes through `ensureMonthTab()` to auto‑create it.
- `getCategoryBucketMap()` → **import the 22 `Категория → 50/30/20` pairs from the `-` tab at runtime.** Never hardcode; the taxonomy has already changed once.
- `getMandatoryExpenses()` → `[{label, amount, paidFlag}]` from D/E/(G) of `D3:G13`. Treat a **S$0 planned line as satisfied** (`Родители`), and exclude `NON_LEDGER_MANDATORY` = `{CPF}` from any "unpaid" logic.
- `getLoggedMandatoryThisMonth()` → from `Transactions`, current month, `Тип == "Обязательные расходы"`, grouped by `Категория` + `Где`, summed (reuse the exact enum string incl. the trailing tab/hyphen spacing).
- `getDailyPacing()` → `{K_cumulative_today, L_saldo_yesterday, D17_flat_daily, D19_realistic_daily, days_left, days_to_positive}` — read K/L/D17/D19 from the monthly tab; compute `days_to_positive = ceil(|K| / D17)` only when K < 0. **Read these values; never recompute the saldo chain.**
- `getTodaySpend()` → today's `Траты`: sum of `Тип == "Расходы"` **only**, both accounts, for that date (verified rule). Excludes `Обязательные расходы` and `Снятие денег`.
- `get503020Status()` → `{needs:{actual,target}, wants:{...}, savings:{...}, target_header}` **read from the `50/30/20` tab's own computed cells** (targets in `AE`). Do **not** recompute from `Transactions` — the tab encodes three exclusions (`Налоги`, `Отложения (премия)`, `Кредитка`) that would have to be re‑implemented and would drift. Return `target_header` text so a stale target month is visible.
- `getCategoryVelocity()` → current‑month sums for the volatile discretionary categories that **actually exist**: **`Рестораны`, `Развлечения`, `Дом`, `Подарки`** (no `Шопинг` — it isn't a category).

**Acceptance.** Each returns valid JSON against the live sheet; numbers match the sheet on spot‑check; empty cells filtered; currency parsed from `S$1 234,56` (space thousands, comma decimal).

**Checkpoint.** Run each once; paste output; Val eyeballs 2–3 values vs the sheet.

---

# DAILY USE CASES

## STAGE 2 — UC‑3 Daily Budget Coach  ·  **P0** (concludes the daily use cases)

**Objective.** A morning brief (each user's `morning_time`, currently **08:00 SGT**) stating today's spendable saldo, pacing, and one actionable nudge — built as a reusable `coach(period)` engine that Stage 5 reuses for the monthly view. This is the headline daily value and the priority for the whole phase.

**Build.**
1. `coach.gs` with `buildCoachPayload(period)` assembling JSON from `reader.gs`:
   ```jsonc
   {
     "period": "daily",
     "cumulative_today": -132.91,      // K — the reality check (how far behind)
     "realistic_daily": 190.34,        // D19 — what's actually spendable per day now
     "flat_daily": 269.75,             // D17 — flat pacing, for context
     "days_left_in_month": 12,
     "days_to_positive": 1,            // ceil(|K| / D17), only when K < 0
     "spend_today": 27.09,             // Траты = Тип "Расходы" only
     "buckets": { "needs":{"actual":47,"target":50}, "wants":{"actual":31,"target":30},
                  "savings":{"actual":15,"target":20} },   // three buckets — the tab has no Taxes row
     "target_header": "Target month (August 2026)",        // surfaces a stale target
     "top_wants_categories": { "Рестораны": 450, "Развлечения": 120 },
     "mandatory_warnings": []   // filled from Stage 4 once built; empty until then
   }
   ```
   **Include both `actual` and `target`** — the model needs both to say "over on Wants."
2. Call `gemini-3.7-flash` with a persona prompt: *"You are a sharp, warm financial coach for a Singapore family. From this JSON write a ≤3‑sentence Telegram brief. Lead with the cumulative position (`cumulative_today`) as the reality check, then state plainly what's realistically spendable per day (`realistic_daily`). If `cumulative_today` is negative, mention the recovery path — `days_to_positive` zero‑spend days, or the softer 'stay under S$X/day' equivalent. Reference at most one category. No tables, no markdown headers — short conversational sentences."*
3. Deliver to **both users'** chats from **`SHEET_FACTS.USERS`** (`config.gs`) — each entry already carries `chat_id`, `morning_time` (both 08:00 SGT) and `active`. Skip users with `active: false`. Reuse `sendTelegramMessage()` from `nudge.gs`, which already iterates `SHEET_FACTS.USERS`.
4. **Scheduler:** prefer a **single 15‑minute heartbeat trigger** that dispatches by clock time rather than one trigger per send — Apps Script's `.atHour()` only guarantees the hour (a 09:00 trigger can fire at 09:47), and per‑user times can't be expressed as shared fixed‑hour triggers. The dispatcher also hosts the weekly Monday check and the month‑rollover check. Guard each send with a once‑per‑day key in Script Properties (`sent_<key>=<yyyy-MM-dd>`) so the heartbeat can't re‑send. Set the project timezone to `Asia/Singapore` in `appsscript.json`.

**Tone (hard).** Concise, Telegram‑native, no tables, ≤3 sentences, explicit spend/pull‑back instruction, never invent numbers absent from the payload.

**Acceptance.** Morning brief sends to both users at their configured `morning_time` (08:00 SGT), once per day; every figure traces to the payload; saldo equals the sheet's value; tone holds across several days of data.

**Checkpoint.** Trigger `sendMorningCoach()` manually; Val + Rita each receive it; saldo matches the sheet.

---

# MONTHLY / ANYTIME USE CASES

> **Reordered (v2.4):** UC‑4 (Reconciler) now comes **before** UC‑6 (Mandatory calendar). The reconciler is the highest‑value, most independent piece and must not be blocked by the mandatory‑calendar details. It shares nothing with UC‑6 beyond the Stage 1 reader.

## STAGE 3 — UC‑4 Statement Reconciler — **split into 6 testable sub‑stages**

**Why split:** dumping the whole reconciler into an agent at once produced poor results. Each sub‑stage below is a **separate Antigravity prompt** with its own test and its own definition of done. **Do not proceed to the next sub‑stage until the current one's test passes.** Every sub‑stage is a pure function where possible — no Telegram, no sheet writes — so it can be run and inspected in isolation from the Apps Script editor.

**Golden rule for the whole stage:** nothing writes to `Transactions` until **Stage 3F**. Everything before it is read‑only and safe to run repeatedly.

---

### Prerequisite — the test harness (`tests.gs`) — build FIRST

Before any reconciler logic, build the safety net. This is a one‑off ~30 minutes that pays for itself immediately.

1. **Fixtures tab.** A hidden `_TestFixtures` sheet tab holding 2–3 small pasted statement samples (one DBS CSV, one Citibank CSV, ~10 rows each) as raw text. Real data, small enough to reason about by hand.
2. **A test runner** with tiny assertion helpers — no framework needed:
   ```javascript
   function assertEq(actual, expected, label) {
     const ok = JSON.stringify(actual) === JSON.stringify(expected);
     Logger.log((ok ? '✅ PASS: ' : '❌ FAIL: ') + label +
                (ok ? '' : `\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`));
     return ok;
   }
   function runAllTests() { /* calls each test_*() and prints a summary count */ }
   ```
3. **`DRY_RUN` flag** in `SHEET_FACTS`. When true, the writer logs the exact rows it *would* append and returns them, without touching the sheet. **Default it to true** for the whole of Stage 3; flip to false only in 3F after you've read the log.
4. **A sandbox copy of the sheet.** Duplicate `Budget 2026` → `Budget 2026 TEST`, and point a `TEST_SPREADSHEET_ID` at it. Any sub‑stage that writes runs against the sandbox first. This is the real safety net: the live ledger is never the test target.

**Test:** `runAllTests()` executes and prints a pass/fail summary with zero real tests. Harness is green before any feature code exists.

---

### Stage 3A — File → raw rows (parsing only)

**Scope:** one function, `parseStatement(fileBlob) → {account, rows[], period}`. No matching, no writing, no Telegram.
- CSV path (**preferred**): `Utilities.parseCsv()`, detect the header row (bank exports carry preamble/footer junk), map columns **by name not index**, handle DBS's split debit/credit columns and single signed‑amount formats.
- PDF path: bytes → `gemini-3.7-flash` with the `extract_transactions` schema.
- Encrypted PDF: detect, return `{error:'encrypted'}` — never fail silently.
- Derive `period` from the rows' own min/max dates.

**Test (`test_parseStatement`):** run against each `_TestFixtures` sample; assert row count, and that the first and last row's date/amount/merchant match what you can read by eye. **Done when:** a real CSV from each bank parses to the exact expected row count and values.

---

### Stage 3B — Normalization

**Scope:** `normalizeRows(rows) → normalizedRows[]`. Dates to `DD.MM.YYYY`, amounts to numbers (handle `S$1 234,56`), merchant strings normalized with the **same** function the Phase‑1 enricher uses (critical — matching depends on both sides normalizing identically), sign/direction resolved.

**Test (`test_normalizeRows`):** feed a hand‑written array of ~8 gnarly inputs (comma decimals, `NETS*FAIRPRICE`, negative amounts, DD/MM vs MM/DD ambiguity) and assert exact outputs. **Done when:** all 8 pass, including the ones you deliberately made nasty.

---

### Stage 3C — Matching engine (the core — keep it pure)

**Scope:** `findMissing(statementRows, ledgerRows) → {matched[], missing[], ambiguous[]}`. A **pure function** — takes two arrays, returns a result. No sheet reads, no I/O. This is what makes it testable and is where the previous attempt went wrong.
- Fast path: exact `dedupe_key` hit.
- Fuzzy: amount exact **and** date within **±3 days** **and** merchant similarity above threshold.
- Return `ambiguous` separately (multiple plausible matches) rather than guessing.

**Test (`test_findMissing`):** construct fixtures that force each branch — an exact match, a match 2 days off, a match with `NETS*FAIRPRICE` vs `Fair Price`, a genuine miss, a same‑amount‑same‑day pair (ambiguous), and a duplicate‑amount case. Assert exact bucket counts. **Done when:** every branch is covered and no already‑logged row lands in `missing`. This is the most important test in the project — false "missing" is the failure mode that destroys trust.

---

### Stage 3D — Non‑spend filtering

**Scope:** `filterNonSpend(missing) → {proposals[], excluded[]}`. Drop CC autopay/repayment, reimbursements/credits, internal transfers, FX/interest — they map to the Phase‑1 reconciliation patterns, not new expenses. Return `excluded` **with reasons** so you can audit what it dropped.

**Test (`test_filterNonSpend`):** feed a fixture containing one of each non‑spend type plus two genuine expenses; assert exactly two proposals survive and each exclusion carries the right reason. **Done when:** no genuine expense is ever excluded (false exclusion is worse than a false proposal — you'd never know).

---

### Stage 3E — Staging review (no writes yet)

**Scope:** write proposals to a **`_Reconcile` staging tab**, not to `Transactions`. Columns: `✓ (checkbox) · date · account · amount · merchant · proposed category · proposed bucket · confidence · source_row · status`.

This staging tab is deliberately **better than the Telegram wizard for this job**: reviewing 45 rows one at a time in chat is miserable; a sheet lets you scan them all, sort, bulk‑tick, and fix a category inline with the existing dropdown.

**Test (`test_stageProposals`):** run end‑to‑end 3A→3E against a fixture; confirm the staging tab is populated correctly and `Transactions` is **untouched** (compare `getLastRow()` before/after). **Done when:** proposals appear in staging with correct proposed categories and the ledger is provably unchanged.

---

### Stage 3F — Commit (the only writing step)

**Scope:** `commitStaged()` reads ticked rows from `_Reconcile` and appends them via the **existing Phase‑1 writer** (11 columns, formula copy‑down for F:G, `LockService`, dedupe). Mark committed rows `status = imported` so a re‑run can't double‑import.

**Test:** with `DRY_RUN = true`, run against the **sandbox** sheet and read the logged would‑be rows. Then flip `DRY_RUN = false` on the sandbox and verify: correct columns (J Notes empty, K bucket), balances chain correctly, re‑running imports nothing. **Only then** point at the live sheet.

**Done when:** a real statement flows 3A→3F on the sandbox with correct results, and a second run is a clean no‑op.

---

### Stage 3G — Entry points (Telegram optional — see below)

Wire the pipeline to the triggers in §"Running the reconciler without Telegram". Telegram upload becomes **one of several** entry points, not the only one.

**Acceptance (whole stage).** A statement in either format, from any date window, produces exactly the right missing set; non‑spend excluded; staging reviewed; committed rows correct and idempotent; every sub‑stage has a passing test in `runAllTests()`.

---

## Running the reconciler without Telegram

Telegram is a poor fit for a monthly batch job — you're on a laptop with the file already downloaded, and reviewing dozens of rows in chat is painful. **Telegram should not be a chokepoint.** Because Stages 3A–3F are pure functions, any of these can drive them:

| # | Option | How it works | Effort | Best for |
|---|---|---|---|---|
| **1** | **Sheets custom menu** ⭐ *recommended* | `onOpen()` adds a **"💰 Budget"** menu to the sheet: *Reconcile from Drive · Review staging · Import ticked rows*. You drop the statement in a Drive folder, open the sheet, click. | Low | The natural home — you review in the sheet anyway |
| **2** | **Drive folder drop** ⭐ *recommended* | A `/BudgetStatements/inbox` Drive folder; a time‑driven trigger (or the menu item) scans it, processes new files, moves them to `/processed`. Zero UI. | Low | "Fire and forget" — drop the file, review later |
| **3** | **Run from the Apps Script editor** | Select `reconcileFromDrive` in the function dropdown → Run. Already works for free with no extra code. | None | Debugging; immediate use today |
| **4** | **`curl` to the web app** | POST the CSV to your `/exec` with `?secret=` from the laptop terminal. | Low | Scripting it into your own workflow |
| **5** | **`clasp run`** | Invoke an Apps Script function from your terminal. Requires a standard GCP project + Apps Script API enabled. | Medium | Terminal‑native workflow |
| **6** | **Local Node/Python CLI** | Bypass Apps Script entirely: read CSV locally, call Gemini + Sheets API direct. | High | Only if you outgrow Apps Script |

**Recommendation: build options 1 + 2 together** (they share one function) and keep Telegram as a convenience path for when you're on your phone. Concretely:

```javascript
function onOpen() {
  SpreadsheetApp.getUi().createMenu('💰 Budget')
    .addItem('Reconcile statements from Drive', 'reconcileFromDrive')
    .addItem('Import ticked rows from staging', 'commitStaged')
    .addSeparator()
    .addItem('Run morning coach now', 'sendMorningCoach')
    .addToUi();
}
```

`reconcileFromDrive()` reads every new file in the inbox folder, runs 3A→3E, and drops proposals into `_Reconcile`. You tick rows and click *Import*. **No Telegram involved anywhere in the monthly flow.**

> **Design consequence:** keep all reconciler logic in **`reconciler.gs` with no Telegram dependencies**. `webhook.gs` may *call* it; it must never *contain* it. That separation is what makes every entry point above possible — and it is also what makes the sub‑stage tests possible.

---

# WEEKLY USE CASES

## STAGE 4 — UC‑6 Mandatory‑payment calendar + weekly reminder + missed‑date alerts

**Objective.** Never forget a fixed payment. Build a **calendar of expected payment dates**, then a **weekly** reminder of what's still unpaid this month, with **prominent alerts for expected dates that have already passed** without a matching payment.

> **Moved after the reconciler (v2.4)** so UC‑4 is never blocked by this stage's details.

### Part A — Build the mandatory‑payment calendar
- New **`Calendar` config tab** (bootstrapped like `Merchants`), one row per fixed item:
  `item · category · expected_day_of_month · typical_amount · account · active`
  Support **end‑of‑month** items (e.g. helper salary paid on the last day) via a sentinel like `EOM` rather than a fixed number.
- **Seed it from history (agent‑proposed, Val‑confirmed).** Analyze `Transactions` for recurring `Обязательные расходы`: compute the **typical day‑of‑month** (median across recent months) and **typical amount** per item, and propose a draft for Val to confirm/edit. From the ledger these cluster clearly — Agora ~1st, rent/mortgage ~1st & ~10th, IRAS ~6th, tuition early‑month, `Лин` salary at month‑end, MOM mid‑month, auto loan ~4th. Derive, propose, confirm — don't hardcode.

**Test (`test_seedCalendar`):** run the seeding against historical data and assert the derived day‑of‑month for 3 known items (e.g. IRAS ≈ 6, `Лин` = EOM) falls within ±2 days of reality.

### Part B — Label→category mapping + exclusions (required)
The 11 actual `Обязательные расходы` labels (from `D3:D13`, verified) map to transaction categories mostly 1:1 — the taxonomy has converged since earlier drafts — but three need special handling:

| Monthly label (D) | Transaction `Категория` | Notes |
|---|---|---|
| Квартира | Квартира | direct (was `Аренда` in older drafts) |
| Авто | Авто | direct (distinct from `Транспорт`; Авто is **Wants**, Транспорт is **Needs**) |
| Родители | — | **visible planned S$0 line**; not a transaction category. Treat S$0 as satisfied, never alert. Log one‑offs under `Другое`. |
| НКО | НКО | direct |
| Лин | Лин | direct (helper — a person's name, not a generic label) |
| Налоги | Налоги | bucket `Taxes` in col K; excluded from the 50/30/20 tab |
| Школа & Детский сад | Школа & Детский сад | direct |
| Extra fund | Extra fund | direct |
| Отдых | Отдых | direct |
| Отложения | Отложения | direct |
| CPF | — | **never in `Transactions`** → `NON_LEDGER_MANDATORY`; planning visibility only |

`NON_LEDGER_MANDATORY = {CPF}` plus any **S$0 planned line** (currently `Родители`) — these must never produce a "missing/unpaid" alert. Because labels now match categories almost exactly, **match on the canonical map first**; the LLM is a fallback for genuinely ambiguous free‑text only, never the primary matcher.

**Test (`test_mandatoryMatching`):** fixture with one paid item, one unpaid, one `CPF`, one S$0 `Родители`; assert exactly one "unpaid" is reported.

### Part C — Weekly reminder + missed‑date alerts
- **Weekly cron:** default **Monday 09:00 SGT** (configurable), via the Stage 2 heartbeat dispatcher. Determine paid/unpaid by cross‑referencing the `Calendar` against logged `Обязательные расходы` — **or** column **G** directly if it proves to be a live paid flag.
- **Brief structure (ordered by expected date):**
  1. **⚠️ Overdue / missed** — expected day passed this month, no matching payment. *Surface prominently.*
  2. **Due this week** — expected day within the next 7 days, not yet logged.
  3. **✅ All clear** — if nothing outstanding.
- **Optional same‑day alert:** a single day‑of ping when an expected date passes unmatched. Behind a flag in `SHEET_FACTS`; off by default.
- **(If column G is a manual checkbox)** optionally **write `TRUE` back to G** when a matching payment is detected — the one sheet‑write exception here, only with Val's approval.
- **Add a menu entry** (`💰 Budget → Check mandatory payments now`) so this is runnable from the sheet, not only via Telegram.

**Acceptance.** Calendar seeds correctly and is editable; the weekly brief lists **overdue** and **due‑this‑week unpaid** items in date order; no false positive for an item paid under its mapped category; excluded items (`CPF`, the S$0 `Родители` line) never appear; EOM items handled; all Part A/B tests pass.

**Checkpoint.** Review the seeded calendar against reality; run the weekly brief for the current month; confirm the overdue/upcoming sets are right (cross‑check column G by eye).

---

## STAGE 5 — UC‑5 Monthly Budget Coach (reuse the Stage 2 engine)

**Objective.** A month‑end results brief — same coach engine, different window and framing.

**Build.**
- Add `period:"monthly"` to `buildCoachPayload()`: full‑month actuals vs targets for all four buckets, final `Рестораны/Развлечения/Дом/Подарки` totals, count of mandatory items paid vs missed (from Stage 4), and month‑over‑month deltas if easily read.
- Persona variant: *"Write a ≤4‑sentence month‑in‑review for the family: how the month landed vs the 50/30/20 targets, the one category that drove overspend or the win, and one concrete focus for next month. Warm, specific, no tables."*
- **Scheduler:** fire on month rollover (the daily trigger + `tomorrow.getMonth() !== today.getMonth()`), sequenced with the reconciler prompt.

**Acceptance.** Fires once, last day of month, to both users; numbers reconcile with the month's `50/30/20` tab.

**Checkpoint.** Force‑run with a month's data; totals match the sheet.

---

## STAGE 6 — UC‑7 Auto‑create next month's tab (rollover + on‑demand)

**Objective.** Automatically create a month's tab so it's ready to use — never set one up by hand. Because Val keeps tabs only up to the current month, this stage has **two jobs**: proactively create *next* month's tab at rollover, and **self‑heal** a missing *current* month tab whenever the bot needs it. This is the most **sheet‑structure‑sensitive** stage; build it last and test on a throwaway copy of the sheet first.

**Build.**
1. **Two entry points.**
   - **(a) Proactive at rollover** — on the daily‑trigger + month‑check, create *next* month's tab if it doesn't exist, so it's ready on day 1.
   - **(b) On‑demand `ensureMonthTab(month)`** — since Val creates tabs just‑in‑time, any stage needing the active month's tab calls this first; if the tab is missing it's created immediately with the same clone‑and‑reset logic. Wire `reader.gs`'s `getActiveMonthTab()` to route through it once this stage ships. This makes the whole system robust to a missing current‑month tab instead of erroring.
2. **Name it** from the confirmed **future‑month naming convention** in `SHEET_FACTS` (full Russian month name + `'YY`; Stage 0). If the convention is unconfirmed, stop and ask rather than inventing a name — and remember `А'26` is April, so August is `Август'26`.
3. **Clone + reset**, using `SHEET_FACTS.monthTemplate`:
   - **Duplicate** the most‑recent month tab (`copyTo` / duplicate) and rename.
   - **Carry forward (structural):** income rows (`Зарплата В/Р`), the mandatory **D/E** labels+amounts, the budget‑per‑day formulas, the `Date Increment` helper table.
   - **Reset (transient):** clear the daily table's траты/сальдо cells; reset mandatory **G** flags to FALSE (if manual); rewrite the header date range to `01.MM.YYYY … <last day of MM>` and regenerate the date‑increment column for the new month.
   - **Formulas that filter `Transactions` by date** should auto‑scope to the new month — verify they do; fix any that hardcode a month.
4. **Income update:** salary figures vary slightly month to month; carry the previous values and flag them for Val to adjust rather than guessing.
5. **Guard:** never overwrite an existing tab; if it exists, no‑op and report (both entry points share this idempotency).

**Acceptance.** Both entry points produce a correctly‑named tab (per the convention) with the mandatory list carried over, **G** reset, dates updated, daily table cleared, and formulas intact and correctly scoped; re‑running is a no‑op; a missing *current* month tab is created on demand rather than throwing.

**Checkpoint.** Run against a **copy** of the sheet; diff the generated tab against a hand‑made month tab; only then enable on the live sheet.

---

## STAGE 7 — UC‑8 Line‑item receipt intelligence

**Objective.** Go one level deeper than the transaction: capture **what was actually bought**, keep a durable item‑level history, and surface the patterns that drive overconsumption — items that are overpriced, bought too often, cheaper elsewhere, quietly discretionary, or **quietly traded up**. It should also answer two questions the transaction ledger can't: *"did we start splurging on something?"* and *"how much of our rising grocery bill is just inflation?"* Turns "you overspent on Продукты" into "you're paying 2× for berries at Cold Storage."

> **Build the capture half early.** Analysis only becomes useful after ~4–8 weeks of item history, so **Part A (capture) is worth shipping alongside Stage 2** even though Part B (analysis) lands here. Start banking data as early as possible; the insight arrives later either way.

### Part A — Capture (extend the Phase‑1 ingestion path)

1. **Only for real receipts.** Line items exist on **receipt photos/PDFs**, not on bank screenshots or typed text. Detect input type: if it's an itemized receipt, run the line‑item extraction pass; otherwise skip silently — never fabricate items.
2. **Extraction schema** (a second Gemini schema alongside `extract_transactions`):
   ```jsonc
   {
     "line_items": [{
       "raw_text": "BRC CHKN BRST 2KG",      // verbatim from receipt
       "item_name": "Chicken breast",         // AI-normalized, human-readable
       "product_key": "chicken_breast",       // canonical key for cross-receipt matching
       "brand": "Sadia",                      // brand if printed; null if unbranded/store-generic
       "brand_tier": "mainstream",            // value | mainstream | premium | organic-specialty
       "qty": 1, "unit": "kg", "size": 2.0,
       "unit_price": 12.90, "line_total": 25.80,
       "discount": 0.00,
       "item_category": "meat",               // coarse grocery taxonomy
       "is_discretionary": true               // snacks/alcohol/treats vs staples
     }],
     "receipt_total": 147.35,
     "confidence": 0.93
   }
   ```
   **Brand capture matters** — it's what powers tier‑drift and splurge detection in Part B. Receipts often abbreviate or omit brands; when absent, set `brand: null` rather than guessing, and let `brand_tier` fall back to the merchant/price context.
3. **Storage — new `LineItems` tab** (bootstrapped automatically like `Merchants`):
   `dedupe_key · date · merchant · account · raw_text · item_name · product_key · brand · brand_tier · qty · unit · size · unit_price · line_total · discount · item_category · is_discretionary`
   - **Link to the parent transaction via the existing `dedupe_key`** — do **not** add columns to `Transactions`; its 10‑column schema and balance formulas stay untouched.
   - **`Products` catalog tab** (auto‑created): `product_key · canonical_name · typical_unit · category · is_discretionary · known_brands · baseline_unit_price · baseline_set_date · last_seen`. Grows as new items appear; the LLM matches new `raw_text` against existing keys first so `BRC CHKN BRST` and `CHICKEN BREAST 2KG` collapse to one product. The **baseline unit price** (first reliable observation, or a rolling early‑period median) is what later price movement is measured against.
4. **No per‑item confirmation.** The user confirms the **transaction** as today (that's what touches balances); line items are written without a 40‑item approval wizard. They're analysis‑only data, so a wrong item costs nothing — friction here would kill the feature.
   - Sanity check: if `sum(line_total) − discounts` differs from the transaction amount by more than ~2%, store the items but set a `reconciled:false` flag and exclude that receipt from price analysis.
5. **Volume:** expect hundreds of rows/month. Fine for Sheets, but keep `LineItems` append‑only and index by `product_key` for the analysis reads.

### Part B — Analysis & recommendations

`analyzer.gs` runs monthly (and on demand via a `/items` command). Compute **deterministically in code**, then let the LLM narrate — never let the model do the arithmetic:

- **Unit‑price normalization** — per kg / per L / per 100g, so sizes and pack counts are comparable.
- **Cross‑merchant price gaps** — the highest‑value signal, since you shop Fair Price, Cold Storage, RedMart, Don Don Donki, Little Farms and M&S: *"Berries average S$9.80/kg at Fair Price vs S$16.40 at Little Farms — you bought them 6× at the pricier one."*
- **Frequency & basket‑share** — items appearing in most baskets; the top 10 products by spend share.
- **Hidden Wants inside Needs** — sum `is_discretionary` within `Продукты` receipts. *"S$310 of your S$1,180 grocery spend was snacks, treats and alcohol — that's Wants sitting inside a Needs bucket."* This is invisible in the current 50/30/20 view and is likely the most actionable output.
- **Repeat‑buy / possible waste** — perishables re‑bought at intervals shorter than they'd plausibly be consumed.
- **Optimization candidates** — bulk vs unit sizing, store brand vs premium brand, subscription‑worthy staples, and merchant‑switch suggestions with the S$/month saving quantified.

#### Brand insights
- **Brand mix per product** — which brands you actually buy for each `product_key`, and the unit‑price spread between them. *"You buy three yoghurt brands; the one you buy most is also the priciest per 100g."*
- **Brand‑tier drift (a splurge signal)** — track the share of spend by `brand_tier` over time. A rising premium/organic share is a behavioral change worth naming: *"Premium‑tier items were 18% of grocery spend in Q1 and 31% in Q2."*
- **Store‑brand opportunity** — where a value/house brand of the same product exists in your own history at a materially lower unit price, quantify the switch. Only suggest substitutions **you have actually bought before** — don't invent products or recommend unfamiliar brands.

#### Splurge detection ("did we start splurging on something?")
Compare a recent window (last 1–2 months) against a trailing baseline (prior 3–6 months) per `product_key` and per `item_category`, and flag **step changes**, distinguishing the four causes so the advice is right:
1. **More often** — purchase frequency up (e.g. berries 2×/month → 7×/month).
2. **More each time** — quantity per basket up.
3. **Traded up** — same product, higher `brand_tier` or a pricier variant (this is the classic splurge).
4. **Pricier venue** — same product, shifted toward a more expensive merchant.
Report as: *"Cheese: S$41/mo → S$96/mo. Driver: switched from mainstream to specialty brands (+S$38) and buying it 2× more often (+S$17)."* Attribute the change to a driver rather than just reporting the delta — the driver is what makes it actionable. Suppress flags below a materiality floor (e.g. < S$15/month) so the review isn't noise.

#### Inflation & price trend over time
- **Personal grocery inflation index** — a basket‑weighted index built from *your own* repeat purchases: for products bought in both periods, weight each product's unit‑price change by its share of your spend. Report monthly, quarterly, and YoY once history allows. *"Your personal grocery basket is up 6.1% over 12 months."*
- **Decompose "spending more" into price vs behavior** — the crucial split, and the reason the index is worth building: hold quantities constant to isolate how much of an increase is **prices rising on you** versus **you buying differently**. *"Grocery spend up S$210/mo: ~S$70 is price inflation, ~S$140 is changed buying."* Only the second half is something you can act on; the first is planning information.
- **Per‑product price history** — biggest movers up and down vs their `baseline_unit_price`, with the date the shift began, so a step change (repricing) is distinguishable from a gradual drift.
- **Guard against false inflation.** A unit‑price rise is only inflation if it's the *same* thing: control for pack size, merchant switch, brand tier, and promo/discount pricing. A move from Fair Price house brand to Little Farms organic is a **trade‑up, not inflation** — classify it as such. Require a minimum number of observations (≥3 in each period) before calling a trend, and exclude `reconciled:false` receipts.

**Output — a monthly "Basket Review"** (Telegram, then optionally a written summary): ≤5 findings, each with a **concrete number and one suggested action**, ranked by annualized saving. Lead with **splurge/step‑changes** (new and actionable) over standing price gaps (already known from prior months), and close with the one‑line **personal inflation** read as context rather than as a to‑do. Example: *"Cheese spend nearly doubled — mostly a switch to specialty brands. Meanwhile your overall basket is up 6% YoY, so ~a third of the grocery increase is just prices."*

**Tone (hard requirement).** This is about **cost optimization, not food policing.** Recommend on price, unit cost, brand tier and merchant choice — never on what the family should or shouldn't eat, and never frame purchases as indulgent or as something to feel bad about. "Splurge" is a **neutral, descriptive** label for a spending step‑change, not a judgment: report it as information ("this went up, here's the driver"), and let Val decide whether it's a problem — a deliberate trade‑up to better coffee is a legitimate choice, not an error. Flag an item only when there's a cheaper way to buy *the same thing*, or when the pattern itself is the point. Findings are suggestions the user can ignore; no streaks, no guilt, no "you failed" framing.

**Acceptance.** Receipt photos produce accurate line items (incl. `brand`/`brand_tier` where printed) linked to the right transaction; variant spellings collapse to one `product_key`; bank screenshots produce none; the transaction total reconciles (or is flagged); the monthly Basket Review produces ≥3 specific, numerically‑grounded findings with actions; **splurge flags name a driver** (frequency / quantity / trade‑up / venue) rather than just a delta; the **inflation index excludes** pack‑size, merchant and brand‑tier changes and is suppressed until there are enough observations; every figure traces to `LineItems` data, none invented.

**Checkpoint.** Feed 5–10 real grocery receipts across different merchants, ideally spanning a few months. Verify: item and brand extraction accuracy, product matching across merchants, and that the price‑gap, hidden‑Wants, splurge and inflation findings match what you'd conclude reading the receipts yourself. Sanity‑check the inflation figure against a known reference (e.g. Singapore CPI food) — a wildly divergent number usually means a trade‑up is being miscounted as price movement.

---

## Build order & rationale

1. **Stage 0** (discovery gate) — unblocks everything; prevents silent corruption.
2. **Stage 1** (read layer) — shared dependency.
3. **Stage 2 — UC‑3 Daily Coach (P0)** — the headline daily value; read‑only, low‑risk, ships the daily‑saldo brief fast. Concludes the daily use cases.
4. **Stage 4 — UC‑6 Weekly mandatory calendar** — the weekly cadence; ensures no forgotten fixed payment. Small‑to‑medium once Stage 0 says what column G is; the calendar seed is the new work.
5. **Stage 3 — UC‑4 Reconciler** — the meatiest/most failure‑prone piece; **upload works any time** (PDF or CSV), with only the prompt tied to month‑end. Isolate it with its own focused build and real‑statement tests.
6. **Stage 5 — UC‑5 Monthly Coach** — thin reuse of the Stage 2 engine.
7. **Stage 6 — UC‑7 New‑month tab** — most structure‑sensitive; tested on a copy before going live.
8. **Stage 7 — UC‑8 Line‑item receipt intelligence** — **split it**: ship **Part A (capture)** early, alongside Stage 2, so item history starts accumulating immediately; build **Part B (analysis)** here, once there are ~4–8 weeks of data to find patterns in.

---

## Appendix — what changed in v2.4

- **Model upgraded to `gemini-3.7-flash`** (GA 13 Aug 2026) from `gemini-3.6-flash` — same price, better document comprehension (relevant to statement parsing). Codebase currently defaults to `gemini-3.5-flash-lite`; update `gemini.gs` and `coach.gs`.
- **UC‑4 (Reconciler) moved ahead of UC‑6** — now **Stage 3**; the mandatory calendar is **Stage 4**. The reconciler is the most valuable and most independent piece and is no longer blocked by UC‑6's details.
- **Reconciler split into 6 sub‑stages (3A–3G)**, each a separate Antigravity prompt with its own test: parse → normalize → match (pure function) → filter non‑spend → stage → commit → entry points. Feeding it whole produced poor results.
- **Test harness added as a prerequisite** — `tests.gs` with `assertEq`/`runAllTests`, a `_TestFixtures` tab of real statement samples, a `DRY_RUN` flag, and a **sandbox copy of the sheet** so nothing is tested against the live ledger.
- **Reconciler runs without Telegram** — Sheets custom menu + Drive‑folder drop as the primary path (plus editor Run, curl, `clasp run`, local CLI as alternatives). Logic lives in `reconciler.gs` with **no Telegram dependencies**; `webhook.gs` may call it but never contains it.
- **Review moved to a `_Reconcile` staging tab** with checkboxes instead of a sequential Telegram wizard — far better for reviewing dozens of rows at once.
- **Two new agent rules** at the top: one sub‑stage per prompt with a passing test before advancing; nothing writes to `Transactions` until the step that says so.
- Stage 4 (mandatory) gained its own tests and a menu entry.

---

## Appendix — what changed vs v2.1

**v2.3 (23 Aug 2026) — Stage 0 closed, model verified against the live sheet:**
- **New "Verified data model" section** — the authoritative reference for Stages 1–2.
- **Schema corrected:** `Transactions` is **11 columns**, J = `Notes`, K = `50/30/20 category` (a Notes column was added since the original export). `writer.gs` already does this correctly.
- **Coach math verified arithmetically:** `K(n) = L(n−1) + D17`, `L(n) = K(n) − Траты(n)`, `D19` = budget left ÷ days left. Brief leads with **K** (reality check), states **D19** (realistic daily), and offers **`days_to_positive = ceil(|K|/D17)`** as the recovery path.
- **`Траты` rule established by verification:** counts `Тип = "Расходы"` **only** — confirmed against 01.07.2026 (S$279,66); excludes `Обязательные расходы` and `Снятие денег`.
- **Taxonomy reconciled:** 22 transaction categories = 19 in the 50/30/20 tab + 3 excluded (`Налоги`, `Отложения (премия)`, `Кредитка`). Column K holds **five** values but the tab reports **three** — so the coach **reads the tab's numbers, never recomputes buckets**. Earlier "four buckets incl. Taxes" was wrong.
- **`CATEGORY_TO_BUCKET_MAP` must be imported from the `-` tab at runtime** — the taxonomy already changed (`Аренда`→`Квартира`, `Детский сад`→`Школа & Детский сад`, `Авто` added as Wants).
- **Stage 3 mapping table rebuilt** from the 11 real labels; `Родители` = visible planned **S$0 line** (never alert), `CPF` = `NON_LEDGER_MANDATORY`, `Отложения (премия)` = `Savings` in column K but absent from the tab.
- **Still open:** whether mandatory column **G** is a formula or a checkbox (run `showMandatory()` — decides Stage 3's path).

- **Reorganized by cadence** (daily → weekly → monthly); stages renumbered accordingly.
- **UC‑3 Daily Coach is now P0** and explicitly closes the daily set (was Stage 3).
- **UC‑6 reworked** from a daily/after‑the‑20th unlogged‑check into a **weekly** feature with three parts: a **payment calendar** (seeded from history, Val‑confirmed, EOM‑aware), a **weekly unpaid reminder**, and **missed‑date alerts** for expected dates that have passed. Optional day‑of alert and optional column‑G write‑back retained.
- **Reconciler (Stage 4) decoupled from month‑end:** statement upload is **always accepted, any date**, from either user; only the *prompt* stays EOM. Diff is scoped to the **statement's own date window** (so mid‑month/partial uploads work). **CSV is a first‑class input alongside PDF** — preferred, in fact (no OCR ambiguity, never encrypted), with header‑row detection, per‑bank column mapping, split debit/credit handling, and an LLM fallback for unknown layouts.
- **New UC‑8 (Stage 7) — line‑item receipt intelligence:** capture individual items (incl. **brand** and **brand tier**) from receipt photos into a new `LineItems` tab (+ a `Products` catalog with baseline unit prices for cross‑merchant matching), linked to the parent transaction by `dedupe_key` so `Transactions` stays untouched. Monthly **Basket Review** covering: unit‑price normalization, cross‑merchant gaps, repeat‑buys, **discretionary spend hidden inside `Needs` grocery runs**, **brand mix and brand‑tier drift**, **splurge detection** (step‑changes attributed to frequency / quantity / trade‑up / venue), and a **personal grocery inflation index** that separates price rises from changed buying. No per‑item confirmation (analysis‑only data); cost‑optimization framing only, never food policing, and "splurge" is descriptive not judgmental. Capture ships early, analysis after data accumulates.
- **Monthly reordered:** **reconciler first**, then **monthly coach**, then the **new** **UC‑7 auto‑create next month's tab**.
- **Stage 0 gains a monthly‑tab template map** (`monthTemplate`) to support UC‑7's clone‑and‑reset.
- Carried from v2.1: explicit `MONTH_TABS` (no name derivation; Aug ≠ `А'26`); label→category map + non‑ledger exclusions; **fuzzy** reconciliation (amount + ±3 days + merchant similarity) with non‑spend filtering and encrypted‑PDF handling; **read, don't recompute** saldo; ~~four buckets incl. Taxes~~ → **corrected in v2.3: the 50/30/20 tab has THREE buckets (Needs/Wants/Savings)** — `Налоги` is tagged `Taxes` in col K but has no row in the tab; volatile categories = Рестораны/Развлечения/Дом/Подарки (no `Шопинг`); `gemini-3.7-flash` default (upgraded from 3.6 in v2.4); briefs to both users, either can reconcile.
