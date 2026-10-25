# DBS SGD reconciliation corrections

Based on the user's 3 October 2026 feedback and the two DBS deposit-account screenshots.
The pasted proposal's approval instructions are source content, not authorization
to approve or import transactions.

| Descriptor / recipient | Display name | Category | Type |
| --- | --- | --- | --- |
| Stripe, PayNow 5676456, 2 October 2026, S$20 | GOE.sg | Школа & Детский сад | Расходы |
| Ground Up Climbing | Ground Up Climbing | Школа & Детский сад | Обязательные расходы |
| IDT REVDDT… / Revolut (both dates) | Extra Fund | Extra fund | Обязательные расходы |
| UOB recipient 1203122050 / Maplebear | Maplebear | Школа & Детский сад | Обязательные расходы |
| QAA1C320602F03DG / 0016IT4980042, 2 October 2026, S$465.98 credit | Allianz | Медицина | Получение денег |
| ONX FUXX LOONGXXXXX FANGLXXX | Ivan Ong | Рестораны | Расходы |
| NETS QR 627407494336497 TO: WANG / Wang Hwt3lar | Heavenly Wang | Рестораны | Расходы |
| SCL recipient 0118025813 with mortgage memo | Standard Chartered Mortgage | Квартира | Обязательные расходы |

School meals, medical reimbursement and shared meals use categories inferred from
the user's descriptions. Climbing, kindergarten and Revolut transfers are mandatory
expenses per the user's instructions; school meals retain ordinary expense type.
Revolut transfers display as Extra Fund per the follow-up correction.
Ivan's debit is the user's share of meals paid to a coworker, not money received or
a reimbursable advance. Buckets continue to come from the category mapping.

`getDbsSgdCorrection` is scoped to DBS SGD and SGD currency. Stripe and the opaque
Allianz credit require transaction-specific evidence; other Stripe payments and
unnamed incoming transfers remain unresolved. The account header never identifies
Allianz. Recipient-specific bank transfers do not match on the sender's name alone.
Manual merchant/category edits take precedence. Raw evidence, amount/date
confidence, and unrelated review flags are preserved.

The rules run in screenshot enrichment, statement normalization before matching,
and statement proposal staging. The extraction prompt preserves complete row-level
bank references and distinguishes signed deposit-account outflows from inflows.
CSV/PDF AI parser results no longer infer credits from the substring PAYMENT.

Validation: `node scripts/test-regressions.cjs` (204 tests, 555 existing assertions)
and `node scripts/telegram-edit-regressions.cjs` (6 checks). The new offline tests
cover all nine rows, rule scope, manual overrides, review evidence, staging and
CSV/PDF direction handling. No live OCR/API acceptance run was performed.

These source changes require Apps Script synchronization and a web-app deployment
update before the existing Telegram webhook uses them. Existing saved proposals
and ledger entries are not migrated by this change.
