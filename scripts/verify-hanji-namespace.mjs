#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const formerPrimaryLower = ['notion', 'like'].join('');
const formerSecondaryLower = ['ink', 'line'].join('');
const formerPrimaryUpperPrefix = `${formerPrimaryLower.toUpperCase()}_`;
const formerPrimaryHeaderPrefix = `X-${['Notion', 'like'].join('')}-`;
const releasedLocalePrefixes = [
  'web/src/locales/en/',
  'web/src/locales/ko/',
  'web/src/locales/ja/',
  'web/src/locales/zh-Hans/',
  'web/src/locales/es/',
  'web/src/locales/fr/',
  'web/src/locales/de/',
  'web/src/locales/pt-BR/',
];

const exactAllowedCompatibilityLines = new Map([
  [
    'backend/lib/hanji-compat.ts',
    new Set([
      `const LEGACY_ENV_PREFIX = '${formerPrimaryUpperPrefix}';`,
      `const LEGACY_HEADER_PREFIX = '${formerPrimaryHeaderPrefix}';`,
      `const LEGACY_HANJI_URI_PROTOCOL = '${formerPrimaryLower}:';`,
      `const LEGACY_HANJI_NATIVE_FORMAT = '${formerSecondaryLower}.export';`,
      `const LEGACY_HANJI_NATIVE_FILE_EXTENSION = '.${formerSecondaryLower}.json';`,
      `export const LEGACY_REFRESH_COOKIE_BASE_NAME_DELETE_ONLY = '${formerPrimaryLower}-refresh';`,
      `const LEGACY_IMPORTED_ROW_CONTEXT_FILTER_MARKER = '${formerPrimaryLower}ImportedRowContextFilter';`,
    ]),
  ],
  [
    'mcp/src/legacy-product-compat.mjs',
    new Set([
      `const LEGACY_ENV_PREFIX = "${formerPrimaryUpperPrefix}";`,
      `const LEGACY_URI_SCHEME = "${formerPrimaryLower}";`,
    ]),
  ],
  [
    'scripts/migrate-hanji-local-namespace.mjs',
    new Set([
      `const LEGACY_PREFIX = '${formerPrimaryUpperPrefix}';`,
      `const LEGACY_BACKEND_COMPONENT_PREFIX = '${formerPrimaryLower}-backend-';`,
      `const LEGACY_DEV_TARGET_PREFIX = '${formerPrimaryLower}-';`,
      `const match = line.match(/^\\s*(?:export\\s+)?(${formerPrimaryUpperPrefix}[A-Z0-9_]*)\\s*=/i);`,
    ]),
  ],
  [
    'shared/legacy-product-compat.ts',
    new Set([
      `export const LEGACY_CURRENT_PAGE_FILTER_KIND_READ_ONLY = "${formerPrimaryLower}.current_page";`,
    ]),
  ],
  [
    'web/public/sw.js',
    new Set([`const LEGACY_CACHE_PREFIX = "${formerPrimaryLower}-sw-";`]),
  ],
  [
    'web/src/lib/legacyNamespace.ts',
    new Set([
      `const LEGACY_NAMESPACE = "${formerPrimaryLower}";`,
      `export const LEGACY_HANJI_URI_PREFIX = "${formerPrimaryLower}://";`,
      `const LEGACY_BLOCKS_MIME = "application/x-${formerPrimaryLower}-blocks";`,
      `const LEGACY_TABLE_ROWS_MIME = "application/x-${formerPrimaryLower}-table-rows";`,
      `const LEGACY_HTML_ATTRIBUTE_PREFIX = "data-${formerPrimaryLower}-";`,
      `const LEGACY_NATIVE_FILE_RE = /\\.(?:${formerSecondaryLower}|${formerPrimaryLower})(?:\\.json)?$/i;`,
      `const LEGACY_NATIVE_FORMATS = new Set(["${formerSecondaryLower}.export", "${formerPrimaryLower}.export"]);`,
      `const match = key.match(/^${formerPrimaryLower}(?=[:.\\-]|$)/i);`,
      `return \`${formerPrimaryLower}-outbox:\${userId}\`;`,
      `return \`${formerPrimaryLower}-records:\${userId}\`;`,
      `return \`${formerPrimaryLower}-lock:\${userId}\`;`,
    ]),
  ],
]);

const generatedCompatibilityFragments = [
  `application/x-${formerPrimaryLower}-blocks`,
  `application/x-${formerPrimaryLower}-table-rows`,
  `data-${formerPrimaryLower}-`,
  `${formerSecondaryLower}.export`,
  `${formerPrimaryLower}.export`,
  `.${formerSecondaryLower}.json`,
  `.${formerPrimaryLower}.json`,
  `^${formerPrimaryLower}(?=`,
  `${formerPrimaryLower}://`,
  `${formerPrimaryLower}-outbox:`,
  `${formerPrimaryLower}-records:`,
  `${formerPrimaryLower}-lock:`,
  `${formerPrimaryLower}.current_page`,
];
const generatedServiceWorkerFragments = [`${formerPrimaryLower}-sw-`];

