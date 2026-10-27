/** @type {import('tailwindcss').Config} */
export default {
  // Scan the form sources and the page shell for class names.
  content: ['./src/**/*.{jsx,js}', './worker/site/*.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        'gdbop-blue': '#47a8f6',
        'gdbop-dark': '#0f172a',
        'police-blue': '#0055ff',
        'police-red': '#ff0000',
      },
      animation: {
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
