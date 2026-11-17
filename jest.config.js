const moduleNameMapper = {
  '^@mera/models(|/.*)$': '<rootDir>/libs/mera-models/src/$1',
  '^@mera/news-core(|/.*)$': '<rootDir>/libs/mera-news-core/src/$1',
  '^@mera/shared(|/.*)$': '<rootDir>/libs/mera-shared/src/$1',
  '^@mera/async(|/.*)$': '<rootDir>/apps/mera-server-async/src/$1',
};

const base = {
  rootDir: __dirname,
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  moduleNameMapper,
};

/** @type {import('jest').Config} */
module.exports = {
  workerIdleMemoryLimit: '1536MB',
  projects: [
    {
      ...base,
      displayName: 'unit',
      roots: ['<rootDir>/apps/', '<rootDir>/libs/'],
      testRegex: '.*\\.spec\\.ts$',
    },
    {
      ...base,
      displayName: 'integration',
      roots: ['<rootDir>/test/integration/'],
      testRegex: '.*\\.spec\\.ts$',
      globalSetup: '<rootDir>/test/harness/global-setup.ts',
      globalTeardown: '<rootDir>/test/harness/global-teardown.ts',
      setupFiles: ['<rootDir>/test/harness/setup-env.ts'],
      setupFilesAfterEnv: ['<rootDir>/test/harness/msw.ts'],
      testTimeout: 60_000,
    },
  ],
};
