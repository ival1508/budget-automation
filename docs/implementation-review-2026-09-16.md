# PRD implementation assessment — 16 September 2026

The assessment and coverage table record the original snapshot. Dated follow-ups
under individual findings record subsequent corrections and validation.

**Closeout update — 16 September:** all five reproduced reliability findings have
source fixes. The [PRD](PRD_Budget2026_Automation_v2.4_stages.md) now records progress
and the matching, dual-sided credit and explicit additional-occurrence policies.
Sheets-visible commit preview is implemented; **136 offline tests pass, with 555
native assertion checks plus Node assertions; all `.gs` files parse**. The offline
suite now executes delivery and monthly behavior too. Item 1 is closed in source
and documentation; latest editor sync succeeded with 24 files, including preview.
**Item 2's real [sandbox acceptance](sandbox-acceptance-checklist.md) and the live
webhook's existing-deployment new-version update are complete — confirmed by Val
on 16 September 2026.** This records Val's explicit completion confirmation; no
new cloud execution, deployed-version lookup or independent run-artifact review
was performed while updating these notes. Actual daily/monthly coaching delivery
and live security-property inspection remain separate from this completion record.
The original assessment, gaps and recommended sequence below are historical
evidence; use the dated follow-ups and PRD progress for current status.

The project has a working transaction-ingestion foundation, a substantial daily coach, and all seven reconciler sub-stages in source. Phase 2 is still incomplete: the payment calendar, correct month-end workflow, automatic month creation, and receipt-item capture/analysis have not met their requirements. The reconciler has progressed significantly since the 9 September review, but needs a filtering correction and full sandbox acceptance of the latest workflow.

## Scope and evidence

- Reference: `docs/PRD_Budget2026_Automation_v2.4_stages.md`, including Stages 0–7.
- Implementation: current working tree at HEAD `9bf5717`, including 12 already-modified files. This assesses the files on disk, not just the last commit or the deployed script.
- Executed locally: `node scripts/test-regressions.cjs` — **78 tests passed; 431 assertions from native test functions checked; all `.gs` files parsed**. The additional regression cases also contain Node assertions; 431 is not the total number of all assertions.
- Executed five additional isolated probes against actual functions with mocked services: monthly period selection, rejected Telegram delivery, sandbox fallback, missing authorization configuration, and unrelated fee/reversal pairing. Each reproduced the behavior described below. No network requests or actual messages were sent.
- README records earlier Apps Script results, including a 393-assertion run and a controlled sandbox commit/balance/idempotency check. These are historical evidence, not a fresh verification of the current changes.
- No deployment, live spreadsheet inspection, Drive configuration, trigger installation, or ledger writes were performed during this assessment. Only this assessment document was added.

## Coverage against the PRD

