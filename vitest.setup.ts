// jest-dom matchers (toBeInTheDocument, toHaveAttribute, etc.) for RTL tests
// added in Plan 11-04. Works under jsdom; harmless when test files import nothing
// DOM-related (the matchers are simply available but never invoked).
import '@testing-library/jest-dom/vitest';
