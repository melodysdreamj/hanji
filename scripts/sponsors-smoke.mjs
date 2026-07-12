#!/usr/bin/env node
// Sponsor banner feed smoke: the product endpoint is a read-only relay of the
// private sponsors-service feed. It must always answer `{ ok: true, sponsors:
// [...] }` with at most five name/url entries and never leak balances or
// expose mutation actions — even when the upstream feed is unreachable
// (empty list, never a 500, so the sign-in screen cannot break).
import { assert, assertRuntimeReachable, normalizeBaseUrl, resolveUrl } from './lib/harness.mjs';

const BASE = normalizeBaseUrl(process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787');

async function main() {
  await assertRuntimeReachable(BASE);

  const response = await fetch(resolveUrl(BASE, '/api/functions/sponsors'), {
    headers: { Accept: 'application/json' },
  });
  assert(response.status === 200, `sponsors feed must never fail, got ${response.status}`);
  const json = await response.json();
  assert(json.ok === true && Array.isArray(json.sponsors), `feed shape: ${JSON.stringify(json).slice(0, 120)}`);
  assert(json.sponsors.length <= 5, `feed must cap at five, got ${json.sponsors.length}`);
  for (const sponsor of json.sponsors) {
    assert(typeof sponsor.name === 'string', 'sponsor entries carry a name');
    assert(!('balance' in sponsor) && !('totalContributed' in sponsor), 'feed must not leak balances');
  }
  console.log(`PASS sponsors feed relays ${json.sponsors.length} entries with the public shape.`);

  // The product exposes no sponsor mutation surface; the pool is managed by
  // the private sponsors-service.
  const post = await fetch(resolveUrl(BASE, '/api/functions/sponsors'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'recordContribution', name: 'x', amount: 1 }),
  });
  assert(post.status === 404 || post.status === 405, `sponsor mutations must be absent, got ${post.status}`);
  console.log('PASS sponsor mutation surface is not exposed by the product.');

  console.log('PASS sponsors banner feed relay works.');
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL sponsors smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