| Stage / user outcome | Current implementation | Assessment |
|---|---|---|
| **0 — Discover the sheet** | Month maps, 11-column ledger layout, ranges, users, CPF exclusion, discovery helpers | **Recorded complete, with follow-up facts missing.** `mandatoryColumnGType` and a usable `monthTemplate` are not frozen in config. Resolve these before paid-flag handling and month cloning. |
| **1 — Read consistent budget data** | Monthly lookup, K/L/D17/D19 pacing, ordinary-expense-only daily spend, mandatory grouping, runtime taxonomy, sheet-based 50/30/20 and target header | **Substantially implemented.** Missing-month errors reach the daily coach; zero-planned and CPF lines are marked satisfied. Other readers still substitute zeros or static taxonomy after missing data. |
| **2 / UC-3 — Daily coach** | Structured payload, generation and grounded fallback, active-user morning times, shared 15-minute dispatcher and daily keys, Singapore timezone | **Implemented with remaining reliability/PRD gaps.** Failed delivery can be marked sent. Bullet formatting and two category callouts differ from the specified conversational, one-category brief. Live delivery/tone acceptance of the current version remains unverified. |
| **3 / UC-4 — Statement reconciliation** | CSV/PDF parsing, normalization, pure matching with explicit aliases, auditable filtering, editable staging, locked commit, menu/inbox/editor/optional Telegram entry points, history | **All sub-stages implemented; whole-stage acceptance pending.** Unrelated fee/reversal pairing can exclude genuine spend. Latest menu/inbox/PDF/formula behavior still needs the full sandbox checkpoint. |
| **4 / UC-6 — Never miss a mandatory payment** | Monday 09:00 AI audit, `/mandatory`, expected/logged readers | **Partial precursor.** No `Calendar` tab, historical date seeding, EOM schedule handling, deterministic payment classification, overdue/upcoming sets, configurable weekly schedule, or mandatory-payment menu entry. |
| **5 / UC-5 — Month-end results brief** | Separate monthly generator/fallback and first-day 09:00 dispatch | **Partial, with a wrong reporting period.** Reads the new current month instead of the completed month. Shared monthly payload, paid/missed counts, brief limits, grounding, and rollover sequencing are incomplete. |
| **6 / UC-7 — Create the next/current month automatically** | Forward names and a reader hook for `ensureMonthTab` | **Not implemented.** No creator, clone/reset logic, template map, salary-adjustment notice, or rollover action. A hook is not month creation. |
| **7 / UC-8 — Receipt intelligence** | Existing receipt/photo transaction extraction | **Not implemented at item level.** No line-item schema, `LineItems`, `Products`, parent linkage, receipt-total validation, `/items`, or Basket Review calculations. Receipt ingestion alone does not satisfy capture. |

### Reconciler detail

| Sub-stage | What is present | Remaining acceptance or limitation |
|---|---|---|
| **3A — Parse** | DBS section-aware CSV, Citi signed CSV, PDF/model path, encryption handling, period from row dates, native-document rejection | Real DBS + Citi fixtures and PDF extraction need exact row/value verification. Citi's known unnamed layout uses positions; unknown layouts use a model fallback. PDF requests JSON without reusing the Phase-1 response schema. |
| **3B — Normalize** | Shared merchant normalization, locale-aware amounts, dates/signs, card suffixes | Local regression coverage passes. |
| **3C — Match** | Exact/fuzzy/canonical matching, account and named-cardholder compatibility, occurrence allocation, ambiguity evidence, injected alias snapshot | Earlier disappearing-row and cross-account counterexamples pass now. Four-day/posting-date matching and score-based winner selection are implemented policy departures from the PRD. |
| **3D — Filter** | Exclusions with reasons, fee/reversal pairing, external-credit proposals | Fee pairing is too broad. Credit inclusion and the positive-expense guard differ from the original specification. |
| **3E — Review** | Dates that sort, type/category dropdowns, cardholder/source/status, append queue, prior-review snapshots for replacement calls | Normal inbox runs retain ticks and edits. Editor replacement calls preserve the old queue in a snapshot rather than merging it. Preview currently requires reading execution logs. |
| **3F — Commit** | Existing writer, shared lock, dry-run, reviewed types, Notes, 11 columns, F:G copying, E/K formulas, per-row imported/duplicate-review status | Same-key legitimate purchases remain a manual-review limitation. Historical controlled sandbox evidence predates the latest E/K formula changes. |
| **3G — Entry points** | Sheets menu, Drive inbox/processed folders, file journal, bounded scans, recovery/retries, optional Telegram queueing | Source workflow is implemented and locally tested. Real folder/permission/trigger/PDF/overlap/history acceptance remains open. HTTP submission and a CLI were optional alternatives, not missing mandatory scope. |

The review queue now supports dismissal with a reason, durable occurrence-based dismissal recognition, completed-row history, and refresh against manually entered ledger rows. These are useful extensions beyond the original staging specification.

## Confirmed issues to resolve

### 1. Test targets can silently become the active workbook — P1

