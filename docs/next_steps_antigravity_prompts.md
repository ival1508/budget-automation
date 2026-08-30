# Next steps — Antigravity prompts (copy‑paste, one at a time)

**Rule for all of these:** one prompt per step. Run it, check the result, commit, *then* move on. Do not paste two steps together — that's what broke the reconciler attempt.

**After every step that changes code:**
```bash
git add -A && git commit -m "<step description>" && git push
clasp push
```

**Two lessons learned the hard way — apply to every step:**
1. **Antigravity cannot run Apps Script.** It has no `clasp run` access, so it will either predict output ("Expected Execution Output") or run a **Node mock** with invented data. Neither proves anything about your live sheet. **You** run every test in the Apps Script editor. If a response contains predicted or mocked output, the step is **not done**.
2. **Run the `test_*` wrapper, not the function itself.** Bare functions `return` values; only the test wrappers `Logger.log` them. Running the function directly gives you an empty log.
3. **Watch for unrequested changes.** Twice now it has slipped in extra "improvements" alongside the requested fix — most dangerously, replacing a hard failure with a **guessed value** (Step 6). Always read the diff for changes you didn't ask for, and be especially suspicious of anything that turns an error path into a fallback. A wrong-but-plausible number is worse than a crash.
4. **`clasp push` is not a deploy.** The `/exec` URL serves a specific deployed *version*. After pushing, use **Deploy → Manage deployments → ✏️ pencil → New version** — never "New deployment" (it mints a new URL and 404s the webhook, which happened on 30 Aug).

**Current deployment (record any change here):**
```
/exec  https://script.google.com/macros/s/AKfycbyhRAocN8rNBhWl3NBL7yIgStBCLIrgHfxNNOC-zt6Pa7HBvQPJ9b7tykdeu4QuMm3_/exec
Version 63 · 30 Aug 2026 · Execute as: Me · Who has access: Anyone  ← both required, else 401
Webhook must include the secret, URL-encoded:
  setWebhook?url=<EXEC_URL>%3Fsecret%3D<WEBHOOK_SECRET>
```

---

## Progress

| Step | What | Status |
|---|---|---|
| 0 | Column G check + double-message check | ✅ **Done** — G is a **manual checkbox** (Stage 4 → Path B); `Родители` is S$0/FALSE → must be treated as satisfied; no duplicate evening messages (the 22:00 recap is the reply to "nothing today") |
| 1 | Audit before building | ✅ **Done** — found `generateMonthlyCoachBrief()` + `generateWeeklyMandatoryReport()` already exist and are trigger-wired (Stages 4/5 are partly built); found the **K-vs-D19 label collision** |
| 2 | Column-G `Тип` bug | ✅ **Done** — fixed in `getLoggedMandatoryThisMonth` **and** `getCategoryVelocity`; also found+fixed the bigger bug: `getCategoryVelocity` had **no `Тип` filter at all** (Дом included S$32k/S$72k renovation transfers + Carousell income → now S$1,246) |
| 2b | `getRange(...,9)` sites | ✅ **Checked — not bugs.** All four only read indices 0–8 (A–I) for dedupe keys. Correct as-is |
| 3 | Model IDs | ✅ **Done** — `gemini-3.7-flash` primary, chain 3.7→3.6→3.5-lite; `callGeminiApiWithRetry` now returns `{text, modelUsed}` and warns on fallback (caught a 503 fallback being mislabelled as 3.7) |
| 4 | Runtime category map | ✅ **Done** — `getCategoryBucketMap()` reads 22 categories from the `-` tab; tightened to one fixed column, no `|| 'Wants'` default, `UNKNOWN` + loud warning instead |
| 4b | Migrate `enrichTransaction` | ✅ **Done** — batch-loads the map once; unknown category → `needs_review` + flag, not a silent bucket. Verified in Apps Script |
| 5 | `getDailyPacing()` + D17 | ✅ **Done** — verified live: K=−87.81, L=−396.88, D17=309.07, D19=110.63, days_left=2, days_to_positive=1. Identity **K = L(yest) + D17** checks out ✓ |
| 6 | Fix `get503020Status` | ✅ **Done** — taxes bucket removed (3 buckets only); `target_header` = "Target month"; summary rows filtered from sub_categories; verified live: needs 21125.48/17721.09, wants 5385.74/9665.08, savings **0**/7496.54 |
| 7 | Standalone `getTodaySpend` | ✅ **Done** — `Расходы`-only; cross-check vs column J passes on both today **and** the mixed-type date 01.07.2026 (279.66 = 279.66). The test caught a bug in the *helper* (wrong month tab), not the reader |
| 7b | **Consolidate daily-budget reads** | ✅ **Done** — all reads on `getDailyPacing`; K relabelled `cumulative_position` (was `daily_budget`); negatives in plain language; money rounded; trends removed from payload, which **stopped the model hallucinating** (`S$507.51` was invented) |
| 8 | Coach payload + persona | ✅ **Done** — exact schema; `categories_over_target` computed & split by Тип (discretionary vs committed); persona rewritten; brief now names actionable categories with S$ formatting and no minus signs. **Delivers to Telegram.** |
| 9 | Heartbeat scheduler | ✅ **Done** — 4 `.atHour()` triggers replaced by ONE `dispatch()` every 15 min running 6 jobs; claim-before-work guard prevents double-send; `setupTriggers()` run, verified |
| 10 | Independent verification | ⬜ **Next** |

