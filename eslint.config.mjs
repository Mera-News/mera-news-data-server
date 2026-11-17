// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Off: `npm run lint` runs --fix, and this rule's fix deletes assertions
      // that steer contextual typing (`{...} as ArticleSummary` in an array),
      // which turned a green tree into type errors twice. Under TypeScript 6 it
      // also flags ~220 assertions that are still load-bearing.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
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
  {
    // Unit tests legitimately build `any`-typed mocks and reference unbound
    // mock methods. The type-checked safety rules add noise without value here.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Async mock implementations that satisfy a Promise-returning interface
      // but have no internal await (e.g. `jest.fn(async () => undefined)`) are
      // idiomatic test doubles — the async keyword documents the contract.
      '@typescript-eslint/require-await': 'off',
      // Tests use require() for jest module isolation (jest.isolateModules,
      // re-requiring after mock setup) — a legitimate pattern in specs.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);