import React, { useState, useEffect, useRef } from 'react';
import { Send, Loader2, AlertTriangle, Check, Info, Paperclip, X, ChevronRight, ChevronDown, ChevronLeft, Plus, Phone, ShieldAlert, FileText, Image as ImageIcon, Mail, Copy } from 'lucide-react';
import { CRIME_TYPES, CRIME_GROUPS, crimeLabel, CHANNELS, CURRENCIES, EVIDENCE, LIMITS, IOC_KINDS, classifyIoc } from '../worker/src/schema.js';
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
    crimeType: '', channel: '', incidentDate: '', lossAmount: '', lossCurrency: 'EUR', suspect: '', suspects: [],
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
        steps: ['За какво е сигналът', 'Подаден ли е сигнал в МВР', 'Вашите данни', 'Какво се случи', 'Доказателства'],
        stepOf: (i, n) => `Стъпка ${i} от ${n}`,
        next: 'Напред', prev: 'Назад', call112: 'Обади се на 112',
        copy: 'Копирай', copied: 'Копирано',
        groupCase: 'Случаят', groupLoss: 'Вреди', groupSuspect: 'Извършител', groupContact: 'Контакт', groupDecl: 'Декларации',
        asidePhones: 'Телефони за сигнали',
        phones: [['112', 'tel:112', 'Единен европейски номер за спешни повиквания'], ['02 982 83 63', 'tel:+35929828363', 'ГДБОП — МВР'], ['116 000', 'tel:116000', 'Изчезнали деца'], ['116 111', 'tel:116111', 'Деца в риск']],
        asideAfter: 'След подаването',
        after: ['Получавате референтен номер – запазете го.', 'Сигналът се разпределя към компетентното звено на ГДБОП.', 'При нужда служител ще се свърже с вас на посочения телефон или имейл.'],
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
        filesWarn: 'Не качвайте документи за самоличност, банкови карти или данни, които не са нужни за сигнала.',
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
        suspect: 'Данни за извършителя', suspectHint: `Сайт, имейл, телефон, профил, IBAN или крипто портфейл – по един наведнъж. Натиснете Enter или „Добави“ и въведете следващия (до ${LIMITS.suspects}, по желание).`,
        suspectAdd: 'Добави', suspectRemove: 'Премахни', suspectPh: 'напр. invest-profit.com, +359 888 123 456, BG80 BNBG…',
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
            suspect: { too_many: `Най-много ${LIMITS.suspects} записа.`, too_long: `Всеки запис – до ${LIMITS.suspect} знака.` },
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
        steps: ['What the report is about', 'Already reported?', 'Your details', 'What happened', 'Evidence'],
        stepOf: (i, n) => `Step ${i} of ${n}`,
        next: 'Continue', prev: 'Back', call112: 'Call 112',
        copy: 'Copy', copied: 'Copied',
        groupCase: 'The case', groupLoss: 'Loss', groupSuspect: 'Offender', groupContact: 'Contact', groupDecl: 'Declarations',
        asidePhones: 'Phone lines',
        phones: [['112', 'tel:112', 'Single European emergency number'], ['02 982 83 63', 'tel:+35929828363', 'GDCOC — MoI'], ['116 000', 'tel:116000', 'Missing children'], ['116 111', 'tel:116111', 'Children at risk']],
        asideAfter: 'After you submit',
        after: ['You get a reference number – keep it.', 'The report is assigned to the competent GDCOC unit.', 'If needed, an officer will contact you by the phone or email you gave.'],
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
        filesWarn: 'Do not upload ID documents, bank cards or data that is not needed for the report.',
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
        suspect: 'Details of the offender', suspectHint: `Website, email, phone, profile, IBAN or crypto wallet – one at a time. Press Enter or “Add” and type the next one (up to ${LIMITS.suspects}, optional).`,
        suspectAdd: 'Add', suspectRemove: 'Remove', suspectPh: 'e.g. invest-profit.com, +359 888 123 456, BG80 BNBG…',
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
            suspect: { too_many: `At most ${LIMITS.suspects} entries.`, too_long: `Each entry – at most ${LIMITS.suspect} characters.` },
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

// --- UI bits (iOS-style grouped lists, gdbop navy + gold) ------------------

const SECTIONS = ['sec-1', 'sec-2', 'sec-3', 'sec-4', 'sec-5'];

// Which form section each field lives in (for steps, "Edit" and error routing).
const SECTION_OF = {
    crimeType: 'sec-1', channel: 'sec-1', incidentDate: 'sec-1', lossAmount: 'sec-1', lossCurrency: 'sec-1', suspect: 'sec-1',
    alreadyReported: 'sec-2', reportedTo: 'sec-2',
    fullName: 'sec-3', egn: 'sec-3', dob: 'sec-3', phone: 'sec-3', email: 'sec-3',
    content: 'sec-4',
    evidence: 'sec-5', files: 'sec-5', childrenAck: 'sec-5',
};

const cx = (...a) => a.filter(Boolean).join(' ');