**Open item carried forward:** `getDailyPacing` returns raw floats (`110.62999999999866`). **Round all money to 2dp at the presentation layer** — never let float tails reach Telegram or the LLM payload. Handled in Step 7b/8.

---

## STEP 0 — ✅ DONE — You do this yourself (no Antigravity) · 2 minutes

Two things only you can answer. Both are quick and both unblock later work.

**0a. Close the last Stage 0 unknown.** In the Apps Script editor, paste `showMandatory()` (below) into any `.gs` file, select it in the function dropdown, click **Run**, and read the log:

```javascript
function showMandatory() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Август'26");
  const r = s.getRange('D3:G13');
  const v = r.getDisplayValues(), f = r.getFormulas();
  v.forEach((row, i) => Logger.log(
    `${i+3}: D="${row[0]}" | E="${row[1]}" | G="${row[3]}" | G-formula="${f[i][3]}"`));
}
```
- **Empty `G-formula`** ⇒ manual checkbox ⇒ Stage 4 takes Path B (write TRUE back).
- **Non‑empty** ⇒ formula ⇒ Stage 4 takes Path A (just read FALSE rows — much simpler).

**0b. Check your phone.** Are you getting **two** evening Telegram messages (21:00 nudge + 22:00 recap)? The evaluation found a `sendDailyEveningRecap()` at 22:00 that isn't in the PRD. If you're getting both, decide which to keep.

---

## STEP 1 — ✅ DONE — Audit what already exists *before* building anything

> This may save two entire stages. Do it first.

```
Read coach.gs and report ONLY — do not change any code.

1. `generateMonthlyCoachBrief()` (around coach.gs:322-832) and
   `generateWeeklyMandatoryReport()` — for each, tell me:
   - What does it actually do today? Does it run without error?
   - Which reader functions does it call?
   - Is it wired to a trigger, or is it dead code nobody calls?
   - How far is it from the PRD's Stage 5 (Monthly Coach) and Stage 4 (Mandatory) specs?

2. `sendDailyEveningRecap()` in nudge.gs (~line 150-220, fires 22:00 SGT):
   - Does it duplicate the 21:00 nudge? Show me what each sends.

3. List every function in reader.gs with a one-line description and
   which other files call it. I need to know what's live vs orphaned
   before we refactor.

Output a table. No code changes.
```

**Why:** if the monthly/weekly coaches already work, Stages 4 and 5 become "verify and align" rather than "build." And you need the caller map before renaming anything.

---

