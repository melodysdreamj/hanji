import { describe, expect, it } from 'vitest';
import { POST as blockMutation } from '../../functions/block-mutation';
import { POST as collaborationMutation } from '../../functions/collaboration-mutation';
import { POST as commentMutation } from '../../functions/comment-mutation';
import { POST as databaseMutation } from '../../functions/database-mutation';
import {
  IMPORT_EXPORT_REQUEST_MAX_BYTES,
  POST as importExport,
} from '../../functions/import-export';
import { POST as mcp } from '../../functions/mcp';
import { POST as notionImport } from '../../functions/notion-import';
import {
  DELETE as notionDelete,
  GET as notionGet,
  PATCH as notionPatch,
  POST as notionPost,
} from '../../functions/notion/v1/[...slug]';
import {
  DELETE as canonicalNotionDelete,
  GET as canonicalNotionGet,
  PATCH as canonicalNotionPatch,
  POST as canonicalNotionPost,
} from '../../functions/v1/[...slug]';

describe('HTTP function request body limits', () => {
  it('keeps bulk mutation and protocol routes at 4 MiB', () => {
    const definitions = [
      blockMutation,
      collaborationMutation,
      commentMutation,
      databaseMutation,
      mcp,
      notionDelete,
      notionGet,
      notionPatch,
      notionPost,
      canonicalNotionDelete,
      canonicalNotionGet,
      canonicalNotionPatch,
      canonicalNotionPost,
    ];

    for (const definition of definitions) {
      expect(definition.maxRequestBodyBytes).toBe(4 * 1024 * 1024);
    }
  });

  it('keeps the Notion import route at 8 MiB', () => {
    expect(notionImport.maxRequestBodyBytes).toBe(8 * 1024 * 1024);
  });

  it('aligns the import/export route with its parser limit', () => {
    expect(importExport.maxRequestBodyBytes).toBe(IMPORT_EXPORT_REQUEST_MAX_BYTES);
  });
});
