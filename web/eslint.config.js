import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'public/cesium/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', '*.js', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.worker, ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
];