## STEP 2 — ✅ DONE — Fix the actively-wrong column read 🔴 *highest risk*

```
Fix ONE bug in reader.gs. Nothing else.

`getLoggedMandatoryThisMonth()` (reader.gs ~173-250) checks BOTH column C
and column G for `Тип` — column G is a legacy 9-column-schema artifact.

In the current 11-column schema, column G is `На счете после` (a NUMBER,
the running balance). Reading it as `Тип` is wrong and fails silently.

Schema is: A Дата · B Счёт · C Тип · D Сумма · E Сумма в SGD ·
F На счете до · G На счете после · H Категория · I Где · J Notes ·
K 50/30/20 category

1. Remove the column-G check. `Тип` is column C only.
2. Grep the whole codebase for any OTHER place reading a column by an
   old 9- or 10-column assumption and list what you find (report, don't fix yet).
3. Show me the before/after diff.
```

---

## STEP 3 — ✅ DONE — Model IDs (two one-line changes)

```
Update the Gemini model ID to `gemini-3.7-flash` (GA 13 Aug 2026).

1. gemini.gs:8 — `GEMINI_MODEL_ID` is currently 'gemini-3.5-flash-lite'.
   Set it to 'gemini-3.7-flash'. Keep 'gemini-3.5-flash-lite' as the
   high-volume/backup option.
2. coach.gs:300 — hardcoded 'gemini-3.5-flash-lite'. Replace the hardcoded
   string with the constant from gemini.gs so there is ONE source of truth.
3. Make one test call and confirm a non-empty response.

Nothing else.
```

---

## STEP 4 — ✅ DONE — Runtime category map (kills the hardcoding)

```
Stage 1: implement `getCategoryBucketMap()` in reader.gs. Nothing else.

Currently constants.gs:73-108 has a hardcoded CATEGORY_TO_BUCKET object.
The taxonomy has already changed once (Аренда→Квартира, Детский сад→Школа &
Детский сад, Авто added), so it must be read at runtime.

1. Add `getCategoryBucketMap(ss)` to reader.gs: read the `-` tab, column B
   = Категория, and its paired bucket column. Return {category: bucket}.
2. Expect 22 categories. Buckets seen in the sheet: Needs, Wants, Savings,
   Taxes (Налоги), '-' (Кредитка). Note: `Отложения (премия)` = Savings.
3. Add `test_getCategoryBucketMap()`: assert 22 entries, and spot-check
   Квартира=Needs, Рестораны=Wants, Отложения=Savings, Налоги=Taxes.
4. Keep the constants.gs map in place for now as a fallback ONLY if the
   `-` tab read fails — log loudly when the fallback is used.
5. Do NOT change any caller yet. Report which files call CATEGORY_TO_BUCKET.

Print the full map you read so I can eyeball it.
```

---

## STEP 5 — ✅ DONE — `getDailyPacing()` with D17 ⭐ *the Stage 2 blocker*

```
Stage 1: add `getDailyPacing()` to reader.gs. ADD a new function — do NOT
rename or delete getDailyBudgetStatus() or getDailySaldo(); other code may
call them.

1. Add `FLAT_DAILY_PACING_CELL: 'D17'` to SHEET_FACTS.MONTHLY_TAB_STRUCTURE
   in config.gs (currently missing — this is the actual gap).

2. Add `getDailyPacing(optDate)` returning exactly:
   {
     K_cumulative_today,   // monthly tab col K, today's row — the reality check
     L_saldo_yesterday,    // col L, yesterday's row
     D17_flat_daily,       // cell D17 — flat pacing
     D19_realistic_daily,  // cell D19 — budget left ÷ days left
     days_left,
     days_to_positive      // Math.ceil(Math.abs(K)/D17) when K<0, else 0
   }
   READ these cells. Never recompute the saldo chain.
   Parse currency from "S$1 234,56" (space thousands, comma decimal).
   Pure read: no writes, no Telegram, no Gemini.

3. Add `test_getDailyPacing()` asserting:
   - D17 and D19 both parse to numbers
   - D19_realistic_daily EXACTLY equals cell D19 read directly
   - days_to_positive is 0 when K >= 0; matches ceil(|K|/D17) when K < 0

Print all six values so I can compare against the sheet.
```

