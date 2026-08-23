/**
 * Budget 2026 Automation v1 - AI Provider Interface & Schema Definitions
 * File: provider.gs
 * 
 * Defines the Gemini JSON Response Schema for strict schema-guaranteed extraction
 * matching the ParsedTransaction structure (§6.2).
 */

/**
 * Gemini JSON Response Schema for ParsedTransaction[] (§6.2)
 * 
 * CRITICAL INVARIANT: The schema strictly omits the 'bucket' / '50/30/20' field.
 * The 50/30/20 bucket is assigned deterministically by enrichTransaction() in Phase 1 (§4.6, §6.2).
 */
const PARSED_TRANSACTION_ITEMS_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    date: {
      type: 'STRING',
      description: 'Transaction date in DD.MM.YYYY format (e.g. 17.07.2026). Default to today if absent.'
    },
    account: {
      type: 'STRING',
      description: 'Proposed account name (e.g. DBS CC SGD, Citibank CC, DBS SGD). Default DBS CC SGD.'
    },
    type: {
      type: 'STRING',
      description: 'Transaction type matching controlled vocabulary strictly (e.g. Расходы, Обязательные расходы\t, Доходы, etc.).'
    },
    amount: {
      type: 'NUMBER',
      description: 'Transaction amount in original currency as a positive number.'
    },
    currency: {
      type: 'STRING',
      description: '3-letter ISO currency code (e.g. SGD, USD, EUR, MYR). Default SGD.'
    },
    amount_sgd: {
      type: 'NUMBER',
      description: 'Amount in SGD. Equals amount if currency is SGD; null if foreign currency awaiting review.'
    },
    where: {
      type: 'STRING',
      description: 'Extracted & normalized merchant name or description (e.g., Fair Price, TADA, Amazon).'
    },
    category: {
      type: 'STRING',
      description: 'Category chosen strictly from the controlled category vocabulary.'
    },
    confidence: {
      type: 'OBJECT',
      properties: {
        amount: { type: 'NUMBER', description: 'Confidence score for amount extraction (0.0 to 1.0).' },
        date: { type: 'NUMBER', description: 'Confidence score for date extraction (0.0 to 1.0).' },
        category: { type: 'NUMBER', description: 'Confidence score for category classification (0.0 to 1.0).' }
      },
      required: ['amount', 'date', 'category']
    },
    needs_review: {
      type: 'BOOLEAN',
      description: 'Set to true if foreign currency, low confidence (<0.8), or special reconciliation flags are present.'
    },
    flags: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Array of flag tags, e.g. ["foreign_currency"], ["reimbursable"], ["papa_charge"], ["cc_payoff"].'
    },
    source: {
      type: 'STRING',
      description: 'Input modality source: "screenshot", "receipt", "text", or "voice".'
    },
    raw_snippet: {
      type: 'STRING',
      description: 'Verbatim text snippet or OCR line corresponding to this transaction.'
    }
  },
  required: [
    'date',
    'account',
    'type',
    'amount',
    'currency',
    'where',
    'category',
    'confidence',
    'needs_review',
    'flags',
    'source',
    'raw_snippet'
  ]
});

/**
 * Complete Response Schema for Gemini API expecting an array of transactions.
 */
const GEMINI_RESPONSE_SCHEMA = Object.freeze({
  type: 'ARRAY',
  description: 'Array of extracted financial transaction objects.',
  items: PARSED_TRANSACTION_ITEMS_SCHEMA
});
