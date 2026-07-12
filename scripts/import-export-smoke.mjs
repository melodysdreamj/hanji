#!/usr/bin/env node

import { permanentlyDeletePage } from './lib/harness.mjs';

const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));

let owner;
let importedPageId = '';
let importedDatabaseId = '';
let importedChildPageId = '';
let replacedPageId = '';
let organizationId = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL import/export smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`WARN cleanup failed: ${message}`);
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Import/export smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);
  const viewer = await signIn(baseUrl);

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  organizationId = bootstrap?.organization?.id ?? '';
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  assert(organizationId, 'workspace-bootstrap must return an organization id');

  const suffix = Date.now();
  const pageTitle = `Import export markdown ${suffix}`;
  const imported = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'importMarkdownPage',
    workspaceId,
    title: pageTitle,
    markdown: [
      '## Imported heading',
      '#### Imported heading four',
      '> #### Imported toggle heading four',
      '',
      '- Bullet one',
      '  - Nested bullet',
      '- [x] Done item',
      'Styled **bold** and *italic* with [link](https://example.com/import-rich) on [today](hanji://date/2026-06-25) by [Ada](hanji://person/user-ada) as `code` and ~~struck~~',
      '> Quoted line',
      '',
      '$$',
      'a + b = c',
      '$$',
      '',
      '| Feature | Status |',
      '| --- | --- |',
      '| Import | kept |',
      '',
      '[Button: Imported button]',
      '[Table of contents]',
      '[Breadcrumb]',
      '[Synced block]',
      '[Tabs]',
      '  [Tab: I Imported tab]',
      '    Imported tab body',
      '',
      '```js',
      'console.log("hello import");',
      '```',
    ].join('\n'),
  });
  importedPageId = imported?.page?.id;
  assert(importedPageId, 'Markdown import must create a page');
  assert(imported.count >= 14, 'Markdown import must create body blocks');

  const exportedPage = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: importedPageId,
  });
  assertIncludes(exportedPage.markdown, `# ${pageTitle}`, 'exported markdown page');
  assertIncludes(exportedPage.markdown, '## Imported heading', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '#### Imported heading four', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '> #### Imported toggle heading four', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '- Bullet one', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '  - Nested bullet', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '- [x] Done item', 'exported markdown page');
  assertIncludes(
    exportedPage.markdown,
    'Styled **bold** and *italic* with [link](https://example.com/import-rich) on [today](hanji://date/2026-06-25) by [Ada](hanji://person/user-ada) as `code` and ~~struck~~',
    'exported markdown page',
  );
  assertIncludes(exportedPage.markdown, '> Quoted line', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '$$\na + b = c\n$$', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '| Feature | Status |', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '| Import | kept |', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '[Button: Imported button]', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '[Table of contents]', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '[Breadcrumb]', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '[Synced block]', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '[Tabs]', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '  [Tab: I Imported tab]', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '    Imported tab body', 'exported markdown page');
  assertIncludes(exportedPage.markdown, '```js', 'exported markdown page');
  assertIncludes(exportedPage.markdown, 'console.log("hello import");', 'exported markdown page');
  console.log('PASS Markdown import creates a page and export preserves representative blocks.');

  const appendedMarkdown = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'appendMarkdownToPage',
    pageId: importedPageId,
    markdown: [
      '### Appended product API heading',
      '- Appended bullet',
      '  - Appended nested bullet',
      'Appended **bold** text with [today](hanji://date/2026-06-25)',
      '',
      '[Button: Appended button]',
    ].join('\n'),
  });
  assert(appendedMarkdown.count >= 5, 'Markdown append must create appended blocks');
  const exportedAppendedPage = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: importedPageId,
  });
  assertIncludes(exportedAppendedPage.markdown, '## Imported heading', 'exported appended markdown page');
  assertIncludes(exportedAppendedPage.markdown, '### Appended product API heading', 'exported appended markdown page');
  assertIncludes(exportedAppendedPage.markdown, '- Appended bullet', 'exported appended markdown page');
  assertIncludes(exportedAppendedPage.markdown, '  - Appended nested bullet', 'exported appended markdown page');
  assertIncludes(
    exportedAppendedPage.markdown,
    'Appended **bold** text with [today](hanji://date/2026-06-25)',
    'exported appended markdown page',
  );
  assertIncludes(exportedAppendedPage.markdown, '[Button: Appended button]', 'exported appended markdown page');
  await expectFunctionStatus(baseUrl, viewer.token, 'import-export', {
    action: 'appendMarkdownToPage',
    pageId: importedPageId,
    markdown: 'viewer should not append',
  }, 403);
  console.log('PASS Markdown append uses product API permissions and preserves imported blocks.');

  const replaceTarget = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'importMarkdownPage',
    workspaceId,
    title: `Import export replace ${suffix}`,
    markdown: [
      '## Replace original heading',
      'This line should be removed.',
      '- Original bullet',
    ].join('\n'),
  });
  replacedPageId = replaceTarget?.page?.id ?? '';
  assert(replacedPageId, 'Markdown replace fixture must create a page');
  const replacedMarkdown = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'replaceMarkdownPage',
    pageId: replacedPageId,
    markdown: [
      '## Replaced product API heading',
      'Replacement **bold** text with [Ada](hanji://person/user-ada)',
      '',
      '| Mode | Status |',
      '| --- | --- |',
      '| Replace | kept |',
    ].join('\n'),
  });
  assert(replacedMarkdown.count >= 3, 'Markdown replace must create replacement blocks');
  assert(replacedMarkdown.deletedIds?.length >= 3, 'Markdown replace must report deleted old blocks');
  const exportedReplacedPage = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: replacedPageId,
  });
  assertIncludes(exportedReplacedPage.markdown, '## Replaced product API heading', 'exported replaced markdown page');
  assertIncludes(
    exportedReplacedPage.markdown,
    'Replacement **bold** text with [Ada](hanji://person/user-ada)',
    'exported replaced markdown page',
  );
  assertIncludes(exportedReplacedPage.markdown, '| Replace | kept |', 'exported replaced markdown page');
  assert(!exportedReplacedPage.markdown.includes('Replace original heading'), 'replaced markdown page must remove old heading');
  assert(!exportedReplacedPage.markdown.includes('This line should be removed.'), 'replaced markdown page must remove old paragraph');
  await expectFunctionStatus(baseUrl, viewer.token, 'import-export', {
    action: 'replaceMarkdownPage',
    pageId: replacedPageId,
    markdown: 'viewer should not replace',
  }, 403);
  console.log('PASS Markdown replace uses product API permissions and replaces old blocks.');

  const fileBlockId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: fileBlockId,
    pageId: importedPageId,
    parentId: null,
    type: 'file',
    content: { rich: [], url: '', fileName: 'export-page-file.txt' },
    plainText: 'export-page-file.txt',
    position: 50,
  });
  const pageFileUpload = await uploadWorkspaceFile(baseUrl, owner.token, {
    pageId: importedPageId,
    blockId: fileBlockId,
    scope: 'blocks/files',
    name: 'export-page-file.txt',
    content: `export page file ${suffix}`,
    contentType: 'text/plain',
  });
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'update',
    id: fileBlockId,
    pageId: importedPageId,
    patch: {
      content: { rich: [], url: pageFileUpload.url, fileName: pageFileUpload.name },
      plainText: pageFileUpload.name,
    },
  });
  const exportedPageWithFile = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: importedPageId,
  });
  assertIncludes(exportedPageWithFile.markdown, '[File: export-page-file.txt](', 'exported markdown page with file');
  assertIncludes(exportedPageWithFile.markdown, 'token=', 'exported markdown page with signed file URL');

  const childTitle = `Import export child ${suffix}`;
  const importedChild = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'importMarkdownPage',
    workspaceId,
    parentId: importedPageId,
    parentType: 'page',
    title: childTitle,
    markdown: 'Child body paragraph',
  });
  importedChildPageId = importedChild?.page?.id;
  assert(importedChildPageId, 'Markdown import must create a child page');

  const currentBlockIds = {
    heading4: crypto.randomUUID(),
    toggle: crypto.randomUUID(),
    toggleChild: crypto.randomUUID(),
    callout: crypto.randomUUID(),
    equation: crypto.randomUUID(),
    table: crypto.randomUUID(),
    tab: crypto.randomUUID(),
    tabLabel: crypto.randomUUID(),
    tabBody: crypto.randomUUID(),
    button: crypto.randomUUID(),
    toc: crypto.randomUUID(),
    breadcrumb: crypto.randomUUID(),
    synced: crypto.randomUUID(),
    pageLink: crypto.randomUUID(),
    richText: crypto.randomUUID(),
    unsafeRichText: crypto.randomUUID(),
  };
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: currentBlockIds.heading4,
        pageId: importedPageId,
        parentId: null,
        type: 'heading_4',
        content: { rich: [{ text: 'Export heading four' }] },
        plainText: 'Export heading four',
        position: 70,
      },
      {
        id: currentBlockIds.toggle,
        pageId: importedPageId,
        parentId: null,
        type: 'toggle',
        content: { rich: [{ text: 'Toggle export' }] },
        plainText: 'Toggle export',
        position: 71,
      },
      {
        id: currentBlockIds.toggleChild,
        pageId: importedPageId,
        parentId: currentBlockIds.toggle,
        type: 'paragraph',
        content: { rich: [{ text: 'Nested export toggle body' }] },
        plainText: 'Nested export toggle body',
        position: 1,
      },
      {
        id: currentBlockIds.callout,
        pageId: importedPageId,
        parentId: null,
        type: 'callout',
        content: { rich: [{ text: 'Export callout' }], icon: '!' },
        plainText: 'Export callout',
        position: 72,
      },
      {
        id: currentBlockIds.equation,
        pageId: importedPageId,
        parentId: null,
        type: 'equation',
        content: { expression: 'a + b = c' },
        plainText: 'a + b = c',
        position: 73,
      },
      {
        id: currentBlockIds.table,
        pageId: importedPageId,
        parentId: null,
        type: 'simple_table',
        content: { table: [['Feature', 'Status'], ['Tabs', 'kept']], headerRow: true },
        plainText: 'Feature\tStatus\nTabs\tkept',
        position: 74,
      },
      {
        id: currentBlockIds.tab,
        pageId: importedPageId,
        parentId: null,
        type: 'tab',
        content: { rich: [] },
        plainText: '',
        position: 75,
      },
      {
        id: currentBlockIds.tabLabel,
        pageId: importedPageId,
        parentId: currentBlockIds.tab,
        type: 'paragraph',
        content: { rich: [{ text: 'Export tab' }], icon: 'T' },
        plainText: 'Export tab',
        position: 1,
      },
      {
        id: currentBlockIds.tabBody,
        pageId: importedPageId,
        parentId: currentBlockIds.tabLabel,
        type: 'paragraph',
        content: { rich: [{ text: 'Export tab body' }] },
        plainText: 'Export tab body',
        position: 1,
      },
      {
        id: currentBlockIds.button,
        pageId: importedPageId,
        parentId: null,
        type: 'button',
        content: { buttonLabel: 'Export button' },
        plainText: 'Export button',
        position: 76,
      },
      {
        id: currentBlockIds.toc,
        pageId: importedPageId,
        parentId: null,
        type: 'table_of_contents',
        content: {},
        plainText: '',
        position: 77,
      },
      {
        id: currentBlockIds.breadcrumb,
        pageId: importedPageId,
        parentId: null,
        type: 'breadcrumb',
        content: {},
        plainText: '',
        position: 78,
      },
      {
        id: currentBlockIds.synced,
        pageId: importedPageId,
        parentId: null,
        type: 'synced_block',
        content: {},
        plainText: '',
        position: 79,
      },
      {
        id: currentBlockIds.pageLink,
        pageId: importedPageId,
        parentId: null,
        type: 'link_to_page',
        content: { childPageId: importedChildPageId },
        plainText: childTitle,
        position: 80,
      },
      {
        id: currentBlockIds.richText,
        pageId: importedPageId,
        parentId: null,
        type: 'paragraph',
        content: {
          rich: [
            { text: 'Styled ' },
            { text: 'bold', bold: true },
            { text: ' and ' },
            { text: 'italic', italic: true },
            { text: ' with ' },
            { text: 'link', link: 'https://example.com/rich text' },
            { text: ' plus ' },
            { text: 'child mention', mention: 'page', pageId: importedChildPageId },
            { text: ' on ' },
            { text: 'today', mention: 'date', date: '2026-06-25' },
            { text: ' by ' },
            { text: 'Ada', mention: 'person', userId: 'user-ada' },
            { text: ' as ' },
            { text: 'code', code: true },
            { text: ' and ' },
            { text: 'struck', strikethrough: true },
          ],
        },
        plainText: 'Styled bold and italic with link plus child mention on today by Ada as code and struck',
        position: 81,
      },
      {
        id: currentBlockIds.unsafeRichText,
        pageId: importedPageId,
        parentId: null,
        type: 'paragraph',
        content: {
          rich: [
            { text: 'Unsafe export ' },
            { text: 'invalid link', link: 'javascript:alert(1)' },
            { text: ' invalid date', mention: 'date', date: '2026-02-31T29:99:99Z' },
            { text: ' invalid person', mention: 'person', userId: 'bad user' },
            { text: ' invalid page', mention: 'page', pageId: 'bad page id' },
          ],
        },
        plainText: 'Unsafe export invalid link invalid date invalid person invalid page',
        position: 82,
      },
    ],
  });
  const exportedCurrentBlocks = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: importedPageId,
  });
  assertIncludes(exportedCurrentBlocks.markdown, '#### Export heading four', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '> Toggle export', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '  Nested export toggle body', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '> ! Export callout', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '$$\na + b = c\n$$', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '| Feature | Status |', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '[Tabs]', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '  [Tab: T Export tab]', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '    Export tab body', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '[Button: Export button]', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '[Table of contents]', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '[Breadcrumb]', 'exported current block markdown');
  assertIncludes(exportedCurrentBlocks.markdown, '[Synced block]', 'exported current block markdown');
  assertIncludes(
    exportedCurrentBlocks.markdown,
    `[[${childTitle}]](/p/${importedChildPageId})`,
    'exported current block markdown',
  );
  assertIncludes(
    exportedCurrentBlocks.markdown,
    `Styled **bold** and *italic* with [link](https://example.com/rich%20text) plus [child mention](/p/${importedChildPageId}) on [today](hanji://date/2026-06-25) by [Ada](hanji://person/user-ada) as \`code\` and ~~struck~~`,
    'exported current block markdown',
  );
  assertIncludes(
    exportedCurrentBlocks.markdown,
    'Unsafe export invalid link invalid date invalid person invalid page',
    'exported current block markdown',
  );
  assert(!exportedCurrentBlocks.markdown.includes('javascript:alert'), 'export must strip unsafe rich text links');
  assert(!exportedCurrentBlocks.markdown.includes('2026-02-31T29'), 'export must strip invalid date mentions');
  assert(!exportedCurrentBlocks.markdown.includes('bad%20user'), 'export must strip invalid person mentions');
  assert(!exportedCurrentBlocks.markdown.includes('bad%20page%20id'), 'export must strip invalid page mentions');
  console.log('PASS Markdown export preserves current Notion-style block structures.');

  await expectFunctionStatus(baseUrl, viewer.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: importedPageId,
  }, 403);
  console.log('PASS unshared users cannot export private imported pages.');

  const databaseTitle = `Import export csv ${suffix}`;
  const importedDb = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'importCsvDatabase',
    workspaceId,
    title: databaseTitle,
    csv: [
      'Name,Score,Ready,Due,Notes',
      'Alpha,10,true,2026-01-01,"Launch notes"',
      'Beta,3,false,2026-01-02,"Follow up"',
    ].join('\n'),
  });
  importedDatabaseId = importedDb?.page?.id;
  assert(importedDatabaseId, 'CSV import must create a database');
  assert(importedDb.count === 2, 'CSV import must create data rows');
  assert(
    importedDb.properties?.some((prop) => prop.name === 'Score' && prop.type === 'number'),
    'CSV import must infer number properties',
  );
  assert(
    importedDb.properties?.some((prop) => prop.name === 'Ready' && prop.type === 'checkbox'),
    'CSV import must infer checkbox properties',
  );
  assert(
    importedDb.properties?.some((prop) => prop.name === 'Due' && prop.type === 'date'),
    'CSV import must infer date properties',
  );

  const exportedDatabase = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: importedDatabaseId,
  });
  assertIncludes(exportedDatabase.markdown, `# ${databaseTitle}`, 'exported database markdown');
  assertIncludes(exportedDatabase.markdown, '| Name | Score | Ready | Due | Notes |', 'exported database markdown');
  assertIncludes(exportedDatabase.markdown, '| Alpha | 10 | checked | 2026-01-01 | Launch notes |', 'exported database markdown');
  assertIncludes(exportedDatabase.markdown, '| Beta | 3 | unchecked | 2026-01-02 | Follow up |', 'exported database markdown');
  console.log('PASS CSV import creates a typed database and export serializes rows as Markdown.');

  const filePropertyId = crypto.randomUUID();
  const fileProperty = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: filePropertyId,
      databaseId: importedDatabaseId,
      name: 'Attachment',
      type: 'files',
      position: 6,
    },
  });
  assert(fileProperty?.record?.id === filePropertyId, 'database file property must be created');
  const firstRowId = importedDb?.rows?.[0]?.id;
  assert(firstRowId, 'CSV import must return imported row ids');
  const rowFileUpload = await uploadWorkspaceFile(baseUrl, owner.token, {
    pageId: firstRowId,
    databaseId: importedDatabaseId,
    propertyId: filePropertyId,
    scope: 'database/files',
    name: 'export-row-file.txt',
    content: `export row file ${suffix}`,
    contentType: 'text/plain',
  });
  await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'update',
    id: firstRowId,
    patch: {
      properties: {
        [filePropertyId]: [
          {
            id: rowFileUpload.key,
            key: rowFileUpload.key,
            name: rowFileUpload.name,
            url: rowFileUpload.url,
            type: rowFileUpload.contentType,
            size: rowFileUpload.size,
          },
        ],
      },
    },
  });
  const rowBodyText = `Database row page body survives export ${suffix}`;
  const rowChildTitle = `Database row child ${suffix}`;
  const rowChildBodyText = `Database row child body survives export ${suffix}`;
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: firstRowId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: rowBodyText }] },
    plainText: rowBodyText,
    position: 1,
  });
  const rowChild = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    workspaceId,
    parentId: firstRowId,
    parentType: 'page',
    kind: 'page',
    title: rowChildTitle,
    position: suffix + 2,
  });
  const rowChildPageId = rowChild?.page?.id;
  assert(rowChildPageId, 'database row child page must be created for export coverage');
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: rowChildPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: rowChildBodyText }] },
    plainText: rowChildBodyText,
    position: 1,
  });
  const exportedDatabaseWithFile = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId: importedDatabaseId,
  });
  assertIncludes(exportedDatabaseWithFile.markdown, 'Attachment', 'exported database markdown with file');
  assertIncludes(exportedDatabaseWithFile.markdown, '[export-row-file.txt](', 'exported database markdown with file');
  assertIncludes(exportedDatabaseWithFile.markdown, 'token=', 'exported database markdown with signed file URL');
  assertIncludes(exportedDatabaseWithFile.markdown, '\n## Alpha\n', 'exported database row page markdown');
  assertIncludes(exportedDatabaseWithFile.markdown, rowBodyText, 'exported database row page markdown');
  assertIncludes(exportedDatabaseWithFile.markdown, `\n### ${rowChildTitle}\n`, 'exported database row child page markdown');
  assertIncludes(exportedDatabaseWithFile.markdown, rowChildBodyText, 'exported database row child page markdown');
  console.log('PASS file attachments and database row-page trees export as Markdown.');

  const exportedDatabaseCsv = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportDatabaseCsv',
    databaseId: importedDatabaseId,
  });
  assertIncludes(exportedDatabaseCsv.csv, 'Name,Score,Ready,Due,Notes,Attachment', 'exported database csv');
  assertIncludes(exportedDatabaseCsv.csv, 'Alpha,10,true,2026-01-01,Launch notes', 'exported database csv');
  assertIncludes(exportedDatabaseCsv.csv, 'export-row-file.txt', 'exported database csv');
  assertIncludes(exportedDatabaseCsv.csv, 'token=', 'exported database csv signed file URL');
  await expectFunctionStatus(baseUrl, viewer.token, 'import-export', {
    action: 'exportDatabaseCsv',
    databaseId: importedDatabaseId,
  }, 403);
  console.log('PASS CSV export serializes typed databases with signed file links and permissions.');

  const exportedWorkspace = await callFunction(baseUrl, owner.token, 'import-export', {
    action: 'exportWorkspaceMarkdown',
    workspaceId,
  });
  assert(exportedWorkspace.pageCount >= 3, 'workspace export must include root and child pages');
  assertIncludes(exportedWorkspace.markdown, `## ${pageTitle}`, 'exported workspace markdown');
  assertIncludes(exportedWorkspace.markdown, `### ${childTitle}`, 'exported workspace markdown');
  assertIncludes(exportedWorkspace.markdown, `## ${databaseTitle}`, 'exported workspace markdown');
  assertIncludes(exportedWorkspace.markdown, '| Name | Score | Ready | Due | Notes |', 'exported workspace markdown');
  assertIncludes(exportedWorkspace.markdown, `\n### Alpha\n`, 'exported workspace database row page markdown');
  assertIncludes(exportedWorkspace.markdown, rowBodyText, 'exported workspace database row page markdown');
  assertIncludes(exportedWorkspace.markdown, `\n#### ${rowChildTitle}\n`, 'exported workspace database row child page markdown');
  assertIncludes(exportedWorkspace.markdown, rowChildBodyText, 'exported workspace database row child page markdown');

  await expectFunctionStatus(baseUrl, viewer.token, 'import-export', {
    action: 'exportWorkspaceMarkdown',
    workspaceId,
  }, 403);
  console.log('PASS workspace export includes nested pages/databases and rejects unshared users.');

  const pageExportAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'export.page_markdown',
    auditLimit: 10,
  });
  assert(
    pageExportAudit?.organizationAuditEvents?.some(
      (event) =>
        event.targetId === importedPageId &&
        event.metadata?.pageId === importedPageId &&
        event.metadata?.pageCount >= 1,
    ),
    'page Markdown export must record a filterable organization audit event',
  );
  const databaseCsvExportAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'export.database_csv',
    auditLimit: 10,
  });
  assert(
    databaseCsvExportAudit?.organizationAuditEvents?.some(
      (event) =>
        event.targetId === importedDatabaseId &&
        event.metadata?.databaseId === importedDatabaseId &&
        event.metadata?.rowCount === 2,
    ),
    'database CSV export must record a filterable organization audit event',
  );
  const workspaceExportAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'export.workspace_markdown',
    auditLimit: 10,
  });
  assert(
    workspaceExportAudit?.organizationAuditEvents?.some(
      (event) => event.targetId === workspaceId && event.metadata?.pageCount >= 3,
    ),
    'workspace Markdown export must record a filterable organization audit event',
  );
  console.log('PASS export operations record filterable organization audit events.');

  const deletedChild = await permanentlyDeletePage(baseUrl, owner.token, importedChildPageId, { call: callFunction });
  assert(
    Array.isArray(deletedChild?.deletedIds) && deletedChild.deletedIds.includes(importedChildPageId),
    'permanent page delete must delete the selected child page',
  );
  const pageDeleteAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'page.delete',
    auditLimit: 10,
  });
  assert(
    pageDeleteAudit?.organizationAuditEvents?.some(
      (event) =>
        event.targetId === importedChildPageId &&
        event.metadata?.pageId === importedChildPageId &&
        event.metadata?.deletedPageCount === 1,
    ),
    'permanent page delete must record a filterable organization audit event',
  );
  importedChildPageId = '';
  console.log('PASS permanent page deletes record filterable organization audit events.');

  console.log('\nPASS import/export works through product APIs.');
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);
  for (const pageId of [importedDatabaseId, importedPageId, importedChildPageId, replacedPageId].filter(Boolean)) {
    await permanentlyDeletePage(baseUrl, owner.token, pageId, { call: callFunction }).catch(() => {});
  }
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/import-export-smoke.mjs [options]