**Check yourself:** does `D19_realistic_daily` match cell D19 in `Август'26`? If not, something is recomputing instead of reading.

---

## STEP 6 — ✅ DONE — Fix the 50/30/20 reader

Took three prompts. Prompt 1 removed the taxes bucket and added `target_header`. Prompt 2 reverted two unrequested changes it slipped in. Prompt 3 cleaned up the output.

**What it fixed:**
- Removed the phantom `taxes` bucket — the tab has only Needs / Wants / Savings
- Added `target_header` (now `"Target month"`) so a stale target is visible
- Filtered spreadsheet summary rows (`Total`, `Total income`, `Difference`) out of `sub_categories`
- Added `safeCellStr()` so a failed read returns `''`, never the literal string `"undefined"`
- Debug row-dump restored behind a `DEBUG_503020` flag / `optDebug` param

**⚠️ Two unrequested changes I had to make it revert — watch for this pattern:**
1. It replaced `if (targetColIndex === -1) return defaultPacing;` with a **guessed column** (`Math.min(Math.max(2, lastCol - 2), 2)`). That would have silently reported *another month's* numbers when the current month's column is missing — e.g. on 1 Sep before a `09/2026` column exists. Reverted to: loud warning + return zeros.
2. It deleted the per-row debug logging. Restored behind a flag.

**Verified live (August 2026):**

| Bucket | Actual | Target | |
|---|---|---|---|
| Needs | S$21,125.48 | S$17,721.09 | 19% **over** — driven by Школа & Детский сад 7,204.80 vs 3,900 |
| Wants | S$5,385.74 | S$9,665.08 | under — but Развлечения 1,892.22 vs 450 is **4× over** |
| Savings | **S$0** | S$7,496.54 | nothing saved in August |

`target_header` = `"Target month"` ✓ · sub_categories: needs 8, wants 10 ✓ · no `Difference` row ✓

> **Note for Step 8:** the coach's first real brief will be blunt — savings at zero and Needs 19% over. Worth checking the tone lands right.
> **Also:** `Total income` (row 25) reads 0 for August. If you want income in the coach payload later, that's a gap in the sheet, not the code.

<details><summary>Original Step 6 prompt (for reference)</summary>

```
Stage 1: fix `get503020Status()` in reader.gs. Nothing else.

Two bugs:
1. It returns a `taxes` bucket. The 50/30/20 TAB HAS NO TAXES ROW — it has
   exactly three: Needs, Wants, Savings. Remove the taxes bucket.
2. It doesn't return `target_header`. Read the header text of column AE
   and return it as `target_header`, so a stale target month is visible
   instead of silently wrong.

Return: {needs:{actual,target}, wants:{actual,target},
         savings:{actual,target}, target_header}

Read the tab's own computed cells — do NOT recompute from Transactions.

Add test_get503020Status() asserting three buckets, all with actual AND
target populated, plus a non-empty target_header. Print the result.
```
</details>

---

## STEP 7 — ✅ DONE — Standalone spend reader ⚠️ *the last unverified assumption*

> This is the final piece of Stage 1's reader, and the most important to get right: `spend_today` is the number every coach figure leans on.

