/**
 * BUDGET 2026 AUTOMATION - CONSTANTS & VOCABULARIES
 * Source of truth for controlled vocabularies, category mappings, and sheet rules.
 */

// 1. TRANSACTION TYPES (Тип)
// Standardized without trailing tabs. Inflow strings must match exact sheet formatting.
const TRANSACTION_TYPES = {
  EXPENSE: 'Расходы',
  FIXED_EXPENSE: 'Обязательные расходы',
  WITHDRAWAL: 'Снятие денег',
  INCOME: 'Доходы',
  INCOME_BONUS: 'Доходы - премия',
  INCOME_EASY: 'Доходы - лёгкие деньги',
  RECEIVED: 'Получение денег'
};

// 2. FIXED EXPENSE CATEGORIES (Column D in Monthly Tabs)
// ONLY these categories are permitted to use the 'Обязательные расходы' type.
const FIXED_EXPENSE_CATEGORIES = [
  'Квартира',
  'Авто',
  'НКО',
  'Лин',
  'Налоги',
  'Школа & Детский сад',
  'Extra fund',
  'Отдых',
  'Отложения',
  'Отложения (премия)',
  // Legacy backups for old rows
  'Аренда',
  'Няня',
  'Пожертвования',
  'Родители',
  'Сбережения',
  'CPF'
];

// 3. MASTER CATEGORIES LIST
// Includes all expense, savings, tax, and transfer categories.
const CATEGORIES = [
  // Needs
  'Продукты',
  'Счётчики',
  'Транспорт',
  'Красота',
  'Медицина',
  'Лин',
  'Квартира',
  'Школа & Детский сад',
  
  // Wants
  'Рестораны',
  'Развлечения',
  'Подписки',
  'Дом',
  'Подарки',
  'НКО',
  'Другое',
  'Extra fund',
  'Отдых',
  'Авто',
  
  // Savings, Taxes & Transfers
  'Отложения',
  'Отложения (премия)',
  'Налоги',
  'Кредитка'
];

// 4. CATEGORY TO 50/30/20 BUCKET MAP (PRD §4.6 + Monthly Budget Col D alignment)
const CATEGORY_TO_BUCKET = {
  // Needs
  'Продукты': 'Needs',
  'Счётчики': 'Needs',
  'Транспорт': 'Needs',
  'Красота': 'Needs',
  'Медицина': 'Needs',
  'Лин': 'Needs',
  'Квартира': 'Needs',
  'Школа & Детский сад': 'Needs',
  'Аренда': 'Needs', // Legacy alias
  'Няня': 'Needs', // Legacy alias
  'Детский сад': 'Needs', // Legacy alias
  
  // Wants
  'Рестораны': 'Wants',
  'Развлечения': 'Wants',
  'Подписки': 'Wants',
  'Дом': 'Wants',
  'Подарки': 'Wants',
  'НКО': 'Wants',
  'Другое': 'Wants',
  'Extra fund': 'Wants',
  'Отдых': 'Wants',
  'Авто': 'Wants',
  'Пожертвования': 'Wants', // Legacy alias
  'Родители': 'Wants', // Legacy alias
  
  // Savings, Taxes & Exclusions
  'Отложения': 'Savings',
  'Отложения (премия)': 'Savings',
  'Налоги': 'Taxes',
  'Кредитка': '-',
  'Сбережения': 'Savings', // Legacy alias
  'CPF': 'Savings' // Legacy alias
};

// 5. EXTENSIBLE ACCOUNTS LIST (Defaults & Known Cards)
const KNOWN_ACCOUNTS = [
  'DBS CC SGD',
  'Citibank CC',
  'DBS SGD'
];

// 6. BACKWARDS COMPATIBILITY ALIASES
const TYPES = TRANSACTION_TYPES;
const CATEGORY_TO_BUCKET_MAP = CATEGORY_TO_BUCKET;
const ACCOUNTS = KNOWN_ACCOUNTS;
const DEFAULT_ACCOUNT = 'DBS CC SGD';
const ALL_TYPES = Object.values(TRANSACTION_TYPES);
