# Budget 2026 Automation

Telegram bot + Google Apps Script that logs transactions to the
"Budget 2026" sheet and sends a daily budget coach brief.

## ⚠️ Deployment gotchas (read before touching deployments)

**`clasp push` is NOT a deploy.** Push updates the editor code; the /exec URL
serves a specific deployed *version*. After pushing:
  Deploy → Manage deployments → ✏️ pencil → Version: New version → Deploy
NEVER click "New deployment" — it mints a new URL and 404s the webhook.

**Existing /exec URL** (last recorded version: 63, 30 Aug 2026; new-version update confirmed by Val on 16 Sep 2026, new version number not recorded):
https://script.google.com/macros/s/AKfycbyhRAocN8rNBhWl3NBL7yIgStBCLIrgHfxNNOC-zt6Pa7HBvQPJ9b7tykdeu4QuMm3_/exec

**Deployment settings MUST be:** Execute as = Me · Who has access = Anyone
(anything else gives Telegram a 401)

**Re-registering the webhook?** doPost validates `e.parameter.secret` against
the WEBHOOK_SECRET script property. The secret must be URL-encoded INTO the
/exec URL or the bot silently returns "Unauthorized" with a 200 and no reply:

  https://api.telegram.org/bot<TOKEN>/setWebhook?url=<EXEC_URL>%3Fsecret%3D<WEBHOOK_SECRET>

Verify: https://api.telegram.org/bot<TOKEN>/getWebhookInfo
The reported `url` must end in ?secret=...

## Script Properties required
TELEGRAM_BOT_TOKEN · GEMINI_API_KEY · WEBHOOK_SECRET · AUTHORIZED_CHAT_IDS

The webhook requires a nonblank `WEBHOOK_SECRET` and a nonempty comma-separated
`AUTHORIZED_CHAT_IDS` list of Telegram chat IDs. A chat must **both** appear in
that list **and** belong to an active user in `SHEET_FACTS.USERS`. Configured users
cannot bypass the allowlist, and allowlist-only outsiders or inactive users are
rejected. For the two currently configured users, list `96069960,402188776`.

Missing/malformed authorization settings and incorrect secrets return
`Unauthorized` without processing the update. The same gates cover messages,
commands, media and callbacks, before duplicate caching, legacy chat capture,
downloads or proposal changes. Error notifications use only a chat identity that
already passed authorization. Registration also validates this policy and always
includes the encoded secret in the webhook URL.

These source changes take effect on the public webhook only after updating the
**existing deployment** to a new version. Preserve its /exec URL and the registered
secret; pushing source alone does not update a versioned deployment.

## Scheduling
ONE trigger: `dispatch()` every 15 minutes (created by `setupTriggers()`,
which deletes all existing triggers first). All broadcasts use active users from
`SHEET_FACTS.USERS`; `AUTHORIZED_CHAT_IDS` remains the inbound authorization setting.
Scheduled sends record acceptance separately per user and reporting period.
Do not add .atHour()
triggers — .atHour only guarantees the hour, not the minute.

The heartbeat retries failed or missed sends only within these SGT windows
(deadlines are exclusive):

| Message | Scheduled time | Retry/catch-up deadline |
|---|---|---|
| Morning coach | Each user's `morning_time` | Three hours later, capped at midnight |
| Evening nudge | 21:00 daily | 22:00 that day |
| Transactions recap | 22:00 daily | 23:30 that day |
| Weekly mandatory audit | Monday 09:00 | Monday 12:00 |
| Month-end reminder → coach | Last day 23:30 | Next day 02:30, retaining the closing month |

