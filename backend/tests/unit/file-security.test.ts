import { describe, expect, it } from 'vitest';

import {
  assertSafeStoredFileType,
  isActiveFileContentType,
  isActiveFileName,
  normalizeFileContentType,
} from '../../lib/file-security';

describe('stored file active-content policy', () => {
  it('normalizes parameters and missing types to a deterministic safe value', () => {
    expect(normalizeFileContentType(' Text/Plain; charset=UTF-8 ')).toBe('text/plain');
    expect(normalizeFileContentType(undefined)).toBe('application/octet-stream');
  });

  it.each([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'application/javascript',
    'text/css',
    'text/xml; charset=utf-8',
    'application/atom+xml',
    'application/vnd.example+xml',
  ])(
    'classifies %s as active content',
    (contentType) => {
      expect(isActiveFileContentType(contentType)).toBe(true);
      expect(() => assertSafeStoredFileType('payload.bin', contentType)).toThrow(
        'Active web content files are not allowed.',
      );
    },
  );

  it.each([
    'page.html',
    'vector.SVG',
    'compressed.svgz',
    'archive.mhtml',
    'module.mjs',
    'module.cjs',
    'styles.css',
    'application.hta',
    'template.shtml',
    'feed.xml',
    'transform.xsl',
    'transform.xslt',
  ])(
    'rejects an active extension even when the claimed MIME is inert (%s)',
    (name) => {
      expect(isActiveFileName(name)).toBe(true);
      expect(() => assertSafeStoredFileType(name, 'application/octet-stream')).toThrow(
        'Active web content files are not allowed.',
      );
    },
  );

  it.each([
    ['report.pdf', 'application/pdf'],
    ['photo.png', 'image/png'],
    ['installer.dmg', 'application/x-apple-diskimage'],
    ['notes.txt', 'text/plain'],
  ])('allows non-active attachment %s', (name, contentType) => {
    expect(assertSafeStoredFileType(name, contentType)).toBe(contentType);
  });
});
