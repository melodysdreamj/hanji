import { hanjiCanonicalEnvValue } from './hanji-compat';

export interface CustomDomainCapability {
  enabled: boolean;
  cnameTarget: string;
}

const RESERVED_EXACT_HOSTNAMES = new Set([
  'example.com',
  'example.net',
  'example.org',
  'localhost',
]);
const RESERVED_TLDS = new Set([
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'test',
]);

export function normalizeCustomDomainCnameTarget(value: unknown) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw === 'off' || raw.endsWith('.') || /[/:@?#*\s]/.test(raw)) return '';
  const hostname = raw.toLowerCase();
  if (hostname.length > 253 || /^\d+(?:\.\d+){3}$/.test(hostname)) return '';
  const labels = hostname.split('.');
  if (
    labels.length < 2
    || RESERVED_EXACT_HOSTNAMES.has(hostname)
    || RESERVED_TLDS.has(labels.at(-1) ?? '')
    || labels.some((label) => (
      label.length < 1
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
  ) {
    return '';
  }
  return hostname;
}

/**
 * A valid dedicated CNAME target is the opt-in bit. Missing, `off`, malformed,
 * local and documentation-only targets all keep the capability disabled.
 */
export function customDomainCapability(
  env: Record<string, unknown> | undefined,
): CustomDomainCapability {
  const cnameTarget = normalizeCustomDomainCnameTarget(
    hanjiCanonicalEnvValue(env, 'HANJI_CUSTOM_DOMAIN_CNAME_TARGET'),
  );
  return {
    enabled: Boolean(cnameTarget),
    cnameTarget,
  };
}