**Follow-up — fixed in local source, 16 September.** Sandbox resolution now throws
for missing IDs, access failures, and wrong/unverifiable workbook identities;
explicit sandbox commit targets receive the same validation. The controlled commit
test resolves its workbook once and passes it to all three commit steps. Six added
offline regressions pass: **84 tests total, 431 native assertions checked**. These
checks perform no live operations. The original finding below records the behavior
before this correction; the remaining findings are unchanged.

`config.gs:314–329` catches sandbox access errors and falls back to `getActiveSpreadsheet()`. An empty sandbox ID does the same. The isolated probe confirmed `getTargetSpreadsheet(true)` returns the active workbook after mocked sandbox access failure.

This conflicts directly with the PRD's sandbox gate. `test_commitStaged()` obtains that target at `tests.gs:1270`, deletes matching leftover rows during preparation, and performs real commits at `tests.gs:1385` and `tests.gs:1452`. Its later safety log is not a pre-write identity check. A failed sandbox lookup can therefore run test mutations against an active live workbook.

Required outcome: requesting a sandbox must fail before any mutation if it cannot be opened or its identity is wrong. Resolve the target once and pass it through the test's commit calls. This must be fixed before recommending a fresh Apps Script `runAllTests()` run.

### 2. Fee/reversal pairing can hide a genuine expense — P1

**Follow-up — fixed in local source, 16 September.** Automatic cancellation now
requires a matching fee identity, opposite equal normalized amounts, matching
account/card/currency details, and a reversal within seven days after the charge.
Only unique pairs cancel; competing or unpaired reversals stay reviewable. The
tuition counterexample now produces two proposals and no exclusions. Known Citi
late-fee pairs still cancel. New native regression coverage passes locally:
**85 tests total, 555 native assertions checked**. The original finding below
records the behavior before the correction.

**Apps Script sync:** the requested `clasp push` completed successfully and reported
“Script is already up to date.” Its remote-content comparison confirms that the
editor project matches the current script files, including both fixes. No deployed
web-app version was changed; Apps Script test execution remains unverified.

`filterNonSpend()` (`reconciler.gs:2097–2125`) pairs any descriptor containing `FEE` with any descriptor containing `REVERSAL` or `WAIVER` when absolute amounts agree. It does not establish the same fee identity, opposite signs, account/card compatibility, or a date relationship.

Isolated reproduction on the same account/card:

- 5 August: `SCHOOL TUITION FEE`, S$100 expense.
- 25 August: `AUTO LATE FEE REVERSAL`, S$100 credit.
- Actual result: **zero proposals; both excluded as “Fee and reversal, net zero.”**

The tuition expense is unrelated to the bank fee reversal and disappears from review. This breaks both the PRD's no-genuine-expense-exclusion criterion and the code's own positive-expense preservation policy. Pair only corroborated reversals; uncertain cases must remain reviewable.

### 3. The monthly retrospective reports the new month — P1

**Follow-up — fixed in local source, 16 September.** A dedicated monthly payload
now passes an explicit reporting date through all relevant readers. Manual runs
on 1 October select September; the reproduced fixture returns September Needs
**S$3,500**, not October's S$50. Bucket actuals, targets and both percentages come
from the selected month's sheet summaries; daily pacing is absent, and missing or
unreadable data yields an unavailable report rather than zero results.

The existing heartbeat now sequences the statement reminder before the closing
month's coach at **23:30 SGT on the last day**, to both active users. Month/user/step
guards prevent repeated accepted deliveries, allow unfinished steps to retry at
23:45, and preserve the report month across midnight. Monthly sends require
Telegram's acceptance; the daily/weekly delivery issue in finding 4 remains open.
The shared coach engine adds monthly bucket/percentage/count validation and a
grounded fallback of at most four sentences.

Payment completion uses the existing paid flags or selected-month fixed-expense
totals covering the planned amount, excluding CPF and zero-value plans; partial
items remain unpaid. Due-date-based missed/overdue classification requires the
Stage 4 calendar and frozen column G semantics. Stage 6 tab creation remains
unimplemented. These remaining stage dependencies are not claimed complete.

