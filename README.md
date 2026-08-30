# Budget 2026 Automation

Telegram bot + Google Apps Script that logs transactions to the
"Budget 2026" sheet and sends a daily budget coach brief.

## ⚠️ Deployment gotchas (read before touching deployments)

**`clasp push` is NOT a deploy.** Push updates the editor code; the /exec URL
serves a specific deployed *version*. After pushing:
  Deploy → Manage deployments → ✏️ pencil → Version: New version → Deploy
NEVER click "New deployment" — it mints a new URL and 404s the webhook.

**Current /exec URL** (Version 63, 30 Aug 2026):
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

## Scheduling
ONE trigger: `dispatch()` every 15 minutes (created by `setupTriggers()`,
which deletes all existing triggers first). It fires six jobs by clock time,
each guarded by a `sent_<key>=<date>` Script Property. Do not add .atHour()
triggers — .atHour only guarantees the hour, not the minute.

## Verification
Run `verifyStages012()` in the Apps Script editor — 39 read-only checks
across Stages 0–2. Antigravity cannot run Apps Script; it must never be
trusted to report test output it did not execute.

## Docs
See /docs for the PRD and the staged build prompts.
