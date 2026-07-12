import { describe, expect, it } from 'vitest';

import { authEmailActionUrls } from '../../edgebase.config';

describe('Hanji authentication email action URLs', () => {
  it('lands every emailed credential on a concrete same-origin SPA route', () => {
    const urls = authEmailActionUrls('https://app.example.com/');
    expect(urls).toEqual({
      verifyUrl: 'https://app.example.com/auth/verify-email#token={token}',
      resetUrl: 'https://app.example.com/auth/reset-password#token={token}',
      emailChangeUrl: 'https://app.example.com/auth/verify-email-change#token={token}',
    });
    expect(Object.values(urls).every((url) => !url.includes('?token='))).toBe(true);
  });
});
