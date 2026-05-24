// Setup for the `dom` vitest project (jsdom + @testing-library/react).
// - Extends expect() with jest-dom matchers (toBeInTheDocument, toBeDisabled, …).
// - Unmounts rendered trees after each test so DOM/listeners don't leak across
//   tests sharing the same jsdom document.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
