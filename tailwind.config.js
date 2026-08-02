/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#07090d', // fond appli
          800: '#0b0f14', // fond carte
          700: '#141a22', // carte surelevee
          600: '#1e2733', // bordures
          500: '#2c3846',
        },
        accent: '#f59e0b', // orange ITM, action principale
        ok: '#22c55e',
        warn: '#f97316',
        bad: '#ef4444',
        info: '#38bdf8',
      },
      fontSize: {
        // Chiffres lisibles a bout de bras, telephone a la ceinture
        chrono: ['4.5rem', { lineHeight: '1', letterSpacing: '-0.03em' }],
        'chrono-sm': ['2.75rem', { lineHeight: '1', letterSpacing: '-0.02em' }],
      },
      spacing: {
        // Hauteur minimale d'une cible tactile utilisable avec des gants
        touch: '4.5rem',
      },
      keyframes: {
        // Confirmation d'un colis ajouté : apparaît net, monte, s'efface.
        count: {
          '0%': { opacity: '0', transform: 'translateY(6px) scale(0.9)' },
          '15%': { opacity: '1', transform: 'translateY(0) scale(1.06)' },
          '35%': { transform: 'translateY(0) scale(1)' },
          '100%': { opacity: '0', transform: 'translateY(-14px) scale(1)' },
        },
      },
      animation: {
        count: 'count 650ms ease-out forwards',
      },
    },
  },
  plugins: [],
}
