<<<<<<< HEAD
// postcss.config.cjs
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
=======
cat > postcss.config.cjs <<'EOF'
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
EOF
>>>>>>> d4b6703acfe8075bb55b369d680817dd5ac6914f
