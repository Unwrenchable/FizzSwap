
/** Jest configuration for TypeScript using ts-jest */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	testMatch: ['**/test/**/*.test.ts', '**/test/**/*.spec.ts'],
	transform: {
		'^.+\\.ts$': 'ts-jest',
	},
	moduleFileExtensions: ['ts', 'js', 'json', 'node'],
	globals: {
		'ts-jest': {
			tsconfig: 'tsconfig.json',
		},
	},
	testTimeout: 30000,
};

