type RateLimitProfile = 'production' | 'development';

function runtimeProfile(): RateLimitProfile {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const value = runtime.process?.env?.NOTIONLIKE_RATE_LIMIT_PROFILE?.trim().toLowerCase();
  return value === 'development' || value === 'test' ? 'development' : 'production';
}

function bucket(
  namespaceId: string,
  productionRequests: number,
  developmentRequests = 10_000_000,
) {
  return (profile: RateLimitProfile) => {
    const requests = profile === 'development' ? developmentRequests : productionRequests;
    return {
      requests,
      window: '60s' as const,
      binding: { limit: requests, period: 60 as const, namespaceId },
    };
  };
}

const buckets = {
  global: bucket('1001', 1_800),
  // Raw product databases are denied to browser callers in release mode, but
  // keep a separate outer ceiling for authenticated SDK/admin traffic.
  db: bucket('1002', 600),
  storage: bucket('1003', 300),
  functions: bucket('1004', 1_200),
  auth: bucket('1005', 120),
  authSignin: bucket('1006', 30),
  authSignup: bucket('1007', 12),
  events: bucket('1008', 2_400),
  // Dynamic Client Registration is intentionally anonymous (RFC 7591), so it
  // gets a much tighter per-IP ceiling than ordinary product functions.
  mcpRegister: bucket('1009', 10),
};

export function rateLimitingForProfile(profile: RateLimitProfile) {
  return {
    global: buckets.global(profile),
    db: buckets.db(profile),
    storage: buckets.storage(profile),
    functions: buckets.functions(profile),
    auth: buckets.auth(profile),
    authSignin: buckets.authSignin(profile),
    authSignup: buckets.authSignup(profile),
    events: buckets.events(profile),
    mcpRegister: buckets.mcpRegister(profile),
  } as const;
}

// Production is fail-safe by default. The npm dev script explicitly opts into
// the high-ceiling profile needed by local multi-tab and full smoke runs.
export const rateLimiting = rateLimitingForProfile(runtimeProfile());
