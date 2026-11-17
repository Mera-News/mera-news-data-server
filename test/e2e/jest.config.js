/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.json' }],
  },
  testEnvironment: 'node',
  testMatch: ['**/*.e2e.ts'],
  maxWorkers: 1,
  testTimeout: 240000,
};
