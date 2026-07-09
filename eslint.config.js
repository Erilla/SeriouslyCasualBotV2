import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // TypeScript's compiler (tsc --noEmit in `npm run typecheck`) already
      // resolves identifiers, so ESLint's no-undef would only produce false
      // positives on Node/DOM globals here. Off, per typescript-eslint guidance.
      'no-undef': 'off',
      // Honor the codebase convention of prefixing intentionally-unused
      // bindings (unused handler args, ignored destructures, swallowed caught
      // errors) with an underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