```
Stage 1: add a standalone pure function `getTodaySpend(optDate)` to reader.gs.
Nothing else.

CRITICAL RULE (verified against the sheet): Траты counts
`Тип == "Расходы"` ONLY — both accounts, that date.
It EXCLUDES Обязательные расходы, Снятие денег, and all income types.
Verified example: 01.07.2026 Траты = S$279.66 = six Расходы rows;
the S$7,592 mortgage (Обязательные расходы) and S$372 Снятие денег
are NOT counted.

1. Add `getTodaySpend(optDate)` — pure, no writes, no Telegram.
   Sum column E (Сумма в SGD) for rows where Col C Тип == "Расходы"
   and Col A date matches the target date.

2. Also check `getDailyBudgetStatus()` / `getTodaysTransactions()`: do they
   already apply this rule correctly, or do they include other Тип values?
   Report what you find — do NOT change them yet.

3. Add `test_getTodaySpend()` that CROSS-CHECKS against the monthly tab's
   column J (Траты) for the same date. THEY MUST BE EQUAL.
   Log both numbers side by side, and also test against a date with known
   mixed types (e.g. 01.07.2026, where Траты = 279.66 but the day also
   contains a 7592 Обязательные расходы and a 372 Снятие денег).

Do NOT run a Node mock — I will run it in the Apps Script editor.
If the column-J cross-check fails, STOP and tell me rather than adjusting
the test to pass.
```

**Why the 01.07.2026 case matters:** that date contains all three transaction types, so a wrong filter is off by *thousands*, not subtly. A date with only `Расходы` rows would pass even with a broken filter.

**Run yourself:** `test_getTodaySpend` in the Apps Script editor. The two numbers (function output vs column J) must match exactly.

---

## STEP 7b — ✅ DONE — Consolidate daily-budget reads ⚠️ *new, from the Step 1 audit*

> Do this AFTER Step 7 (it consumes `getTodaySpend()`). This fixes a bug that would make your morning brief and evening recap quote **different numbers under the same label**.

```
Consolidate all daily-budget reads onto getDailyPacing(). Nothing else.

PROBLEM (found in the Step 1 audit): three code paths read "daily budget"
from two different cells and BOTH call it "Daily Budget":
  - getDailySaldo() reads cell D19 (realistic go-forward daily allowance)
  - getDailyBudgetStatus() reads column K (cumulative budget available today)
  - sendDailyEveningRecap() uses getDailyBudgetStatus's column-K number and
    labels it "🎯 Daily Budget"
Meanwhile buildCoachPayload() uses getDailySaldo's D19 number.

Result: the morning brief and the evening recap will quote DIFFERENT numbers
for the same day under the same label. K and D19 answer different questions
and must never share a name.

getDailyPacing() now returns both under unambiguous names and is verified
against the live sheet.

TASKS:

1. Make getDailyPacing() the single source for K / L / D17 / D19.
   Migrate these consumers to call it:
   - coach.gs buildCoachPayload()  (currently getDailySaldo)
   - nudge.gs sendDailyEveningRecap() / generateDailyTransactionsRecap()
     (currently getDailyBudgetStatus)
   Keep getDailySaldo() and getDailyBudgetStatus() as thin wrappers that
   delegate to getDailyPacing() — do NOT delete them, other callers exist.

2. Fix the LABELS so the two numbers are never confused. In the evening
   recap, the column-K figure must NOT be called "Daily Budget". Use:
   - K  -> "Cumulative position" (or plain language, see #3)
   - D19 -> "Spendable per day"

3. Handle negatives in plain language. Today K is -87.81 and the recap
   previously printed "Daily Budget: S$-557.45", which reads like a bug.
   Never print a negative allowance. Instead:
   "You're S$88 behind pace — one zero-spend day clears it."
   Use days_to_positive from getDailyPacing.

4. ROUND ALL MONEY at the presentation layer. getDailyPacing returns raw
   floats like 110.62999999999866 and -87.8096774193574. No float tails may
   ever reach a Telegram message or the LLM payload. Round to 2dp.
   Keep getDailyPacing itself precise — days_to_positive divides by D17.

5. Grep for any other place reading D19 or column K directly and report it.

TEST: add test_dailyBudgetConsistency() asserting that the number the evening
recap uses and the number buildCoachPayload uses are BOTH sourced from
getDailyPacing, and that they are labelled differently. Then RUN it in Apps
Script (not Node) and paste the ACTUAL log.

Also print, side by side, what the evening recap WOULD say today vs what the
morning brief WOULD say today, so I can confirm they're consistent.
```

