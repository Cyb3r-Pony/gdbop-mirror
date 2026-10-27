import React, { useState, useEffect, useRef } from 'react';
import { Send, Loader2, AlertTriangle, CheckCircle, Info, ClipboardList, Paperclip, X, ChevronRight, ArrowLeft, Pencil } from 'lucide-react';
import { CRIME_TYPES, CRIME_GROUPS, crimeLabel, CHANNELS, CURRENCIES, EVIDENCE, LIMITS } from '../worker/src/schema.js';
import { validateReport } from '../worker/src/validate.js';
import { FILE_LIMITS, FILE_TYPES, ACCEPT, detectFileType } from '../worker/src/files.js';
import { REPORT_CONFIG } from './report-config.js';

const MB = 1024 * 1024;
const IMG_MB = FILE_TYPES.png.maxBytes / MB;
const DOC_MB = FILE_TYPES.pdf.maxBytes / MB;
const TOTAL_MB = FILE_LIMITS.maxTotalBytes / MB;
const fmtSize = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// PUT one file to its signed upload URL, reporting progress (fetch has no upload progress).
const uploadOne = (url, file, onProgress) =>
    new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.timeout = 15 * 60 * 1000;
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
        xhr.onerror = () => resolve(false);
        xhr.ontimeout = () => resolve(false);
        xhr.send(file);
    });

const EMPTY = {
    crimeType: '', channel: '', incidentDate: '', lossAmount: '', lossCurrency: 'EUR', suspect: '',
    alreadyReported: '', reportedTo: '',
    fullName: '', egn: '', dob: '', phone: '', email: '',
    content: '', evidence: [],
    consent: false, truthDeclaration: false, fax: '', childrenAck: false,
};

// Confirmed on the review screen, not in the form itself.
const FINAL_FIELDS = ['consent', 'truthDeclaration', 'captcha'];

