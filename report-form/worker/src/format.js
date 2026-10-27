// Builds the plain-text email for a validated report. Only validated/normalised
// values and server-side labels reach the output; the free-text content is
// defanged so no reported URL or domain becomes clickable.
import { CHANNELS, CURRENCIES, EVIDENCE, crimeLabel } from './schema.js';
import { REPORT_ID_PREFIX, FILE_TYPES } from './files.js';
import { scanText, defangUrl } from './validate.js';
import { KIND_LABELS } from './intel.js';

const label = (list, id) => list.find((x) => x.id === id)?.bg ?? '';

const QUOTE = '│ ';

export const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const CHILDREN_NOTE = [
  '',
  '!! КАТЕГОРИЯ "ПРЕСТЪПЛЕНИЯ СРЕЩУ ДЕЦА" !!',
  'Подателят е декларирал, че файловете не съдържат голота или сексуално съдържание с непълнолетни. Това не е проверено.',
  'Отваряйте ги само в изолирана среда от упълномощено лице. При съмнение за нелегално съдържание не ги изтегляйте и не ги препращайте, а действайте по вътрешната процедура.',
];

const FLAG_TEXT = {
  'credentials-in-url': 'потребител/парола в URL',
  'ip-address-host': 'IP адрес вместо домейн',
  punycode: 'punycode (възможна имитация на домейн)',
  'url-shortener': 'скъсен линк',
  'risky-tld': 'рисков домейн от най-високо ниво',
  'non-standard-port': 'нестандартен порт',
  'executable-or-archive': 'изпълним файл или архив',
  'very-long': 'много дълъг URL',
  'many-subdomains': 'много поддомейни',
  unparseable: 'неразпознаваем URL',
};

export const newReportId = (now = new Date(), random = crypto.getRandomValues(new Uint8Array(5))) => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Array.from(random, (b) => alphabet[b % alphabet.length]).join('');
  return `${REPORT_ID_PREFIX}-${day}-${suffix}`;
};

// Identifiers as shown in the email: anything that a mail client could turn into
// a link is defanged, like the rest of the reporter's text.
const showIndicator = ({ kind, value }) => {
  if (kind === 'domain') return value.replace(/\./g, '[.]');
  if (kind === 'url') return value.replace(/^([^/?]+)/, (h) => h.replace(/\./g, '[.]'));
  if (kind === 'email') return value.replace(/@(.*)$/, (_, d) => `[@]${d.replace(/\./g, '[.]')}`);
  return value;
};

const REPORTER_LABELS = { name: 'същите имена', phone: 'същия телефон', email: 'същия имейл' };

const otherReports = (n) => (n === 1 ? 'още 1 сигнал' : `още ${n} сигнала`);
const sampleIds = ({ total, reports }) =>
  `${reports.map((r) => r.id).join(', ')}${total > reports.length ? ', ...' : ''}`;

// `intel`: null when the feature is off (no section), { error: true } when the
// lookup failed, otherwise the result of findLinks().
const intelLines = (intel) => {
  if (!intel) return [];
  const lines = ['', '== ВРЪЗКИ С ДРУГИ СИГНАЛИ =='];
  if (intel.error) return [...lines, 'Проверката не беше достъпна в момента.'];
  if (!intel.indicators.length) {
    lines.push('В сигнала не са открити идентификатори (сайт, профил, имейл, телефон, IBAN, крипто адрес, потребителско име).');
  } else {
    lines.push(`Идентификатори в този сигнал: ${intel.indicators.length}`);
    intel.indicators.forEach((ind, i) => {
      const seen = ind.total
        ? `${otherReports(ind.total)} (последен ${ind.reports[0].at.slice(0, 10)}): ${sampleIds(ind)}`
        : 'не е подаван досега';
      lines.push(`${i + 1}. ${KIND_LABELS[ind.kind]}: ${showIndicator(ind)} - ${seen}`);
    });
  }
  const matches = Object.entries(intel.reporter).filter(([, m]) => m.total);
  if (!matches.length) {
    lines.push('Подател: няма други сигнали със същите имена, телефон или имейл.');
  } else {
    for (const [kind, m] of matches) lines.push(`Подател, ${REPORTER_LABELS[kind]}: ${otherReports(m.total)}: ${sampleIds(m)}`);
  }
  return lines;
};