// A grouped list: small header above, rounded block of rows, footnote below.
const Group = ({ header, footer, children, tone }) => (
    <div>
        {header && <p className="px-4 pb-1.5 text-[13px] text-ios-label">{header}</p>}
        <div className={cx('rounded-[14px] overflow-hidden divide-y divide-white/[0.07]', tone === 'warn' ? 'bg-gdbop-blue/[0.08] ring-1 ring-inset ring-gdbop-blue/25' : 'bg-ios-cell')}>
            {children}
        </div>
        {footer && <div className="px-4 pt-1.5 text-[13px] leading-snug text-ios-label">{footer}</div>}
    </div>
);

const cellBase = 'block px-4 py-2.5 transition-colors focus-within:bg-white/[0.035] focus-within:shadow-[inset_3px_0_0_0_#ffc83d]';
const ctrl = 'block w-full bg-transparent text-[16px] leading-6 text-ios-text placeholder:text-ios-label/60 outline-none disabled:opacity-50';

// One labelled row: label on top, the control below (iOS "stacked" cell).
const Cell = ({ id, label, required, error, hint, children, accessory }) => (
    <div className={cellBase}>
        <label htmlFor={id} className={cx('block text-[13px] leading-snug', error ? 'text-ios-red' : 'text-ios-label')}>
            {label}
            {required && <span aria-hidden="true" className="text-gdbop-blue"> *</span>}
        </label>
        <div className="flex items-center gap-2 pt-0.5">
            <div className="flex-1 min-w-0">{children}</div>
            {accessory}
        </div>
        {error ? (
            <p id={`${id}-err`} role="alert" className="pt-1 text-[13px] text-ios-red">{error}</p>
        ) : hint ? (
            <p id={`${id}-hint`} className="pt-1 text-[12.5px] leading-snug text-ios-label">{hint}</p>
        ) : null}
    </div>
);

const SelectCtrl = ({ children, ...props }) => (
    <div className="relative">
        <select {...props} className={cx(ctrl, 'appearance-none pr-7 cursor-pointer [&>option]:bg-ios-sheet [&>optgroup]:bg-ios-sheet')}>{children}</select>
        <ChevronDown size={18} className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-ios-label" aria-hidden="true" />
    </div>
);

// iOS switch. A real <button role="switch"> so it is keyboard and screen-reader friendly.
const Switch = ({ id, checked, onChange, invalid, children }) => (
    <div className={cx(cellBase, 'flex items-start gap-4')}>
        <label htmlFor={id} className={cx('flex-1 text-[15px] leading-snug cursor-pointer', invalid ? 'text-ios-red' : 'text-ios-text')}>{children}</label>
        <button
            id={id} type="button" role="switch" aria-checked={checked} aria-invalid={invalid ? 'true' : undefined}
            onClick={() => onChange(!checked)}
            className={cx('relative mt-0.5 shrink-0 w-[51px] h-[31px] rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-gdbop-blue focus-visible:ring-offset-2 focus-visible:ring-offset-ios-cell', checked ? 'bg-gdbop-blue' : invalid ? 'bg-ios-red/40' : 'bg-white/20')}
        >
            <span className={cx('absolute top-[2px] left-[2px] w-[27px] h-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,.25)] transition-transform duration-200', checked && 'translate-x-[20px]')} />
        </button>
    </div>
);

// iOS segmented control.
const Segmented = ({ name, value, onChange, options, invalid, labelledBy }) => (
    <div role="radiogroup" aria-labelledby={labelledBy} className={cx('grid gap-0.5 p-0.5 rounded-[10px] bg-black/25', invalid && 'ring-1 ring-ios-red')} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}>
        {options.map(([val, text]) => (
            <label key={val} className={cx('relative text-center rounded-[8px] px-3 py-2 text-[14px] font-medium cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gdbop-blue', value === val ? 'bg-ios-cell2 text-ios-text shadow-[0_2px_6px_rgba(0,0,0,.3)]' : 'text-ios-label hover:text-ios-text')}>
                <input type="radio" name={name} value={val} checked={value === val} onChange={() => onChange(val)} aria-invalid={invalid ? 'true' : undefined} className="sr-only" />
                {text}
            </label>
        ))}
    </div>
);

const ErrorBanner = ({ text }) => (
    <div role="alert" className="flex gap-3 items-start rounded-[12px] bg-ios-red/12 ring-1 ring-inset ring-ios-red/30 px-4 py-3 text-[14px] text-red-100">
        <AlertTriangle className="shrink-0 mt-0.5 text-ios-red" size={18} />
        <p>{text}</p>
    </div>
);

