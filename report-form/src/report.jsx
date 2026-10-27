import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft } from 'lucide-react';
import { ReportSection } from './report-form.jsx';
import { REPORT_ENABLED } from './report-config.js';

// The page follows the gdbop.bg design (navy + gold, Montserrat, square
// corners): header with the emblem, page hero with breadcrumb, footer.
// SITE_URL: where "Начало" points (the mirror while this is a demo; gdbop.bg later).
const SITE_URL = { bg: 'https://cyb3r-pony.github.io/gdbop-mirror/', en: 'https://cyb3r-pony.github.io/gdbop-mirror/en/index.html' };

const TRANSLATIONS = {
    bg: {
        home: 'Начало',
        backHome: 'Към сайта',
        brandSup: 'Министерство на вътрешните работи',
        brandMain: 'ГДБОП',
        brandFull: 'Главна дирекция „Борба с организираната престъпност“',
        crumb: 'Подай сигнал',
        title: 'Подай сигнал',
        lead: 'Подайте сигнал за организирана престъпност или киберпрестъпление. При спешен случай се обадете на 112.',
        unavailable: 'Формата за сигнали временно не е достъпна.',
        footer: 'Главна дирекция „Борба с организираната престъпност“ при Министерство на вътрешните работи на Република България.',
        rights: 'Всички права запазени.',
        demo: 'Демонстрационна версия',
        emergency: 'Спешни случаи',
        logo: 'images/logo-bg.png',
        logoAlt: 'Емблема на ГДБОП',
    },
    en: {
        home: 'Home',
        backHome: 'Back to site',
        brandSup: 'Ministry of Interior',
        brandMain: 'GDCOC',
        brandFull: 'General Directorate Combating Organized Crime',
        crumb: 'Submit a report',
        title: 'Submit a report',
        lead: 'Report organised crime or cybercrime. In an emergency, call 112.',
        unavailable: 'The report form is temporarily unavailable.',
        footer: 'General Directorate Combating Organized Crime, Ministry of Interior of the Republic of Bulgaria.',
        rights: 'All rights reserved.',
        demo: 'Demo version',
        emergency: 'Emergencies',
        logo: 'images/logo-en.png',
        logoAlt: 'GDCOC emblem',
    },
};

const App = () => {
    const [lang, setLang] = useState(() => (new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'bg'));
    const t = TRANSLATIONS[lang];

    useEffect(() => {
        document.documentElement.lang = lang;
        document.title = lang === 'en' ? 'Submit a report | GDCOC — MoI' : 'Подай сигнал | ГДБОП — МВР';
    }, [lang]);

    return (
        <>
            <div className="bg-slate-950 border-b border-white/5 text-[0.78rem] text-slate-300">
                <div className="max-w-[1280px] mx-auto px-4 md:px-6 py-1.5 flex justify-between items-center gap-4">
                    <span className="flex items-center gap-2">
                        <span className="inline-block w-[18px] h-3 rounded-[2px] bg-[linear-gradient(180deg,#fff_33%,#00966e_33%_66%,#d62612_66%)]" aria-hidden="true"></span>
                        {t.brandSup}
                    </span>
                    <a href="tel:112" className="hover:text-gdbop-blue">{t.emergency}: <b className="text-white">112</b></a>
                </div>
            </div>

            <header className="sticky top-0 z-50 bg-slate-900/90 backdrop-blur border-b border-white/10">
                <div className="max-w-[1280px] mx-auto px-4 md:px-6 flex items-center justify-between gap-4">
                    <a href={SITE_URL[lang]} className="flex items-center gap-3 py-2.5">
                        <img src={t.logo} alt={t.logoAlt} className="h-14 w-auto -my-1 drop-shadow-[0_2px_8px_rgba(0,0,0,.5)]" />
                        <span className="leading-tight">
                            <span className="block text-xl md:text-2xl font-bold tracking-wide text-gdbop-blue">{t.brandMain}</span>
                            <span className="hidden md:block text-[0.62rem] uppercase tracking-[0.14em] text-slate-300 max-w-xs">{t.brandFull}</span>
                        </span>
                    </a>
                    <div className="flex items-center gap-3">
                        <a href={SITE_URL[lang]} className="hidden sm:inline-flex items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-slate-200 hover:text-gdbop-blue">
                            <ArrowLeft size={15} /> {t.backHome}
                        </a>
                        <button
                            type="button"
                            onClick={() => setLang(lang === 'bg' ? 'en' : 'bg')}
                            lang={lang === 'bg' ? 'en' : 'bg'}
                            className="px-3.5 py-2 border border-gdbop-blue/50 text-gdbop-blue text-[0.7rem] font-bold tracking-[0.14em] hover:bg-gdbop-blue hover:text-slate-950 transition-colors"
                        >
                            {lang === 'bg' ? 'EN' : 'БГ'}
                        </button>
                    </div>
                </div>
            </header>

            <section className="relative bg-slate-950 overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(800px_360px_at_80%_-10%,rgba(255,200,61,.1),transparent_60%)]" aria-hidden="true"></div>
                <div className="relative max-w-[1280px] mx-auto px-4 md:px-6 pt-14 pb-12 md:pt-20 md:pb-14">
                    <nav className="flex flex-wrap items-center gap-3 text-[0.7rem] uppercase tracking-[0.2em] text-slate-300 mb-5" aria-label="breadcrumb">
                        <a href={SITE_URL[lang]} className="hover:text-gdbop-blue">{t.home}</a>
                        <span className="text-gdbop-blue">/</span>
                        <span>{t.crumb}</span>
                    </nav>
                    <h1 className="relative pb-5 text-3xl md:text-5xl font-extrabold uppercase leading-tight text-white after:absolute after:left-0 after:bottom-0 after:h-[3px] after:w-[74px] after:bg-gdbop-blue">
                        {t.title}
                    </h1>
                    <p className="mt-5 max-w-2xl text-slate-300">{t.lead}</p>
                </div>
            </section>

            <main className="flex-grow">
                {REPORT_ENABLED ? (
                    <ReportSection lang={lang} />
                ) : (
                    <p className="max-w-[1280px] mx-auto px-6 py-24 text-slate-300">{t.unavailable}</p>
                )}
            </main>

            <footer className="bg-slate-950 border-t border-white/10">
                <div className="max-w-[1280px] mx-auto px-4 md:px-6 py-10 flex flex-col md:flex-row gap-6 md:items-center md:justify-between">
                    <div className="flex items-center gap-4 max-w-xl">
                        <img src={t.logo} alt="" className="h-14 w-auto" />
                        <p className="text-sm text-slate-300"><strong className="text-white">{lang === 'en' ? 'GDCOC — MoI' : 'ГДБОП — МВР'}</strong><br />{t.footer}</p>
                    </div>
                    <p className="text-xs text-slate-400">© {new Date().getFullYear()} {lang === 'en' ? 'GDCOC — MoI' : 'ГДБОП — МВР'}. {t.rights} · {t.demo}</p>
                </div>
            </footer>
        </>
    );
};

createRoot(document.getElementById('root')).render(<App />);