export const buildReportEmail = (v, { id, receivedAt, country, files = [], intel = null, brand = 'example.bg', incomplete = false }) => {
  const scan = scanText(v.content);
  const suspect = v.suspect ? scanText(v.suspect).defanged : '';
  const loss = v.lossAmount ? `${v.lossAmount.replace(',', '.')} ${label(CURRENCIES, v.lossCurrency)}` : '';

  const lines = [
    `СИГНАЛ ${id}`,
    `Получен: ${receivedAt.toISOString()}${country ? `  (държава на подателя: ${country})` : ''}`,
    '',
    '== ВИД И ОБСТОЯТЕЛСТВА ==',
    `Вид престъпление: ${crimeLabel(v.crimeType)}`,
    `Канал на контакт: ${label(CHANNELS, v.channel) || '-'}`,
    `Дата на събитието: ${v.incidentDate || '-'}`,
    `Претърпени вреди: ${loss || '-'}`,
    `Данни за извършителя: ${suspect || '-'}`,
    `Налични доказателства: ${(v.evidence || []).map((id) => label(EVIDENCE, id)).join('; ') || '-'}`,
    '',
    '== ПОДАДЕН СИГНАЛ В МВР ==',
    v.alreadyReported === 'yes' ? `ДА - звено / номер на сигнала: ${v.reportedTo}` : 'НЕ',
    '',
    '== ПОДАТЕЛ ==',
    `Три имена: ${v.fullName}`,
    `ЕГН: ${v.egn || '-'}`,
    `Дата на раждане: ${v.dob || '-'}`,
    `Телефон: ${v.phone}`,
    `Имейл: ${v.email}`,
    '',
    '== ПОТВЪРЖДЕНИЯ НА ПОДАТЕЛЯ ==',
    'Случаят не е спешен: потвърдено (преди попълване на формата).',
    'Декларация, че данните са верни и пълни и че отговорността по закон за неверни данни е известна: да.',
    'Съгласие за обработка на личните данни за разглеждане на сигнала: да.',
    '',
    '== СЪДЪРЖАНИЕ НА СИГНАЛА (текст, въведен от подателя) ==',
    // Every line is prefixed, so the reporter's text cannot pass itself off as
    // one of the email's own sections (a fake "== ПОДАТЕЛ ==" block, links, ...).
    ...scan.defanged.split('\n').map((line) => `${QUOTE}${line}`),
    '== КРАЙ НА ТЕКСТА ОТ ПОДАТЕЛЯ ==',
    '',
    '== АВТОМАТИЧЕН АНАЛИЗ НА ВРЪЗКИТЕ ==',
  ];

  if (!scan.urls.length) {
    lines.push('Не са открити връзки.');
  } else {
    lines.push(
      `Открити връзки: ${scan.urls.length}. Всички са "обезвредени" ([.] вместо . и hxxp вместо http) - не ги отваряйте директно.`,
    );
    scan.urls.forEach((u, i) => {
      const flags = u.flags.map((f) => FLAG_TEXT[f] ?? f);
      lines.push(`${i + 1}. ${defangUrl(u.url)}${flags.length ? `  ⚠ ${flags.join('; ')}` : ''}`);
    });
  }

  lines.push(...intelLines(intel));

  lines.push('', '== ПРИКАЧЕНИ ФАЙЛОВЕ ==');
  if (!files.length) {
    lines.push('Няма.');
  } else {
    const arrived = files.filter((f) => f.arrived);
    lines.push(
      `Декларирани: ${files.length}, получени: ${arrived.length}. Файловете НЕ са прикачени към това писмо - намират се в карантина в частното хранилище.`,
      'Проверяват се с ClamAV и VirusTotal (само по SHA-256) и резултатът идва в отделно писмо "Резултат от проверката" с личните връзки за изтегляне (обикновено до 10-15 минути).',
    );
    if (incomplete) lines.push('⚠ Подателят не завърши качването - изпратено автоматично с наличните файлове.');
    files.forEach((f, i) => {
      const t = FILE_TYPES[f.kind];
      lines.push(`${i + 1}. ${t ? t.label : f.kind}, ${fmtSize(f.size)}${f.origName ? `, "${f.origName}"` : ''}${f.arrived ? ' - в карантина' : ' - НЕ Е ПОЛУЧЕН'}`);
    });
    if (v.crimeType === 'children') lines.push(...CHILDREN_NOTE);
  }

  lines.push('', '--', `Изпратено автоматично от формата на ${brand}. Съдържанието е непроверено и подадено от трето лице.`);

  return {
    // ASCII-only on purpose: no RFC 2047 encoding needed, nothing user-supplied.
    subject: `[${brand}] New report ${id} (${v.crimeType})`,
    text: lines.join('\n'),
  };
};

const REASONS = {
  infected: 'открит зловреден код',
  vt_malicious: 'VirusTotal: известен зловреден файл',
  invalid: 'съдържанието не отговаря на типа / повреден файл',
  too_large: 'по-голям от разрешеното',
  not_msg: 'OLE файл, който не е Outlook .msg',
};

const PDF_FLAGS = {
  javascript: 'JavaScript',
  openaction: 'автоматично действие при отваряне (OpenAction/AA)',
  launch: 'стартиране на програма (Launch)',
  embedded: 'вградени файлове',
  xfa: 'XFA формуляр',
  uri: 'външни връзки (URI)',
  encrypted: 'криптиран',
};

