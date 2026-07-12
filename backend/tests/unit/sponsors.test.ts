import { describe, expect, it } from 'vitest';
import {
  configuredSponsorsFeedUrl,
  normalizeFeedSponsors,
  readBoundedSponsorPayload,
  sponsorsMode,
} from '../../functions/sponsors';

// The pool/burn logic lives in the private sponsors-service (tested there);
// the product only relays the public feed, so the unit surface is the
// payload normalization.
describe('normalizeFeedSponsors', () => {
  it('keeps only name/github-url and caps at five entries', () => {
    const sponsors = normalizeFeedSponsors({
      sponsors: [
        { name: 'A', url: 'https://github.com/a', balance: 100 },
        { name: 'B' },
        { name: 'C', url: 42 },
        { name: 'D', url: 'https://github.com/d' },
        { name: 'E', login: 'ellen' },
        { name: 'F', login: 'frank' },
      ],
    });
    expect(sponsors).toHaveLength(5);
    expect(sponsors[0]).toEqual({ name: 'A', url: 'https://github.com/a' });
    expect(sponsors[1]).toEqual({ name: 'B', url: null });
    expect(sponsors[2]).toEqual({ name: 'C', url: null });
    expect(sponsors[4]).toEqual({ name: 'E', url: 'https://github.com/ellen' });
    expect(sponsors.every((item) => !('balance' in item))).toBe(true);
  });

  it('normalizes names and keeps only github link targets', () => {
    expect(normalizeFeedSponsors({
      sponsors: [
        { name: '  Gh sponsor  ', url: 'https://github.com/octocat#bio' },
        { name: 'External', url: 'https://sponsor.example/profile' },
        { name: 'Script', url: 'javascript:alert(1)' },
        { name: 'Private', url: 'http://127.0.0.1/admin' },
        { name: 'x'.repeat(81), url: 'https://github.com/toolong' },
      ],
    })).toEqual([
      { name: 'Gh sponsor', url: 'https://github.com/octocat' },
      { name: 'External', url: null },
      { name: 'Script', url: null },
      { name: 'Private', url: null },
    ]);
  });

  it('prefers a validated github login, else falls back to a github url', () => {
    expect(normalizeFeedSponsors({
      sponsors: [
        { name: 'ValidLogin', login: 'Octo-cat', url: 'https://evil.example' },
        { name: 'BadLogin', login: 'not a login', url: 'https://github.com/fallback' },
        { name: 'BadLoginNoGithub', login: '-bad-', url: 'https://evil.example' },
        { name: 'WwwGithub', url: 'https://www.github.com/wwwuser' },
      ],
    })).toEqual([
      { name: 'ValidLogin', url: 'https://github.com/Octo-cat' },
      { name: 'BadLogin', url: 'https://github.com/fallback' },
      { name: 'BadLoginNoGithub', url: null },
      { name: 'WwwGithub', url: 'https://www.github.com/wwwuser' },
    ]);
  });

  it('uses only the upstream feed unless fetching is explicitly disabled', () => {
    expect(configuredSponsorsFeedUrl(undefined)).toBe(
      'https://hanji-sponsors-service.melodydreamj.workers.dev/sponsors',
    );
    expect(configuredSponsorsFeedUrl({ HANJI_SPONSORS_FEED_URL: 'off' })).toBe('');
    for (const configured of [
      'http://example.com/feed',
      'https://127.0.0.1/feed',
      'https://feed.example/sponsors',
      'not a URL',
    ]) {
      expect(configuredSponsorsFeedUrl({ HANJI_SPONSORS_FEED_URL: configured })).toBe(
        'https://hanji-sponsors-service.melodydreamj.workers.dev/sponsors',
      );
    }
  });

  it('rejects a chunked feed that exceeds the bounded parser limit', async () => {
    const oversized = new Uint8Array(256 * 1024 + 1);
    await expect(readBoundedSponsorPayload(new Response(oversized))).rejects.toThrow('too large');
  });

  it('rejects malformed payloads', () => {
    for (const payload of [null, {}, { sponsors: 'x' }, { sponsors: [null, 42, { url: 'no-name' }] }]) {
      expect(normalizeFeedSponsors(payload)).toEqual([]);
    }
  });

  it('normalizes a bundled snapshot the same way, enforcing github links', () => {
    expect(normalizeFeedSponsors({
      sponsors: [
        { name: 'Snap', login: 'snap-co' },
        { name: 'Ad', url: 'https://ad.example' },
      ],
    })).toEqual([
      { name: 'Snap', url: 'https://github.com/snap-co' },
      { name: 'Ad', url: null },
    ]);
  });
});

describe('sponsorsMode', () => {
  it('maps HANJI_SPONSORS_FEED_URL to live / bundled / off', () => {
    expect(sponsorsMode(undefined)).toBe('live');
    expect(sponsorsMode({})).toBe('live');
    expect(sponsorsMode({ HANJI_SPONSORS_FEED_URL: 'https://feed.example/sponsors' })).toBe('live');
    expect(sponsorsMode({ HANJI_SPONSORS_FEED_URL: 'off' })).toBe('off');
    expect(sponsorsMode({ HANJI_SPONSORS_FEED_URL: 'OFF' })).toBe('off');
    expect(sponsorsMode({ HANJI_SPONSORS_FEED_URL: 'bundled' })).toBe('bundled');
    expect(sponsorsMode({ HANJI_SPONSORS_FEED_URL: ' Bundled ' })).toBe('bundled');
  });
});
