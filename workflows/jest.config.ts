import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/__tests__/**/*.spec.ts'],
  // Archived pre-v3 code (deterministic scoring + discarded Maps/ML/IG sources)
  // lives under legacy/ with intentionally dangling imports — keep it out of
  // both test discovery and the module graph.
  testPathIgnorePatterns: ['/node_modules/', '/legacy/'],
  modulePathIgnorePatterns: ['/legacy/'],
}

export default config
