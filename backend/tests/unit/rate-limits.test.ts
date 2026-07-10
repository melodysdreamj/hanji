import { describe, expect, it } from 'vitest';

import { rateLimitingForProfile } from '../../config/rate-limits';

describe('rate limiting profiles', () => {
  it('uses finite production ceilings for public and authentication surfaces', () => {
    const limits = rateLimitingForProfile('production');

    expect(limits.global.requests).toBe(1_800);
    expect(limits.functions.requests).toBe(1_200);
    expect(limits.authSignin.requests).toBe(30);
    expect(limits.authSignup.requests).toBe(12);
    expect(limits.mcpRegister.requests).toBe(10);
    expect(limits.global.binding.limit).toBe(limits.global.requests);
  });

  it('keeps exhaustive local verification on an explicit development profile', () => {
    const limits = rateLimitingForProfile('development');

    expect(limits.global.requests).toBe(10_000_000);
    expect(limits.functions.requests).toBe(10_000_000);
    expect(limits.authSignin.requests).toBeGreaterThan(1_000);
  });
});