**Watch for:** that it kept `getDailySaldo`/`getDailyBudgetStatus` as *delegating wrappers* (deleting them breaks unaudited callers), and that rounding happens at presentation, not inside `getDailyPacing`.

---

## STEP 8 — ✅ DONE — Coach payload + persona · *the brief reaches Telegram*

**Final output, live in Telegram:**
> *"You're S$87.81 behind pace, but one zero-spend day clears it. That leaves S$110.63 a day for the last 2 days. **Развлечения** is the main category to watch, sitting at S$1,892.22 against a S$450 target."*

Took three rounds. What each fixed:

**Round 1** — correct but flat, and it said *"pull back on Школа & Детский сад"* — unactionable advice about committed school fees, because `categories_over_target` pooled all buckets and fixed Needs categories outranked discretionary ones.

**Round 2** — my first fix (exclude fixed categories entirely) was **wrong**: it would hide a real S$3,305 overspend. Val's sharper model replaced it:
- **Target comparison stays whole-category** — actual vs target uses `Расходы` + `Обязательные расходы` combined, because that's how the budget is set and how the 50/30/20 tab computes it.
- **Actionability is about the *composition* of the overspend.** Split each over-target category by `Тип`: `discretionary_spend` (Расходы) vs `committed_spend` (Обязательные расходы). Rank by **discretionary_spend**, not raw `over_by`. Drop categories where discretionary is 0 — nothing to advise.
- Result: Развлечения (100% discretionary) leads; Транспорт correctly ranks third because S$2,707 of its S$3,493 is the committed car loan and only S$786 is actionable.

**Round 3** — three polish edits: model priority (below), discretionary framing in prose, and cover *all* over-target categories (cap 5, brief allowed 4 sentences) rather than just one.

> **Model priority swapped after four 503s from 3.7 in one day** — one coach run took **5 minutes** against Apps Script's 6-minute ceiling. Now: `gemini-3.6-flash` primary → `gemini-3.5-flash-lite` (fastest tier, for speed when the primary struggles) → `gemini-3.7-flash` last. Retries capped at 1 per model so a slow primary can't eat the execution budget.

> **Note for Stage 5:** a category over target purely on *committed* spend now drops out of the daily brief — correct, since there's no daily action. But that's exactly what the **monthly review** should surface: a fixed cost persistently over target means the *target* is wrong, not the spending.

**Where 7b left it.** The brief is now accurate and grounded but **flat** — it recites numbers without advising, and never mentions a category despite `Развлечения` running 4× its target and savings at zero. Accurate-and-dull is the right starting point; this step adds the judgement.

Current output for reference:
> *"You logged S$0 in spending yesterday. Your available budget stands at S$110.63/day across the remaining 2 days of the month. Your cumulative position is currently S$87.81 behind pace, which takes 1 zero-spend day to bring back to positive."*

Three sentences, every number correct, no advice, no category. Fix that.