Validation: **103 offline tests pass; 555 native assertions checked**, plus the Node
assertions in the monthly fixtures. Coverage includes leap/year rollover, complete
month boundaries, missing data, invalid model figures, rejected Telegram replies,
interrupted execution and concurrent dispatch. No live messages or sheet writes
were used.

**Apps Script sync:** the requested `clasp push` succeeded, uploading **24 files**
to the configured editor project. No versioned web-app deployment was changed;
live trigger execution and Telegram delivery remain unverified.

The original finding below records the behavior before the correction.

`nudge.gs:410` fires on day 1, then `sendMonthlyCoach()` (`nudge.gs:283`) uses `getBudgetCoachContext()`. That reader (`reader.gs:1029`) and `get503020Status()` (`reader.gs:567`) select the current month from the clock. Neither accepts a completed-month reporting window.

The isolated dispatcher probe at **1 October 09:01 SGT** used a mock sheet containing September Needs = S$3,500 and October Needs = S$50. The generated context selected **`Октябрь'26` and S$50**, confirming that it reports October rather than September.

The PRD asks for a last-day results brief sequenced with the reconciler reminder. The last-day branch still only logs a placeholder (`nudge.gs:428`). Passing `"monthly"` to `buildCoachPayload()` currently changes the period label while retaining the daily/current-month fields.

Required outcome: an explicit report period passed through every reader, correct full-month data and paid/missed results, and the specified rollover schedule. Monthly generation should receive the same grounding protections as daily generation.

### 4. A rejected Telegram send is recorded as delivered — P2

**Follow-up — fixed in local source, 16 September.** All `sendTelegramMessage()`
calls now require HTTP 200 and Telegram `ok:true`; HTTP/API rejection, invalid JSON
and network failures throw. Broadcasts use only active configured users, attempt
every recipient, and expose partial acceptance rather than silently returning.
The evening nudge now uses the same verified sender and retains its button.

The dispatcher records acceptance per job/user/period only after the successful
reply. Separate short locked execution claims prevent overlapping attempts and
expire after seven minutes following an interrupted execution. Model and network
work do not hold the shared lock. A failed user's retry never resends an accepted
message to the other user.

The catch-up policy is explicit: morning and Monday audits have a three-hour
window; the evening nudge retries until 22:00, the recap until 23:30, and month-end
reminder/coach steps until 02:30 the next day, preserving the closing month.
Daily catch-up never crosses midnight. Retry state respects Telegram's
`retry_after` and a 1/2/4/8/15-minute backoff, and waits for an eligible heartbeat.
Expired jobs remain unaccepted and are not delivered outside their window.

Validation: **121 offline tests pass; 555 native assertions checked**, plus Node
assertions. The original two-user 429 probe now leaves both sent keys unset and
the next heartbeat retries them successfully. Mixed acceptance, malformed/API/
network errors, rate limits, deadlines, active recipients, concurrent dispatch,
interrupted execution and midnight/month/year rollover also pass. No live
messages or sheet writes were used.

**Apps Script sync:** `clasp push` succeeded, uploading **24 files** to the configured
editor project. The existing dispatcher uses this source; no new trigger was
installed and no versioned webhook deployment was changed. Live delivery remains
unverified.

The original finding below records the behavior before the correction.

`sendTelegramMessage()` (`nudge.gs:44–57`) logs non-200 responses and returns normally. The dispatcher claims a sent key before delivery (`nudge.gs:355`) and clears it only for a thrown error.

The isolated probe returned HTTP 429 for both morning sends. Both sent keys remained set; invoking the dispatcher again in the same eligible window made no new attempts. Users can miss the brief while the scheduler records success.

Required outcome: propagate delivery failure and track acceptance per user. The narrow 15-minute eligibility window also needs a defined retry/catch-up policy; clearing a key alone will not guarantee a retry on the next heartbeat. Weekly/monthly broadcasts currently use Script Properties recipients rather than the active-user list used by morning dispatch.