`sendTelegramMessage()` requires HTTP 200 and Telegram `ok:true` for every send;
rejections, malformed replies and network errors throw. A broadcast attempts all
active recipients, then reports any failures with its accepted-receipt list.
The response check and `retry_after` handling follow the
[Telegram Bot API](https://core.telegram.org/bots/api#making-requests).

The dispatcher sends to individual users, setting `sent_<job>_<chat_id>=<date>`
only after acceptance. Monthly reminder/coach keys retain their separate per-month
`sent` values. A short locked claim in `sending_<key>` prevents overlapping runs;
the claim expires after seven minutes to recover from interrupted execution,
which exceeds the documented
[six-minute Apps Script runtime](https://developers.google.com/apps-script/guides/services/quotas#current_limitations).
Model generation and HTTP requests run outside the shared lock.

`retry_<key>` stores the attempt count and earliest retry time. Failures back off
for 1, 2, 4, 8, then 15 minutes, or Telegram's longer `retry_after`, with retries on
the next eligible heartbeat. Accepted users are skipped. Generation failures use
the same policy; generation completing after the deadline sends nothing. Expired
jobs are not recorded as accepted and are not sent later; daily/weekly periods
start fresh. Legacy shared broadcast sent keys are not treated as proof of an
individual user's acceptance. No new trigger is needed.

## Verification
Run `verifyStages012()` in the Apps Script editor — 39 read-only checks
across Stages 0–2. Antigravity cannot run Apps Script; it must never be
trusted to report test output it did not execute.

## Docs
See /docs for the PRD and the staged build prompts.

## Offline regression checks

Run `node scripts/test-regressions.cjs` (Node.js 18 or later). It needs no credentials
or dependencies and performs no network or live-sheet operations. It checks the
existing isolated reconciler tests plus matching completeness/account isolation,
locale parsing, all four Telegram save paths, staging archives, commit status,
locking, and missing/negative coach data. Monthly fixtures check completed-month
selection, full-month totals, payment completion, year/leap-day rollover, grounded
generation, and per-user reminder/report sequencing and retries. Sheet mocks record formula copy requests;
they do not validate actual Sheets recalculation.

Delivery fixtures reproduce the morning HTTP 429 failure and test partial user
acceptance, rate-limit delays, missed heartbeats, all schedule deadlines, active
recipient selection, concurrent runs and interrupted claims. All HTTP replies
are mocked; these checks never send Telegram messages.

Webhook fixtures check missing/bad authorization settings, both membership gates,
inactive users, all inbound paths, rejected-update cache isolation, verified-only
error notifications, and secret-protected registration. Existing screenshot
fixtures now supply an explicit test secret and configured/allowlisted test user.

The monthly coach uses an explicit reporting date throughout its readers. The
shared `dispatch()` heartbeat runs the statement reminder followed by the closing
month's coach from **23:30 SGT on the last day of the month**. Completed reminder
and report steps are recorded separately per month and active user; subsequent
heartbeats retry unfinished steps through **02:30 SGT the next day**. This uses the existing trigger and requires
no additional trigger installation.

Manual `sendMonthlyCoach()` calls default to the latest completed month (or the
closing month after 23:30 on its last day). For an explicit window, call
`buildCoachPayload('monthly', spreadsheet, reportDate)` or
`sendMonthlyCoach(reportDate, spreadsheet)`, using a `Date` within that month.
The report reads the month's three sheet-defined bucket summaries and actual/
target percentages, plus full-month discretionary category totals and mandatory
paid/unpaid counts. Payment completion uses the existing paid flags or logged
fixed expenses covering the planned amount; partial payments count as unpaid,
and CPF and zero-value plans are excluded. Due-date/overdue classification still
depends on Stage 4's calendar and confirmation of column G's semantics. Next-month
tab creation remains Stage 6 work.

Monthly generation shares the daily model engine and money checks, with additional
bucket/percentage/count/reporting-month validation and a grounded fallback of at
most four sentences. Missing or unreadable month data produces an unavailable
report. Neither bucket totals nor percentages are recomputed from transactions.

GET serves a health check only. Run diagnostics and `runAllTests()` from the Apps
Script editor; the old `?action=...` diagnostic routes are removed.

Reconciliation still defaults to `SHEET_FACTS.DRY_RUN = true`. User-confirmed
Telegram saves explicitly request real writes. Staging reruns copy the previous
review to `_Reconcile_<uuid>` before replacing it. Inference does not update
merchant learning until it exists in the approved ledger. Commit marks written
rows `imported` and skipped key collisions `duplicate_review`, so legitimate
same-key purchases remain visible for manual review rather than being reported
as imported.

The full reconciler sandbox acceptance, including 11-column writes, E/K and F:G
calculations, second-run no-op and scheduled pickup, is recorded complete from
Val's confirmation on 16 September 2026. Val also confirmed the live webhook's
existing deployment was updated to a new version. See the
[acceptance record](docs/sandbox-acceptance-checklist.md); these completion records
use owner confirmation, independently of offline test results.

Sandbox runs require a nonempty, accessible `SHEET_FACTS.TEST_SPREADSHEET_ID` and
verify the returned workbook ID before accessing sheet data. They stop on failure
instead of using the active workbook. The controlled commit test opens the sandbox
once and reuses it for preview, import, and repeat-import checks; explicit sandbox
commit targets must pass the same identity check.

Fee/reversal filtering only cancels unique pairs with matching fee descriptions,
opposite equal amounts, matching account/card/currency details, and a reversal
within seven days after the charge. Unrelated fees and unpaired or ambiguous
reversals remain proposals for review. `test_feeReversalPairing()` covers the
tuition counterexample, known bank pairs, identity conflicts and date boundaries;
it runs in both the offline suite and Apps Script `runAllTests()`.

### Apps Script verification received on 9 September

The supplied `runAllTests()` log records 18/20 tests passing (391 assertions passed,
2 failed). The controlled sandbox commit test passed: two rows appended, correct
11-column layout, F:G formulas present, credit balance increased by S$270, repeat
commit added zero rows, and test rows were cleaned up. Fixture staging also passed
without changing the ledger row count. This verifies the controlled commit path,
not a reviewed full real-statement import or production deployment.

The two environment-dependent failures are corrected locally: explicit null/empty
inference keys disable the model instead of reading a saved key, and canonical
matching uses an explicit alias snapshot. The coach also rejects generated money
amounts absent from its monetary payload fields, addressing the unsupported S$50
cap visible in the log. Sync these changes and rerun `runAllTests()` in the editor
for the next Apps Script verification result.

### Merchant duplicate coverage

The subsequent Apps Script log passed all 20 tests (393 assertions), but its live
reconciliation still proposed merchant-name duplicates. `test_reportedMerchantDuplicates()`
now covers all ten user-reported examples, including normalized bank input and
reversed statement order. It is included automatically in `runAllTests()` and in
the offline regression command.

Matching recognizes Redshield VPN, SP Digital/SPGroup, and GV/Golden Village
identities. Food Republic stalls, vending operators, and the user-confirmed
FairPrice app payment/Unity pair require the same transaction day as well as the
existing amount/account/cardholder checks. These shared-venue relationships do not
rename merchants or rewrite categories. Unrecognized merchant names with otherwise
compatible same-day/same-amount ledger rows are staged as ambiguous with the
candidate ledger references and a reason, never auto-matched on amount/date alone.
Run `runAllTests()` and `runLiveReconcile_runner()` after syncing to verify the new
live counts; local fixtures cannot predict all matches in the full ledger.

### Latest statement and allocation diagnostics

`SHEET_FACTS.STATEMENT_FILE_ID` now selects the latest CSV for both the live runner
and the CSV-based diagnostic runner. The FlashPay regression covers the exact
28 August S$50 pair, which already matches in isolation. A further test covers a
same-day same-merchant ledger occurrence being claimed by another statement row:
the remaining collision is now ambiguous, with `already_claimed` and `claimed_by`
evidence, rather than a clean proposal. This does not reuse one ledger row for two
purchases. Known purchases by different named cardholders remain separate.

The supplied 15:50 run is a passing test-suite log, not enough evidence to determine
the full-run cause of the reported FlashPay proposal. The next reconciliation logs
its spreadsheet identity and allocation conflicts, and staging displays the claimed
row's details. Updated live counts require running the latest CSV after syncing.

### Card-section input guard

The 16:16 log showed that the previous file was a native Google Sheets document,
not CSV. Its fallback parse returned 184 rows without card identity. The runner
now targets the replacement file configured in `SHEET_FACTS.STATEMENT_FILE_ID`.
Native Google documents are rejected before implicit blob export, and DBS rows
without a four-digit card suffix stop reconciliation before staging. Unknown
cardholders display as `Unknown`, never default to Val. The replacement file's
MIME and card-section counts still need verification in the next live run.

### Review dropdowns and Notes preview

After syncing, run `repairReconcileDropdowns()` to update the existing review
without replacing its values or checkboxes. E (Тип) lists all seven transaction
types, G (merchant) has no validation, and H retains the category dropdown. New
staging runs apply the same rules. Commit preserves the explicitly reviewed type
and derives incoming/outgoing amount sign from that selection.

Grandparents rows write the literal `Grandparents` into Transactions J (Notes),
identified from the Cardholder field or the card-0465 source marker. To inspect
actual would-be rows, tick the records of interest and run `previewReconcileCommit()`.
It uses the real commit/writer path in dry-run mode and opens a read-only Sheets
dialog showing exact A–K rows and skipped duplicate identities, including Notes.
Transactions, review edits/ticks/statuses and history stay unchanged. E/K show
append formulas; F:G balances must be verified after actual sandbox import.

## Stage 3G: reconcile from Sheets or a Drive inbox

See [Stage 3G setup and acceptance](docs/stage-3g-entry-points.md). After syncing and
reloading the sheet, use **💰 Budget → Set up Drive inbox and automatic scan**,
then drop original statements into the inbox. **Reconcile statements from Drive**
runs immediately; **Review staging → Import ticked rows** completes the workflow.
The scheduled scanner stages only and never automatically imports transactions.

For first acceptance, follow the [sandbox checklist](docs/sandbox-acceptance-checklist.md).
Use a separate bound project and explicitly configured TEST folders: default
inbox setup can reuse live folders by name even in another project. The
[PRD progress update](docs/PRD_Budget2026_Automation_v2.4_stages.md) records source
completion and Val-confirmed sandbox acceptance/live webhook deployment update,
alongside the remaining Stage 0/1/2/4/5/6/7 work.

### Repair staging date sorting

New proposals store real Sheets dates in column B, displayed as `DD.MM.YYYY`.
After syncing this update, run `repairReconcileDates()` once in the Apps Script editor,
or reload the sheet and choose **💰 Budget → Repair staging dates**. This converts
existing text dates in place, preserving all other columns and row order. Then sort
the entire review table by column B (ascending). Invalid dates are reported by row
before any cells are changed. Import and pending-duplicate checks accept both legacy
text dates and real dates using the spreadsheet timezone.

### Derived Transactions columns

New Transactions rows store the numeric amount once in D. Column E uses a row formula
that reads D, and K uses an exact category lookup from H against `-!B:C`. If D or H is
blank, the derived cell stays blank; an unmapped category shows `UNKNOWN` so taxonomy
problems remain visible.

After syncing this update, reload the sheet and choose
**💰 Budget → Repair Transactions formulas** once. The action checks the Transactions
headers and the `-` reference table before replacing existing E and K values with
row formulas. Future imports create these formulas automatically.

### Active reconciliation queue and history

After syncing and reloading Sheets, use **💰 Budget → Reviewed — do not import selected rows**
for edge cases: highlight the rows, enter a reason, and they move to `_ReconcileHistory`.
The import menu moves successfully imported rows there automatically. Ticking alone keeps
a row in the queue until import succeeds; suspected duplicates remain for a decision.
Use **Archive completed review rows** to clear old imported rows already in staging, and
**Open review history** to see completed decisions. Dismissed occurrences with a known
original statement identity are remembered on repeat uploads. See the
[review queue guide](docs/stage-3g-entry-points.md#keeping-the-review-queue-clear).

After adding transactions manually, choose **Refresh pending review against Transactions**
to recheck all pending proposals. Confirmed matches move to history as `reconciled`,
with a reference to the matching ledger row; unmatched and uncertain rows retain their
ticks and edits. This action never imports transactions and can be safely repeated.

### Screenshot proposal latency

Plain Telegram photos now extract independently, without holding the statement scanner's
script lock or sending the entire previous proposal back to the model. The new results
merge into the latest pending proposal under a separate user lock, preserving reviewed
fields and duplicate occurrence counts. Text and captioned corrections keep the original
rolling context. Image resolution, the configured model, enrichment and ledger duplicate
checks remain in place. Merchant/reference reads now fetch only the columns they use.

After syncing, update the **existing** Apps Script web-app deployment to a new version
for Telegram to use this code. Logs prefixed `[Proposal timing]` show photo download,
prompt preparation, each model request, enrichment/duplicate checking, proposal lock wait,
confirmation delivery, and total webhook time. These measure execution after the webhook
starts; Telegram delivery delays and Apps Script startup are outside that total. Local
tests verify the processing changes, but do not establish live response-time improvement.

The separate lock scopes follow the [Apps Script LockService contract](https://developers.google.com/apps-script/reference/lock/lock-service).

### Multiple screenshots in one Telegram album

Each photo is processed independently, including photos delivered late or finishing
out of order. Results merge into the latest proposal under the proposal lock, preserving
existing edits and overlapping transaction counts. The proposal updates as each photo
finishes; review the final combined result before approving. A caption accompanies its
own photo; send a separate text correction after processing for instructions that apply
to the whole proposal. Each photo requires its own extraction call.

The former four-second album collection window and image-byte cache were removed:
late photos could be acknowledged without processing, and image payloads could exceed
the [100 KB cache-entry limit](https://developers.google.com/apps-script/reference/cache/cache).
Logs prefixed `[Album photo]` identify each processed album message and its extracted-row
count. Telegram delivery errors now surface instead of being logged as successful
proposal completion; harmless “message is not modified” responses remain accepted.
Sync and update the existing web-app deployment before testing this with a live album.