```
Stage 2: refactor `buildCoachPayload('daily')` in coach.gs to the exact
schema below, then tune the persona. Nothing else.

--- PAYLOAD ---

Return exactly these keys. Drop the legacy ones (budget_trend, spend_trend,
recent_daily_trends, pace_verdict, taxes). Do NOT re-add trends — removing
them is what stopped the model hallucinating.

{
  "period": "daily",
  "cumulative_today": <K from getDailyPacing>,
  "realistic_daily": <D19>,
  "flat_daily": <D17>,
  "days_left_in_month": <n>,
  "days_to_positive": <n>,
  "spend_today": <getTodaySpend>,
  "buckets": { "needs":{actual,target}, "wants":{actual,target},
               "savings":{actual,target} },
  "target_header": "<from get503020Status>",
  "categories_over_target": [        // NEW - computed, ranked by overspend
    {"name":"Развлечения","actual":1892.22,"target":450,"over_by":1442.22}
  ],
  "mandatory_warnings": []           // empty until Stage 4
}

`categories_over_target`: from get503020Status sub_categories across ALL
buckets, keep only those where actual > target, sort by (actual - target)
descending, cap at 3. This is what lets the coach name a specific category
instead of speaking in generalities. Exclude any category with target = 0.

Round every money value to 2dp. Raw floats (110.62999999999866) must never
reach the LLM or Telegram.

--- PERSONA ---

Replace the persona prompt with exactly:

"You are a sharp, warm financial coach for a Singapore family. From this JSON
write a Telegram brief of at most 3 short sentences.

Structure:
1. Lead with the reality check: where cumulative_today stands. If negative,
   say plainly how far behind pace they are and the recovery path — either
   days_to_positive zero-spend days, or the softer 'stay under S$X/day'
   equivalent.
2. State what is realistically spendable per day (realistic_daily).
3. Give ONE concrete, actionable instruction — either 'you have room for X'
   or 'pull back on Y'. If categories_over_target is non-empty, name the
   first category and its overspend. Reference at most one category.

Rules:
- USE ONLY numbers present in the JSON. Never compute, infer, extrapolate or
  invent figures. Every number you mention must appear verbatim in the JSON.
- Never describe a trend direction (rising, falling, clawed back, improving)
  unless the JSON explicitly states it. You have no history — do not imply any.
- Always end with an instruction, never a bare summary of numbers.
- Telegram HTML only: <b>bold</b>, <i>italic</i>. Never markdown (**bold**).
- No tables, no headers, no bullet lists. Short conversational sentences.
- Warm and direct, never preachy or moralising. This is money coaching, not
  a lecture. Never shame the user for spending."

--- OUTPUT ---

Generate one brief with today's real data and print BOTH the payload and the
brief. Send it to Val (96069960) ONLY — not to Rita.
```

**Note from the Step 1 audit:** `sendDailyEveningRecap()` already renders spend/budget/saldo. Prefer **one** rendering path with two entry points (morning brief, evening recap) over a parallel implementation — otherwise the two will drift.

**⚠️ Brace for the tone.** With savings at S$0 against a S$7,497 target and Needs 19% over, the first honest brief will be blunt. That's correct behaviour — but read it as a person, not a tester. If it feels like nagging rather than coaching, adjust the persona's last two rules before it starts arriving every morning at 08:00. A brief you learn to ignore is worse than no brief.

**Check when it runs:**
- Every number in the brief appears in the printed payload — no exceptions
- It names a category and gives an instruction, not just a recital
- `<b>` tags, no `**markdown**`
- It arrives in *your* Telegram only

---

## STEP 9 — ✅ DONE — Heartbeat scheduler

**Result:** 4 old `.atHour()` triggers deleted, replaced by **one** `dispatch()` trigger firing every 15 minutes. `setupTriggers()` run successfully (Trigger ID 7613601871432777728).

**Why the heartbeat beats one-trigger-per-job:** `.atHour(8)` only guarantees the *hour* — an 08:00 trigger can fire at 08:47. The heartbeat lands within 15 minutes of the real time. And per-user `morning_time` values can't be expressed as shared fixed-hour triggers at all; the dispatcher reads them per user. Adding future jobs is now a code change, not a trigger change.

**Six jobs now running off the one trigger:**

| # | Job | When | State |
|---|---|---|---|
| 1 | Morning coach | each user's `morning_time` (08:00) | ✅ refined in Step 8 |
| 2 | Evening nudge | 21:00 | ✅ Phase 1, fine as-is — it's a prompt to act, not a brief |
| 3 | Evening recap | 22:00 | 🟡 got the 7b treatment (pacing reads, labels, rounding) but is **template text, not LLM** — no persona work needed |
| 4 | Weekly mandatory audit | Mon 09:00 | 🔴 pre-existing Phase 1 code, **unreviewed** — this is Stage 4 / UC-6 |
| 5 | Monthly retrospective | 1st of month, 09:00 | 🔴 pre-existing, **unreviewed**, still uses legacy `getBudgetCoachContext()` — this is Stage 5 / UC-5 |
| 6 | Month-rollover | last day, 23:30 | ⬜ stub — logs "not implemented", does not mark itself sent |

