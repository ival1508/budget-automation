# Stage 7A — receipt item capture

Implemented 28 October 2026. Val chose capture first; Stage 7B's Basket Review
remains deferred until useful receipt history has accumulated (roughly 4–8 weeks).

## Delivery plan and result

1. Extend the current ingestion path with a separate visual receipt schema.
2. Keep item detail with the pending transaction through edits and overlapping
   photos, without asking the user to approve individual products.
3. On approval, append item history and maintain a product catalog using the
   existing shared write lock. Keep the eleven-column ledger unchanged.
4. Reconcile totals in code, normalize quantities and unit prices, and prevent
   unreliable receipts from establishing price baselines.
5. Verify extraction boundaries, document routing, approval, replay, failure and
   storage behavior; deploy to the existing web-app URL.

Steps 1–5 are complete. The regression suite passes **292 tests**, including
22 new receipt checks, with 556 existing assertions; all `.gs` files parse.
The seven separate Telegram edit regressions also pass. Service calls are mocked:
these results do not establish actual OCR accuracy or Telegram delivery.

**Release:** version **94** is deployed to the existing web-app deployment.
All **34 application files** match the local source, Apps Script editor and
immutable version 94. The existing URL and two-entry deployment inventory are
unchanged. No trigger changes were required.

## Everyday use

Send an itemized receipt as a Telegram photo, image document or PDF. Review and
approve the transaction as before. The confirmation then reports how many receipt
items were saved and whether a receipt total needs review. Item detail is
analysis-only and does not change balances, categories or spending allowances.

`LineItems` and `Products` are created on the first approved receipt capture.
`/items` and **Budget → Receipt capture status** show capture counts and receipts
that need reconciliation/completeness review. They are read-only and do not
generate recommendations. No new trigger or scheduled report is added.

Typed text, voice, bank screenshots and bank statements produce no product
history. A separate visual pass runs for transactions classified as receipts.
PDFs are classified before routing: actual receipts go to transaction approval;
bank documents and CSVs retain the statement-inbox path. An unreadable or unrelated
PDF does not silently enter the bank importer; resend a clearer copy. This adds
one model request before a PDF bank statement is queued.

## Extraction and parent linkage

`receiptItems.gs` supplies the second model schema, validation and item storage.
The transaction extractor still emits one financial transaction per receipt.
Candidate merchant names and the latest 400 product catalog entries help the
visual pass reuse canonical keys. Exact catalog keys, canonical names and recorded
raw aliases also resolve deterministically after extraction.

Raw item text is retained. Brands remain absent when not printed; unsupported
brand tiers are `unknown`. Product identity excludes brand and pack size.
Pack counts and sizes normalize g→kg and ml→L; unknown sizes remain unknown.
Unit prices are calculated in code rather than copied from the model.

A receipt must match exactly one candidate purchase by normalized merchant,
date when printed, original currency and total (within two cents). Several
plausible parents, or several receipts for one parent, produce a capture warning
rather than a positional guess. The approved date/account/merchant/amount determine
the final parent key. For converted purchases, this is the key reconstructable
from the ledger's actual SGD amount; item prices retain their original currency.

Existing transaction edits preserve the attached receipt. Changing its amount
re-runs reconciliation on approval. Pending detail uses bounded cache chunks to
stay within CacheService's per-value limit. Missing chunks expire the proposal
safely; item history is never written before approval or after discard.

## Storage contract

`Transactions` retains columns A–K. No item columns, extra financial entries or
balance adjustments are introduced.

`LineItems` begins with the PRD's seventeen columns:

```
dedupe_key · date · merchant · account · raw_text · item_name · product_key
brand · brand_tier · qty · unit · size · unit_price · line_total · discount
item_category · is_discretionary
```

Additional metadata columns make reconciliation, currency and replay explicit:

```
receipt_id · line_index · line_count · currency · receipt_total
receipt_discount · receipt_charges · reconciled · reconciliation_delta
confidence · captured_at · price_analysis_eligible
```

`Products` contains the nine PRD columns plus `raw_aliases` (a JSON list), used
with the catalog's canonical name and key. `known_brands` is also a JSON list.
The baseline is the first reliable, reconciled SGD observation with a known
comparable unit. Foreign prices cannot silently become SGD baselines.

Item rows are append-only. Replays add no duplicate rows; an interrupted append
can fill missing line indices, and a replay repairs an interrupted catalog update.
Catalog repair uses the stored item observations. A different receipt already
linked to the same parent is preserved and flagged instead of overwritten.
Same-key forced ledger duplicates cannot be uniquely linked and are flagged.
Existing tabs with unexpected headers are preserved. OCR/model strings are
escaped before writing so they cannot become spreadsheet formulas.

## Reconciliation and price eligibility

Amounts are checked in integer cents:

```
item net = sum(gross line_total − line discount)
computed receipt = item net − printed basket discount + printed extra tax/fees
delta = computed receipt − approved transaction amount
```

The prompt distinguishes gross/net line prices and included/excluded tax to avoid
subtracting discounts or adding tax twice. No synthetic balancing item is created.
Both the computed total and printed receipt total must match the approved
original-currency amount within max(two cents, 2%). A mismatch keeps the items
with `reconciled=false`, flags the saved receipt and excludes it from price use.

Comparable unit prices allocate basket discounts/extra charges proportionally
across net lines. `price_analysis_eligible` also requires confidence ≥0.8 and a
known positive quantity/size/unit. A later Stage 7B reader must check receipt
completeness, currency, parent identity and observation comparability as well;
the per-row flag alone is not a complete analytics policy.

## Failure recovery and acceptance

Receipt extraction/storage problems do not undo a successfully saved financial
transaction. They produce a visible capture warning. To retry, resend the receipt
and skip its duplicate transaction: capture can attach to the uniquely existing
parent without another ledger row. An unresolved/ambiguous parent is flagged.

Offline coverage includes normalization, printed/unknown brands, discounts,
tax/fees, tolerance, parent ambiguity, missing inputs, model failures/truncation,
bank/text exclusion, transaction edits, foreign currency, approval/discard,
duplicate skip, idempotency, partial recovery, header drift, formula escaping,
cache limits, grid expansion, and PDF/CSV/image routing.

**Remaining operational acceptance:** send 5–10 real receipts across merchants
and compare extracted items, brands, units and totals with the originals. No
real receipts were supplied during this build, and no test Telegram messages or
synthetic transactions were written to the live workbook. Monthly Basket Review,
price-gap/splurge findings and inflation measures are Stage 7B, not this release.

For rollback, restore version 93's editor source and update the existing web-app
deployment to version 93. Preserve captured `LineItems` and `Products` history;
rolling back code does not require deleting user data. Version 93 includes the
corrected Summary!E4 funding policy.
