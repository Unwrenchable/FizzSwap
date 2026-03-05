/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // Only run fizz-chain tests (avoids pulling in relayer HTTP deps)
  testMatch: ['**/src/fizz-chain/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          // Use a relaxed config for tests to avoid needing rootDir = ".."
          strict: true,
          esModuleInterop: true,
          module: 'CommonJS',
          target: 'ES2020',
          skipLibCheck: true,
        },
      },
    ],
  },
  // Show individual test names in output
  verbose: true,
  // Fail fast after first test failure in CI
  bail: false,
  // Timeout for PoW mining tests (difficulty 1 is fast but give generous budget)
  testTimeout: 30000,
};