const L = {
    bg: {
        title: 'ПОДАЙ СИГНАЛ',
        gateTitle: 'Преди да започнете',
        gateText: 'Тази система не се наблюдава 24/7. Ако случаят е спешен или животът или здравето на някого са застрашени, веднага се обадете на 112.',
        gateConfirm: 'Потвърждавам, че случаят не е спешен',
        notice: [
            'Форма за подаване до ГДБОП – МВР на сигнали за организирана престъпност и киберпрестъпления (демонстрационна версия)!',
            'Формата НЕ Е предназначена за спешни случаи!',
            'Ако животът или здравето Ви са застрашени веднага се обадете на телефон 112!',
            'Опишете престъплението или нарушението ясно, хронологично, детайлно и подробно! Прикачете доказателства за инцидента!',
        ],
        required: 'Всички полета, отбелязани със *, са задължителни.',
        s1: '1. За какво е сигналът',
        s2: '2. Подаден ли е сигнал в МВР',
        s3: '3. Данни за подателя',
        s4: '4. Съдържание на сигнала',
        s5: '5. Доказателства',
        evidenceQ: 'Какви доказателства имате?',
        evidenceHint: 'Отбележете всичко, с което разполагате, дори да не го прикачвате тук.',
        filesTitle: 'Файлове (по желание)',
        filesHint: `До ${FILE_LIMITS.maxFiles} файла, общо до ${TOTAL_MB} MB: изображения (PNG, JPG, WebP) до ${IMG_MB} MB, PDF документи до ${DOC_MB} MB и имейли (.eml от Gmail/Thunderbird или .msg от Outlook) до ${DOC_MB} MB. Например скрийншоти, договори, банкови извлечения, получени фишинг писма.`,
        filesWarn: 'Не качвайте документи за самоличност, банкови карти или данни, които не са нужни за сигнала. Файловете се пазят в карантина, проверяват се с антивирус (ClamAV и VirusTotal по хеш), изображенията се прекодират, а получателят ги отваря само от защитена връзка.',
        uploading: (i, n) => `Качване на файл ${i} от ${n}…`, finishing: 'Изпращане на сигнала…',
        okFilesFailed: (n) => `${n} от файловете не можаха да бъдат качени. Сигналът е изпратен без тях – можете да ги изпратите отделно, като посочите референтния номер.`,
        filesPick: 'Добави файлове', filesRemove: 'Премахни файла',
        childrenWarn: 'Не качвайте и не препращайте изображения или видео със сексуално съдържание, в което участват непълнолетни – дори да сте ги получили или намерили. Притежаването и разпространението им е престъпление. Прикачвайте само снимки на екрана (профил, чат, обява, сайт), които показват къде и как е станало, без самото съдържание. При съмнение изпратете само адреса и описание.',
        childrenAck: 'Декларирам, че прикачените файлове не съдържат голота или сексуално съдържание с непълнолетни.',
        crimeType: 'Вид престъпление', crimeTypePh: 'Изберете вид…',
        childrenHint: 'Не копирайте и не описвайте подробно материали с насилие над деца – посочете само къде сте ги видели (сайт, профил, чат).',
        channel: 'Как сте били потърсен/а или къде е станало', channelPh: 'Изберете (по желание)…',
        incidentDate: 'Дата на събитието',
        lossAmount: 'Претърпени вреди (сума)', lossCurrency: 'Валута', lossCurrencyPh: 'Валута…',
        suspect: 'Данни за извършителя', suspectHint: 'Уебсайт, телефон, профил, IBAN или портфейл – каквото знаете (по желание).',
        reported: 'Подавали ли сте вече сигнал в структурно звено на МВР?',
        yes: 'Да, подал/а съм', no: 'Не, още не съм',
        reportedTo: 'Наименование на звеното или номер на сигнала',
        reportedToHint: 'Напр. „03 РУ – СДВР“ или „вх. № 1234/2026“.',
        fullName: 'Три имена', fullNameHint: 'Име, презиме и фамилия.',
        egn: 'ЕГН', egnHint: 'Използва се само за идентификация на подателя.',
        dob: 'Дата на раждане', dobHint: 'Използва се само за идентификация на подателя.',
        phone: 'Мобилен телефон', phoneHint: 'Напр. 0888 123 456 или +359 888 123 456.',
        email: 'Електронна поща',
        content: 'Опишете какво се е случило',
        contentHint: 'Какво, кога и как е станало; какви суми и какви данни са засегнати.',
        toReview: 'Продължи към преглед',
        reviewTitle: 'Преглед и изпращане',
        reviewIntro: 'Проверете данните, преди да изпратите сигнала. Можете да редактирате всеки раздел.',
        reviewIssues: 'Има проблеми, които трябва да се поправят, преди да изпратите сигнала.',
        edit: 'Редактирай', back: 'Назад към формата', none: '—',
        filesCount: (n) => `${n} бр.`,
        consent: 'Съгласен/а съм личните ми данни (три имена, ЕГН, телефон, електронна поща) да бъдат обработени за разглеждане на сигнала.',
        truthDeclaration: 'Декларирам, че предоставените от мен данни са верни и пълни. Известна ми е отговорността, която нося по закон за предоставяне на неверни данни.',
        captcha: 'Потвърдете, че не сте робот.',
        submit: 'Изпрати сигнала', sending: 'Изпращане…',
        okTitle: 'Сигналът е изпратен', okRef: 'Референтен номер:', okKeep: 'Запазете го – ще ви послужи, ако се свържете с нас.', again: 'Подай нов сигнал',
        fixErrors: 'Моля, поправете отбелязаните полета.',
        err: {
            required: 'Полето е задължително.',
            invalid: 'Невалидна стойност.',
            too_short: 'Твърде кратко – опишете случая по-подробно.',
            too_long: 'Твърде дълго.',
            three_names: 'Въведете трите си имена (име, презиме, фамилия).',
            dangerous: 'Текстът съдържа HTML, код или подозрителни конструкции. Премахнете ги (напр. < >, javascript:) и опитайте отново.',
            too_many_links: `Твърде много връзки (най-много ${LIMITS.maxUrls}).`,
        },
        errField: {
            egn: { invalid: 'Невалидно ЕГН.' },
            dob: { invalid: 'Въведете валидна дата на раждане.', required: 'Датата на раждане е задължителна.' },
            phone: { invalid: 'Въведете мобилен номер, напр. 0888 123 456 или +359 888 123 456.' },
            email: { invalid: 'Невалиден адрес на електронна поща.' },
            alreadyReported: { required: 'Изберете „Да“ или „Не“.' },
            reportedTo: { required: 'Посочете звено или номер на сигнала.' },
            consent: { required: 'Необходимо е съгласие, за да изпратите сигнала.' },
            truthDeclaration: { required: 'Необходима е декларация за истинността на данните.' },
            notEmergency: { required: 'Потвърдете, че случаят не е спешен.' },
            crimeType: { required: 'Изберете вид престъпление.' },
            lossCurrency: { required: 'Изберете валута.' },
            childrenAck: { required: 'Необходима е декларация, за да качите файлове.' },
            captcha: { required: 'Потвърдете, че не сте робот.' },
            files: {
                too_many: `Най-много ${FILE_LIMITS.maxFiles} файла.`,
                too_large: `Изображенията трябва да са до ${IMG_MB} MB, а PDF/EML/MSG – до ${DOC_MB} MB.`,
                total_too_large: `Общият размер на файловете трябва да е до ${TOTAL_MB} MB.`,
                bad_type: 'Приемат се само PNG, JPG, WebP, PDF, EML и MSG файлове (проверява се съдържанието, не името).',
                unavailable: 'Качването на файлове временно не работи. Изпратете сигнала без тях.',
            },
        },
        server: {
            captcha_failed: 'Проверката „не съм робот“ не успя. Опитайте отново.',
            captcha_unavailable: 'Услугата за проверка е временно недостъпна. Опитайте след малко.',
            rate_limited: 'Твърде много опити. Изчакайте минута и опитайте отново.',
            too_large: 'Сигналът е твърде голям.',
            send_failed: 'Сигналът не можа да бъде изпратен. Опитайте по-късно.',
            storage_failed: 'Файловете не можаха да бъдат записани. Опитайте отново или изпратете сигнала без тях.',
            network: 'Няма връзка със сървъра. Проверете интернет връзката и опитайте отново.',
            generic: 'Възникна грешка. Опитайте отново.',
        },
    },
    en: {
        title: 'SUBMIT A REPORT',
        gateTitle: 'Before you start',
        gateText: 'This system is not monitored 24/7. If this is an emergency or someone’s life or health is in danger, call 112 immediately.',
        gateConfirm: 'I confirm that this is not an emergency',
        notice: [
            'Form for reporting organised crime and cybercrime to GDCOC – Ministry of Interior (demo version)!',
            'This form is NOT intended for emergencies!',
            'If your life or health is in danger, call 112 immediately!',
            'Describe the crime or offence clearly, chronologically and in detail! Attach evidence of the incident!',
        ],
        required: 'All fields marked * are required.',
        s1: '1. What the report is about',
        s2: '2. Already reported to the Ministry of Interior?',
        s3: '3. Your details',
        s4: '4. Report details',
        s5: '5. Evidence',
        evidenceQ: 'What evidence do you have?',
        evidenceHint: 'Tick everything you have, even if you do not attach it here.',
        filesTitle: 'Files (optional)',
        filesHint: `Up to ${FILE_LIMITS.maxFiles} files, ${TOTAL_MB} MB in total: images (PNG, JPG, WebP) up to ${IMG_MB} MB, PDF documents up to ${DOC_MB} MB and emails (.eml from Gmail/Thunderbird or .msg from Outlook) up to ${DOC_MB} MB – e.g. screenshots, contracts, bank statements, phishing emails you received.`,
        filesWarn: 'Do not upload ID documents, bank cards or data that is not needed for the report. Files are held in quarantine and virus-scanned (ClamAV and VirusTotal by hash), images are re-encoded, and the recipient opens them only from a protected link.',
        uploading: (i, n) => `Uploading file ${i} of ${n}…`, finishing: 'Sending the report…',
        okFilesFailed: (n) => `${n} of the files could not be uploaded. The report was sent without them – you can send them separately quoting the reference number.`,
        filesPick: 'Add files', filesRemove: 'Remove file',
        childrenWarn: 'Do not upload or forward images or videos of a sexual nature involving minors – even if you received or found them. Possessing and distributing them is a crime. Attach only screenshots (profile, chat, listing, site) that show where and how it happened, not the material itself. If in doubt, send just the address and a description.',
        childrenAck: 'I declare that the attached files contain no nudity or sexual content involving minors.',
        crimeType: 'Type of crime', crimeTypePh: 'Select a type…',
        childrenHint: 'Do not copy or describe in detail any abuse material – only state where you saw it (site, profile, chat).',
        channel: 'How you were contacted / where it happened', channelPh: 'Select (optional)…',
        incidentDate: 'Date of the incident',
        lossAmount: 'Loss suffered (amount)', lossCurrency: 'Currency', lossCurrencyPh: 'Currency…',
        suspect: 'Details of the offender', suspectHint: 'Website, phone, profile, IBAN or wallet – whatever you know (optional).',
        reported: 'Have you already filed a report with a unit of the Ministry of Interior?',
        yes: 'Yes, I have', no: 'No, not yet',
        reportedTo: 'Name of the unit or the report number',
        reportedToHint: 'E.g. "03 District Police Dept" or "ref. 1234/2026".',
        fullName: 'Full name (three names)', fullNameHint: 'First, middle and last name.',
        egn: 'Personal ID number (ЕГН)', egnHint: 'Used only to identify the reporter.',
        dob: 'Date of birth', dobHint: 'Used only to identify the reporter.',
        phone: 'Mobile phone', phoneHint: 'E.g. 0888 123 456 or +359 888 123 456.',
        email: 'Email',
        content: 'Describe what happened',
        contentHint: 'What, when and how; amounts and data involved.',
        toReview: 'Continue to review',
        reviewTitle: 'Review and submit',
        reviewIntro: 'Check your details before sending the report. You can edit any section.',
        reviewIssues: 'There are issues that need to be fixed before you can submit the report.',
        edit: 'Edit', back: 'Back to the form', none: '—',
        filesCount: (n) => `${n}`,
        consent: 'I agree to my personal data (full name, date of birth, phone, email) being processed to handle this report.',
        truthDeclaration: 'I declare that the information I have provided is true and complete. I am aware of my legal responsibility for providing false information.',
        captcha: 'Please confirm you are not a robot.',
        submit: 'Send report', sending: 'Sending…',
        okTitle: 'Report sent', okRef: 'Reference number:', okKeep: 'Keep it in case you contact us.', again: 'Submit another report',
        fixErrors: 'Please fix the highlighted fields.',
        err: {
            required: 'This field is required.',
            invalid: 'Invalid value.',
            too_short: 'Too short – please describe the case in more detail.',
            too_long: 'Too long.',
            three_names: 'Enter all three names (first, middle, last).',
            dangerous: 'The text contains HTML, code or suspicious constructs. Remove them (e.g. < >, javascript:) and try again.',
            too_many_links: `Too many links (max ${LIMITS.maxUrls}).`,
        },
        errField: {
            egn: { invalid: 'Invalid ЕГН.' },
            dob: { invalid: 'Enter a valid date of birth.', required: 'Date of birth is required.' },
            phone: { invalid: 'Enter a mobile number, e.g. 0888 123 456 or +359 888 123 456.' },
            email: { invalid: 'Invalid email address.' },
            alreadyReported: { required: 'Choose "Yes" or "No".' },
            reportedTo: { required: 'State the unit or the report number.' },
            consent: { required: 'Consent is required to send the report.' },
            truthDeclaration: { required: 'A declaration that the information is true is required.' },
            notEmergency: { required: 'Please confirm that this is not an emergency.' },
            crimeType: { required: 'Select a type of crime.' },
            lossCurrency: { required: 'Select a currency.' },
            childrenAck: { required: 'A declaration is required to upload files.' },
            captcha: { required: 'Please confirm you are not a robot.' },
            files: {
                too_many: `At most ${FILE_LIMITS.maxFiles} files.`,
                too_large: `Images must be at most ${IMG_MB} MB, PDF/EML/MSG files at most ${DOC_MB} MB.`,
                total_too_large: `The files must be at most ${TOTAL_MB} MB in total.`,
                bad_type: 'Only PNG, JPG, WebP, PDF, EML and MSG files are accepted (the content is checked, not the name).',
                unavailable: 'File upload is temporarily unavailable. Send the report without them.',
            },
        },
        server: {
            captcha_failed: 'The "not a robot" check failed. Please try again.',
            captcha_unavailable: 'The verification service is temporarily unavailable. Try again shortly.',
            rate_limited: 'Too many attempts. Wait a minute and try again.',
            too_large: 'The report is too large.',
            send_failed: 'The report could not be sent. Please try again later.',
            storage_failed: 'The files could not be saved. Try again or send the report without them.',
            network: 'Could not reach the server. Check your connection and try again.',
            generic: 'Something went wrong. Please try again.',
        },
    },
};

