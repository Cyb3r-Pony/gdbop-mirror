/** @type {import('tailwindcss').Config} */
// gdbop.bg design: the "slate" scale is remapped to the site's navy tones and
// the accent ("gdbop-blue", kept as the class name) is the site's gold, so the
// form components need no class changes. Square corners as on gdbop.bg.
export default {
  content: ['./src/**/*.{jsx,js}', './worker/site/*.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // the form itself: the platform UI face (SF on Apple devices), as in iOS
        ios: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Segoe UI Variable Text"', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      keyframes: {
        pop: { '0%': { transform: 'scale(.4)', opacity: '0' }, '100%': { transform: 'scale(1)', opacity: '1' } },
      },
      colors: {
        slate: {
          50: '#f8fbff', 100: '#f1f6ff', 200: '#dbe5f6', 300: '#c3d2ec', 400: '#9fb3d6',
          500: '#7489b3', 600: '#2f5a9e', 700: '#21529c', 800: '#1a417f', 900: '#103166', 950: '#0b2350',
        },
        'gdbop-blue': '#ffc83d', // gold accent (var(--gold) on gdbop.bg)
        'gdbop-gold-light': '#ffdd6b',
        'gdbop-dark': '#103166', // page background (var(--navy-900))
        'police-blue': '#4f8cff',
        'police-red': '#ffc83d', // required-field asterisk in gold, as on the site
        // iOS-style grouped surfaces on the gdbop navy
        'ios-sheet': '#0c2756',
        'ios-cell': '#15386f',
        'ios-cell2': '#2a5194',
        'ios-text': '#f3f6fc',
        'ios-label': '#9db0d3',
        'ios-red': '#ff6b6b',
      },
      borderRadius: { sm: '1px', DEFAULT: '2px', md: '2px', lg: '2px', xl: '3px', '2xl': '4px' },
    },
  },
  plugins: [],
};
