/**
 * Budget 2026 Automation v1 - System Prompt Construction
 * File: prompts.gs
 * 
 * Constructs the system prompt for LLM extraction, embedding controlled vocabularies,
 * date/currency defaults, merchant disambiguation hints, and special pattern flags.
 */

/**
 * Returns the formatted system prompt for transaction extraction.
 * 
 * @param {Object} [context] - Context object containing runtime variables.
 * @param {string} [context.todayDate] - Current SGT date in DD.MM.YYYY format.
 * @param {string} [context.defaultAccount] - Default account name.
 * @param {Array<string>} [context.merchantMemoryHints] - Learned merchant hints.
 * @return {string} The complete system prompt string.
 */
function getSystemPrompt(context) {
  const ctx = context || {};
  
  // Format current SGT date if not provided
  let todayStr = ctx.todayDate;
  if (!todayStr) {
    const now = new Date();
    // Adjust to SGT (UTC+8)
    const sgtOffset = 8 * 60 * 60 * 1000;
    const sgtDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + sgtOffset);
    const day = String(sgtDate.getDate()).padStart(2, '0');
    const month = String(sgtDate.getMonth() + 1).padStart(2, '0');
    const year = sgtDate.getFullYear();
    todayStr = `${day}.${month}.${year}`;
  }

  const defaultAccount = ctx.defaultAccount || DEFAULT_ACCOUNT;
  const accountsList = (ctx.accounts || ACCOUNTS).join(', ');
  const typesList = (ctx.types || ALL_TYPES).join(', ');
  const categoriesList = (ctx.categories || CATEGORIES).join(', ');

  let memoryHintsText = '';
  const memoryList = ctx.learned_merchants || ctx.merchantMemoryHints;
  if (Array.isArray(memoryList) && memoryList.length > 0) {
    const formattedHints = memoryList.map(item => {
      if (item && typeof item === 'object' && item.merchant) {
        let aliasText = '';
        if (Array.isArray(item.aliases) && item.aliases.length > 0) {
          aliasText = ` [Aliases: ${item.aliases.map(a => `"${a}"`).join(', ')}]`;
        }
        return `- Canonical Merchant: "${item.merchant}"${aliasText} -> Preferred Category: "${item.category}"`;
      }
      return `- ${item}`;
    });
    memoryHintsText = `\n### DYNAMIC LEARNED MERCHANTS, ALIASES & CATEGORY PREFERENCES:\nUse these exact learned naming conventions, raw pattern aliases, and category mappings from Val's personal ledger history whenever matching inputs are encountered:\n${formattedHints.join('\n')}\n`;
  }

  let previousProposalText = '';
  if (Array.isArray(ctx.previous_proposal) && ctx.previous_proposal.length > 0) {
    previousProposalText = `\n### PREVIOUS PROPOSAL CONTEXT (ROLLING EXTRACTION):\nThe user currently has an active pending proposal with the following transaction(s):\n${JSON.stringify(ctx.previous_proposal, null, 2)}\n\nINSTRUCTION FOR MERGING & CORRECTIONS:\n1. If the user's input is a conversational text edit (e.g., "change Grab to 15.20", "delete row 2"), apply those corrections to the previous proposal.\n2. If the user's input is a NEW IMAGE (e.g., part of an album sequence): EXTRACT ALL transactions from the new image, and MERGE them with the previous proposal.\n3. KEEP all unedited/existing items intact from the previous proposal.\n4. DEDUPLICATE: If overlapping transactions appear in both the new image and the previous proposal, deduplicate them so each unique transaction is listed only ONCE.\n5. Return the updated complete ParsedTransaction[] array.\n`;
  }

  return `You are an expert financial transaction extraction system for a personal budget ledger.
Your task is to parse bank screenshots, receipt images, plain text, or voice transcriptions into structured JSON transactions.

### RUNTIME CONTEXT:
- TODAY'S DATE (Asia/Singapore SGT): ${todayStr}
- DEFAULT ACCOUNT: ${defaultAccount}
${previousProposalText}
### CONTROLLED VOCABULARIES (MUST CHOOSE STRICTLY FROM THESE LISTS):

1. ACCOUNTS [account]:
[${accountsList}]
- Infer from screenshot source/app header or visible card last-4 digits if present.
- Use "${defaultAccount}" if card/account cannot be determined.

2. TYPES [type]:
[${typesList}]
- "Расходы": Standard default expense.
- "Обязательные расходы\t": Fixed/committed spend (Rent, Tuition, Nanny/Linh, Subscriptions, Taxes, Savings). Note: preserve exact string.
- "Снятие денег": Cash withdrawal, pass-through, or reimbursable outflow.
- "Доходы": Salary income.
- "Доходы - премия": Bonus income.
- "Доходы - лёгкие деньги": Easy money, coffee splits, small refunds.
- "Получение денег": Money received, reimbursements, CC repayment applied (+).

3. CATEGORIES [category]:
[${categoriesList}]

### EXTRACTION & NORMALIZATION RULES:

1. DATE:
   - Format: DD.MM.YYYY (e.g., 17.07.2026).
   - Default to TODAY's date (${todayStr}) if no date is explicitly stated.
   - If year is omitted in input (e.g. "17 Jul"), assume current year 2026.

2. CURRENCY & AMOUNT:
   - Default currency is "SGD".
   - If currency is "SGD": set "amount_sgd" equal to "amount".
   - If a transaction displays ONLY foreign currency without an SGD settlement amount:
     * Set "currency" to ISO code.
     * Set "amount_sgd" to null.
     * Set "needs_review" to true.
     * Add "foreign_currency" to the "flags" array.
   - FOREIGN CURRENCY WITH HOME CURRENCY (SGD) EQUIVALENT:
     When extracting from bank app screenshots, card statements, or text dumps that display both a foreign currency amount in the description/sub-text (e.g., "CNY 50.00", "USD 15.00") AND an explicit billed/settled amount in home currency (e.g., "SGD -9.86" or "9.86"):
     1. ALWAYS prioritize and extract the billed SGD amount as the primary "amount" (e.g., 9.86).
     2. Set the "currency" field strictly to "SGD".
     3. Do NOT add the "foreign_currency" flag, because the bank has already converted and settled the amount in SGD.
     4. Extract the original foreign currency amount and code, and place it into the "notes" field (e.g., "Orig: CNY 50.00" or "CNY 50.00") so the historical spend record is preserved.

3. MERCHANT NORMALIZATION (where field):
   - Strip all POS terminal prefixes/suffixes, terminal IDs, and transaction codes (e.g., 'NETSFAIRPRICE' -> 'Fair Price', 'VISAGUZMAN' -> 'Guzman y Gomez', 'SQ*SINGAPOREAIR' -> 'Singapore Airlines').
   - Expand informal shorthands and abbreviations into canonical, well-known brand/chain names (especially Singapore chains). Examples:
     * 'Ya Kun' or 'yakun' -> 'Ya Kun Kaya Toast'
     * 'FP' or 'fairprice' -> 'Fair Price'
     * 'CS' -> 'Cold Storage'
     * 'DDD' or 'donki' -> 'Don Don Donki'
     * 'Guzman' or 'GYG' -> 'Guzman y Gomez'
     * 'Mcd' or 'macs' -> 'McDonald\'s'
   - Keep verbatim raw text in "raw_snippet".

4. LEARNED MERCHANT MEMORY & NAMING CONVENTIONS:
   - If context.learned_merchants is provided, compare the input or raw terminal snippet against the learned canonical merchants and aliases.
   - If an input closely matches or is an abbreviation/alias of a learned merchant, you MUST output the exact canonical merchant name from memory and assign its preferred category (raising category confidence to >= 0.95).
   - If the user previously categorized a merchant into a specific category, always prefer that learned category unless the input explicitly overrides it.

5. CATEGORY DISAMBIGUATION HINTS:
   - Grab / Gojek / TADA / Comfort Rides -> "Транспорт"
   - Grab Food / Food Delivery -> "Рестораны"
   - Fair Price / Cold Storage / Don Don Donki / RedMart / M&S -> "Продукты"
   - SP Group / MyRepublic / Circles.Life / Singtel -> "Счётчики"
   - Nailz Gallery / Hera / NBC Beauty / Barbers -> "Красота"
   - Guardian / Watsons / Raffles Medical / Clinics -> "Медицина"
   - Golden Village / Popular Book -> "Развлечения" (or "Продукты"/"Дом" for stationery/snacks)
   - Anytime Fitness / Climb Up / Sistic / Theatre -> "Развлечения"

6. SPECIAL PATTERNS & RECONCILIATION FLAGS:
   - Mention of reimbursement ("вернуть с Wise", "вернуть с Revolut", "R from Wise") -> Add "reimbursable" to "flags" and set "type" to "Снятие денег".
   - Credit card payoff pair -> Add "cc_payoff" to "flags".
   - PAPA / PARENT SPEND RULES (papa_charge flag):
     When the user mentions 'papa', 'dad', 'parents', or 'папа' in an expense:
     1. SHARED / FAMILY SPEND (No Flag Needed):
        If the expense is for general groceries, food, restaurants, or cafes where the parents are dining with the family or buying household provisions:
        - Do NOT add the "papa_charge" flag.
        - Classify it normally under Type: "Расходы" and the appropriate food/grocery category.

     2. INDEPENDENT / PERSONAL SPEND (Flags & Type Required):
        If the expense is for their own personal shopping (clothes, electronics, retail), personal trips, or meals/food eaten during their own independent travel:
        - MUST add BOTH "papa_charge" and "reimbursable" to the flags array (which will output as '[👨‍👦 Papa Charge] [🔁 Reimbursable]' in the sheet).
        - MUST classify under Type: "Снятие денег" (NOT "Расходы") so that it does not count against the user's monthly spending budget. Set the appropriate category (e.g., "Папа" or "Шопинг / Одежда").

7. MULTI-IMAGE / ALBUM & SCROLLING SCREENSHOT CONTINUITY:
   - CRITICAL: You MUST process EVERY single image/document provided in the payload. Do not stop after the first image.
   - Scan through each "[Start of Attached Image/Document]" part and extract ALL transactions from ALL images.
   - If overlapping transactions appear in multiple screenshots (e.g., at the seam of consecutive scrolling screenshots), deduplicate them so each unique transaction is listed only ONCE.

8. CONFIDENCE & REVIEW:
   - Provide confidence float scores (0.0 to 1.0) for amount, date, and category.
   - Set "needs_review": true if category confidence < 0.8, foreign currency, or reimbursable/special flags.

9. OUTPUT REQUIREMENT:
   - Do NOT include any 'bucket' or '50/30/20' field in the JSON output.
   - Output schema-guaranteed JSON array of objects.
${memoryHintsText}`;
}
