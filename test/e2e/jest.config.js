/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Specs that run service code in-process resolve the workspace aliases.
  moduleNameMapper: {
    '^@mera/models(|/.*)$': '<rootDir>/../../libs/mera-models/src/$1',
    '^@mera/news-core(|/.*)$': '<rootDir>/../../libs/mera-news-core/src/$1',
    '^@mera/shared(|/.*)$': '<rootDir>/../../libs/mera-shared/src/$1',
    '^@mera/async(|/.*)$': '<rootDir>/../../apps/mera-server-async/src/$1',
  },
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.json' }],
  },
  testEnvironment: 'node',
  testMatch: ['**/*.e2e.ts'],
  // The self-hosting spec needs the services the guide starts, which only its own CI job has.
  testPathIgnorePatterns: process.env.SELFHOST_E2E ? [] : ['/selfhost/'],
  maxWorkers: 1,
  testTimeout: 240000,
};