function candidateFiles(root) {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.status !== 0) {
    throw new Error(`Could not enumerate public Git candidates: ${listed.stderr.trim()}`);
  }
  return listed.stdout.split('\0').filter(Boolean).sort();
}

function generatedFiles(root) {
  const generatedRoot = resolve(root, 'web', 'dist');
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
      else if (entry.isFile()) files.push(relativePath(root, absolute));
    }
  };
  try {
    visit(generatedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('web/dist is missing. Build the web package before using --generated.');
    }
    throw error;
  }
  return files.sort();
}

function relativePath(root, path) {
  return path.slice(resolve(root).length + 1).split('\\').join('/');
}

function legacyMatches(line) {
  const matches = [];
  const seen = new Set();
  const patterns = [
    {
      label: 'former product namespace',
      regex: new RegExp(`notion[._/\\s-]*like`, 'gi'),
    },
    {
      label: 'former secondary product name',
      regex: new RegExp(`Ink[._/\\s-]*Line`, 'g'),
    },
    {
      label: 'former secondary product namespace',
      regex: new RegExp(`(?<![A-Za-z])ink[._/\\s-]*line(?![A-Za-z])`, 'gi'),
    },
    {
      label: 'former secondary Korean product name',
      regex: new RegExp(`잉크[\\s._/-]*라인`, 'g'),
    },
    {
      label: 'former primary Korean product name',
      regex: new RegExp(`노션[\\s._/-]*라이크`, 'g'),
    },
  ];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern.regex)) {
      const key = `${match.index ?? 0}:${match[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ label: pattern.label, token: match[0], column: (match.index ?? 0) + 1 });
    }
  }
  return matches;
}

function isAllowedCompatibilityUse(path, line) {
  return exactAllowedCompatibilityLines.get(path)?.has(line.trim()) === true;
}

function isAllowedGeneratedUse(path, source, absoluteIndex) {
  const fragments = path === 'web/dist/sw.js'
    ? generatedServiceWorkerFragments
    : path.startsWith('web/dist/assets/') && path.endsWith('.js')
      ? generatedCompatibilityFragments
      : [];
  return fragments.some((fragment) => {
    let start = source.indexOf(fragment);
    while (start >= 0) {
      if (absoluteIndex >= start && absoluteIndex < start + fragment.length) return true;
      start = source.indexOf(fragment, start + 1);
    }
    return false;
  });
}

function isPendingTranslationCatalog(path) {
  return path.startsWith('web/src/locales/') &&
    !releasedLocalePrefixes.some((prefix) => path.startsWith(prefix));
}

export function findHanjiNamespaceViolations({
  root = repoRoot,
  files = candidateFiles(root),
  generated = false,
} = {}) {
  const violations = [];
  for (const path of files) {
    // Hidden translation targets intentionally catch up in separate translation
    // passes and are not part of a product release. Their structural integrity is
    // still checked by i18n-status; namespace enforcement resumes when a locale
    // becomes selectable and is added to releasedLocalePrefixes above.
    if (!generated && isPendingTranslationCatalog(path)) continue;
    const absolute = resolve(root, path);
    let source;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch (error) {
      violations.push({
        path,
        line: 0,
        column: 0,
        label: `unreadable public candidate: ${error instanceof Error ? error.message : String(error)}`,
        token: '',
      });
      continue;
    }
    if (source.includes('\0')) continue;

    let lineStart = 0;
    for (const [index, rawLine] of source.split('\n').entries()) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      for (const match of legacyMatches(line)) {
        const absoluteIndex = lineStart + match.column - 1;
        if (
          !isAllowedCompatibilityUse(path, line) &&
          !(generated && isAllowedGeneratedUse(path, source, absoluteIndex))
        ) {
          violations.push({ path, line: index + 1, ...match });
        }
      }
      lineStart += rawLine.length + 1;
    }

    for (const match of legacyMatches(path)) {
      violations.push({ path, line: 0, ...match, label: `${match.label} in path` });
    }
  }
  return violations;
}

export function verifyHanjiNamespace(options = {}) {
  const root = options.root ?? repoRoot;
  const generated = options.generated === true;
  const files = options.files ?? [
    ...candidateFiles(root),
    ...(generated ? generatedFiles(root) : []),
  ];
  const violations = findHanjiNamespaceViolations({ root, files, generated });
  if (violations.length) {
    throw new Error(
      `Found ${violations.length} unapproved pre-Hanji namespace occurrence(s):\n${violations
        .map((item) => {
          const location = item.line ? `${item.path}:${item.line}:${item.column}` : item.path;
          return `- ${location} ${item.label}${item.token ? ` (${JSON.stringify(item.token)})` : ''}`;
        })
        .join('\n')}`,
    );
  }
  return { files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const unknown = process.argv.slice(2).filter((arg) => arg !== '--generated');
    if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
    const result = verifyHanjiNamespace({ generated: process.argv.includes('--generated') });
    console.log(`PASS Hanji namespace guard (${result.files} public candidate files scanned).`);
  } catch (error) {
    console.error(`FAIL Hanji namespace guard: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
