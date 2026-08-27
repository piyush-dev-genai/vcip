import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // docs/ holds the source-of-truth design documents and the consistency
    // checker. Never lint or reformat them — see docs/00-decisions.md.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.venv/**',
      '**/*.d.ts',
      'docs/**',
      // Throwaway Day-0 spikes. Mixed browser/Node contexts and a vendored
      // SDK bundle; they are deleted once the path they prove is implemented.
      'spikes/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    // Plain JS/MJS tooling scripts run on Node. TypeScript files get this via
    // @types/node, but typescript-eslint's no-undef override does not apply here.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always'],

      // Sensitive-data boundary: application logging goes through the
      // configured logger with redaction, never raw console output.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);
