import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'test-results/**',
      'tests/.tmp/**',
      'tests/tmp/**',
      // Plan and SDD scratch trees are gitignored; probes left there must not fail the gate.
      'docs/superpowers/**',
      '.superpowers/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
);
