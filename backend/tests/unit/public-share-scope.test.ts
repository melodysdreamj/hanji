import { describe, expect, it, vi } from 'vitest';
import {
  POST,
  collectPublicShareFileReferences,
  collectPublicSharePageGraph,
  sanitizePublicShareValue,
  sharedUploadMap,
  signSharedFileUrls,
  visiblePermissionsForActor,
} from '../../functions/share-mutation';
import type { FileUpload } from '../../lib/app-types';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

function snapshotPage(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Page ${id}`,
    position: 0,
    inTrash: false,
    isPublic: false,
    ...extra,
  };
}

async function publicSnapshot(database: FakeDb, token: string) {
  const uploads = database.tables.file_uploads ?? [];
  const result = await handlerOf(POST)({
    auth: null,
    admin: { db: () => database },
    storage: {
      bucket() { return this; },
      async head(key: string) {
        const upload = uploads.find((item) => item.key === key);
        if (!upload) return null;
        return {
          key,
          size: upload.size as number,
          contentType: upload.contentType as string,
          etag: upload.etag as string,
        };
      },
      async getSignedUrl(key: string) {
        return `https://signed.example/${encodeURIComponent(key)}`;
      },
    },
    request: new Request('http://localhost:8787/functions/share-mutation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publicPage', token }),
    }),
  });
  if (result instanceof Response) {
    throw new Error(`publicPage failed (${result.status}): ${await result.text()}`);
  }
  return result as Record<string, unknown>;
}

const PUBLIC_INTERNAL_AUDIT_KEYS = new Set([
  'createdby',
  'updatedby',
  'lasteditedby',
  'verifiedby',
  'deletedby',
  'trashedby',
  'archivedby',
  'createdat',
  'updatedat',
  'lasteditedat',
  'deletedat',
  'trashedat',
  'archivedat',
  'deletionpendingat',
]);

function expectNoPublicInternalAuditFields(value: unknown) {
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    const isPublicPageDto = typeof record.id === 'string' && typeof record.workspaceId === 'string';
    for (const [key, item] of Object.entries(record)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (isPublicPageDto && (normalized === 'createdat' || normalized === 'updatedat')) {
        expect(typeof item).toBe('string');
        continue;
      }
      if (isPublicPageDto && (normalized === 'createdby' || normalized === 'lasteditedby')) {
        expect(item).toEqual(expect.stringMatching(/^public-person:/));
        continue;
      }
      expect(PUBLIC_INTERNAL_AUDIT_KEYS.has(normalized), `public payload leaked ${key}`).toBe(false);
      visit(item);
    }
  };
  visit(value);
}

// #3: A public share link must not leak private pages reached only via a
// link_to_page / child_page block. Only independently-published targets may be
// followed; genuine descendants of the shared root still inherit its visibility.
describe('public share page graph gating (#3)', () => {
  function graphFor(pages: Row[], blocks: Row[], rootId: string) {
    const db = fakeDb({ pages, blocks });
    return collectPublicSharePageGraph(pages as never, db.table('blocks') as never, rootId);
  }

  const ws = 'ws1';

  it('does not follow a link_to_page (alias) into a private (non-public) page or its subtree', async () => {
    const pages: Row[] = [
      { id: 'root', workspaceId: ws, isPublic: true, inTrash: false, parentId: null },
      { id: 'private', workspaceId: ws, isPublic: false, inTrash: false, parentId: null },
      { id: 'privateChild', workspaceId: ws, isPublic: false, inTrash: false, parentId: 'private' },
    ];
    const blocks: Row[] = [
      { id: 'b1', pageId: 'root', type: 'link_to_page', content: { childPageId: 'private' } },
    ];
    const { pageIds } = await graphFor(pages, blocks, 'root');
    expect(pageIds.has('root')).toBe(true);
    expect(pageIds.has('private')).toBe(false);
    expect(pageIds.has('privateChild')).toBe(false);
  });

  it('does not follow a child_page into a non-descendant, non-public page (block.content is unvalidated)', async () => {
    // A child_page block can reference an arbitrary page id, so a workspace member
    // could otherwise publish any private workspace page by embedding its id in a
    // page they share. A non-descendant target that is not independently published
    // must NOT be pulled into the public graph.
    const pages: Row[] = [
      { id: 'root', workspaceId: ws, isPublic: true, inTrash: false, parentId: null },
      { id: 'embedded', workspaceId: ws, isPublic: false, inTrash: false, parentId: null },
    ];
    const blocks: Row[] = [
      { id: 'b1', pageId: 'root', type: 'child_page', content: { childPageId: 'embedded' } },
    ];
    const { pageIds } = await graphFor(pages, blocks, 'root');
    expect(pageIds.has('embedded')).toBe(false);
  });

  it('follows a child_page into an independently-published target', async () => {
    const pages: Row[] = [
      { id: 'root', workspaceId: ws, isPublic: true, inTrash: false, parentId: null },
      { id: 'pubEmbed', workspaceId: ws, isPublic: true, inTrash: false, parentId: null },
    ];
    const blocks: Row[] = [
      { id: 'b1', pageId: 'root', type: 'child_page', content: { childPageId: 'pubEmbed' } },
    ];
    const { pageIds } = await graphFor(pages, blocks, 'root');
    expect(pageIds.has('pubEmbed')).toBe(true);
  });

  it('follows a link_to_page into an independently-published page and its subtree', async () => {
    const pages: Row[] = [
      { id: 'root', workspaceId: ws, isPublic: true, inTrash: false, parentId: null },
      { id: 'pub', workspaceId: ws, isPublic: true, inTrash: false, parentId: null },
      { id: 'pubChild', workspaceId: ws, isPublic: false, inTrash: false, parentId: 'pub' },
    ];
    const blocks: Row[] = [
      { id: 'b1', pageId: 'root', type: 'link_to_page', content: { childPageId: 'pub' } },
    ];
    const { pageIds } = await graphFor(pages, blocks, 'root');
    expect(pageIds.has('pub')).toBe(true);
    // The published target's own subtree is shared by inheritance.
    expect(pageIds.has('pubChild')).toBe(true);
  });

  it('still includes genuine descendants of the shared root regardless of their own isPublic', async () => {
    const pages: Row[] = [
      { id: 'root', workspaceId: ws, isPublic: true, inTrash: false, parentId: null },
      { id: 'sub', workspaceId: ws, isPublic: false, inTrash: false, parentId: 'root' },
    ];
    const { pageIds } = await graphFor(pages, [], 'root');
    expect(pageIds.has('sub')).toBe(true);
  });
});