const vtLine = (vt) => {
  if (!vt || vt.status === 'skipped') return 'VirusTotal: не е проверен (няма ключ или е изчерпана квотата)';
  if (vt.status === 'unknown') return 'VirusTotal: непознат хеш (файлът не е виждан досега)';
  if (vt.status === 'error') return 'VirusTotal: грешка при проверката';
  const n = `${vt.malicious ?? 0}/${vt.total ?? 0}`;
  const sus = vt.suspicious ? `, подозрителен за ${vt.suspicious}` : '';
  return `VirusTotal: ${n} антивирусни програми го определят като зловреден${sus}`;
};

// Second email: what the scanner found for each file of a sent report, with
// signed links for the files that passed. `meta` is meta/<id>.json (no
// personal data), `results` is results/<id>.json from the GitHub Action,
// `links` maps a stored name to its signed download URL.
export const buildScanEmail = ({ id, meta, results, links, brand = 'example.bg', bucket = '' }) => {
  const byName = new Map((results.files || []).map((r) => [r.name, r]));
  const files = meta.files.filter((f) => f.arrived);
  const clean = files.filter((f) => byName.get(f.name)?.verdict === 'clean').length;
  const rejected = files.filter((f) => byName.get(f.name)?.verdict === 'rejected').length;
  const lines = [
    `РЕЗУЛТАТ ОТ ПРОВЕРКАТА НА ФАЙЛОВЕТЕ КЪМ СИГНАЛ ${id}`,
    `Проверени: ${results.scannedAt || '-'}  |  Чисти: ${clean}  |  Отхвърлени: ${rejected}${files.length - clean - rejected ? `  |  Без резултат: ${files.length - clean - rejected}` : ''}`,
    `ClamAV база: ${results.clamavVersion || '-'}`,
    '',
  ];
  files.forEach((f, i) => {
    const r = byName.get(f.name) || {};
    const t = FILE_TYPES[f.kind];
    lines.push(`${i + 1}. ${t ? t.label : f.kind}, ${fmtSize(r.size || f.size)}${f.origName ? `, "${f.origName}"` : ''}`);
    lines.push(`   SHA-256: ${r.sha256 || '-'}`);
    if (r.md5) lines.push(`   MD5:     ${r.md5}`);
    lines.push(`   ClamAV: ${r.clamav === 'infected' ? `ЗАРАЗЕН${r.signature ? ` (${r.signature})` : ''}` : r.clamav === 'clean' ? 'чист' : r.clamav || '-'}`);
    lines.push(`   ${vtLine(r.vt)}`);
    if (r.sha256 && r.vt && r.vt.status !== 'skipped') lines.push(`   VT: https://www.virustotal.com/gui/file/${r.sha256}`);
    if (r.pdfFlags && r.pdfFlags.length) lines.push(`   ⚠ PDF съдържа: ${r.pdfFlags.map((x) => PDF_FLAGS[x] || x).join('; ')}`);
    if (r.mail) {
      const m = r.mail;
      if (m.subject) lines.push(`   Писмо - тема: ${scanText(m.subject).defanged}`);
      if (m.from) lines.push(`   Писмо - от: ${scanText(m.from).defanged.replace(/@/g, '[@]')}`);
      if (m.date) lines.push(`   Писмо - дата: ${m.date}`);
      (m.attachments || []).forEach((a, j) => {
        lines.push(`   └ прикачен файл ${j + 1}: "${a.name || '-'}", ${fmtSize(a.size || 0)}, SHA-256 ${a.sha256}${a.clamav === 'infected' ? ', ClamAV: ЗАРАЗЕН' : ''}`);
        lines.push(`     ${vtLine(a.vt)}`);
      });
      if (m.urlCount) lines.push(`   В писмото има ${m.urlCount} връзки (не са проверявани).`);
    }
    if (r.verdict === 'clean') {
      lines.push(`   РЕЗУЛТАТ: чист${t && t.group === 'image' ? ' (прекодиран, без EXIF/GPS)' : ' (оригиналът, без промени)'}`);
      if (links[f.name]) lines.push(`   Изтегляне (7 дни, вход с код по имейл): ${links[f.name]}`);
    } else if (r.verdict === 'rejected') {
      lines.push(`   РЕЗУЛТАТ: ОТХВЪРЛЕН - ${REASONS[r.reason] || r.reason || ''}`);
      lines.push(`   Оригиналът е запазен 30 дни като доказателство: ${bucket ? `${bucket}/` : ''}rejected/${id}/${f.name}`);
    } else {
      lines.push('   РЕЗУЛТАТ: без резултат (ще бъде проверен отново)');
    }
    lines.push('');
  });
  if (meta.crimeType === 'children') lines.push(...CHILDREN_NOTE, '');
  lines.push('Връзките са лични - не ги препращайте. Чист резултат не е гаранция: отваряйте файловете в изолирана среда.');
  lines.push('', '--', `Изпратено автоматично от формата на ${brand}.`);
  return {
    subject: `[${brand}] Scan results ${id}: ${clean} clean, ${rejected} rejected`,
    text: lines.join('\n'),
  };
};
