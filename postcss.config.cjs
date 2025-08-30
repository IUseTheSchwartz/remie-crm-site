// postcss.config.cjs
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {}, // TailwindCSS with PostCSS 8
    autoprefixer: {},           // adds vendor prefixes for browser support
  },
};
