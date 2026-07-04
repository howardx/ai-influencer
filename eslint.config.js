import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

// Focused on bug-catchers (rules-of-hooks, exhaustive-deps, unused/undefined
// vars) rather than style. `npm run lint` must stay green — new violations are
// real findings, not noise.
export default [
  { ignores: ['dist/**', 'node_modules/**', '.playwright-mcp/**', 'public/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Empty catch is this codebase's deliberate quota-tolerant localStorage
      // pattern (see store.jsx / higgsfieldGenerate.js) — other empty blocks stay errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]