describe('public share sensitive-file boundary', () => {
  const localUrl = '/api/storage/files/workspaces/ws1/uploads/file.pdf';
  const signedSource = 'https://files.example/file.pdf?token=private-bearer';

  it('drops private Notion staging metadata and credential-bearing source URLs', () => {
    const sanitized = sanitizePublicShareValue({
      title: 'Shared report',
      url: localUrl,
      sourceUrl: signedSource,
      notionFileReference: {
        uploadId: 'upload-1',
        key: 'workspaces/ws1/uploads/file.pdf',
        url: localUrl,
        sourceUrl: signedSource,
      },
      notionBlock: { file: { url: signedSource } },
      __notion: { Files: { files: [{ file: { url: signedSource } }] } },
      ordinaryLink: 'https://example.com/report',
    }, { fileDownloadsAllowed: true });

    expect(sanitized).toMatchObject({
      title: 'Shared report',
      url: localUrl,
      ordinaryLink: 'https://example.com/report',
      notionFileReference: {
        url: localUrl,
      },
    });
    expect(sanitized).not.toHaveProperty('sourceUrl');
    expect(sanitized).not.toHaveProperty('notionBlock');
    expect(sanitized).not.toHaveProperty('__notion');
    expect(JSON.stringify(sanitized)).not.toContain('private-bearer');
  });

  it('drops camelCase and nested secret-bearing keys without matching ordinary words', () => {
    const sanitized = sanitizePublicShareValue({
      title: 'Public integration guide',
      clientSecret: 'synthetic-client-secret',
      nested: [{
        oauthToken: 'synthetic-oauth-token',
        bearerToken: 'synthetic-bearer-token',
        webhookSecret: 'synthetic-webhook-secret',
        passwordHash: 'synthetic-password-hash',
        sessionCookie: 'synthetic-session-cookie',
        credentialId: 'synthetic-credential-id',
        authorizationHeader: 'Bearer synthetic',
        APIKey: 'synthetic-api-key',
        apiKeyValue: 'synthetic-api-key-value',
        xApiKeyHeader: 'synthetic-api-key-header',
        clientapikey: 'synthetic-lowercase-api-key',
        clientsecret: 'synthetic-lowercase-secret',
        passwordhash: 'synthetic-lowercase-password-hash',
        authorizationheader: 'Bearer synthetic lowercase',
        signedUrl: 'https://files.example/private?signature=synthetic',
        signedUrlExpiresAt: '2030-01-01T00:00:00.000Z',
        downloadSignedUrlExpiry: '2030-01-01T00:00:00.000Z',
        secretaryName: 'Synthetic Secretary',
        tokenizationModel: 'wordpiece',
        tokenCount: 3,
        designToken: 'surface-muted',
        cookiePolicy: 'essential-only',
        passwordlessEnabled: true,
        clientSecretaryName: 'Synthetic Client Secretary',
        authTokenizationModel: 'wordpiece-v2',
        tokens: ['synthetic-token'],
        secrets: ['synthetic-secret'],
        credentials: ['synthetic-credential'],
        passwords: ['synthetic-password'],
        jwt: 'synthetic-jwt',
        bearer: 'synthetic-bearer',
        samlResponse: 'synthetic-saml-response',
        clientAssertion: 'synthetic-client-assertion',
        oauthVerifier: 'synthetic-oauth-verifier',
        secretvalue: 'synthetic-secret-value',
        tokenvalue: 'synthetic-token-value',
        cookievalue: 'synthetic-cookie-value',
        clientsecrets: ['synthetic-client-secret'],
        authtokens: ['synthetic-auth-token'],
        usercredentials: ['synthetic-user-credential'],
        accesstokenhash: 'synthetic-access-token-hash',
        refreshtokenhash: 'synthetic-refresh-token-hash',
        clientsecrethash: 'synthetic-client-secret-hash',
        tokenhash: 'synthetic-token-hash',
        secretvaluehash: 'synthetic-secret-value-hash',
        sessioncookiehash: 'synthetic-cookie-hash',
        xapikeyhash: 'synthetic-api-key-hash',
      }],
    });

    expect(sanitized).toEqual({
      title: 'Public integration guide',
      nested: [{
        secretaryName: 'Synthetic Secretary',
        tokenizationModel: 'wordpiece',
        tokenCount: 3,
        designToken: 'surface-muted',
        cookiePolicy: 'essential-only',
        passwordlessEnabled: true,
        clientSecretaryName: 'Synthetic Client Secretary',
        authTokenizationModel: 'wordpiece-v2',
      }],
    });
  });

  it('projects imported Notion people to response-local aliases without raw identity metadata', () => {
    const importedPerson = {
      id: 'notion-user:synthetic-notion-person-id',
      userId: 'notion-user:synthetic-notion-person-id',
      notionUserId: 'synthetic-notion-person-id',
      displayName: 'Synthetic Person',
      email: 'synthetic.person@example.com',
      avatarUrl: 'https://cdn.example/avatar.png',
      notionUserType: 'person',
      notion: {
        id: 'synthetic-notion-person-id',
        type: 'person',
        name: 'Synthetic Person',
        avatar_url: 'https://cdn.example/avatar.png',
        person: { email: 'synthetic.person@example.com' },
      },
    };
    const sanitized = sanitizePublicShareValue({
      block: {
        content: {
          rich: [{
            text: 'Synthetic Person',
            mention: 'person',
            userId: importedPerson.userId,
            notionUser: importedPerson,
            notionMention: { type: 'user', user: importedPerson.notion },
          }],
        },
      },
      row: {
        properties: {
          people: [importedPerson],
          'prop-created-by': importedPerson,
        },
      },
      importedRenderConfig: {
        notion: {
          number: { format: 'dollar' },
          date: { type: 'date' },
          chart: { type: 'bar' },
        },
      },
      unsafeAvatarPerson: {
        ...importedPerson,
        notionUserId: 'synthetic-second-person-id',
        id: 'notion-user:synthetic-second-person-id',
        userId: 'notion-user:synthetic-second-person-id',
        avatarUrl: 'https://cdn.example/avatar.png?access_token=synthetic-private-token',
      },
      emailOnlyMention: {
        text: 'email-only@example.com',
        mention: 'person',
        userId: 'notion-user:synthetic-email-only-id',
        notionUser: {
          id: 'notion-user:synthetic-email-only-id',
          userId: 'notion-user:synthetic-email-only-id',
          notionUserId: 'synthetic-email-only-id',
          displayName: 'email-only@example.com',
          email: 'email-only@example.com',
          notion: {
            id: 'synthetic-email-only-id',
            type: 'person',
            person: { email: 'email-only@example.com' },
          },
        },
      },
      rawNotionUser: {
        object: 'user',
        id: 'synthetic-raw-notion-user-id',
        type: 'person',
        name: null,
        avatar_url: null,
        person: { email: 'raw-user@example.com' },
      },
    }) as Record<string, any>;

    const span = sanitized.block.content.rich[0];
    const peoplePerson = sanitized.row.properties.people[0];
    const createdBy = sanitized.row.properties['prop-created-by'];
    expect(span).toEqual({
      text: 'Synthetic Person',
      mention: 'person',
      userId: peoplePerson.userId,
    });
    expect(peoplePerson).toEqual({
      id: expect.stringMatching(/^public-person:/),
      userId: expect.stringMatching(/^public-person:/),
      displayName: 'Synthetic Person',
      avatarUrl: 'https://cdn.example/avatar.png',
    });
    expect(peoplePerson.id).toBe(peoplePerson.userId);
    expect(createdBy.id).toBe(peoplePerson.id);
    expect(sanitized.unsafeAvatarPerson).not.toHaveProperty('avatarUrl');
    expect(sanitized.emailOnlyMention).toEqual({
      text: 'Guest',
      mention: 'person',
      userId: expect.stringMatching(/^public-person:/),
    });
    expect(sanitized.rawNotionUser).toEqual({
      id: expect.stringMatching(/^public-person:/),
      userId: expect.stringMatching(/^public-person:/),
    });
    expect(sanitized.importedRenderConfig).toEqual({
      notion: {
        number: { format: 'dollar' },
        date: { type: 'date' },
        chart: { type: 'bar' },
      },
    });
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain('synthetic.person@example.com');
    expect(json).not.toContain('email-only@example.com');
    expect(json).not.toContain('raw-user@example.com');
    expect(json).not.toContain('synthetic-raw-notion-user-id');
    expect(json).not.toContain('synthetic-notion-person-id');
    expect(json).not.toContain('notionUserId');
    expect(json).not.toContain('notionUser');
    expect(json).not.toContain('notionMention');
    expect(json).not.toContain('"person":{"email"');
  });

  it('drops Azure SAS, AWS signed, and fragment-token URLs while preserving ordinary query links', () => {
    const sanitized = sanitizePublicShareValue({
      azureSas: 'https://synthetic.blob.core.windows.net/public/file.pdf?sv=2024-11-04&se=2030-01-01T00%3A00%3A00Z&sp=r&spr=https&sr=b&sig=synthetic-signature',
      azureDelegation: 'https://cdn.example/file.pdf?sv=2024-11-04&skoid=synthetic-object&ske=2030-01-01&sp=r',
      awsLegacy: 'https://bucket.example/file.pdf?AWSAccessKeyId=SYNTHETIC&Expires=1893456000&Signature=synthetic-signature',
      oauthFragment: 'https://app.example/callback#access_token=synthetic-token&token_type=bearer',
      fragmentOnly: '#access_token=synthetic-token&token_type=bearer',
      oauthCode: 'https://app.example/callback?code=synthetic-code&state=synthetic-state',
      clientCallback: 'https://app.example/callback?client_secret=synthetic-secret',
      apiEndpoint: 'https://api.example/report?api-key=synthetic-key',
      ssoCallback: 'https://app.example/sso?SAMLResponse=synthetic-assertion',
      oauthVerifier: 'https://app.example/callback?oauth_verifier=synthetic-verifier',
      assertionCallback: 'https://app.example/callback?client_assertion=synthetic-assertion',
      authLink: 'https://app.example/callback?auth=synthetic-credential',
      nestedRedirect: 'https://app.example/login?redirect=https%3A%2F%2Ftarget.example%2Fcallback%3Faccess_token%3Dsynthetic-token',
      routedFragment: 'https://app.example/#/callback?access_token=synthetic-token',
      encodedRoutedFragment: 'https://app.example/#%2Fcallback%3Faccess_token%3Dsynthetic-token',
      ftpBasicAuth: 'ftp://synthetic-user:synthetic-password@files.example/report.pdf',
      ordinaryQuery: 'https://example.com/report?sp=overview&section=public',
      ordinaryCode: 'https://example.com/docs?code=public-example',
    });

    expect(sanitized).toEqual({
      ordinaryQuery: 'https://example.com/report?sp=overview&section=public',
      ordinaryCode: 'https://example.com/docs?code=public-example',
    });
  });

  it('removes all file access locators when organization downloads are disabled', () => {
    const sanitized = sanitizePublicShareValue({
      type: 'file',
      name: 'file.pdf',
      notionFileCopied: true,
      uploadId: 'upload-1',
      key: 'workspaces/ws1/uploads/file.pdf',
      bucket: 'files',
      url: localUrl,
      ordinaryLink: 'https://example.com/help',
    }, { fileDownloadsAllowed: false });

    expect(sanitized).toEqual({
      type: 'file',
      name: 'file.pdf',
      notionFileCopied: true,
      ordinaryLink: 'https://example.com/help',
    });
  });

  it('returns only a public file DTO when downloads are enabled', async () => {
    const key = 'workspaces/ws1/uploads/file.pdf';
    const localFileUrl = `/api/storage/files/${key}`;
    const allowed = new Map<string, FileUpload>([[key, {
      id: 'upload-1', workspaceId: 'ws1', bucket: 'files', key, url: localFileUrl,
      status: 'uploaded', completedAt: '2026-07-11T00:00:00.000Z',
      etag: 'etag-1', size: 10, contentType: 'application/pdf',
    }]]);
    const storage = {
      bucket() { return this; },
      async head() { return { key, etag: 'etag-1', size: 10, contentType: 'application/pdf' }; },
      async getSignedUrl() { return 'https://signed.example/file.pdf'; },
    };
    const sanitized = sanitizePublicShareValue({
      id: 'upload-1', uploadId: 'upload-1', key, bucket: 'files',
      name: 'file.pdf', type: 'application/pdf', size: 10, url: localFileUrl,
    }, { fileDownloadsAllowed: true, storedFileUrls: new Set([localFileUrl]) });

    await expect(signSharedFileUrls(sanitized, allowed, storage)).resolves.toEqual({
      name: 'file.pdf', type: 'application/pdf', size: 10,
      url: 'https://signed.example/file.pdf',
    });
  });

  it('removes nested external file locators when downloads are disabled', () => {
    const sanitized = sanitizePublicShareValue({
      type: 'file',
      content: {
        name: 'external.pdf',
        url: 'https://files.example/external.pdf',
        href: '//files.example/external.pdf?X-Amz-Signature=secret',
      },
      ordinaryLink: 'https://example.com/help',
    }, { fileDownloadsAllowed: false });

    expect(sanitized).toEqual({
      type: 'file',
      content: { name: 'external.pdf' },
      ordinaryLink: 'https://example.com/help',
    });
  });

  it('never returns an unsigned local storage locator when signing cannot be proven', async () => {
    const key = 'workspaces/ws1/uploads/file.pdf';
    const value = {
      allowedButStorageUnavailable: `/api/storage/files/${key}`,
      outsideSharedGraph: '/api/storage/files/workspaces/ws1/private/secret.pdf',
      external: 'https://example.com/help',
    };
    const allowed = new Map<string, FileUpload>([[key, {
      id: 'upload-1', workspaceId: 'ws1', key, status: 'uploaded',
      completedAt: '2026-07-11T00:00:00.000Z',
      etag: 'etag-1', size: 10, contentType: 'application/pdf',
    }]]);

    await expect(signSharedFileUrls(value, allowed, undefined)).resolves.toEqual({
      external: 'https://example.com/help',
    });
  });

  it('never treats evil-origin or nested-proxy storage path lookalikes as local files', async () => {
    const key = 'workspaces/ws1/uploads/file.pdf';
    const allowed = new Map<string, FileUpload>([[key, {
      id: 'upload-1', workspaceId: 'ws1', key, status: 'uploaded',
      completedAt: '2026-07-11T00:00:00.000Z',
      etag: 'etag-1', size: 10, contentType: 'application/pdf',
    }]]);
    const getSignedUrl = vi.fn(async () => 'https://signed.example/private');
    const storage = {
      bucket() { return this; },
      async head() { return { key, etag: 'etag-1', size: 10, contentType: 'application/pdf' }; },
      getSignedUrl,
    };
    const value = {
      evil: `https://evil.example/api/storage/files/${key}`,
      nested: `https://evil.example/proxy/api/storage/files/${key}`,
      protocolRelative: `//evil.example/api/storage/files/${key}`,
    };

    await expect(signSharedFileUrls(value, allowed, storage)).resolves.toEqual(value);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('signs an absolute storage URL only when it exactly matches trusted upload metadata', async () => {
    const key = 'workspaces/ws1/uploads/file.pdf';
    const absolute = `https://hanji.example/api/storage/files/${key}`;
    const allowed = new Map<string, FileUpload>([[key, {
      id: 'upload-1', workspaceId: 'ws1', key, url: absolute, status: 'uploaded',
      completedAt: '2026-07-11T00:00:00.000Z',
      etag: 'etag-1', size: 10, contentType: 'application/pdf',
    }]]);
    const storage = {
      bucket() { return this; },
      async head() { return { key, etag: 'etag-1', size: 10, contentType: 'application/pdf' }; },
      async getSignedUrl() { return 'https://signed.example/file'; },
    };

    await expect(signSharedFileUrls({ url: absolute }, allowed, storage)).resolves.toEqual({
      url: 'https://signed.example/file',
    });
    expect(sanitizePublicShareValue(
      { url: absolute },
      { fileDownloadsAllowed: false, storedFileUrls: new Set([absolute]) },
    )).toEqual({});
  });

  it('does not sign an uploaded legacy row that lacks a verified completion marker', async () => {
    const key = 'workspaces/ws1/uploads/unverified.pdf';
    const allowed = new Map<string, FileUpload>([[key, {
      id: 'upload-unverified', workspaceId: 'ws1', key, status: 'uploaded',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      etag: 'etag-1', size: 10, contentType: 'application/pdf',
    }]]);
    const getSignedUrl = vi.fn(async () => 'https://signed.example/private');
    const storage = {
      bucket() { return this; },
      async head() { return { key, etag: 'etag-1', size: 10, contentType: 'application/pdf' }; },
      getSignedUrl,
    };

    await expect(signSharedFileUrls(
      { url: `/api/storage/files/${key}` },
      allowed,
      storage,
    )).resolves.toEqual({});
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('allows only payload-referenced non-template uploads from the public graph', async () => {
    const referencedRowKey = 'workspaces/ws1/database/row-file.pdf';
    const referencedRowUrl = `/api/storage/files/${referencedRowKey}`;
    const templateKey = 'workspaces/ws1/templates/private-default.pdf';
    const templateUrl = `/api/storage/files/${templateKey}`;
    const legacyTemplateKey = 'workspaces/ws1/templates/legacy-private-default.pdf';
    const legacyTemplateUrl = `/api/storage/files/${legacyTemplateKey}`;
    const unrelatedKey = 'workspaces/ws1/database/unrelated.pdf';
    const db = fakeDb({
      file_uploads: [
        {
          id: 'row-upload', workspaceId: 'ws1', databaseId: 'private-parent-db',
          key: referencedRowKey, url: referencedRowUrl, status: 'uploaded',
          completedAt: '2026-07-11T00:00:00.000Z',
        },
        {
          id: 'template-upload', workspaceId: 'ws1', databaseId: 'private-parent-db',
          templateId: 'private-template', key: templateKey, url: templateUrl,
          status: 'uploaded', completedAt: '2026-07-11T00:00:00.000Z',
        },
        {
          // Historical template uploads predate templateId and are otherwise
          // indistinguishable from database-scoped files.
          id: 'legacy-template-upload', workspaceId: 'ws1', databaseId: 'private-parent-db',
          key: legacyTemplateKey, url: legacyTemplateUrl,
          status: 'uploaded', completedAt: '2026-07-11T00:00:00.000Z',
        },
        {
          id: 'unrelated-upload', workspaceId: 'ws1', databaseId: 'private-parent-db',
          key: unrelatedKey, url: `/api/storage/files/${unrelatedKey}`,
          status: 'uploaded', completedAt: '2026-07-11T00:00:00.000Z',
        },
      ],
    });
    // Include the template URL deliberately: template ownership itself must be
    // a hard deny, so copying the same locator into a public field cannot turn
    // the private template attachment into a fresh signed capability.
    const references = collectPublicShareFileReferences({
      rowFile: { id: 'row-upload', url: referencedRowUrl },
      copiedTemplateUrl: templateUrl,
      copiedLegacyTemplate: {
        id: 'legacy-template-upload',
        key: legacyTemplateKey,
        url: legacyTemplateUrl,
      },
    });
    const privateTemplateReferences = collectPublicShareFileReferences({
      icon: legacyTemplateUrl,
      blocks: [{ uploadId: 'legacy-template-upload', key: legacyTemplateKey }],
    });
    const deniedUploadReferences = new Set<string>();

    const allowed = await sharedUploadMap(
      db as never,
      'ws1',
      new Set(['row-page', 'private-parent-db']),
      references,
      privateTemplateReferences,
      deniedUploadReferences,
    );

    expect(Array.from(allowed.keys())).toEqual([referencedRowKey]);
    expect(references.has(referencedRowKey)).toBe(true);
    expect(deniedUploadReferences).toEqual(new Set([
      'template-upload',
      templateKey,
      templateUrl,
      'legacy-template-upload',
      legacyTemplateKey,
      legacyTemplateUrl,
    ]));
    const sanitized = sanitizePublicShareValue({
      files: [
        {
          id: 'legacy-template-upload',
          key: legacyTemplateKey,
          url: legacyTemplateUrl,
          name: 'private-default.pdf',
        },
      ],
    }, {
      fileDownloadsAllowed: true,
      deniedFileReferences: deniedUploadReferences,
    });
    await expect(signSharedFileUrls(sanitized, allowed, undefined)).resolves.toEqual({
      files: [{ name: 'private-default.pdf' }],
    });
  });
});

describe('publicPage database metadata privacy boundary', () => {
  const token = 'public-token';
  const privateAuditFields = {
    createdBy: 'private-creator-user-id',
    updatedBy: 'private-updater-user-id',
    lastEditedBy: 'private-editor-user-id',
    verifiedBy: 'private-verifier-user-id',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
  const withPrivateAudit = (rows: Row[]) => rows.map((row) => ({ ...privateAuditFields, ...row }));
  const baseTables = (rootId: string, pages: Row[], extra: Record<string, Row[]> = {}) => {
    const {
      blocks = [],
      db_properties: properties = [],
      db_views: views = [],
      db_templates: templates = [],
      file_uploads: uploads = [],
      share_links: shareLinks = [{
        id: `share-${rootId}`,
        workspaceId: 'ws1',
        pageId: rootId,
        token,
        enabled: true,
        role: 'view',
      }],
      ...rest
    } = extra;
    return {
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: 'owner-1' }],
      pages: withPrivateAudit(pages),
      blocks: withPrivateAudit(blocks),
      db_properties: withPrivateAudit(properties),
      db_views: withPrivateAudit(views),
      db_templates: withPrivateAudit(templates),
      file_uploads: uploads,
      share_links: withPrivateAudit(shareLinks),
      ...rest,
    };
  };

  it('loads a tiny public graph without materializing an unrelated 25k-page workspace', async () => {
    const rootId = 'bounded-public-root';
    const unrelated = Array.from({ length: 25_001 }, (_, index) => snapshotPage(
      `unrelated-${index}`,
      { parentId: null, isPublic: false },
    ));
    const database = fakeDb(baseTables(rootId, [
      snapshotPage(rootId, { isPublic: true }),
      ...unrelated,
    ]));

    const snapshot = await publicSnapshot(database, token) as { pages: Row[] };

    expect(snapshot.pages.map((page) => page.id)).toEqual([rootId]);
  });

  it('minimizes direct-page and share-link metadata while preserving people display fields', async () => {
    const rootId = 'public-page-root';
    const database = fakeDb(baseTables(rootId, [
      snapshotPage(rootId, {
        isPublic: true,
        properties: {
          notionImportJobId: 'private-import-job-id',
          notionWorkspaceId: 'private-notion-workspace-id',
          notionPageId: 'private-notion-page-id',
          notionLinkedDatabaseResolvedTitle: 'Public linked title',
          notionLinkedDatabaseSourceUnavailable: true,
          people: [{
            id: 'display-person-id',
            name: 'Display Person',
            avatarUrl: 'https://example.com/avatar.png',
            createdBy: 'nested-private-user-id',
            updatedAt: '2026-07-03T00:00:00.000Z',
          }],
        },
      }),
    ], {
      blocks: [{
        id: 'public-block',
        pageId: rootId,
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: 'Public body' }] },
        plainText: 'Public body',
        position: 1,
      }],
    }));

    const snapshot = await publicSnapshot(database, token) as {
      page: Row;
      blocks: Row[];
      shareLink: Row;
    };
    expect(snapshot.shareLink).toEqual({ enabled: true, role: 'view', expiresAt: null });
    expect(snapshot.page).toMatchObject({ id: rootId, workspaceId: 'ws1' });
    expect(snapshot.page.createdAt).toBe(privateAuditFields.createdAt);
    expect(snapshot.page.updatedAt).toBe(privateAuditFields.updatedAt);
    expect(snapshot.page.createdBy).toEqual(expect.stringMatching(/^public-person:/));
    expect(snapshot.page.lastEditedBy).toEqual(expect.stringMatching(/^public-person:/));
    expect(snapshot.page.createdBy).not.toBe(privateAuditFields.createdBy);
    expect(snapshot.page.properties?.people).toEqual([{
      id: 'display-person-id',
      name: 'Display Person',
      avatarUrl: 'https://example.com/avatar.png',
    }]);
    expect(snapshot.page.properties).toMatchObject({
      notionLinkedDatabaseResolvedTitle: 'Public linked title',
      notionLinkedDatabaseSourceUnavailable: true,
    });
    expect(snapshot.page.properties).not.toHaveProperty('notionImportJobId');
    expect(snapshot.page.properties).not.toHaveProperty('notionWorkspaceId');
    expect(snapshot.page.properties).not.toHaveProperty('notionPageId');
    expect(JSON.stringify(snapshot)).not.toContain('private-import-job-id');
    expect(snapshot.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'public-block', pageId: rootId, plainText: 'Public body' }),
    ]));
    expectNoPublicInternalAuditFields(snapshot);
  });

  it('keeps direct databases renderable while omitting templates and every template upload locator', async () => {
    const databaseId = 'database-public';
    const rowId = 'row-public';
    const filePropertyId = 'file-property';
    const personPropertyId = 'person-property';
    const legacyTemplateKey = 'workspaces/ws1/database/files/legacy-template.pdf';
    const legacyTemplateUrl = `/api/storage/files/${legacyTemplateKey}`;
    const explicitTemplateKey = 'workspaces/ws1/database/files/explicit-template.pdf';
    const explicitTemplateUrl = `/api/storage/files/${explicitTemplateKey}`;
    const rowKey = 'workspaces/ws1/database/files/public-row.pdf';
    const rowUrl = `/api/storage/files/${rowKey}`;
    const database = fakeDb(baseTables(databaseId, [
      snapshotPage(databaseId, {
        kind: 'database',
        title: 'Public database',
        isPublic: true,
      }),
      snapshotPage(rowId, {
        parentId: databaseId,
        parentType: 'database',
        title: 'Public row',
        properties: {
          [personPropertyId]: [
            'private-local-user-id',
            {
              id: 'private-local-profile-id',
              userId: 'private-local-profile-id',
              displayName: 'Public Teammate',
              email: 'private.teammate@example.com',
            },
          ],
          [filePropertyId]: [
            {
              id: 'legacy-template-upload',
              key: legacyTemplateKey,
              url: legacyTemplateUrl,
              name: 'legacy-template.pdf',
            },
            {
              id: 'explicit-template-upload',
              key: explicitTemplateKey,
              url: explicitTemplateUrl,
              name: 'explicit-template.pdf',
            },
            {
              id: 'row-upload',
              key: rowKey,
              url: rowUrl,
              name: 'public-row.pdf',
            },
          ],
        },
      }),
    ], {
      db_properties: [
        {
          id: filePropertyId,
          databaseId,
          name: 'Files',
          type: 'files',
          position: 1,
        },
        {
          id: personPropertyId,
          databaseId,
          name: 'People',
          type: 'person',
          position: 2,
        },
      ],
      db_views: [{
        id: 'public-view',
        databaseId,
        name: 'Public table',
        type: 'table',
        config: { visibleProperties: [filePropertyId, personPropertyId] },
        position: 1,
      }],
      db_templates: [{
        id: 'private-template',
        databaseId,
        name: 'PRIVATE_TEMPLATE_NAME',
        title: 'PRIVATE_TEMPLATE_TITLE',
        icon: legacyTemplateUrl,
        properties: {
          [filePropertyId]: [{
            id: 'legacy-template-upload',
            key: legacyTemplateKey,
            url: legacyTemplateUrl,
          }],
        },
        blocks: [{
          type: 'file',
          plainText: 'PRIVATE_TEMPLATE_BLOCK',
          content: { uploadId: 'explicit-template-upload', url: explicitTemplateUrl },
        }],
        position: 1,
      }],
      file_uploads: [
        {
          id: 'legacy-template-upload',
          workspaceId: 'ws1',
          databaseId,
          key: legacyTemplateKey,
          url: legacyTemplateUrl,
          status: 'uploaded',
          completedAt: '2026-07-11T00:00:00.000Z',
          etag: 'legacy-etag',
          size: 11,
          contentType: 'application/pdf',
        },
        {
          id: 'explicit-template-upload',
          workspaceId: 'ws1',
          databaseId,
          templateId: 'private-template',
          key: explicitTemplateKey,
          url: explicitTemplateUrl,
          status: 'uploaded',
          completedAt: '2026-07-11T00:00:00.000Z',
          etag: 'explicit-etag',
          size: 12,
          contentType: 'application/pdf',
        },
        {
          id: 'row-upload',
          workspaceId: 'ws1',
          pageId: rowId,
          databaseId,
          propertyId: filePropertyId,
          key: rowKey,
          url: rowUrl,
          status: 'uploaded',
          completedAt: '2026-07-11T00:00:00.000Z',
          etag: 'row-etag',
          size: 13,
          contentType: 'application/pdf',
        },
      ],
    }));

    const snapshot = await publicSnapshot(database, token) as {
      pages: Row[];
      properties: Row[];
      views: Row[];
      templates: Row[];
    };
    expectNoPublicInternalAuditFields(snapshot);
    expect(snapshot.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: filePropertyId, databaseId }),
    ]));
    expect(snapshot.views).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'public-view', databaseId }),
    ]));
    expect(snapshot.templates).toEqual([]);
    const publicRow = snapshot.pages.find((page) => page.id === rowId);
    const people = publicRow?.properties?.[personPropertyId] as Row[];
    expect(people[0]).toEqual(expect.stringMatching(/^public-person:/));
    expect(people[1]).toEqual({
      id: expect.stringMatching(/^public-person:/),
      userId: expect.stringMatching(/^public-person:/),
      displayName: 'Public Teammate',
    });
    const files = publicRow?.properties?.[filePropertyId] as Row[];
    expect(files).toEqual([
      { name: 'legacy-template.pdf' },
      { name: 'explicit-template.pdf' },
      {
        url: `https://signed.example/${encodeURIComponent(rowKey)}`,
        name: 'public-row.pdf',
      },
    ]);
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of [
      'PRIVATE_TEMPLATE_NAME',
      'PRIVATE_TEMPLATE_TITLE',
      'PRIVATE_TEMPLATE_BLOCK',
      'legacy-template-upload',
      legacyTemplateKey,
      legacyTemplateUrl,
      'explicit-template-upload',
      explicitTemplateKey,
      explicitTemplateUrl,
      'private-local-user-id',
      'private-local-profile-id',
      'private.teammate@example.com',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('gives a directly shared row only private-parent properties and safe relation previews', async () => {
    const databaseId = 'database-private-parent';
    const rowId = 'row-shared';
    const relatedId = 'row-related';
    const numberPropertyId = 'number-property';
    const relationPropertyId = 'relation-property';
    const database = fakeDb(baseTables(rowId, [
      snapshotPage(databaseId, {
        kind: 'database',
        title: 'Private parent database',
      }),
      snapshotPage(rowId, {
        parentId: databaseId,
        parentType: 'database',
        title: 'Shared row',
        isPublic: true,
        properties: {
          [numberPropertyId]: 7,
          [relationPropertyId]: [relatedId],
        },
      }),
      snapshotPage(relatedId, {
        parentId: databaseId,
        parentType: 'database',
        title: 'Safe relation preview',
        properties: { secret: 'must not become preview properties' },
      }),
    ], {
      db_properties: [
        {
          id: numberPropertyId,
          databaseId,
          name: 'Estimate',
          type: 'number',
          position: 1,
        },
        {
          id: relationPropertyId,
          databaseId,
          name: 'Related',
          type: 'relation',
          config: { relationDatabaseId: databaseId },
          position: 2,
        },
      ],
      db_views: [{
        id: 'private-parent-view',
        databaseId,
        name: 'Private author view',
        type: 'table',
        position: 1,
      }],
      db_templates: [{
        id: 'private-parent-template',
        databaseId,
        name: 'PRIVATE_PARENT_TEMPLATE',
        blocks: [{ plainText: 'PRIVATE_PARENT_TEMPLATE_BLOCK' }],
        position: 1,
      }],
    }));

    const snapshot = await publicSnapshot(database, token) as {
      pages: Row[];
      properties: Row[];
      views: Row[];
      templates: Row[];
      navigablePageIds: string[];
    };
    expectNoPublicInternalAuditFields(snapshot);
    expect(snapshot.properties.map((property) => property.id)).toEqual([
      numberPropertyId,
      relationPropertyId,
    ]);
    expect(snapshot.views).toEqual([]);
    expect(snapshot.templates).toEqual([]);
    expect(snapshot.navigablePageIds).toEqual([rowId]);
    expect(snapshot.pages.some((page) => page.id === databaseId)).toBe(false);
    expect(snapshot.pages.find((page) => page.id === relatedId)).toMatchObject({
      title: 'Safe relation preview',
      properties: {},
    });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_PARENT_TEMPLATE');
  });

  it('preserves linked-source rendering metadata without returning either database template set', async () => {
    const linkedDatabaseId = 'linked-database';
    const sourceDatabaseId = 'source-database';
    const sourceRowId = 'source-row';
    const sourcePropertyId = 'source-title-property';
    const database = fakeDb(baseTables(linkedDatabaseId, [
      snapshotPage(linkedDatabaseId, {
        kind: 'database',
        title: 'Public linked database',
        isPublic: true,
        properties: {
          notionLinkedDatabaseSourceUnavailable: true,
          notionDatabaseId: 'notion-source-id',
        },
      }),
      snapshotPage(sourceDatabaseId, {
        kind: 'database',
        title: 'Private physical source',
        properties: { notionDatabaseId: 'different-id' },
      }),
      snapshotPage(sourceRowId, {
        parentId: sourceDatabaseId,
        parentType: 'database',
        title: 'Linked source row',
        properties: { [sourcePropertyId]: 'Linked source row' },
      }),
    ], {
      db_properties: [{
        id: sourcePropertyId,
        databaseId: sourceDatabaseId,
        name: 'Name',
        type: 'title',
        position: 1,
      }],
      db_views: [{
        id: 'source-view',
        databaseId: sourceDatabaseId,
        name: 'Linked table',
        type: 'table',
        config: {
          visibleProperties: [sourcePropertyId],
          notion: { parent: { database_id: 'notion-source-id' } },
        },
        position: 1,
      }],
      db_templates: [
        {
          id: 'linked-private-template',
          databaseId: linkedDatabaseId,
          name: 'LINKED_PRIVATE_TEMPLATE',
          position: 1,
        },
        {
          id: 'source-private-template',
          databaseId: sourceDatabaseId,
          name: 'SOURCE_PRIVATE_TEMPLATE',
          blocks: [{ plainText: 'SOURCE_PRIVATE_TEMPLATE_BLOCK' }],
          position: 1,
        },
      ],
    }));

    const snapshot = await publicSnapshot(database, token) as {
      pages: Row[];
      properties: Row[];
      views: Row[];
      templates: Row[];
      navigablePageIds: string[];
    };
    expectNoPublicInternalAuditFields(snapshot);
    expect(snapshot.properties).toEqual([
      expect.objectContaining({ id: sourcePropertyId, databaseId: linkedDatabaseId }),
    ]);
    expect(snapshot.views).toEqual([
      expect.objectContaining({ id: 'source-view', databaseId: linkedDatabaseId }),
    ]);
    expect(snapshot.pages.find((page) => page.id === sourceRowId)).toMatchObject({
      parentId: linkedDatabaseId,
      parentType: 'database',
      title: 'Linked source row',
    });
    expect(snapshot.navigablePageIds).toEqual([linkedDatabaseId]);
    expect(snapshot.templates).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toMatch(/LINKED_PRIVATE_TEMPLATE|SOURCE_PRIVATE_TEMPLATE/);
  });
});

