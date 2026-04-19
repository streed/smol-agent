/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/unit/**/*.test.js', '<rootDir>/test/unit/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      diagnostics: false, // Disable type checking during tests for gradual migration
      tsconfig: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        isolatedModules: true,
        esModuleInterop: true,
        strict: false,
        noImplicitAny: false,
        strictNullChecks: false,
        skipLibCheck: true,
        noEmit: true,
      },
    }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: ['/node_modules/', '/e2e/', '/.smol-agent/'],
  collectCoverageFrom: ['src/**/*.js', 'src/**/*.ts', '!src/index.js', '!src/index.ts'],
  coverageDirectory: 'coverage',
  verbose: true,
};

export default config;
