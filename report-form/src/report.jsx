        import React, { useState, useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ArrowLeft, Globe } from 'lucide-react';
        import { ReportSection } from './report-form.jsx';
        import { REPORT_ENABLED } from './report-config.js';

        const TRANSLATIONS = {
            bg: {
                backHome: 'Към Началото',
                partOf: 'част от ГДБОП',
                unavailable: 'Формата за сигнали временно не е достъпна.',
                rights: 'Всички права запазени.',
                demo: 'демонстрационна версия',
            },
            en: {
                backHome: 'Back to Home',
                partOf: 'part of GDCOC',
                unavailable: 'The report form is temporarily unavailable.',
                rights: 'All rights reserved.',
                demo: 'demo version',
            },
        };

        const App = () => {
            const [lang, setLang] = useState(() => (new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'bg'));
            const t = TRANSLATIONS[lang];

            useEffect(() => { document.documentElement.lang = lang; }, [lang]);

            return (
                <>
                    <div className="scanlines"></div>
                    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
                        <div className="absolute -top-40 -left-40 w-96 h-96 bg-police-blue rounded-full opacity-10 blur-[100px] animate-pulse-slow"></div>
                        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-police-red rounded-full opacity-10 blur-[100px] animate-pulse-slow" style={{ animationDelay: '2s' }}></div>
                    </div>

                    <a
                        href={lang === 'en' ? 'https://cyb3r-pony.github.io/gdbop-mirror/en/index.html' : 'https://cyb3r-pony.github.io/gdbop-mirror/'}
                        className="fixed top-6 left-6 z-50 flex items-center gap-2 px-4 py-2 bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-full text-slate-300 hover:text-white hover:border-white transition-all group"
                    >
                        <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" />
                        <span className="font-bold text-sm tracking-wide hidden sm:inline">{t.backHome}</span>
                    </a>

                    <div className="fixed top-6 right-6 z-50 flex items-center gap-3 px-3 py-1.5 bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-full">
                        <a
                            href={lang === 'en' ? 'https://cyb3r-pony.github.io/gdbop-mirror/en/index.html' : 'https://cyb3r-pony.github.io/gdbop-mirror/'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 border-r border-slate-700/50 pr-3 opacity-70 hover:opacity-100 transition-opacity group/gdcoc"
                        >
                            <img
                                src={lang === 'en' ? 'images/gdcoc_logo_en.png' : 'images/gdcoc_logo_bg.png'}
                                alt="GDCOC Logo"
                                className="h-6 w-auto"
                            />
                            <span className="text-[10px] text-slate-400 group-hover/gdcoc:text-slate-200 transition-colors uppercase tracking-wide whitespace-nowrap">
                                {t.partOf}
                            </span>
                        </a>
                        <button
                            onClick={() => setLang(lang === 'bg' ? 'en' : 'bg')}
                            className="flex items-center gap-2 px-3 py-1 bg-slate-800 border border-slate-700/50 rounded-full text-gdbop-blue hover:bg-gdbop-blue hover:text-white hover:border-white transition-all duration-300 group"
                        >
                            <Globe size={14} className="group-hover:rotate-180 transition-transform duration-500" />
                            <span className="font-bold font-mono text-xs uppercase tracking-wider">{lang === 'bg' ? 'EN' : 'BG'}</span>
                        </button>
                    </div>

                    <main className="flex-grow pt-16">
                        {REPORT_ENABLED ? (
                            <ReportSection lang={lang} />
                        ) : (
                            <p className="text-center text-slate-300 py-32 px-4">{t.unavailable}</p>
                        )}
                    </main>

                    <footer className="relative z-10 py-6 text-center text-xs text-slate-500">
                        © {new Date().getFullYear()} ГДБОП – МВР ({t.demo}). {t.rights}
                    </footer>
                </>
            );
        };

        createRoot(document.getElementById('root')).render(<App />);