// --- Turnstile -------------------------------------------------------------

const loadTurnstile = () =>
    new Promise((resolve, reject) => {
        if (window.turnstile) return resolve(window.turnstile);
        let s = document.querySelector('script[data-turnstile]');
        if (!s) {
            s = document.createElement('script');
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            s.async = true;
            s.defer = true;
            s.dataset.turnstile = '1';
            document.head.appendChild(s);
        }
        s.addEventListener('load', () => resolve(window.turnstile));
        s.addEventListener('error', reject);
    });

// --- UI bits ---------------------------------------------------------------

const inputCls = (invalid) =>
    `w-full bg-slate-800/80 border ${invalid ? 'border-red-500' : 'border-slate-600'} rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-gdbop-blue focus:ring-1 focus:ring-gdbop-blue [&>option]:bg-slate-800`;

const Field = ({ id, label, required, error, hint, children }) => (
    <div>
        <label htmlFor={id} className="block text-sm font-semibold text-slate-200 mb-1.5">
            {label}
            {required && <span className="text-police-red ml-1" aria-hidden="true">*</span>}
        </label>
        {children}
        {error ? (
            <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-red-400">{error}</p>
        ) : hint ? (
            <p id={`${id}-hint`} className="mt-1 text-xs text-slate-400">{hint}</p>
        ) : null}
    </div>
);