### 5. Missing authorization settings disable their gates — P1, configuration-dependent

**Follow-up — fixed in local source, 16 September.** The webhook now requires
nonblank `WEBHOOK_SECRET`, a valid nonempty `AUTHORIZED_CHAT_IDS` list, and active
configured-user membership. Authorization uses the **intersection** of config
and allowlist: neither can bypass the other; inactive users and allowlist-only
outsiders are rejected. To keep both current users enabled, both Val and Rita
must be listed in `AUTHORIZED_CHAT_IDS` as well as active in config.

Authorization runs before duplicate caching, fallback chat capture, callbacks,
commands, downloads and proposal processing. Invalid/unsupported event identities
and configuration read failures also reject without processing. Error handling
uses only the already-verified chat ID, eliminating the previous reparsing of an
unverified request body. Registration requires the same configured policy and
always embeds the encoded secret.

Validation: **134 offline tests pass; 555 native assertions checked**, plus Node
assertions. Missing settings, invalid secrets/lists, independent membership
checks, inactive users, all inbound types, cache poisoning, malformed identities,
error notifications and registration safeguards pass. Authorized Val/Rita
commands and callbacks still work; existing screenshot/album coverage passes
with explicitly configured test credentials. No live messages, registration,
Script Property changes or sheet writes were performed.

The five confirmed findings now have source corrections. Remaining stage/data
contract requirements and live acceptance checks are separate work.

**Apps Script sync:** `clasp push` succeeded, uploading **24 files** to the configured
editor project. Live settings and the versioned deployment were not changed. The
public webhook needs an **existing-deployment new version** before these
protections apply there; ensure both enabled users appear in the allowlist.

The original finding below records the behavior before the correction.

`doPost()` checks the webhook secret only if the property exists (`webhook.gs:32`). Its outsider-chat rejection also runs only if `AUTHORIZED_CHAT_IDS` is populated (`webhook.gs:86`). Configured users are not an independently enforced gate when that property is empty.

The isolated probe removed both properties and submitted an unknown chat. It reached callback handling despite `SHEET_FACTS.USERS` being present. This does not establish that the deployed properties are missing; it establishes how source behaves if required setup is absent.

Required outcome: missing required security configuration should reject processing, and a known allowed-user policy should apply consistently. Check authorization before remembering an incoming chat as the fallback recipient.

## What has improved since 9 September

The earlier review is explicitly an audit snapshot. Its original failure list should not be treated as current:

- GET now serves health only; financial diagnostics and test dispatch are removed.
- All four Telegram save paths explicitly request real writes, independent of reconciliation dry-run.
- The reproduced competing-row, conflicting-cardholder, and cross-account matching regressions pass.
- Matching accepts an alias snapshot and performs no Script Properties reads itself.
- Reader and statement amount parsers have distinct names and passing locale tests.
- Failed directly invoked assertions throw; the old misleading HTTP test route is absent.
- Daily coaching no longer quotes a per-day shortfall as a total monthly overspend. Generated monetary amounts absent from supported payload fields trigger fallback.
- Missing-month errors propagate to the daily coach. CPF and zero-planned lines are marked satisfied by the mandatory reader.
- Staging uses the shared lock, preserves replacement reviews, and appends inbox reviews. Its inference path no longer calls durable merchant-persistence/alias-cleanup routines.
- Commit reports per-row imported versus duplicate-review outcomes. Queue/history refresh and interrupted-archive recovery have regression coverage.
- Screenshot and album processing now has regressions for concurrent extraction, preserving review edits, overlapping images, multiplicity, and completed-proposal handling.

## Remaining specification and data-contract gaps

