const DNS_TIMEOUT_MS = 5_000;
const MAX_DNS_ANSWER_COUNT = 100;

interface DnsJsonAnswer {
  type?: unknown;
  data?: unknown;
}

interface DnsJsonResponse {
  Status?: unknown;
  Answer?: unknown;
}

export interface DomainVerificationResult {
  verified: boolean;
  recordName: string;
  recordValue: string;
  reason?: string;
}

export function domainVerificationRecord(domain: string, token: string) {
  return {
    recordName: `_hanji-verification.${domain}`,
    recordValue: `hanji-verification=${token}`,
  };
}

function normalizeTxtData(value: string) {
  const trimmed = value.trim();
  const unquoted = trimmed
    .split(/\s+/)
    .map((chunk) => chunk.replace(/^"|"$/g, ''))
    .join('');
  return unquoted.replace(/\\"/g, '"');
}

export async function verifyDomainTxtRecord(
  domain: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<DomainVerificationResult> {
  const record = domainVerificationRecord(domain, token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
  try {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', record.recordName);
    url.searchParams.set('type', 'TXT');
    const response = await fetcher(url, {
      headers: { Accept: 'application/dns-json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ...record, verified: false, reason: `DNS resolver returned ${response.status}.` };
    }
    const payload = await response.json() as DnsJsonResponse;
    if (payload.Status !== 0) {
      return { ...record, verified: false, reason: 'The DNS name does not resolve yet.' };
    }
    const answers = Array.isArray(payload.Answer)
      ? (payload.Answer as DnsJsonAnswer[]).slice(0, MAX_DNS_ANSWER_COUNT)
      : [];
    const verified = answers.some(
      (answer) => answer.type === 16
        && typeof answer.data === 'string'
        && normalizeTxtData(answer.data) === record.recordValue,
    );
    return verified
      ? { ...record, verified: true }
      : { ...record, verified: false, reason: 'The expected TXT value was not found.' };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? 'DNS verification timed out.'
      : 'DNS verification is temporarily unavailable.';
    return { ...record, verified: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}