const primaryBtn = 'inline-flex items-center justify-center gap-2 min-h-[50px] px-7 rounded-[14px] bg-gdbop-blue text-[#0b2350] text-[16px] font-semibold tracking-[-0.01em] hover:bg-gdbop-gold-light active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-ios-sheet';
const plainBtn = 'inline-flex items-center justify-center gap-1 min-h-[50px] px-4 rounded-[14px] text-gdbop-blue text-[16px] font-medium hover:bg-white/[0.05] transition outline-none focus-visible:ring-2 focus-visible:ring-gdbop-blue';
const tintBtn = 'inline-flex items-center justify-center gap-2 min-h-[50px] px-6 rounded-[14px] bg-ios-cell text-gdbop-blue text-[16px] font-semibold hover:bg-ios-cell2 transition outline-none focus-visible:ring-2 focus-visible:ring-gdbop-blue';

const FILE_ICON = { image: ImageIcon, pdf: FileText, mail: Mail };

// --- Section ---------------------------------------------------------------

export const ReportSection = ({ lang }) => {
    const t = L[lang];
    // gate (not-an-emergency) -> form (5 steps) -> review -> success
    const [view, setView] = useState('gate');
    const [step, setStep] = useState(0);
    const [values, setValues] = useState(EMPTY);
    const [errors, setErrors] = useState({});
    const [submitting, setSubmitting] = useState(false);
    const [banner, setBanner] = useState('');
    const [refId, setRefId] = useState('');
    const [copied, setCopied] = useState(false);
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
    const addSuspect = () => {
        const one = values.suspect.trim().replace(/\s+/g, ' ');
        if (!one) return;
        if (values.suspects.length >= LIMITS.suspects) { setErrors((e) => ({ ...e, suspect: 'too_many' })); return; }
        if (one.length > LIMITS.suspect) { setErrors((e) => ({ ...e, suspect: 'too_long' })); return; }
        setValues((v) => ({ ...v, suspect: '', suspects: v.suspects.includes(one) ? v.suspects : [...v.suspects, one] }));
        setErrors((e) => { const { suspect: _d, ...rest } = e; return rest; });
    };
    const removeSuspect = (i) => setValues((v) => ({ ...v, suspects: v.suspects.filter((_, j) => j !== i) }));
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
        // a typed but not yet added entry counts too
        suspects: [...values.suspects, values.suspect.trim()].filter(Boolean),
        suspect: undefined,
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

    // Step navigation: only the current step's fields block "Continue".
    const nextStep = (e) => {
        e?.preventDefault();
        setBanner('');
        const all = formErrors();
        const here = Object.fromEntries(Object.entries(all).filter(([k]) => SECTION_OF[k] === SECTIONS[step]));
        if (Object.keys(here).length) {
            setErrors(here);
            focusFirstError();
            return;
        }
        setErrors({});
        if (step < SECTIONS.length - 1) {
            setStep(step + 1);
        } else if (Object.keys(all).length) {
            // something in an earlier step went wrong after all: go there
            const first = SECTIONS.findIndex((sec) => Object.keys(all).some((k) => SECTION_OF[k] === sec));
            setErrors(all);
            setStep(first);
            setBanner(t.fixErrors);
        } else {
            setView('review');
        }
        scrollTop();
    };
    const prevStep = () => {
        setBanner('');
        setErrors({});
        if (step === 0) setView('gate');
        else setStep(step - 1);
        scrollTop();
    };

    const editSection = (sectionId) => {
        setBanner('');
        setStep(Math.max(0, SECTIONS.indexOf(sectionId)));
        setView('form');
        scrollTop();
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
            setStep(0);
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

    const copyRef = async () => {
        try { await navigator.clipboard.writeText(refId); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
    };

    // --- review helpers ---
    const label = (list, id) => list.find((x) => x.id === id)?.[lang] ?? '';
    const Row = ({ name, field, children, stacked }) => (
        <div className={cx('px-4 py-3', stacked ? 'space-y-1' : 'flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6')}>
            <dt className={cx('text-[15px] text-ios-label', !stacked && 'sm:max-w-[48%]')}>{name}</dt>
            <dd className={cx('text-[15px] break-words min-w-0 text-ios-text', !stacked && 'sm:text-right')}>
                {errors[field]
                    ? <span className="inline-flex items-center gap-1.5 text-ios-red text-[14px]"><AlertTriangle size={14} /> {msg(field, errors[field])}</span>
                    : children || <span className="text-ios-label/60">{t.none}</span>}
            </dd>
        </div>
    );
    const ReviewGroup = ({ index, children }) => {
        const bad = Object.keys(errors).some((k) => SECTION_OF[k] === SECTIONS[index]);
        return (
            <div>
                <div className="flex items-end justify-between px-4 pb-1.5">
                    <p className={cx('text-[13px]', bad ? 'text-ios-red' : 'text-ios-label')}>{t.steps[index]}</p>
                    <button type="button" onClick={() => editSection(SECTIONS[index])} className="text-[15px] text-gdbop-blue hover:underline outline-none focus-visible:underline">{t.edit}</button>
                </div>
                <dl className={cx('rounded-[14px] bg-ios-cell divide-y divide-white/[0.07]', bad && 'ring-1 ring-inset ring-ios-red/50')}>{children}</dl>
            </div>
        );
    };

    const inForm = view === 'form';
    const n = SECTIONS.length;

    return (
        <section id="report" className="max-w-[1280px] mx-auto w-full px-4 md:px-6 py-10 md:py-14 relative font-ios">
            <div className="grid lg:grid-cols-[minmax(0,720px)_300px] lg:justify-between gap-8 lg:gap-12 items-start">
                <div ref={panelRef} className="rounded-[22px] bg-ios-sheet ring-1 ring-white/[0.06] shadow-[0_40px_90px_-30px_rgba(0,0,0,.65)] px-4 py-6 sm:px-8 sm:py-8 scroll-mt-28">

                    {view === 'gate' && (
                        <div className="space-y-6">
                            <div className="w-14 h-14 rounded-[16px] bg-ios-cell2 grid place-items-center">
                                <ShieldAlert className="text-gdbop-blue" size={28} />
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-[26px] leading-8 font-bold tracking-[-0.02em] text-ios-text">{t.gateTitle}</h2>
                                <p className="text-[16px] leading-relaxed text-ios-label max-w-[56ch]">{t.gateText}</p>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-3">
                                <button type="button" onClick={() => { setStep(0); setView('form'); scrollTop(); }} className={primaryBtn}>
                                    {t.gateConfirm} <ChevronRight size={18} />
                                </button>
                                <a href="tel:112" className={tintBtn}><Phone size={17} /> {t.call112}</a>
                            </div>
                        </div>
                    )}

                    {view === 'success' && (
                        <div className="text-center py-6 space-y-5" role="status">
                            <div className="mx-auto w-20 h-20 rounded-full bg-gdbop-blue grid place-items-center motion-safe:animate-[pop_.45s_cubic-bezier(.2,1.4,.4,1)_both]">
                                <Check className="text-[#0b2350]" size={40} strokeWidth={3} />
                            </div>
                            <div className="space-y-1.5">
                                <h2 className="text-[26px] font-bold tracking-[-0.02em] text-ios-text">{t.okTitle}</h2>
                                <p className="text-ios-label">{t.okKeep}</p>
                            </div>
                            <div className="mx-auto max-w-sm rounded-[14px] bg-ios-cell px-4 py-3 flex items-center justify-between gap-3 text-left">
                                <div className="min-w-0">
                                    <p className="text-[13px] text-ios-label">{t.okRef}</p>
                                    <p className="text-[17px] font-semibold tabular-nums tracking-wide text-ios-text break-all">{refId}</p>
                                </div>
                                <button type="button" onClick={copyRef} className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-ios-cell2 px-3 py-1.5 text-[14px] font-medium text-gdbop-blue hover:brightness-110">
                                    {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t.copied : t.copy}
                                </button>
                            </div>
                            {failedUploads > 0 && <p className="mx-auto max-w-md text-[14px] text-gdbop-gold-light">{t.okFilesFailed(failedUploads)}</p>}
                            <button type="button" onClick={() => { setView('gate'); setBanner(''); }} className={plainBtn}>{t.again}</button>
                        </div>
                    )}

                    {inForm && (
                        <form onSubmit={nextStep} method="post" noValidate autoComplete="off" className="space-y-7">
                            <div className="space-y-3">
                                <div className="flex items-center justify-between text-[13px] text-ios-label">
                                    <span>{t.stepOf(step + 1, n)}</span>
                                    <span className="hidden sm:inline">{t.required}</span>
                                </div>
                                <div className="grid grid-cols-5 gap-1.5" aria-hidden="true">
                                    {SECTIONS.map((sec, i) => (
                                        <span key={sec} className={cx('h-1 rounded-full transition-colors duration-300', i <= step ? 'bg-gdbop-blue' : 'bg-white/[0.12]')} />
                                    ))}
                                </div>
                                <h2 className="pt-2 text-[28px] leading-[34px] font-bold tracking-[-0.022em] text-ios-text">{t.steps[step]}</h2>
                            </div>

                            {/* Honeypot: invisible to people, tempting to bots. */}
                            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
                                <label>Fax<input type="text" name="fax" tabIndex={-1} autoComplete="off" value={values.fax} onChange={on('fax')} /></label>
                            </div>

                            {banner && <ErrorBanner text={banner} />}

                            {step === 0 && (
                                <>
                                    <div className="flex gap-3 rounded-[14px] bg-ios-cell px-4 py-3.5 text-[14px] leading-snug">
                                        <Info className="shrink-0 mt-0.5 text-gdbop-blue" size={18} />
                                        <div className="space-y-1">
                                            <p className="font-semibold text-ios-text">{t.notice[0]}</p>
                                            <p className="text-ios-label">{t.notice[1]} {t.notice[2]}</p>
                                        </div>
                                    </div>

                                    <Group header={t.groupCase}>
                                        <Cell id="crimeType" label={t.crimeType} required error={errText('crimeType')}>
                                            <SelectCtrl id="crimeType" name="crimeType" value={values.crimeType} onChange={on('crimeType')} {...aria('crimeType')}>
                                                <option value="">{t.crimeTypePh}</option>
                                                {CRIME_GROUPS.map((g) => (
                                                    <optgroup key={g.id} label={g[lang]}>
                                                        {CRIME_TYPES.filter((c) => c.group === g.id).map((c) => <option key={c.id} value={c.id}>{c[lang]}</option>)}
                                                    </optgroup>
                                                ))}
                                            </SelectCtrl>
                                        </Cell>
                                        {values.crimeType === 'children' && (
                                            <div className="flex gap-3 px-4 py-3 text-[14px] text-gdbop-gold-light bg-gdbop-blue/[0.06]">
                                                <AlertTriangle className="shrink-0 mt-0.5" size={17} />
                                                <p>{t.childrenHint}</p>
                                            </div>
                                        )}
                                        <Cell id="channel" label={t.channel} error={errText('channel')}>
                                            <SelectCtrl id="channel" name="channel" value={values.channel} onChange={on('channel')} {...aria('channel')}>
                                                <option value="">{t.channelPh}</option>
                                                {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c[lang]}</option>)}
                                            </SelectCtrl>
                                        </Cell>
                                        <Cell id="incidentDate" label={t.incidentDate} error={errText('incidentDate')}>
                                            <input id="incidentDate" name="incidentDate" type="date" min="2000-01-01" max={today} value={values.incidentDate} onChange={on('incidentDate')} className={cx(ctrl, '[color-scheme:dark]')} {...aria('incidentDate')} />
                                        </Cell>
                                    </Group>

                                    <Group header={t.groupLoss}>
                                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9.5rem)] divide-x divide-white/[0.07]">
                                            <Cell id="lossAmount" label={t.lossAmount} error={errText('lossAmount')}>
                                                <input id="lossAmount" name="lossAmount" type="text" inputMode="decimal" maxLength={15} placeholder="0.00" value={values.lossAmount} onChange={on('lossAmount')} className={cx(ctrl, 'tabular-nums')} {...aria('lossAmount')} />
                                            </Cell>
                                            <Cell id="lossCurrency" label={t.lossCurrency} error={errText('lossCurrency')}>
                                                <SelectCtrl id="lossCurrency" name="lossCurrency" value={values.lossCurrency} onChange={on('lossCurrency')} {...aria('lossCurrency')}>
                                                    <option value="">{t.lossCurrencyPh}</option>
                                                    {CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c.id === 'CRYPTO' || c.id === 'OTHER' ? c[lang] : c.id}</option>)}
                                                </SelectCtrl>
                                            </Cell>
                                        </div>
                                    </Group>

                                    <Group header={t.groupSuspect} footer={!errors.suspect && t.suspectHint}>
                                        <Cell
                                            id="suspect" label={t.suspect} error={errText('suspect')}
                                            accessory={(
                                                <button
                                                    type="button" onClick={addSuspect} aria-label={t.suspectAdd} title={t.suspectAdd}
                                                    disabled={!values.suspect.trim() || values.suspects.length >= LIMITS.suspects}
                                                    className="shrink-0 w-8 h-8 rounded-full bg-gdbop-blue text-[#0b2350] grid place-items-center transition disabled:bg-white/10 disabled:text-ios-label outline-none focus-visible:ring-2 focus-visible:ring-white"
                                                >
                                                    <Plus size={18} strokeWidth={2.6} />
                                                </button>
                                            )}
                                        >
                                            <input
                                                id="suspect" name="suspect" type="text" maxLength={LIMITS.suspect} placeholder={t.suspectPh} enterKeyHint="done"
                                                value={values.suspect} onChange={on('suspect')}
                                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSuspect(); } }}
                                                disabled={values.suspects.length >= LIMITS.suspects}
                                                className={ctrl} {...aria('suspect')}
                                            />
                                        </Cell>
                                        {values.suspects.length > 0 && (
                                            <ul className="flex flex-wrap gap-2 px-4 py-3" aria-label={t.suspect}>
                                                {values.suspects.map((x, i) => (
                                                    <li key={x} className="inline-flex items-center max-w-full rounded-full bg-white/[0.08] pl-3 pr-1 py-1 text-[14px]">
                                                        <span className="shrink-0 pr-2 text-[12px] font-semibold text-gdbop-blue">{IOC_KINDS[classifyIoc(x)][lang]}</span>
                                                        <span className="truncate text-ios-text">{x}</span>
                                                        <button type="button" onClick={() => removeSuspect(i)} aria-label={`${t.suspectRemove}: ${x}`} className="ml-1 shrink-0 w-6 h-6 rounded-full grid place-items-center text-ios-label hover:bg-white/10 hover:text-ios-text">
                                                            <X size={14} />
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </Group>
                                </>
                            )}

                            {step === 1 && (
                                <>
                                    <Group footer={errors.alreadyReported ? <span role="alert" className="text-ios-red">{errText('alreadyReported')}</span> : null}>
                                        <div className="px-4 py-3.5 space-y-3">
                                            <p id="reported-label" className="text-[15px] leading-snug text-ios-text">{t.reported}<span aria-hidden="true" className="text-gdbop-blue"> *</span></p>
                                            <Segmented name="alreadyReported" value={values.alreadyReported} onChange={(v) => setField('alreadyReported', v)} options={[['yes', t.yes], ['no', t.no]]} invalid={errors.alreadyReported} labelledBy="reported-label" />
                                        </div>
                                    </Group>
                                    {values.alreadyReported === 'yes' && (
                                        <Group>
                                            <Cell id="reportedTo" label={t.reportedTo} required hint={t.reportedToHint} error={errText('reportedTo')}>
                                                <input id="reportedTo" name="reportedTo" type="text" maxLength={LIMITS.reportedTo.max} value={values.reportedTo} onChange={on('reportedTo')} className={ctrl} {...aria('reportedTo')} />
                                            </Cell>
                                        </Group>
                                    )}
                                </>
                            )}

                            {step === 2 && (
                                <>
                                    <Group header={t.s3.replace(/^\d+\.\s*/, '')}>
                                        <Cell id="fullName" label={t.fullName} required hint={t.fullNameHint} error={errText('fullName')}>
                                            <input id="fullName" name="fullName" type="text" autoComplete="name" maxLength={LIMITS.nameTotal} value={values.fullName} onChange={on('fullName')} className={ctrl} {...aria('fullName')} />
                                        </Cell>
                                        {lang === 'en' ? (
                                            <Cell id="dob" label={t.dob} required hint={t.dobHint} error={errText('dob')}>
                                                <input id="dob" name="dob" type="date" min="1900-01-01" max={today} autoComplete="bday" value={values.dob} onChange={on('dob')} className={cx(ctrl, '[color-scheme:dark]')} {...aria('dob')} />
                                            </Cell>
                                        ) : (
                                            <Cell id="egn" label={t.egn} required hint={t.egnHint} error={errText('egn')}>
                                                <input id="egn" name="egn" type="text" inputMode="numeric" autoComplete="off" maxLength={10} value={values.egn} onChange={(e) => setField('egn', e.target.value.replace(/\D/g, '').slice(0, 10))} className={cx(ctrl, 'tabular-nums tracking-[0.12em]')} {...aria('egn')} />
                                            </Cell>
                                        )}
                                    </Group>
                                    <Group header={t.groupContact}>
                                        <Cell id="phone" label={t.phone} required hint={t.phoneHint} error={errText('phone')}>
                                            <input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={20} value={values.phone} onChange={on('phone')} className={cx(ctrl, 'tabular-nums')} {...aria('phone')} />
                                        </Cell>
                                        <Cell id="email" label={t.email} required error={errText('email')}>
                                            <input id="email" name="email" type="email" autoComplete="email" maxLength={LIMITS.email} value={values.email} onChange={on('email')} className={ctrl} {...aria('email')} />
                                        </Cell>
                                    </Group>
                                </>
                            )}

                            {step === 3 && (
                                <Group footer={<span className="flex justify-between gap-4"><span>{!errors.content && t.contentHint}</span><span className="tabular-nums shrink-0">{values.content.length}/{LIMITS.content.max}</span></span>}>
                                    <Cell id="content" label={t.content} required error={errText('content')}>
                                        <textarea id="content" name="content" rows={10} maxLength={LIMITS.content.max} value={values.content} onChange={on('content')} className={cx(ctrl, 'resize-y min-h-[200px] py-1')} {...aria('content')} />
                                    </Cell>
                                </Group>
                            )}

                            {step === 4 && (
                                <>
                                    <Group header={t.evidenceQ} footer={t.evidenceHint}>
                                        {EVIDENCE.map((ev) => {
                                            const on2 = values.evidence.includes(ev.id);
                                            return (
                                                <label key={ev.id} className={cx(cellBase, 'flex items-center justify-between gap-4 cursor-pointer py-3 has-[:focus-visible]:bg-white/[0.04]')}>
                                                    <span className="text-[15px] text-ios-text">{ev[lang]}</span>
                                                    <input type="checkbox" name="evidence" value={ev.id} checked={on2} onChange={() => toggleEvidence(ev.id)} className="sr-only" />
                                                    <Check size={20} strokeWidth={2.6} className={cx('shrink-0 text-gdbop-blue transition-opacity', on2 ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                                                </label>
                                            );
                                        })}
                                    </Group>

                                    {REPORT_CONFIG.filesEnabled && (
                                        <>
                                            {values.crimeType === 'children' && (
                                                <Group tone="warn">
                                                    <div className="flex gap-3 px-4 py-3 text-[14px] leading-snug text-gdbop-gold-light">
                                                        <AlertTriangle className="shrink-0 mt-0.5" size={17} />
                                                        <p>{t.childrenWarn}</p>
                                                    </div>
                                                    <Switch id="childrenAck" checked={values.childrenAck} onChange={(v) => setField('childrenAck', v)} invalid={errors.childrenAck}>{t.childrenAck}</Switch>
                                                </Group>
                                            )}
                                            <Group
                                                header={t.filesTitle}
                                                footer={errors.files
                                                    ? <span id="files-err" role="alert" className="text-ios-red">{errText('files')}</span>
                                                    : <>{t.filesHint} {t.filesWarn}</>}
                                            >
                                                {files.map(({ file: f, kind }, i) => {
                                                    const Icon = FILE_ICON[FILE_TYPES[kind].group] || FileText;
                                                    return (
                                                        <div key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-center gap-3 px-4 py-2.5">
                                                            <span className="shrink-0 w-9 h-9 rounded-[9px] bg-ios-cell2 grid place-items-center"><Icon size={18} className="text-gdbop-blue" /></span>
                                                            <span className="min-w-0 flex-1">
                                                                <span className="block truncate text-[15px] text-ios-text">{f.name}</span>
                                                                <span className="block text-[13px] text-ios-label">{FILE_TYPES[kind].label}, {fmtSize(f.size)}</span>
                                                            </span>
                                                            <button type="button" onClick={() => removeFile(i)} aria-label={`${t.filesRemove}: ${f.name}`} title={t.filesRemove} className="shrink-0 w-8 h-8 rounded-full grid place-items-center text-ios-label hover:bg-white/10 hover:text-ios-red">
                                                                <X size={17} />
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                                <div className="px-4 py-1">
                                                    <input
                                                        ref={fileInput} id="files" name="files" type="file" multiple accept={ACCEPT} className="sr-only"
                                                        onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
                                                        {...aria('files')}
                                                    />
                                                    <button
                                                        type="button" onClick={() => fileInput.current?.click()} disabled={files.length >= FILE_LIMITS.maxFiles}
                                                        className="w-full flex items-center justify-between gap-3 py-2.5 text-[16px] text-gdbop-blue disabled:text-ios-label disabled:cursor-not-allowed outline-none focus-visible:underline"
                                                    >
                                                        <span className="inline-flex items-center gap-2.5"><Paperclip size={18} /> {t.filesPick}</span>
                                                        <span className="text-[14px] text-ios-label tabular-nums">{files.length}/{FILE_LIMITS.maxFiles}</span>
                                                    </button>
                                                </div>
                                            </Group>
                                        </>
                                    )}
                                </>
                            )}

                            <div className="flex items-center justify-between gap-3 pt-1">
                                <button type="button" onClick={prevStep} className={plainBtn}>
                                    <ChevronLeft size={20} /> {t.prev}
                                </button>
                                <button type="submit" className={primaryBtn}>
                                    {step === n - 1 ? t.toReview : t.next} <ChevronRight size={18} />
                                </button>
                            </div>
                        </form>
                    )}

                    {view === 'review' && (
                        <div className="space-y-7">
                            <div className="space-y-2">
                                <h2 className="text-[28px] leading-[34px] font-bold tracking-[-0.022em] text-ios-text">{t.reviewTitle}</h2>
                                <p className="text-[15px] text-ios-label">{t.reviewIntro}</p>
                            </div>
                            {banner && <ErrorBanner text={banner} />}

                            <ReviewGroup index={0}>
                                <Row name={t.crimeType} field="crimeType">{crimeLabel(values.crimeType, lang)}</Row>
                                <Row name={t.channel} field="channel">{label(CHANNELS, values.channel)}</Row>
                                <Row name={t.incidentDate} field="incidentDate">{values.incidentDate}</Row>
                                <Row name={t.lossAmount} field="lossAmount">{values.lossAmount && `${values.lossAmount} ${values.lossCurrency}`}</Row>
                                <Row name={t.suspect} field="suspect" stacked={payload().suspects.length > 0}>
                                    {payload().suspects.length > 0 && (
                                        <span className="flex flex-wrap gap-1.5 pt-0.5">
                                            {payload().suspects.map((x) => (
                                                <span key={x} className="inline-flex max-w-full rounded-full bg-white/[0.08] px-2.5 py-0.5 text-[13px]"><span className="text-gdbop-blue pr-1.5">{IOC_KINDS[classifyIoc(x)][lang]}</span><span className="truncate">{x}</span></span>
                                            ))}
                                        </span>
                                    )}
                                </Row>
                            </ReviewGroup>

                            <ReviewGroup index={1}>
                                <Row name={t.reported} field="alreadyReported" stacked>{values.alreadyReported === 'yes' ? t.yes : values.alreadyReported === 'no' ? t.no : ''}</Row>
                                {values.alreadyReported === 'yes' && <Row name={t.reportedTo} field="reportedTo">{values.reportedTo}</Row>}
                            </ReviewGroup>

                            <ReviewGroup index={2}>
                                <Row name={t.fullName} field="fullName">{values.fullName}</Row>
                                {lang === 'en'
                                    ? <Row name={t.dob} field="dob">{values.dob}</Row>
                                    : <Row name={t.egn} field="egn"><span className="tabular-nums">{values.egn}</span></Row>}
                                <Row name={t.phone} field="phone">{values.phone}</Row>
                                <Row name={t.email} field="email">{values.email}</Row>
                            </ReviewGroup>

                            <ReviewGroup index={3}>
                                <Row name={t.content} field="content" stacked>
                                    {values.content && <span className="block whitespace-pre-wrap max-h-56 overflow-y-auto text-[15px] leading-relaxed">{values.content}</span>}
                                </Row>
                            </ReviewGroup>

                            <ReviewGroup index={4}>
                                <Row name={t.evidenceQ} field="evidence" stacked={values.evidence.length > 0}>
                                    {values.evidence.length > 0 && EVIDENCE.filter((ev) => values.evidence.includes(ev.id)).map((ev) => ev[lang]).join(', ')}
                                </Row>
                                {REPORT_CONFIG.filesEnabled && (
                                    <Row name={t.filesTitle} field="files" stacked={files.length > 0}>
                                        {files.length > 0 && (
                                            <span className="block space-y-0.5">
                                                {files.map(({ file: f, kind }) => (
                                                    <span key={`${f.name}-${f.size}`} className="flex justify-between gap-3 text-[14px]"><span className="truncate">{f.name}</span><span className="shrink-0 text-ios-label">{FILE_TYPES[kind].label}, {fmtSize(f.size)}</span></span>
                                                ))}
                                            </span>
                                        )}
                                    </Row>
                                )}
                                {values.crimeType === 'children' && files.length > 0 && <Row name={t.childrenAck} field="childrenAck" stacked>{values.childrenAck ? '✓' : ''}</Row>}
                            </ReviewGroup>

                            <Group header={t.groupDecl}>
                                <Switch id="truthDeclaration" checked={values.truthDeclaration} onChange={(v) => setField('truthDeclaration', v)} invalid={errors.truthDeclaration}>
                                    {t.truthDeclaration}<span aria-hidden="true" className="text-gdbop-blue"> *</span>
                                </Switch>
                                <Switch id="consent" checked={values.consent} onChange={(v) => setField('consent', v)} invalid={errors.consent}>
                                    {t.consent}<span aria-hidden="true" className="text-gdbop-blue"> *</span>
                                </Switch>
                            </Group>
                            {(errors.truthDeclaration || errors.consent) && (
                                <p role="alert" className="-mt-5 px-4 text-[13px] text-ios-red">{errText('truthDeclaration') || errText('consent')}</p>
                            )}

                            <div>
                                <div ref={widgetBox} aria-label={t.captcha} className="min-h-[65px]" />
                                {errors.captcha && <p role="alert" className="pt-1 px-1 text-[13px] text-ios-red">{errText('captcha')}</p>}
                            </div>

                            {progress ? (
                                <div className="rounded-[14px] bg-ios-cell px-4 py-3.5 space-y-2" role="status" aria-live="polite">
                                    <div className="flex justify-between text-[14px]">
                                        <span className="text-ios-text">{progress.finishing ? t.finishing : t.uploading(progress.i, progress.n)}</span>
                                        <span className="text-ios-label tabular-nums">{Math.round(((progress.i - 1 + progress.frac) / progress.n) * 100)}%</span>
                                    </div>
                                    <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                                        <div className="h-full rounded-full bg-gdbop-blue transition-[width] duration-200" style={{ width: `${Math.round(((progress.i - 1 + progress.frac) / progress.n) * 100)}%` }} />
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3">
                                    <button type="button" onClick={() => editSection('sec-5')} className={plainBtn}>
                                        <ChevronLeft size={20} /> {t.back}
                                    </button>
                                    <button type="button" onClick={send} disabled={submitting} className={primaryBtn}>
                                        {submitting ? <Loader2 className="animate-spin" size={18} /> : <Send size={17} />}
                                        {submitting ? t.sending : t.submit}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <aside className="space-y-6 lg:sticky lg:top-28">
                    <Group header={t.asidePhones}>
                        {t.phones.map(([num, href, lbl]) => (
                            <a key={num} href={href} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors">
                                <span className="shrink-0 w-8 h-8 rounded-full bg-ios-cell2 grid place-items-center"><Phone size={15} className="text-gdbop-blue" /></span>
                                <span className="min-w-0">
                                    <span className="block text-[17px] font-semibold tabular-nums text-ios-text">{num}</span>
                                    <span className="block text-[13px] text-ios-label">{lbl}</span>
                                </span>
                            </a>
                        ))}
                    </Group>
                    <Group header={t.asideAfter}>
                        {t.after.map((x, i) => (
                            <div key={i} className="flex gap-3 px-4 py-3 text-[14px] leading-snug text-ios-text">
                                <span className="shrink-0 w-6 h-6 rounded-full bg-white/[0.08] grid place-items-center text-[12px] font-semibold text-ios-label tabular-nums">{i + 1}</span>
                                <span>{x}</span>
                            </div>
                        ))}
                    </Group>
                </aside>
            </div>
        </section>
    );
};