const Fieldset = ({ id, legend, children }) => (
    <fieldset id={id} className="space-y-5 border border-slate-700/60 rounded-xl p-5 md:p-6 scroll-mt-24">
        <legend className="px-2 text-sm font-bold tracking-wider text-gdbop-blue uppercase">{legend}</legend>
        {children}
    </fieldset>
);

const Check = ({ id, checked, onChange, invalid, children }) => (
    <label className="flex gap-3 items-start cursor-pointer text-sm text-slate-200">
        <input
            id={id} name={id} type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            aria-invalid={invalid ? 'true' : undefined}
            className="mt-1 h-4 w-4 shrink-0 accent-[#47a8f6]"
        />
        <span>{children}</span>
    </label>
);

const ErrorBanner = ({ text }) => (
    <div role="alert" className="flex gap-3 items-start p-3 rounded-lg bg-red-500/10 border border-red-500/40 text-red-200 text-sm">
        <AlertTriangle className="shrink-0 mt-0.5" size={18} />
        <p>{text}</p>
    </div>
);

const primaryBtn = 'inline-flex items-center justify-center gap-2 px-8 py-3 rounded-lg bg-gdbop-blue hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-bold tracking-wide transition-colors';
const secondaryBtn = 'inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg border border-slate-600 bg-slate-800/80 text-slate-200 hover:border-gdbop-blue hover:text-white transition-colors';

// Which form section each field lives in (for "Edit" and for error routing).
const SECTION_OF = {
    crimeType: 'sec-1', channel: 'sec-1', incidentDate: 'sec-1', lossAmount: 'sec-1', lossCurrency: 'sec-1', suspect: 'sec-1',
    alreadyReported: 'sec-2', reportedTo: 'sec-2',
    fullName: 'sec-3', egn: 'sec-3', dob: 'sec-3', phone: 'sec-3', email: 'sec-3',
    content: 'sec-4',
    evidence: 'sec-5', files: 'sec-5', childrenAck: 'sec-5',
};

// --- Section ---------------------------------------------------------------