// #21: the sharing roster (with external emails) must only be enumerable by a
// manager; a view-only actor sees just their own entry.
describe('accessPayload roster visibility (#21)', () => {
  const roster = [
    { principalType: 'user', principalId: 'alice', label: 'Alice' },
    { principalType: 'user', principalId: 'bob', label: 'Bob' },
    { principalType: 'email', principalId: 'guest@example.com', label: 'guest@example.com' },
  ];

  it('returns the full roster to a manager', () => {
    expect(visiblePermissionsForActor(roster, true, 'alice', 'alice@example.com')).toHaveLength(3);
  });

  it('returns only the actor’s own user entry to a non-manager', () => {
    const visible = visiblePermissionsForActor(roster, false, 'bob', undefined);
    expect(visible).toEqual([{ principalType: 'user', principalId: 'bob', label: 'Bob' }]);
  });

  it('matches the actor’s own email entry but hides other collaborators’ emails', () => {
    const visible = visiblePermissionsForActor(roster, false, 'nobody', 'guest@example.com');
    expect(visible).toEqual([
      { principalType: 'email', principalId: 'guest@example.com', label: 'guest@example.com' },
    ]);
  });

  it('discloses nothing to an unrelated view-only actor', () => {
    expect(visiblePermissionsForActor(roster, false, 'mallory', 'mallory@example.com')).toEqual([]);
  });
});
