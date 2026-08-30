# Antigravity prompt — STEP 10: Verify Stages 0, 1 & 2

> **Updated 30 Aug 2026, after Steps 0–9.** Paste everything below into Antigravity as a single task. It is **read‑only**: no sheet writes, no deploys, no Telegram sends to anyone but Val.
>
> **Why this exists:** it independently checks whether the fixes from Steps 2–9 actually took, rather than trusting the same agent that made them. Its final question is the one that matters: **is Stage 3 safe to start?**

---

## Task

Verify that Stages 0, 1 and 2 of the Budget 2026 automation are correctly implemented. Do **two** things:

**Part 1 — Static audit.** Read the code and report what exists vs. what should exist.
**Part 2 — Write `verify.gs`**, containing one read‑only function `verifyStages012()` that checks everything at runtime and logs a PASS/FAIL report. I will run it myself in the Apps Script editor.

### Hard constraints
- **Read‑only.** `verifyStages012()` must not write to any sheet, create/modify tabs, deploy, or change Script Properties or triggers.
- **No spam.** If you test Telegram delivery, send **only to Val (`96069960`)**, never to Rita, and only one message.
- **Do not run a Node mock.** You cannot execute Apps Script. Do not fabricate or predict output. Write the function; I run it and paste the real log. If you present predicted output as results, the task is failed.
- **Don't fix anything yet.** Report findings. I'll decide what changes.
- Every check logs `✅ PASS` or `❌ FAIL: <expected vs actual>`, ending with a summary count.

---

## Part 1 — Static audit

Report a table of **file · function · exists? · matches expectation?** for:

- `config.gs` — `SHEET_FACTS` (incl. `FLAT_DAILY_PACING_CELL: 'D17'`), `runDiscovery()`
- `reader.gs` — `getActiveMonthTab`, `getCategoryBucketMap`, `getMandatoryExpenses`, `getLoggedMandatoryThisMonth`, `getDailyPacing`, `getTodaySpend`, `get503020Status`, `getCategoryVelocity`, and the thin wrappers `getDailySaldo` / `getDailyBudgetStatus`
- `coach.gs` — `buildCoachPayload(period)`, the persona prompt, `generateCoachBrief`, `buildFallbackCoachBrief`
- `nudge.gs` — `dispatch()`, `setupTriggers()`, per‑user delivery from `SHEET_FACTS.USERS`
- `gemini.gs` — model constants and `callGeminiApiWithRetry` returning `{text, modelUsed}`
- `enricher.gs` — `enrichTransaction(parsedRow, categoryBucketMap)` and `enrichTransactions`

Flag explicitly if you find any of these **regressions** (all were fixed in Steps 2–9 — confirm none have crept back):

1. Any read of **column G (`row[6]`) as `Тип`** — column G is `На счете после`, a number. Fixed in `getLoggedMandatoryThisMonth` and `getCategoryVelocity`.
2. Any spend total **not filtered to `Тип == "Расходы"`** — `getCategoryVelocity` previously counted `Снятие денег` renovation transfers (S$32k, S$72k) and Carousell income as discretionary spend.
3. A **hardcoded** `CATEGORY_TO_BUCKET` used as anything other than a fallback.
4. A **`taxes` bucket** in `get503020Status` — the 50/30/20 tab has only Needs/Wants/Savings.
5. Any function returning a key named **`daily_budget`** — renamed to `cumulative_position` in Step 7b because it held column K, not D19.
6. Anything **recomputing** saldo / 50/30/20 instead of reading the sheet's cells.
7. **Trend data** (`getRecentDailyTrends`, `budget_trend`, `spend_trend`, `pace_verdict`) in the coach payload — removing it is what stopped the model hallucinating figures.
8. A **guessed fallback** where a lookup fails — e.g. defaulting a column index or a bucket instead of returning zeros / `UNKNOWN` with a loud warning. A wrong‑but‑plausible number is worse than a visible failure.
9. **More than one project trigger**, or any surviving `.atHour()` trigger creation.

---

## Part 2 — Write `verify.gs` with these checks

### Stage 0 — `SHEET_FACTS` vs the live sheet
1. `SHEET_FACTS` has: `MONTH_TAB_NAMES`, `CORE_TABS`, `USERS`, `MONTHLY_TAB_STRUCTURE` (incl. **`FLAT_DAILY_PACING_CELL: 'D17'`** and `CURRENT_DAILY_BUDGET_CELL: 'D19'`), `TRANSACTIONS_TAB_STRUCTURE`, `BUDGET_50_30_20_TAB_STRUCTURE`.
2. `getMonthTabName()` returns a tab that **actually exists** for the current month.
3. `Transactions` has **11 columns**, header J = `Notes`, header K starts with `50/30/20`.
4. Monthly tab `D3:G13` yields **11** non‑empty labels in column D.
5. `D17` and `D19` both read and parse to numbers.
6. `50/30/20` column **AE** target readable; log its header text.
7. The `-` tab yields **22** categories via `getCategoryBucketMap()`, read at runtime.
8. `USERS` has Val + Rita with `chat_id`, `morning_time`, `active`.