export const ReportSection = ({ lang }) => {
    const t = L[lang];
    // gate (not-an-emergency) -> form -> review -> success
    const [view, setView] = useState('gate');
    const [values, setValues] = useState(EMPTY);
    const [errors, setErrors] = useState({});
    const [submitting, setSubmitting] = useState(false);
    const [banner, setBanner] = useState('');
    const [refId, setRefId] = useState('');
    const [token, setToken] = useState('');
    const [files, setFiles] = useState([]); // [{ file, kind }]
    const [progress, setProgress] = useState(null); // { i, n, frac } while uploading
    const [failedUploads, setFailedUploads] = useState(0);
    const fileInput = useRef(null);
    const panelRef = useRef(null);
    const widgetBox = useRef(null);
    const widgetId = useRef(null);
    const today = new Date().toISOString().slice(0, 10);

    // The captcha lives on the review screen: (re)create it there, and when the language changes.
    useEffect(() => {
        if (view !== 'review') return undefined;
        let cancelled = false;
        loadTurnstile()
            .then((ts) => {
                if (cancelled || !widgetBox.current) return;
                widgetId.current = ts.render(widgetBox.current, {
                    sitekey: REPORT_CONFIG.turnstileSiteKey,
                    theme: 'dark',
                    language: lang === 'bg' ? 'bg' : 'en',
                    callback: (tok) => {
                        setToken(tok);
                        setErrors((e) => { const { captcha, ...rest } = e; return rest; });
                    },
                    'expired-callback': () => setToken(''),
                    'error-callback': () => setToken(''),
                });
            })
            .catch(() => setBanner(t.server.captcha_unavailable));
        return () => {
            cancelled = true;
            if (widgetId.current !== null && window.turnstile) window.turnstile.remove(widgetId.current);
            widgetId.current = null;
            setToken('');
        };
    }, [lang, view]);

    const resetCaptcha = () => {
        setToken('');
        if (widgetId.current !== null && window.turnstile) window.turnstile.reset(widgetId.current);
    };

    const setField = (key, value) => {
        setValues((v) => ({ ...v, [key]: value }));
        setErrors((e) => {
            if (!e[key]) return e;
            const { [key]: _drop, ...rest } = e;
            return rest;
        });
    };
    const on = (key) => (e) => setField(key, e.target.value);
    const toggleEvidence = (id) =>
        setField('evidence', values.evidence.includes(id) ? values.evidence.filter((x) => x !== id) : [...values.evidence, id]);

    const msg = (field, code) => t.errField[field]?.[code] ?? t.err[code] ?? t.err.invalid;
    const errText = (field) => (errors[field] ? msg(field, errors[field]) : '');
    const aria = (field) => ({
        'aria-invalid': errors[field] ? 'true' : undefined,
        'aria-describedby': errors[field] ? `${field}-err` : `${field}-hint`,
    });

    const addFiles = async (picked) => {
        const next = [...files];
        let problem = '';
        for (const f of picked) {
            if (next.some((x) => x.file.name === f.name && x.file.size === f.size && x.file.lastModified === f.lastModified)) continue;
            if (next.length >= FILE_LIMITS.maxFiles) { problem = 'too_many'; break; }
            if (f.size === 0) { problem = 'bad_type'; continue; }
            const head = new Uint8Array(await f.slice(0, FILE_LIMITS.sniffBytes).arrayBuffer());
            let kind = detectFileType(head);
            if (kind === 'msg?') kind = 'msg'; // OLE2: the scanner confirms it is an Outlook message
            if (!FILE_TYPES[kind]) { problem = 'bad_type'; continue; }
            if (f.size > FILE_TYPES[kind].maxBytes) { problem = 'too_large'; continue; }
            if (next.reduce((a, x) => a + x.file.size, 0) + f.size > FILE_LIMITS.maxTotalBytes) { problem = 'total_too_large'; continue; }
            next.push({ file: f, kind });
        }
        setFiles(next);
        setErrors((e) => {
            const { files: _drop, ...rest } = e;
            return problem ? { ...rest, files: problem } : rest;
        });
    };

    const removeFile = (index) => {
        setFiles((f) => f.filter((_, i) => i !== index));
        setErrors((e) => { const { files: _drop, ...rest } = e; return rest; });
    };

    const scrollTop = () => requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    const focusFirstError = () =>
        requestAnimationFrame(() => panelRef.current?.querySelector('[aria-invalid="true"]')?.focus());

    // English form: date of birth instead of the ЕГН; Bulgarian form: the reverse.
    const payload = () => ({
        ...values,
        egn: lang === 'en' ? '' : values.egn,
        dob: lang === 'en' ? values.dob : '',
        notEmergency: true, // the gate was passed
    });

    // Errors of the form fields only (the final confirmations are on the review screen).
    const formErrors = () => {
        const found = { ...validateReport({ ...payload(), consent: true, truthDeclaration: true }).errors };
        delete found.notEmergency;
        if (values.crimeType === 'children' && files.length > 0 && !values.childrenAck) found.childrenAck = 'required';
        return found;
    };

    const goToReview = (e) => {
        e.preventDefault();
        setBanner('');
        const found = formErrors();
        if (Object.keys(found).length) {
            setErrors(found);
            setBanner(t.fixErrors);
            focusFirstError();
            return;
        }
        setErrors({});
        setView('review');
        scrollTop();
    };

    const editSection = (sectionId) => {
        setBanner('');
        setView('form');
        requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    };

    const send = async () => {
        if (submitting) return;
        setBanner('');
        const found = { ...formErrors() };
        const final = validateReport(payload()).errors;
        if (final.consent) found.consent = final.consent;
        if (final.truthDeclaration) found.truthDeclaration = final.truthDeclaration;
        if (!token) found.captcha = 'required';
        if (Object.keys(found).length) {
            setErrors(found);
            setBanner(t.reviewIssues);
            focusFirstError();
            return;
        }

        setSubmitting(true);
        const withFiles = REPORT_CONFIG.filesEnabled && files.length > 0;
        const manifest = withFiles ? files.map(({ file, kind }) => ({ kind, size: file.size, name: file.name })) : [];
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20000);
        const done = (id, failed = 0) => {
            setRefId(String(id || ''));
            setFailedUploads(failed);
            setValues(EMPTY); // drop personal data from memory
            setFiles([]);
            setErrors({});
            setView('success');
            scrollTop();
        };
        try {
            const res = await fetch(REPORT_CONFIG.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload(), files: manifest, captchaToken: token }),
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                signal: ctl.signal,
            });
            clearTimeout(timer);
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok && !data.uploads) return done(data.id);
            if (res.ok && data.ok && Array.isArray(data.uploads)) {
                // each file on its own, straight into quarantine; one retry each
                let failed = 0;
                for (let i = 0; i < data.uploads.length; i++) {
                    setProgress({ i: i + 1, n: data.uploads.length, frac: 0 });
                    const onP = (frac) => setProgress({ i: i + 1, n: data.uploads.length, frac });
                    const ok = (await uploadOne(data.uploads[i].url, files[i].file, onP)) || (await uploadOne(data.uploads[i].url, files[i].file, onP));
                    if (!ok) failed++;
                }
                setProgress({ i: data.uploads.length, n: data.uploads.length, frac: 1, finishing: true });
                // if this call fails the server still sends the report within the hour
                await fetch(data.finalize, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
                return done(data.id, failed);
            }
            if (data.error === 'validation' && data.fields) {
                setErrors(data.fields);
                setBanner(t.reviewIssues);
            } else {
                setBanner(t.server[data.error] ?? t.server.generic);
            }
        } catch {
            setBanner(t.server.network);
        } finally {
            clearTimeout(timer);
            setProgress(null);
            // a Turnstile token is single-use
            resetCaptcha();
            setSubmitting(false);
        }
    };

    // --- review helpers ---
    const label = (list, id) => list.find((x) => x.id === id)?.[lang] ?? '';
    const issue = (field) =>
        errors[field] ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-red-500/15 text-red-300 px-2 py-1 text-xs">
                <AlertTriangle size={13} /> {msg(field, errors[field])}
            </span>
        ) : null;
    const Row = ({ name, field, children }) => (
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 sm:gap-6 py-2.5 border-b border-slate-700/50 last:border-0">
            <dt className="text-sm font-semibold text-slate-300 sm:w-2/5">{name}</dt>
            <dd className="text-sm text-slate-100 sm:w-3/5 sm:text-right break-words">{issue(field) || children || <span className="text-slate-500">{t.none}</span>}</dd>
        </div>
    );
    const ReviewCard = ({ title, section, children }) => {
        const bad = Object.keys(errors).some((k) => SECTION_OF[k] === section);
        return (
            <div className={`rounded-xl border ${bad ? 'border-red-500/50' : 'border-slate-700/60'} p-4 md:p-5`}>
                <div className="flex items-center justify-between mb-2">
                    <h5 className="font-bold text-white">{title}</h5>
                    <button type="button" onClick={() => editSection(section)} className="inline-flex items-center gap-1.5 text-sm text-gdbop-blue hover:underline">
                        <Pencil size={14} /> {t.edit}
                    </button>
                </div>
                <dl>{children}</dl>
            </div>
        );
    };

    return (
        <section id="report" className="container mx-auto px-4 py-16 z-10 relative">
            <div className="flex items-center justify-center mb-8 gap-4">
                <ClipboardList className="text-police-red" size={32} />
                <h3 className="text-2xl md:text-3xl font-bold text-white text-center border-b-2 border-gdbop-blue pb-2 uppercase">
                    {view === 'review' ? t.reviewTitle : t.title}
                </h3>
                <ClipboardList className="text-police-blue" size={32} />
            </div>

            <div ref={panelRef} className="max-w-3xl mx-auto glass-panel bg-slate-900/80 backdrop-blur-md rounded-2xl border border-white/10 shadow-2xl p-5 md:p-8 scroll-mt-24">
                {view === 'gate' && (
                    <div className="space-y-6 text-center py-2">
                        <div className="flex gap-3 items-start text-left p-5 rounded-lg bg-red-500/10 border border-red-500/40 text-red-100">
                            <AlertTriangle className="shrink-0 mt-0.5 text-red-400" size={22} />
                            <div>
                                <p className="font-bold text-white mb-1">{t.gateTitle}</p>
                                <p>{t.gateText}</p>
                            </div>
                        </div>
                        <button type="button" onClick={() => { setView('form'); scrollTop(); }} className={primaryBtn}>
                            {t.gateConfirm} <ChevronRight size={18} />
                        </button>
                    </div>
                )}

                {view === 'success' && (
                    <div className="text-center py-8" role="status">
                        <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-400" />
                        <h4 className="text-2xl font-bold text-white mb-2">{t.okTitle}</h4>
                        <p className="text-slate-300">
                            {t.okRef} <span className="font-mono text-gdbop-blue font-bold">{refId}</span>
                        </p>
                        <p className="text-slate-400 text-sm mt-1">{t.okKeep}</p>
                        {failedUploads > 0 && <p className="mt-4 text-amber-200 text-sm max-w-md mx-auto">{t.okFilesFailed(failedUploads)}</p>}
                        <button
                            type="button"
                            onClick={() => { setView('gate'); setBanner(''); }}
                            className="mt-6 px-6 py-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold transition-colors"
                        >
                            {t.again}
                        </button>
                    </div>
                )}

                {view === 'form' && (
                    <form onSubmit={goToReview} method="post" noValidate autoComplete="off" className="space-y-6">
                        <div className="flex gap-3 items-start p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-100 text-sm">
                            <Info className="shrink-0 mt-0.5" size={18} />
                            <div className="space-y-1.5">
                                {t.notice.map((line, i) => (
                                    <p key={i} className={i === 0 ? 'font-bold text-amber-50' : i === 1 || i === 2 ? 'font-semibold' : ''}>{line}</p>
                                ))}
                            </div>
                        </div>
                        <p className="text-xs text-slate-400">{t.required}</p>

                        {/* Honeypot: invisible to people, tempting to bots. */}
                        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
                            <label>Fax<input type="text" name="fax" tabIndex={-1} autoComplete="off" value={values.fax} onChange={on('fax')} /></label>
                        </div>

                        <Fieldset id="sec-1" legend={t.s1}>
                            <Field id="crimeType" label={t.crimeType} required error={errText('crimeType')}>
                                <select id="crimeType" name="crimeType" value={values.crimeType} onChange={on('crimeType')} className={inputCls(errors.crimeType)} {...aria('crimeType')}>
                                    <option value="">{t.crimeTypePh}</option>
                                    {CRIME_GROUPS.map((g) => (
                                        <optgroup key={g.id} label={g[lang]}>
                                            {CRIME_TYPES.filter((c) => c.group === g.id).map((c) => <option key={c.id} value={c.id}>{c[lang]}</option>)}
                                        </optgroup>
                                    ))}
                                </select>
                            </Field>
                            {values.crimeType === 'children' && (
                                <div className="flex gap-3 items-start p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-100 text-sm">
                                    <AlertTriangle className="shrink-0 mt-0.5" size={18} />
                                    <p>{t.childrenHint}</p>
                                </div>
                            )}
                            <div className="grid md:grid-cols-2 gap-5">
                                <Field id="channel" label={t.channel} error={errText('channel')}>
                                    <select id="channel" name="channel" value={values.channel} onChange={on('channel')} className={inputCls(errors.channel)} {...aria('channel')}>
                                        <option value="">{t.channelPh}</option>
                                        {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c[lang]}</option>)}
                                    </select>
                                </Field>
                                <Field id="incidentDate" label={t.incidentDate} error={errText('incidentDate')}>
                                    <input id="incidentDate" name="incidentDate" type="date" min="2000-01-01" max={today} value={values.incidentDate} onChange={on('incidentDate')} className={inputCls(errors.incidentDate)} {...aria('incidentDate')} />
                                </Field>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-[2fr_1fr] gap-5">
                                <Field id="lossAmount" label={t.lossAmount} error={errText('lossAmount')}>
                                    <input id="lossAmount" name="lossAmount" type="text" inputMode="decimal" maxLength={15} placeholder="0.00" value={values.lossAmount} onChange={on('lossAmount')} className={inputCls(errors.lossAmount)} {...aria('lossAmount')} />
                                </Field>
                                <Field id="lossCurrency" label={t.lossCurrency} error={errText('lossCurrency')}>
                                    <select id="lossCurrency" name="lossCurrency" value={values.lossCurrency} onChange={on('lossCurrency')} className={inputCls(errors.lossCurrency)} {...aria('lossCurrency')}>
                                        <option value="">{t.lossCurrencyPh}</option>
                                        {CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c[lang]}</option>)}
                                    </select>
                                </Field>
                            </div>
                            <Field id="suspect" label={t.suspect} hint={t.suspectHint} error={errText('suspect')}>
                                <input id="suspect" name="suspect" type="text" maxLength={LIMITS.suspect} value={values.suspect} onChange={on('suspect')} className={inputCls(errors.suspect)} {...aria('suspect')} />
                            </Field>
                        </Fieldset>

                        <Fieldset id="sec-2" legend={t.s2}>
                            <div role="radiogroup" aria-labelledby="reported-label" aria-required="true" className="space-y-3">
                                <p id="reported-label" className="text-sm font-semibold text-slate-200">
                                    {t.reported}<span className="text-police-red ml-1" aria-hidden="true">*</span>
                                </p>
                                <div className="grid sm:grid-cols-2 gap-3">
                                    {[['yes', t.yes], ['no', t.no]].map(([val, text]) => (
                                        <label key={val} className="flex items-center gap-3 cursor-pointer rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-3 text-slate-200 hover:border-gdbop-blue has-[:checked]:border-gdbop-blue has-[:checked]:bg-gdbop-blue/10 has-[:checked]:text-white transition-colors">
                                            <input
                                                type="radio" name="alreadyReported" value={val}
                                                checked={values.alreadyReported === val}
                                                onChange={on('alreadyReported')}
                                                aria-invalid={errors.alreadyReported ? 'true' : undefined}
                                                className="h-4 w-4 accent-[#47a8f6]"
                                            />
                                            <span className="font-medium">{text}</span>
                                        </label>
                                    ))}
                                </div>
                                {errors.alreadyReported && <p role="alert" className="text-xs text-red-400">{errText('alreadyReported')}</p>}
                            </div>
                            {values.alreadyReported === 'yes' && (
                                <Field id="reportedTo" label={t.reportedTo} required hint={t.reportedToHint} error={errText('reportedTo')}>
                                    <input id="reportedTo" name="reportedTo" type="text" maxLength={LIMITS.reportedTo.max} value={values.reportedTo} onChange={on('reportedTo')} className={inputCls(errors.reportedTo)} {...aria('reportedTo')} />
                                </Field>
                            )}
                        </Fieldset>

                        <Fieldset id="sec-3" legend={t.s3}>
                            <Field id="fullName" label={t.fullName} required hint={t.fullNameHint} error={errText('fullName')}>
                                <input id="fullName" name="fullName" type="text" autoComplete="name" maxLength={LIMITS.nameTotal} value={values.fullName} onChange={on('fullName')} className={inputCls(errors.fullName)} {...aria('fullName')} />
                            </Field>
                            <div className="grid md:grid-cols-2 gap-5">
                                {lang === 'en' ? (
                                    <Field id="dob" label={t.dob} required hint={t.dobHint} error={errText('dob')}>
                                        <input id="dob" name="dob" type="date" min="1900-01-01" max={today} autoComplete="bday" value={values.dob} onChange={on('dob')} className={inputCls(errors.dob)} {...aria('dob')} />
                                    </Field>
                                ) : (
                                    <Field id="egn" label={t.egn} required hint={t.egnHint} error={errText('egn')}>
                                        <input id="egn" name="egn" type="text" inputMode="numeric" autoComplete="off" maxLength={10} value={values.egn} onChange={(e) => setField('egn', e.target.value.replace(/\D/g, '').slice(0, 10))} className={`${inputCls(errors.egn)} font-mono tracking-widest`} {...aria('egn')} />
                                    </Field>
                                )}
                                <Field id="phone" label={t.phone} required hint={t.phoneHint} error={errText('phone')}>
                                    <input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={20} value={values.phone} onChange={on('phone')} className={inputCls(errors.phone)} {...aria('phone')} />
                                </Field>
                            </div>
                            <Field id="email" label={t.email} required error={errText('email')}>
                                <input id="email" name="email" type="email" autoComplete="email" maxLength={LIMITS.email} value={values.email} onChange={on('email')} className={inputCls(errors.email)} {...aria('email')} />
                            </Field>
                        </Fieldset>

                        <Fieldset id="sec-4" legend={t.s4}>
                            <Field id="content" label={t.content} required hint={t.contentHint} error={errText('content')}>
                                <textarea id="content" name="content" rows={8} maxLength={LIMITS.content.max} value={values.content} onChange={on('content')} className={inputCls(errors.content)} {...aria('content')} />
                                <p className="mt-1 text-right text-xs text-slate-500 font-mono">{values.content.length}/{LIMITS.content.max}</p>
                            </Field>
                        </Fieldset>

                        <Fieldset id="sec-5" legend={t.s5}>
                            <div className="space-y-3">
                                <p className="text-sm font-semibold text-slate-200">{t.evidenceQ}</p>
                                <p className="text-xs text-slate-400">{t.evidenceHint}</p>
                                <div className="grid sm:grid-cols-2 gap-2">
                                    {EVIDENCE.map((ev) => (
                                        <label key={ev.id} className="flex items-center gap-3 cursor-pointer rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2.5 text-sm text-slate-200 hover:border-gdbop-blue has-[:checked]:border-gdbop-blue has-[:checked]:bg-gdbop-blue/10 transition-colors">
                                            <input
                                                type="checkbox" name="evidence" value={ev.id}
                                                checked={values.evidence.includes(ev.id)}
                                                onChange={() => toggleEvidence(ev.id)}
                                                className="h-4 w-4 shrink-0 accent-[#47a8f6]"
                                            />
                                            <span>{ev[lang]}</span>
                                        </label>
                                    ))}
                                </div>
                                {errors.evidence && <p role="alert" className="text-xs text-red-400">{errText('evidence')}</p>}
                            </div>

                            {REPORT_CONFIG.filesEnabled && (
                                <div className="space-y-4 pt-2">
                                    <p className="text-sm font-semibold text-slate-200">{t.filesTitle}</p>
                                    {values.crimeType === 'children' && (
                                        <div className="space-y-3">
                                            <div className="flex gap-3 items-start p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-100 text-sm">
                                                <AlertTriangle className="shrink-0 mt-0.5" size={18} />
                                                <p>{t.childrenWarn}</p>
                                            </div>
                                            <Check id="childrenAck" checked={values.childrenAck} onChange={(v) => setField('childrenAck', v)} invalid={errors.childrenAck}>
                                                {t.childrenAck}
                                            </Check>
                                            {errors.childrenAck && <p role="alert" className="text-xs text-red-400">{errText('childrenAck')}</p>}
                                        </div>
                                    )}
                                    <p className="text-sm text-slate-300">{t.filesHint}</p>
                                    <div className="flex gap-3 items-start p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-100 text-xs">
                                        <Info className="shrink-0 mt-0.5" size={16} />
                                        <p>{t.filesWarn}</p>
                                    </div>
                                    <div>
                                        <input
                                            ref={fileInput} id="files" name="files" type="file" multiple
                                            accept={ACCEPT}
                                            className="sr-only"
                                            onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
                                            {...aria('files')}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => fileInput.current?.click()}
                                            disabled={files.length >= FILE_LIMITS.maxFiles}
                                            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-600 bg-slate-800/80 text-slate-200 hover:border-gdbop-blue hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                        >
                                            <Paperclip size={16} />
                                            {t.filesPick} ({files.length}/{FILE_LIMITS.maxFiles})
                                        </button>
                                        {errors.files && <p id="files-err" role="alert" className="mt-2 text-xs text-red-400">{errText('files')}</p>}
                                    </div>
                                    {files.length > 0 && (
                                        <ul className="space-y-2">
                                            {files.map(({ file: f, kind }, i) => (
                                                <li key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-center justify-between gap-3 rounded-lg bg-slate-800/60 border border-slate-700 px-3 py-2 text-sm">
                                                    <span className="truncate text-slate-200">{f.name}</span>
                                                    <span className="shrink-0 flex items-center gap-3">
                                                        <span className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-200">{FILE_TYPES[kind].label}</span>
                                                        <span className="text-xs text-slate-400 font-mono">{fmtSize(f.size)}</span>
                                                        <button type="button" onClick={() => removeFile(i)} aria-label={t.filesRemove} title={t.filesRemove} className="text-slate-400 hover:text-red-400 transition-colors">
                                                            <X size={16} />
                                                        </button>
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </Fieldset>

                        {banner && <ErrorBanner text={banner} />}

                        <button type="submit" className={`w-full md:w-auto ${primaryBtn}`}>
                            {t.toReview} <ChevronRight size={18} />
                        </button>
                    </form>
                )}

                {view === 'review' && (
                    <div className="space-y-5">
                        <p className="text-sm text-slate-300">{t.reviewIntro}</p>
                        {banner && <ErrorBanner text={banner} />}

                        <ReviewCard title={t.s1} section="sec-1">
                            <Row name={t.crimeType} field="crimeType">{crimeLabel(values.crimeType, lang)}</Row>
                            <Row name={t.channel} field="channel">{label(CHANNELS, values.channel)}</Row>
                            <Row name={t.incidentDate} field="incidentDate">{values.incidentDate}</Row>
                            <Row name={t.lossAmount} field="lossAmount">{values.lossAmount && `${values.lossAmount} ${label(CURRENCIES, values.lossCurrency)}`}</Row>
                            <Row name={t.suspect} field="suspect">{values.suspect}</Row>
                        </ReviewCard>

                        <ReviewCard title={t.s2} section="sec-2">
                            <Row name={t.reported} field="alreadyReported">{values.alreadyReported === 'yes' ? t.yes : values.alreadyReported === 'no' ? t.no : ''}</Row>
                            {values.alreadyReported === 'yes' && <Row name={t.reportedTo} field="reportedTo">{values.reportedTo}</Row>}
                        </ReviewCard>

                        <ReviewCard title={t.s3} section="sec-3">
                            <Row name={t.fullName} field="fullName">{values.fullName}</Row>
                            {lang === 'en'
                                ? <Row name={t.dob} field="dob">{values.dob}</Row>
                                : <Row name={t.egn} field="egn">{values.egn}</Row>}
                            <Row name={t.phone} field="phone">{values.phone}</Row>
                            <Row name={t.email} field="email">{values.email}</Row>
                        </ReviewCard>

                        <ReviewCard title={t.s4} section="sec-4">
                            <Row name={t.content} field="content">
                                {values.content && <span className="block whitespace-pre-wrap text-left max-h-48 overflow-y-auto">{values.content}</span>}
                            </Row>
                        </ReviewCard>

                        <ReviewCard title={t.s5} section="sec-5">
                            <Row name={t.evidenceQ} field="evidence">
                                {values.evidence.length > 0 && (
                                    <span className="block text-left sm:text-right">{EVIDENCE.filter((ev) => values.evidence.includes(ev.id)).map((ev) => ev[lang]).join('; ')}</span>
                                )}
                            </Row>
                            {REPORT_CONFIG.filesEnabled && (
                                <Row name={t.filesTitle} field="files">
                                    {files.length > 0 && (
                                        <span className="block text-left sm:text-right">
                                            {files.map(({ file: f, kind }) => `${f.name} (${FILE_TYPES[kind].label}, ${fmtSize(f.size)})`).join(', ')}
                                        </span>
                                    )}
                                </Row>
                            )}
                            {values.crimeType === 'children' && files.length > 0 && <Row name={t.childrenAck} field="childrenAck">{values.childrenAck ? '✓' : ''}</Row>}
                        </ReviewCard>

                        <div className="space-y-3 rounded-xl border border-slate-700/60 p-4 md:p-5">
                            <Check id="truthDeclaration" checked={values.truthDeclaration} onChange={(v) => setField('truthDeclaration', v)} invalid={errors.truthDeclaration}>
                                {t.truthDeclaration}<span className="text-police-red ml-1" aria-hidden="true">*</span>
                            </Check>
                            {errors.truthDeclaration && <p role="alert" className="text-xs text-red-400">{errText('truthDeclaration')}</p>}
                            <Check id="consent" checked={values.consent} onChange={(v) => setField('consent', v)} invalid={errors.consent}>
                                {t.consent}<span className="text-police-red ml-1" aria-hidden="true">*</span>
                            </Check>
                            {errors.consent && <p role="alert" className="text-xs text-red-400">{errText('consent')}</p>}
                        </div>

                        <div>
                            <div ref={widgetBox} aria-label={t.captcha} />
                            {errors.captcha && <p role="alert" className="mt-1 text-xs text-red-400">{errText('captcha')}</p>}
                        </div>

                        <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-between">
                            <button type="button" onClick={() => editSection('sec-1')} className={secondaryBtn}>
                                <ArrowLeft size={18} /> {t.back}
                            </button>
                            {progress && (
                                <div className="sm:flex-1 sm:mx-4 self-center w-full" role="status" aria-live="polite">
                                    <p className="text-xs text-slate-300 mb-1">{progress.finishing ? t.finishing : t.uploading(progress.i, progress.n)}</p>
                                    <div className="h-2 rounded bg-slate-700 overflow-hidden">
                                        <div className="h-2 bg-gdbop-blue transition-all" style={{ width: `${Math.round(((progress.i - 1 + progress.frac) / progress.n) * 100)}%` }} />
                                    </div>
                                </div>
                            )}
                            <button type="button" onClick={send} disabled={submitting} className={primaryBtn}>
                                {submitting ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                                {submitting ? t.sending : t.submit}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
};
