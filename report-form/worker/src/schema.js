// Shared between the Cloudflare Worker (server-side, authoritative) and the
// site's report form (src/report-form.jsx, bundled by esbuild). Pure data,
// no dependencies, no Worker-only APIs.

// ГДБОП lines of work (as on gdbop.bg "Линии на работа") plus the main kinds of
// cybercrime handled by Дирекция „Киберпрестъпност“. `group` drives the
// <optgroup> in the form and the "Група › Вид" label in the email. `id` is what
// travels over the wire; labels never come from the client, so the email
// subject/body can't be influenced by request data.
export const CRIME_GROUPS = [
  { id: 'gdbop', bg: 'Организирана престъпност (ГДБОП)', en: 'Organised crime (GDCOC)' },
  { id: 'cyber', bg: 'Киберпрестъпност', en: 'Cybercrime' },
  { id: 'misc', bg: 'Друго', en: 'Other' },
];

export const CRIME_TYPES = [
  { id: 'drugs', group: 'gdbop', bg: 'Наркотици', en: 'Drug trafficking' },
  { id: 'human_trafficking', group: 'gdbop', bg: 'Трафик на хора', en: 'Human trafficking' },
  { id: 'migrant_smuggling', group: 'gdbop', bg: 'Трафик на мигранти', en: 'Migrant smuggling' },
  { id: 'cultural_property', group: 'gdbop', bg: 'Трафик на културни ценности', en: 'Trafficking in cultural property' },
  { id: 'terrorism', group: 'gdbop', bg: 'Тероризъм и радикализация', en: 'Terrorism and radicalisation' },
  { id: 'corruption', group: 'gdbop', bg: 'Корупция', en: 'Corruption' },
  { id: 'money_laundering', group: 'gdbop', bg: 'Изпиране на пари', en: 'Money laundering' },
  { id: 'tax_fraud', group: 'gdbop', bg: 'Данъчни и осигурителни престъпления (ДДС, акцизи)', en: 'Tax and social-security fraud (VAT, excise)' },
  { id: 'counterfeiting', group: 'gdbop', bg: 'Фалшификации (пари, документи, платежни карти)', en: 'Counterfeiting (currency, documents, payment cards)' },
  { id: 'smuggling', group: 'gdbop', bg: 'Контрабанда (цигари, горива, стоки)', en: 'Smuggling (tobacco, fuel, goods)' },
  { id: 'extortion', group: 'gdbop', bg: 'Изнудване, лихварство, рекет', en: 'Extortion, loan-sharking, racketeering' },

  { id: 'phishing', group: 'cyber', bg: 'Фишинг (кражба на данни, фалшиви сайтове и SMS)', en: 'Phishing (data theft, fake sites and SMS)' },
  { id: 'investment', group: 'cyber', bg: 'Инвестиционни измами', en: 'Investment fraud' },
  { id: 'online_shopping', group: 'cyber', bg: 'Измами при онлайн пазаруване и обяви', en: 'Online shopping and classified-ad fraud' },
  { id: 'bec', group: 'cyber', bg: 'Подменена банкова сметка (BEC)', en: 'BEC fraud (Business Email Compromise)' },
  { id: 'romance', group: 'cyber', bg: 'Романтични измами', en: 'Romance scams' },
  { id: 'vishing', group: 'cyber', bg: 'Телефонни измами (фалшиви банки, полицаи, роднини)', en: 'Phone scams (fake bank, police, relatives)' },
  { id: 'crypto', group: 'cyber', bg: 'Криптовалути', en: 'Cryptocurrency crimes' },
  { id: 'account_takeover', group: 'cyber', bg: 'Откраднат профил или акаунт', en: 'Hijacked profile or account' },
  { id: 'access', group: 'cyber', bg: 'Незаконен достъп (хакерски атаки)', en: 'Unauthorized access (hacking)' },
  { id: 'ransomware', group: 'cyber', bg: 'Рансъмуер (изнудване)', en: 'Ransomware' },
  { id: 'malware', group: 'cyber', bg: 'Компютърни вируси (зловреден код)', en: 'Malware' },
  { id: 'ddos', group: 'cyber', bg: 'DDoS атаки', en: 'DDoS attacks' },
  { id: 'children', group: 'cyber', bg: 'Престъпления срещу деца онлайн', en: 'Online crimes against children' },
  { id: 'sextortion', group: 'cyber', bg: 'Сексуално изнудване онлайн', en: 'Online sextortion' },
  { id: 'ipr', group: 'cyber', bg: 'Онлайн пиратство и фалшиви стоки', en: 'Online piracy and counterfeit goods' },

  { id: 'other', group: 'misc', bg: 'Друго', en: 'Other' },
];

