/**
 * Budget 2026 Automation v1 - Telegram Webhook Registration & Diagnostics
 * File: setup.gs
 * 
 * Utility functions to register and inspect the Telegram Bot Webhook endpoint (§5.2, §5.3).
 */

// PASTE YOUR GOOGLE APPS SCRIPT DEPLOYED WEB APP /exec URL HERE:
const WEB_APP_URL = 'PASTE_YOUR_DEPLOYED_EXEC_URL_HERE';

/**
 * Registers the Google Apps Script Web App URL with Telegram Bot Webhook API (§5.3).
 * Run this function after deploying your web app as "Execute as: Me", "Who has access: Anyone".
 */
function registerTelegramWebhook() {
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  const webhookSecret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN missing in Script Properties.');
  }

  if (WEB_APP_URL === 'PASTE_YOUR_DEPLOYED_EXEC_URL_HERE' || !WEB_APP_URL.startsWith('https://script.google.com/')) {
    throw new Error(
      'PLEASE UPDATE WEB_APP_URL!\n' +
      'Deploy your script as a Web App (Deploy -> New Deployment -> Web App),\n' +
      'set "Execute as: Me" & "Who has access: Anyone", copy the /exec URL, and paste it into WEB_APP_URL in setup.gs.'
    );
  }

  // Construct target URL including secret parameter (§5.2)
  let targetUrl = WEB_APP_URL;
  if (webhookSecret) {
    targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(webhookSecret);
  }

  const telegramUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(targetUrl)}`;
  Logger.log(`Registering Webhook URL: ${targetUrl.replace(webhookSecret || '', '***SECRET***')}`);

  const response = UrlFetchApp.fetch(telegramUrl, { muteHttpExceptions: true });
  const resultJson = JSON.parse(response.getContentText());

  if (resultJson.ok) {
    Logger.log('✅ Telegram Webhook registered successfully!');
    Logger.log(`Details: ${JSON.stringify(resultJson, null, 2)}`);
  } else {
    Logger.log(`❌ Webhook registration failed: ${resultJson.description}`);
    Logger.log(`Full response: ${JSON.stringify(resultJson, null, 2)}`);
  }
}

/**
 * Fetches current Telegram Webhook status to check for pending updates, errors, or SSL issues (§5.3).
 */
function getWebhookInfo() {
  const botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN missing in Script Properties.');
  }

  const telegramUrl = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
  const response = UrlFetchApp.fetch(telegramUrl, { muteHttpExceptions: true });
  const resultJson = JSON.parse(response.getContentText());

  Logger.log('=== Telegram Webhook Status ===');
  Logger.log(JSON.stringify(resultJson, null, 2));

  if (resultJson.ok && resultJson.result) {
    const info = resultJson.result;
    Logger.log(`URL: ${info.url || 'Not set'}`);
    Logger.log(`Pending update count: ${info.pending_update_count || 0}`);
    if (info.last_error_message) {
      Logger.log(`⚠️ Last error message: ${info.last_error_message}`);
    }
  }
}