Checks Markdown page import/export, CSV database import/export, workspace
Markdown export, and private export permission denial against a running
Hanji EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  });
  assert(response.ok, `/api/health returned HTTP ${response.status}`);
}

async function signIn(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  const token = body?.accessToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'anonymous sign-in must return an access token');
  assert(typeof userId === 'string' && userId, 'anonymous sign-in must return a user id');
  return { token, userId };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `${name} returned HTTP ${response.status} for ${JSON.stringify(body).slice(0, 300)}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function expectFunctionStatus(baseUrl, token, name, body, status) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(`${name} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function uploadWorkspaceFile(baseUrl, token, input) {
  const bytes = new TextEncoder().encode(input.content);
  const prepared = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'prepareUpload',
    pageId: input.pageId,
    blockId: input.blockId,
    databaseId: input.databaseId,
    propertyId: input.propertyId,
    scope: input.scope,
    name: input.name,
    size: bytes.byteLength,
    contentType: input.contentType,
  });
  const upload = prepared?.upload;
  assert(upload?.id && upload?.key, 'prepareUpload must return an upload id and key');
  assert(prepared.uploadUrl, 'prepareUpload must return a signed upload URL');

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: input.contentType }), upload.key);
  form.append('key', upload.key);
  form.append('customMetadata', JSON.stringify({
    uploadId: upload.id,
    workspaceId: upload.workspaceId,
    pageId: upload.pageId ?? '',
    blockId: upload.blockId ?? '',
    databaseId: upload.databaseId ?? '',
    propertyId: upload.propertyId ?? '',
    originalName: input.name,
  }));

  const uploadResponse = await fetchWithTimeout(prepared.uploadUrl, {
    method: 'POST',
    body: form,
  });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`signed file upload returned HTTP ${uploadResponse.status}: ${text.slice(0, 200)}`);
  }

  const url = storageUrl(baseUrl, upload.bucket || 'files', upload.key);
  const completed = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'completeUpload',
    id: upload.id,
    key: upload.key,
    url,
  });
  const completedUpload = completed?.upload;
  assert(completedUpload?.status === 'uploaded', 'completeUpload must mark the file uploaded');
  return completedUpload;
}

function storageUrl(baseUrl, bucket, key) {
  return `${baseUrl}/api/storage/${encodeURIComponent(bucket)}/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

async function postFunction(baseUrl, token, name, body) {
  return fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function resolveUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function normalizeBaseUrl(url) {
  return String(url ?? '').replace(/\/$/, '') || DEFAULT_BASE_URL;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, expected, label) {
  if (typeof text !== 'string' || !text.includes(expected)) {
    throw new Error(`${label} did not include "${expected}":\n${text}`);
  }
}
