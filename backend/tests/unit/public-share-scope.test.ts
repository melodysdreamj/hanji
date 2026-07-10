import { describe, expect, it } from 'vitest';
import {
  collectPublicSharePageGraph,
  visiblePermissionsForActor,
} from '../../functions/share-mutation';
import { fakeDb, type Row } from './helpers/fake-db';

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

// #21: the sharing roster (with external emails) must only be enumerable by a
// manager; a view-only actor sees just their own entry.
describe('accessPayload roster visibility (#21)', () => {
  const roster = [
    { principalType: 'user', principalId: 'alice', label: 'Alice' },
    { principalType: 'user', principalId: 'bob', label: 'Bob' },
    { principalType: 'email', principalId: 'guest@evil.com', label: 'guest@evil.com' },
  ];

  it('returns the full roster to a manager', () => {
    expect(visiblePermissionsForActor(roster, true, 'alice', 'alice@x.com')).toHaveLength(3);
  });

  it('returns only the actor’s own user entry to a non-manager', () => {
    const visible = visiblePermissionsForActor(roster, false, 'bob', undefined);
    expect(visible).toEqual([{ principalType: 'user', principalId: 'bob', label: 'Bob' }]);
  });

  it('matches the actor’s own email entry but hides other collaborators’ emails', () => {
    const visible = visiblePermissionsForActor(roster, false, 'nobody', 'guest@evil.com');
    expect(visible).toEqual([
      { principalType: 'email', principalId: 'guest@evil.com', label: 'guest@evil.com' },
    ]);
  });

  it('discloses nothing to an unrelated view-only actor', () => {
    expect(visiblePermissionsForActor(roster, false, 'mallory', 'mallory@x.com')).toEqual([]);
  });
});
