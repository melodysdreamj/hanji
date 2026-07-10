import { describe, expect, it } from 'vitest';

import { seedDefaultWorkspacePages } from '../../lib/default-workspace-pages';
import { fakeDb, type Row } from './helpers/fake-db';

const WORKSPACE = { id: 'ws1' };

function existingPage(extra: Partial<Row> = {}): Row {
  return {
    id: `page-${Math.random().toString(36).slice(2)}`,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    inTrash: false,
    ...extra,
  };
}

describe('seedDefaultWorkspacePages', () => {
  it('seeds the welcome page and its blocks into an empty workspace', async () => {
    const db = fakeDb();
    const inserted = await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');

    expect(inserted).toHaveLength(1);
    const page = inserted[0] as Row;
    expect(page.workspaceId).toBe('ws1');
    expect(page.parentId).toBeNull();
    expect(page.parentType).toBe('workspace');
    expect(page.kind).toBe('page');
    expect(page.title).toBe('Hanji에 오신 것을 환영합니다!');
    expect(page.icon).toBe('👋');
    expect(page.iconType).toBe('emoji');
    expect(page.position).toBe(1000);
    expect(page.isFavorite).toBe(false);
    expect(page.inTrash).toBe(false);
    expect(page.createdBy).toBe('actor1');
    expect(page.lastEditedBy).toBe('actor1');
    expect(page.createdAt).toBe(page.updatedAt);

    const blocks = db.tables.blocks;
    expect(blocks).toHaveLength(5);
    expect(blocks.every((block) => block.pageId === page.id)).toBe(true);
    expect(blocks.every((block) => block.createdBy === 'actor1')).toBe(true);
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'heading_2',
      'to_do',
      'to_do',
      'to_do',
    ]);
    expect(blocks.map((block) => block.position)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });

  it('shapes block content as rich text, with checked state on to-dos', async () => {
    const db = fakeDb();
    await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');
    const blocks = db.tables.blocks;

    const paragraph = blocks[0];
    expect(paragraph.content).toEqual({ rich: [{ text: paragraph.plainText }] });
    expect(paragraph.plainText).toContain('Hanji');

    const heading = blocks[1];
    expect(heading.content).toEqual({ rich: [{ text: '시작하기' }] });

    const todo = blocks[2];
    expect(todo.content).toEqual({ rich: [{ text: '첫 문서 만들기' }], checked: false });
    expect(todo.plainText).toBe('첫 문서 만들기');
  });

  it('gives every seeded record a unique id', async () => {
    const db = fakeDb();
    const inserted = await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');
    const ids = [...inserted.map((page) => page.id), ...db.tables.blocks.map((block) => block.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not seed twice', async () => {
    const db = fakeDb();
    await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');
    const second = await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');
    expect(second).toEqual([]);
    expect(db.tables.pages).toHaveLength(1);
    expect(db.tables.blocks).toHaveLength(5);
  });

  it('skips seeding when any live root page exists', async () => {
    const withWorkspaceRoot = fakeDb({ pages: [existingPage()] });
    expect(await seedDefaultWorkspacePages(withWorkspaceRoot as never, WORKSPACE, 'actor1')).toEqual([]);

    const withNullParent = fakeDb({ pages: [existingPage({ parentType: 'page', parentId: null })] });
    expect(await seedDefaultWorkspacePages(withNullParent as never, WORKSPACE, 'actor1')).toEqual([]);
  });

  it('seeds when the only root page is in the trash', async () => {
    const db = fakeDb({ pages: [existingPage({ inTrash: true })] });
    const inserted = await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');
    expect(inserted).toHaveLength(1);
    expect(db.tables.pages).toHaveLength(2);
  });

  it('seeds when existing pages are only nested children', async () => {
    const db = fakeDb({ pages: [existingPage({ parentType: 'page', parentId: 'some-parent' })] });
    const inserted = await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');
    expect(inserted).toHaveLength(1);
  });

  it('ignores root pages that belong to other workspaces', async () => {
    const db = fakeDb({ pages: [existingPage({ workspaceId: 'ws-other' })] });
    const inserted = await seedDefaultWorkspacePages(db as never, WORKSPACE, 'actor1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].workspaceId).toBe('ws1');
  });
});
