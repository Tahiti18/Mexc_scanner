/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d0d0f',
        panel: '#17171c',
        text: '#e5e7eb',
        green: '#16a34a',
        red: '#dc2626',
        accent: '#60a5fa'
      }
    }
  },
  plugins: []
};