> **⚠️ Jobs 4 and 5 will fire on schedule with unreviewed code.** The monthly retrospective lands **1 September** with August's data (savings S$0, Needs 19% over). Either let it run and read the output as a free preview of what Stage 5 must fix, or comment out cases 4–5 in `dispatch()` until those stages are built.

**Two bugs caught before `setupTriggers()` was run:**
1. **Double-fire race.** `isTimeInWindow` used `diff >= -2 && diff <= 14` — a **17-minute** window against a 15-minute tick, so two consecutive ticks could both match. `hasSentToday` guarded it, but `markSentToday` ran *after* the send — and a coach run had taken **5 minutes** (Gemini 503 retries), so a second tick could fire mid-send. Fixed: exact `diff >= 0 && diff < 15`, plus **claim-before-work** (mark sent immediately after the check, clear the key on error so the next tick retries).
2. **Empty rollover job** called `markSentToday()` and logged "✅ completed" without doing anything — it would have looked wired up while doing nothing. Now logs "not yet implemented" and doesn't claim the slot.

**Verify after running:** Triggers page (⏰ left rail) shows exactly one `dispatch` entry. To test without waiting for 08:00, set `morning_time` a few minutes ahead, confirm the brief arrives **once**, then run `dispatch` manually and confirm it skips. Check Executions: no-op ticks should complete in milliseconds — it runs ~96×/day against quota.

<details><summary>Original Step 9 prompt (for reference)</summary>

```
Stage 2: replace the trigger architecture in nudge.gs. Nothing else.

1. Add `setupTriggers()` that DELETES all existing project triggers, then
   creates ONE trigger: `dispatch()` every 15 minutes.
2. `dispatch()` checks the clock in Asia/Singapore and fires whatever is due.
3. Guard EVERY send with a once-per-day key in Script Properties:
   `sent_<key>` = yyyy-MM-dd.
4. Match a WINDOW not an exact time.
5. Confirm appsscript.json has "timeZone": "Asia/Singapore".
6. Early-exit fast when nothing is due.

List the triggers before and after. Do NOT run setupTriggers() yet.
```
</details>

---

## STEP 10 — ⬅️ YOU ARE HERE — Independent verification

Run the verification prompt from `antigravity_prompt_verify_stages_0_1_2.md`.

Point: it was written **before** any of these fixes, so it's an independent check on whether they actually took — rather than trusting the same agent that made them. Its final question is the one that matters: **is Stage 3 safe to start?**

**Two things to add to that prompt now**, since the codebase moved:
```
Additionally verify:
- getDailyPacing() is the SINGLE source for K/L/D17/D19. No caller reads
  cell D19 or column K directly except getDailyPacing itself,
  getRecentDailyTrends (historical trajectory - legitimate), and tests.
- No function returns a key named "daily_budget" (renamed to
  cumulative_position in Step 7b).
- getCategoryBucketMap() is used by enrichTransaction; the hardcoded
  CATEGORY_TO_BUCKET in constants.gs is referenced ONLY as a fallback.
- Exactly ONE project trigger exists: dispatch(), every 15 minutes.
- No money value anywhere reaches Telegram or the LLM payload with more
  than 2 decimal places.
```

**Also worth doing before Stage 3:** live with the morning brief for a few days. Tone reveals itself over a week, not in one sample. Track what reads well and what you start skimming — that feedback shapes the Stage 5 monthly coach too.

---

## Then: Stage 3

Only after Step 10 passes. Order from the PRD:
1. `tests.gs` harness + `_TestFixtures` + `DRY_RUN` + **sandbox copy of the sheet**
2. 3A parse → 3B normalize → 3C match → 3D filter → 3E stage → 3F commit → 3G entry points

One sub‑stage per prompt. Nothing writes to `Transactions` until 3F.
