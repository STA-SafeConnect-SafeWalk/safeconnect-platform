const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@aws-sdk/(.*)$': '<rootDir>/node_modules/@aws-sdk/$1',
  },
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['**/tests/*.test.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['**/tests/integration/**/*.test.ts'],
    },
  ],
};