- **Unavailable data:** `get503020Status()` returns apparently valid zero totals when its sheet/month header cannot be read (`reader.gs:497–507, 594–596, 739–741`). The daily payload checks pacing errors, but not these failures. `getCategoryBucketMap()` still falls back to static constants on reference failures (`reader.gs:1189`). These weaken “read the sheet's own numbers; never guess.” Return explicit unavailable-data results and prevent ungrounded coaching/import preparation.
- **Mandatory checks:** marking CPF/zero lines satisfied is implemented in the reader, but the current AI audit still asks the model to perform semantic matching. It does not deterministically exclude those items or calculate overdue/upcoming dates. Stage 4 is more than changing that prompt.
- **Occurrence identity:** writer dedupe omits cardholder/multiplicity. Staged same-key purchases can remain `duplicate_review` even after ticking; `commitStaged()` always supplies empty flags, so the writer's force-add capability is not exposed through that review workflow. Rita/Val imports also leave Notes empty, so their card identity is not retained there. Define an explicit, auditable way to approve an additional occurrence while preserving ordinary idempotency.
- **Coach experience:** current daily coaching uses bullet labels, up to two categories, all-bucket over-target filtering and a S$100 materiality floor. The PRD specifies conversational prose and at most one category. Preserve intentional choices by recording them in the specification. `target_header` is carried into payloads, but stale-header visibility is not guaranteed in the delivered brief.
- **Models:** source uses Flash Lite by default for transaction ingestion, a separate coach model, and an explicit 3.7 preference for statement parsing (`gemini.gs:8–11`, `reconciler.gs:664`). This differs from the PRD's universal default. This assessment does not verify external model availability, release dates, or pricing claims.

The PRD also needs an editorial consistency pass: its final build-order list puts Stage 4 before Stage 3 despite the v2.4 change; it calls 3A–3G six sub-stages although there are seven; Stage 5 still says four buckets despite the corrected three-bucket model; Stage 7 still mentions a ten-column Transactions schema despite the verified eleven columns. Use the verified-data-model section as the reference when resolving these conflicts.

## Recommended next sequence

1. **Close the concrete reliability gaps.** Fail closed on sandbox identity, fix unrelated fee pairing and the monthly reporting window, propagate delivery failures, and enforce authorization configuration. Add focused regressions for these reproduced failures. Define matching/credit/additional-occurrence policy in the PRD instead of silently reverting implemented behavior.
2. **Accept the latest reconciler in a sandbox.** Follow `docs/stage-3g-entry-points.md`: real DBS/Citi CSV and PDF, overlapping windows/card sections, retained edits, failures/retries, file journal/moves, exact reviewed imports, recalculated E/K and F:G, second-run no-op, dismissal/history/manual-entry refresh, and actual scheduled pickup. Compare row identities and values, not just summary counts. Finish the Sheets-visible preview so review does not require execution logs.
3. **Build Stage 4.** Freeze G semantics; seed an editable calendar from history; use deterministic canonical matching; support EOM; compute overdue/due-this-week sets; wire schedule, menu, and daily warnings; review the seeded draft with Val as specified.
4. **Complete Stage 5 and rollover sequencing.** Correct the reporting period, reuse a period-aware coach payload, include payment results, ground the narration, and wire the statement reminder/monthly brief in the requested last-day sequence.
5. **Start Stage 7A capture soon.** Item history is currently not accumulating. Shipping capture before the analysis avoids another 4–8-week wait once Basket Review is built; this early split is already recommended in the PRD.
6. **Discover and implement Stage 6 on a copy.** Freeze the actual template ranges/formulas, then clone/reset safely and test both proactive and on-demand creation, including year rollover. Current maps are fixed to 2026.
7. **Build Stage 7B after enough history exists.** Deterministic unit prices, gaps, behavior drivers, and controlled inflation measurements before model narration.

The success metrics remain unproven: local tests do not measure reconciliation time per account, exhaustive missing-transaction catch, payment lateness, or brief readership. The offline runner also does not load `nudge.gs` for behavioral execution; its scheduler tests cover inbox-trigger setup rather than the real dispatch/delivery/monthly-period behavior. Passing 78 tests is useful regression evidence, but does not mean all PRD stages or live acceptance criteria are complete.