### Stage 1 — `reader.gs` (all values must match the sheet)
9. **`getDailyPacing()`** returns all six fields. Assert the identity **`K_cumulative_today ≈ L_saldo_yesterday + D17_flat_daily`** (±0.01) — this is the strongest single proof the row matching is correct. Assert `D19_realistic_daily` **exactly equals** cell D19 read directly. Assert `days_to_positive === 0` when K ≥ 0, else `ceil(|K|/D17)`.
10. **`getTodaySpend()`** cross‑checks against the monthly tab's **column J** for the same date — they must be equal (±0.001). Test **today** AND the mixed‑type date **01.07.2026**, where Траты = 279.66 despite the day also containing a S$7,592 `Обязательные расходы` and a S$372 `Снятие денег`.
11. **`get503020Status()`** returns exactly three buckets (`needs`/`wants`/`savings`, **no `taxes`**), each with numeric `actual` and `target`, plus a non‑empty `target_header` that is not the literal string `"undefined"`. Assert no summary rows (`Total`, `Total income`, `Difference`) appear in `sub_categories`.
12. **`getCategoryVelocity()`** returns `Рестораны`/`Развлечения`/`Дом`/`Подарки` (no `Шопинг`). Assert every category's `total` equals its `Расходы` sub‑total — proof the type filter holds. Assert `Квартира`, `Налоги`, `Отложения`, `Кредитка` are all **0** (they carry only non‑`Расходы` types).
13. **`getCategoryBucketMap()`** returns 22 entries; spot‑check Квартира=Needs, Рестораны=Wants, Отложения=Savings, Отложения (премия)=Savings, Налоги=Taxes, Кредитка='-', Авто=Wants, Транспорт=Needs. Assert **no** `⚠️` fallback warning fired.
14. **`getMandatoryExpenses()`** returns 11 items. Assert the S$0 `Родители` line is treated as **satisfied**, and `CPF` is in `NON_LEDGER_MANDATORY` (never expected to have a matching transaction).
15. Currency parsing: `"S$1 234,56"` → `1234.56`.
16. Missing‑tab safety: `getActiveMonthTab()` for a month with no tab (e.g. 9) returns a clean signal, does not throw.

### Stage 2 — coach engine
17. **`buildCoachPayload('daily')`** returns exactly: `period`, `cumulative_today`, `realistic_daily`, `flat_daily`, `days_left_in_month`, `days_to_positive`, `spend_today`, `buckets` (3, with actual+target), `target_header`, `categories_over_target`, `mandatory_warnings`. Assert **no** legacy keys (`budget_trend`, `spend_trend`, `recent_daily_trends`, `pace_verdict`, `taxes`).
18. **`categories_over_target`**: each entry has `discretionary_spend`, `committed_spend`, `actionable`. Assert sorted by `discretionary_spend` descending, capped at 5, and **no entry has `discretionary_spend === 0`**. Assert no purely‑committed category (e.g. `Школа & Детский сад` when its overspend is all `Обязательные расходы`) appears.
19. **Rounding:** assert no value anywhere in the payload has more than 2 decimal places. Log any offender.
20. **Model config:** `GEMINI_MODEL_ID === 'gemini-3.6-flash'`, `BACKUP_MODEL_1 === 'gemini-3.5-flash-lite'`, `BACKUP_MODEL_2 === 'gemini-3.7-flash'`. Make **one** call and assert `modelUsed` is reported (not the constant).
21. **Generate one brief** and assert: ≤4 sentences; **every number in it appears verbatim in the payload**; contains `<b>` and no `**markdown**`; contains no bare minus sign before a money value; ends with an instruction rather than a recital. Log the brief in full for me to read.
22. **Delivery:** confirm the send path resolves both users from `SHEET_FACTS.USERS` — but send **only to Val**, exactly once.

### Scheduler
23. `ScriptApp.getProjectTriggers()` returns **exactly one** trigger: `dispatch`, time‑based, every 15 minutes. Report any extras or duplicates.
24. `appsscript.json` has `"timeZone": "Asia/Singapore"`.
25. In `dispatch()`, assert the send‑window test is a **non‑overlapping 15 minutes** (`diff >= 0 && diff < 15`), and that `markSentToday` is called **before** the send (claim‑before‑work), with the key cleared on error.
26. Report which `sent_*` keys currently exist in Script Properties and their dates.

### Cross‑cutting
27. Script Properties present: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `WEBHOOK_SECRET`, `AUTHORIZED_CHAT_IDS` (log names + value **lengths** only, never values).
28. Assert `Transactions.getLastRow()` is **identical before and after** the whole run — proof nothing was written.
29. Grep for any remaining direct read of cell **D19** or **column K** outside `getDailyPacing`, `getRecentDailyTrends` (historical trajectory — legitimate), `config.gs` constants, and tests. Report them.

---

## Output I want

1. The static audit table, with any of the 9 regressions flagged.
2. `verify.gs` created and pushed (`clasp push`) — **not deployed**.
3. A short list: **what's missing or wrong**, ordered by severity.
4. An explicit answer: **is Stage 3 (the reconciler) safe to start, or must something be fixed first?**
