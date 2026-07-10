#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = join(root, '.edgebase', 'ui-discovery', 'popover-layer-audit');
const statusRank = { pass: 0, watch: 1, fail: 2 };

const highRiskChecks = [
  {
    id: 'editor.block-actions',
    surface: 'Editor block action menu',
    why: 'Block handles are used inside row peeks and transformed panels.',
    requirements: [
      requirement('web/src/components/editor/BlockHandle.tsx', /createPortal\(children,\s*document\.body\)/, 'menu layer portals to document.body'),
      requirement('web/src/components/editor/editor.module.css', /\.blockMenu\s*\{[^}]*?z-index:\s*1001\b/, 'menu z-index sits above row peek'),
      requirement('web/src/components/editor/editor.module.css', /\.blockMenuBackdrop\s*\{[^}]*?z-index:\s*1000\b/, 'backdrop z-index sits above row peek'),
    ],
  },
  {
    id: 'editor.slash-menu',
    surface: 'Slash command menu',
    why: 'Slash menus use viewport coordinates from the caret.',
    requirements: [
      requirement('web/src/components/editor/SlashMenu.tsx', /createPortal\(menu,\s*document\.body\)/, 'slash menu portals to document.body'),
      requirement('web/src/components/editor/editor.module.css', /\.slash\s*\{[^}]*?z-index:\s*1003\b/, 'slash menu uses top popover z-index'),
    ],
  },
  {
    id: 'editor.mention-menu',
    surface: 'Text mention menu',
    why: 'Mention menus use viewport coordinates from the caret and can appear in row peek bodies.',
    requirements: [
      requirement('web/src/components/editor/BlockItem.tsx', /function MentionMenu[\s\S]*?createPortal\(picker,\s*document\.body\)/, 'mention menu portals to document.body'),
      requirement('web/src/components/editor/BlockItem.tsx', /function MentionMenu[\s\S]*?position:\s*"fixed"/, 'mention menu uses viewport positioning'),
      requirement('web/src/components/editor/BlockItem.tsx', /className=\{`\$\{styles\.menuBackdrop\} \$\{styles\.editorFloatingBackdrop\}`\}/, 'mention backdrop uses the editor floating layer'),
      requirement('web/src/components/editor/editor.module.css', /\.editorFloatingBackdrop\s*\{[^}]*?z-index:\s*60\b/, 'editor floating backdrop sits above row peek panels'),
    ],
  },
  {
    id: 'editor.text-floating-menus',
    surface: 'Text link/date/person/page/pasted URL menus',
    why: 'Inline text popovers use viewport coordinates from text ranges and mentions.',
    requirements: [
      requirement('web/src/components/editor/BlockItem.tsx', /function TextFloatingMenuPortal[\s\S]*?createPortal\(children,\s*document\.body\)/, 'shared text floating menu portal renders to document.body'),
      countRequirement('web/src/components/editor/BlockItem.tsx', /<TextFloatingMenuPortal>/g, 5, 'all five text floating menu call sites use the portal'),
      requirement('web/src/components/editor/editor.module.css', /\.inlineLinkMenu\s*\{[^}]*?position:\s*fixed\b/, 'inline link menu uses viewport positioning'),
      requirement('web/src/components/editor/editor.module.css', /\.inlineDateMenu\s*\{[^}]*?position:\s*fixed\b/, 'inline date menu uses viewport positioning'),
      requirement('web/src/components/editor/editor.module.css', /\.inlinePersonMenu\s*\{[^}]*?position:\s*fixed\b/, 'inline person menu uses viewport positioning'),
      requirement('web/src/components/editor/editor.module.css', /\.inlinePageMenu\s*\{[^}]*?position:\s*fixed\b/, 'inline page menu uses viewport positioning'),
      requirement('web/src/components/editor/editor.module.css', /\.pastedUrlMenu\s*\{[^}]*?position:\s*fixed\b/, 'pasted URL menu uses viewport positioning'),
    ],
  },
  {
    id: 'editor.database-source-picker',
    surface: 'Inline database source picker',
    why: 'Database source picker uses viewport coordinates from block insertion points.',
    requirements: [
      requirement('web/src/components/editor/BlockItem.tsx', /function DatabaseSourcePicker[\s\S]*?createPortal\(picker,\s*document\.body\)/, 'database source picker portals to document.body'),
      requirement('web/src/components/editor/BlockItem.tsx', /editorFloatingBackdrop[\s\S]*?aria-label="Close database source picker"/, 'database source picker backdrop uses the editor floating layer'),
    ],
  },
  {
    id: 'editor.inline-database-actions',
    surface: 'Inline database actions menu',
    why: 'Inline databases can appear inside page bodies and row peek bodies.',
    requirements: [
      requirement('web/src/components/editor/BlockItem.tsx', /createPortal\(inlineDatabaseActionsMenu,\s*document\.body\)/, 'inline database actions menu portals to document.body'),
      requirement('web/src/components/editor/editor.module.css', /\.inlineDatabaseMenu\s*\{[^}]*?z-index:\s*1003\b/, 'inline database menu uses top popover z-index'),
    ],
  },
  {
    id: 'database.row-menu',
    surface: 'Database row/page action menu',
    why: 'Row action menus can open from tables, boards, and inline page references.',
    requirements: [
      requirement('web/src/components/RowMenu.tsx', /createPortal\(surface,\s*document\.body\)/, 'anchored row menu portals to document.body'),
      requirement('web/src/components/RowMenu.module.css', /\.contextMenu\s*\{[^}]*?position:\s*fixed\b/, 'anchored row menu uses viewport positioning'),
    ],
  },
  {
    id: 'database.property-cell',
    surface: 'Database property cell editor menu',
    why: 'Cell editors can open in tables embedded in page bodies.',
    requirements: [
      requirement('web/src/components/database/PropertyCell.tsx', /createPortal\([\s\S]*?document\.body/, 'property cell menu portals to document.body'),
    ],
  },
  {
    id: 'database.table-property-menus',
    surface: 'Table header/add-property/summary menus',
    why: 'Table menus use viewport coordinates and may appear inside inline databases.',
    requirements: [
      countRequirement('web/src/components/database/TableView.tsx', /createPortal\(/g, 3, 'table view menu layers portal to document.body'),
    ],
  },
  {
    id: 'database.view-menus',
    surface: 'Database view toolbar and row peek layers',
    why: 'Database view chrome contains toolbar menus, row peek, template menus, and dialogs.',
    requirements: [
      countRequirement('web/src/components/database/DatabaseView.tsx', /createPortal\(/g, 5, 'database view floating layers portal to document.body'),
    ],
  },
  {
    id: 'database.template-block-actions',
    surface: 'Database template editor block action menu',
    why: 'Template editor body rows should reuse the shared editor BlockHandle layer contract.',
    requirements: [
      requirement('web/src/components/database/DatabaseView.tsx', /data-template-shared-editor="true"/, 'template editor mounts the shared Editor surface'),
      requirement('web/src/components/database/DatabaseView.tsx', /<Editor[\s\S]*?templateMode/, 'template editor routes body editing through the shared Editor'),
      requirement('web/src/components/editor/BlockHandle.tsx', /createPortal\(children,\s*document\.body\)/, 'shared block action menu portals to document.body'),
      requirement('web/src/components/editor/editor.module.css', /\.blockMenu\s*\{[^}]*?z-index:\s*1001\b/, 'shared block action menu sits above row peek/template editor layers'),
    ],
  },
  {
    id: 'database.shared-selects',
    surface: 'Shared database select and board menus',
    why: 'Select/group menus can be embedded in row details and database views.',
    requirements: [
      requirement('web/src/components/database/NotionSelect.tsx', /createPortal\(menuLayer,\s*document\.body\)/, 'NotionSelect menu portals to document.body'),
      requirement('web/src/components/database/BoardView.tsx', /createPortal\(/, 'board group menu portals to document.body'),
    ],
  },
];

const watchChecks = [
  {
    id: 'editor.page-link-picker',
    surface: 'Page-link block picker',
    why: 'This is row-local absolute UI, so it should stay near the block instead of using viewport coordinates.',
    requirements: [
      requirement('web/src/components/editor/editor.module.css', /\.pageLinkPicker\s*\{[^}]*?position:\s*absolute\b/, 'page link picker remains local absolute UI'),
    ],
  },
  {
    id: 'editor.block-selection-toolbar',
    surface: 'Multi-block selection toolbar',
    why: 'This toolbar intentionally sticks to the visible screen/panel bottom.',
    requirements: [
      requirement('web/src/components/editor/editor.module.css', /\.blockSelectionToolbar\s*\{[^}]*?position:\s*fixed\b/, 'selection toolbar is intentionally fixed'),
      requirement('web/src/components/editor/editor.module.css', /\.blockSelectionMenu\s*\{[^}]*?position:\s*fixed\b/, 'selection toolbar submenus are intentionally fixed'),
    ],
  },
  {
    id: 'database.row-properties-local-menus',
    surface: 'Row property add/edit menus',
    why: 'These menus are local row-detail menus rather than viewport-anchored menus.',
    requirements: [
      requirement('web/src/components/database/RowProperties.tsx', /className=\{styles\.rowPropertyMenu\}/, 'row property menu remains local to row detail'),
      requirement('web/src/components/database/RowProperties.tsx', /createPortal\(renderCustomizeMenu\(\),\s*document\.body\)/, 'floating customize-only menu portals to document.body'),
    ],
  },
  {
    id: 'topbar.crumb-menu',
    surface: 'Top bar breadcrumb menu',
    why: 'Top bar menus are outside row peek/editor transformed panels.',
    requirements: [
      requirement('web/src/components/TopBar.tsx', /position:\s*"fixed"/, 'breadcrumb menu uses viewport positioning in the top bar'),
    ],
  },
];

const sourceCandidates = scanPotentialViewportMenus();
const fixedCssSelectors = scanFixedCssSelectors();
const checks = [
  ...highRiskChecks.map((check) => evaluateCheck(check, 'fail')),
  ...watchChecks.map((check) => evaluateCheck(check, 'watch')),
];
checks.sort((a, b) => statusRank[b.status] - statusRank[a.status] || a.id.localeCompare(b.id));

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    checks: checks.length,
    failed: checks.filter((check) => check.status === 'fail').length,
    passed: checks.filter((check) => check.status === 'pass').length,
    watch: checks.filter((check) => check.status === 'watch').length,
    sourceCandidates: sourceCandidates.length,
    fixedCssSelectors: fixedCssSelectors.length,
  },
  checks,
  sourceCandidates,
  fixedCssSelectors,
};

mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, 'popover-layer-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(artifactDir, 'popover-layer-audit.md'), renderMarkdown(report));

const failures = checks.filter((check) => check.status === 'fail');
assert(
  failures.length === 0,
  `Popover layer audit found ${failures.length} high-risk failure(s). See ${relative(root, artifactDir)}/popover-layer-audit.md`,
);

console.log(
  `PASS popover layer audit: ${report.summary.passed} pass, ${report.summary.watch} watch, ${report.summary.fixedCssSelectors} fixed CSS selectors catalogued.`,
);
console.log(`Report: ${relative(root, join(artifactDir, 'popover-layer-audit.md'))}`);

function requirement(file, pattern, label) {
  return { kind: 'pattern', file, pattern, label };
}

function countRequirement(file, pattern, minimum, label) {
  return { kind: 'count', file, pattern, minimum, label };
}

function evaluateCheck(check, failureStatus) {
  const results = check.requirements.map(evaluateRequirement);
  const missing = results.filter((result) => !result.pass);
  return {
    ...check,
    status: missing.length === 0 ? (failureStatus === 'watch' ? 'watch' : 'pass') : failureStatus,
    requirements: results,
  };
}

function evaluateRequirement(req) {
  const text = readRepoFile(req.file);
  if (req.kind === 'count') {
    const matches = [...text.matchAll(req.pattern)];
    return {
      file: req.file,
      label: req.label,
      pass: matches.length >= req.minimum,
      line: matches[0] ? lineForIndex(text, matches[0].index ?? 0) : null,
      observed: matches.length,
      expected: `>= ${req.minimum}`,
    };
  }
  const match = text.match(req.pattern);
  return {
    file: req.file,
    label: req.label,
    pass: !!match,
    line: match ? lineForIndex(text, match.index ?? 0) : null,
  };
}

function scanPotentialViewportMenus() {
  const componentRoot = join(root, 'web', 'src', 'components');
  const files = walk(componentRoot).filter((file) => file.endsWith('.tsx'));
  return files
    .map((file) => {
      const text = readFileSync(file, 'utf8');
      const hasViewportAnchor = /getBoundingClientRect\(/.test(text);
      const hasFixedInlineStyle = /position:\s*["']fixed["']/.test(text);
      const hasPortal = /createPortal\(/.test(text);
      const hasMenuLikeState = /(menu|Menu|popover|Popover|picker|Picker|dialog|Dialog|anchor|Anchor)/.test(text);
      if (!hasMenuLikeState || (!hasViewportAnchor && !hasFixedInlineStyle)) return null;
      return {
        file: relative(root, file),
        hasViewportAnchor,
        hasFixedInlineStyle,
        hasPortal,
        status: hasPortal ? 'covered' : 'watch',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.file.localeCompare(b.file));
}

function scanFixedCssSelectors() {
  const cssFiles = walk(join(root, 'web', 'src', 'components')).filter((file) => file.endsWith('.css'));
  const selectors = [];
  for (const file of cssFiles) {
    const text = readFileSync(file, 'utf8');
    const matches = text.matchAll(/([^{}]+)\{[^{}]*position:\s*fixed\s*;[^{}]*\}/g);
    for (const match of matches) {
      selectors.push({
        file: relative(root, file),
        line: lineForIndex(text, match.index ?? 0),
        selector: match[1].replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return selectors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function renderMarkdown(report) {
  const lines = [
    '# Popover Layer Audit',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Summary: ${report.summary.passed} pass, ${report.summary.watch} watch, ${report.summary.failed} fail.`,
    '',
    '## Checked Surfaces',
    '',
  ];

  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.surface}`);
    lines.push(`  - Why: ${check.why}`);
    for (const req of check.requirements) {
      const where = req.line ? `${req.file}:${req.line}` : req.file;
      const observed = req.observed === undefined ? '' : ` (${req.observed}/${req.expected})`;
      lines.push(`  - ${req.pass ? 'ok' : 'missing'} ${req.label}${observed} - ${where}`);
    }
  }

  lines.push('', '## Source Candidates', '');
  for (const candidate of report.sourceCandidates) {
    lines.push(
      `- ${candidate.status}: ${candidate.file} ` +
        `(rect=${candidate.hasViewportAnchor}, fixedStyle=${candidate.hasFixedInlineStyle}, portal=${candidate.hasPortal})`,
    );
  }

  lines.push('', '## Fixed CSS Selectors', '');
  for (const selector of report.fixedCssSelectors) {
    lines.push(`- ${selector.file}:${selector.line} ${selector.selector}`);
  }

  return `${lines.join('\n')}\n`;
}

function readRepoFile(file) {
  return readFileSync(join(root, file), 'utf8');
}

function lineForIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else results.push(full);
  }
  return results;
}