// "Група › Вид", e.g. "Киберпрестъпност › Фишинг (...)".
export const crimeLabel = (id, lang = 'bg') => {
  const t = CRIME_TYPES.find((x) => x.id === id);
  if (!t) return '';
  const g = CRIME_GROUPS.find((x) => x.id === t.group);
  return t.group === 'misc' ? t[lang] : `${g[lang]} › ${t[lang]}`;
};

export const CHANNELS = [
  { id: 'email', bg: 'Имейл', en: 'Email' },
  { id: 'sms', bg: 'SMS съобщение', en: 'SMS' },
  { id: 'phone', bg: 'Телефонно обаждане', en: 'Phone call' },
  { id: 'messenger', bg: 'Чат приложение', en: 'Chat app' },
  { id: 'social', bg: 'Социална мрежа', en: 'Social network' },
  { id: 'website', bg: 'Уебсайт / платформа', en: 'Website / platform' },
  { id: 'marketplace', bg: 'Онлайн обява / пазар', en: 'Online marketplace' },
  { id: 'in_person', bg: 'Лично / на място', en: 'In person' },
  { id: 'other', bg: 'Друго', en: 'Other' },
];

// "What evidence do you have?" (checkboxes). The reporter says what exists;
// images can be attached separately.
export const EVIDENCE = [
  { id: 'emails', bg: 'Копие от имейл кореспонденция', en: 'Copy of email communications' },
  { id: 'messages', bg: 'Текстови съобщения / записи на разговори', en: 'Text messages / call recordings' },
  { id: 'letters', bg: 'Писма или факсове', en: 'Letters or faxes' },
  { id: 'photos', bg: 'Снимки или снимки на екрана', en: 'Photos or screenshots' },
  { id: 'cctv', bg: 'Записи от охранителни камери', en: 'Security camera recordings' },
  { id: 'contracts', bg: 'Договори или други документи', en: 'Contracts or other legal documents' },
  { id: 'financial', bg: 'Банкови извлечения / платежни документи', en: 'Financial transaction statements' },
  { id: 'other', bg: 'Друго', en: 'Other' },
];

export const CURRENCIES = [
  { id: 'EUR', bg: 'EUR (евро)', en: 'EUR (euro)' },
  { id: 'BGN', bg: 'BGN (лева)', en: 'BGN (leva)' },
  { id: 'USD', bg: 'USD', en: 'USD' },
  { id: 'CRYPTO', bg: 'Криптовалута', en: 'Cryptocurrency' },
  { id: 'OTHER', bg: 'Друга', en: 'Other' },
];

export const LIMITS = {
  nameParts: { min: 3, max: 5 },
  namePart: { min: 2, max: 40 },
  nameTotal: 120,
  reportedTo: { min: 3, max: 200 },
  suspect: 300, // one perpetrator identifier (site, phone, IBAN, profile, wallet...)
  suspects: 10, // how many of them
  content: { min: 30, max: 5000 },
  email: 254,
  emailLocal: 64,
  maxUrls: 20,
  // Hard cap on the raw request body, enforced before JSON parsing.
  bodyBytes: 16 * 1024,
};

export const ids = (list) => list.map((x) => x.id);

// What kind of perpetrator identifier was typed (for the chip label in the
// form and the tag in the email). A hint only: everything is kept as typed.
export const IOC_KINDS = {
  url: { bg: 'Сайт / линк', en: 'Website / link' },
  email: { bg: 'Имейл', en: 'Email' },
  phone: { bg: 'Телефон', en: 'Phone' },
  iban: { bg: 'IBAN', en: 'IBAN' },
  crypto: { bg: 'Крипто адрес', en: 'Crypto address' },
  handle: { bg: 'Профил', en: 'Profile' },
  other: { bg: 'Друго', en: 'Other' },
};

export const classifyIoc = (raw) => {
  const s = String(raw || '').trim();
  const compact = s.replace(/[\s.-]/g, '');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return 'email';
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i.test(compact) && /^[A-Z]{2}/i.test(s)) return 'iban';
  if (/^(bc1[a-z0-9]{20,80}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|[LM][a-km-zA-HJ-NP-Z1-9]{26,33}|D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32})$/.test(s)) return 'crypto';
  if (/^(\+|00)?[\d\s().-]{7,20}$/.test(s) && compact.replace(/[^\d]/g, '').length >= 7) return 'phone';
  if (/^@[\w.]{2,64}$/.test(s) || /(t\.me|telegram\.me|facebook\.com|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|wa\.me|viber)\//i.test(s)) return 'handle';
  if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(\/\S*)?$/i.test(s) || /^(https?|hxxps?):\/\//i.test(s)) return 'url';
  return 'other';
};
