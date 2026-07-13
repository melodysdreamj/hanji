import { nowIso } from './table-utils';

interface Workspace {
  id: string;
}

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  kind?: string;
  title?: string;
  icon?: string;
  iconType?: string;
  font?: string;
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: string;
  pageCommentsDisplay?: string;
  isFavorite?: boolean;
  inTrash?: boolean;
  position?: number;
  createdBy?: string;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Block {
  id: string;
  pageId: string;
  parentId?: string | null;
  type: string;
  content?: Record<string, unknown>;
  plainText?: string;
  position?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ListResult<T> {
  items?: T[];
  hasMore?: boolean;
}

interface TableRef<T> {
  insert(data: Partial<T>): Promise<T>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  getList(): Promise<ListResult<T>>;
}

interface DbRef {
  table<T>(name: string): TableRef<T>;
}

type BlockSpec = {
  type?: string;
  text: string;
  checked?: boolean;
};

type DefaultPageSpec = {
  title: string;
  icon: string;
  blocks: BlockSpec[];
};

const ROOT_POSITION_STEP = 1000;
const BLOCK_POSITION_STEP = 1000;

type DefaultWorkspaceLocale = 'en' | 'ko';

const DEFAULT_WORKSPACE_PAGES: Record<DefaultWorkspaceLocale, DefaultPageSpec[]> = {
  en: [
    {
      title: 'Welcome to Hanji!',
      icon: '👋',
      blocks: [
        {
          type: 'paragraph',
          text: 'Hanji is an open-source workspace for team documents, databases, sharing, and permissions, built on EdgeBase.',
        },
        { type: 'heading_2', text: 'Get started' },
        { type: 'to_do', text: 'Create your first document' },
        { type: 'to_do', text: 'Add an existing server account and review permissions' },
        { type: 'to_do', text: 'Prepare a Notion API import' },
      ],
    },
  ],
  ko: [
  {
    title: 'Hanji에 오신 것을 환영합니다!',
    icon: '👋',
    blocks: [
      {
        type: 'paragraph',
        text: 'Hanji는 EdgeBase 기반으로 팀 문서, 데이터베이스, 공유, 권한을 함께 다루는 오픈소스 워크스페이스입니다.',
      },
      { type: 'heading_2', text: '시작하기' },
      { type: 'to_do', text: '첫 문서 만들기' },
      { type: 'to_do', text: '서버에 등록된 계정을 추가하고 권한 확인하기' },
      { type: 'to_do', text: 'Notion API 가져오기 준비하기' },
    ],
  },
  ],
};

export function defaultWorkspaceLocale(acceptLanguage: string | null | undefined): DefaultWorkspaceLocale {
  return (acceptLanguage ?? '').trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

async function listAll<T>(query: TableQuery<T>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await query.page(page).limit(1000).getList();
    const items = res.items ?? [];
    out.push(...items);
    if (!res.hasMore || items.length === 0) break;
  }
  return out;
}

function rich(text: string) {
  return { rich: [{ text }] };
}

function blockContent(spec: BlockSpec) {
  if (spec.type === 'to_do') return { ...rich(spec.text), checked: spec.checked === true };
  return rich(spec.text);
}

function pageRecord(
  workspace: Workspace,
  actorId: string,
  spec: DefaultPageSpec,
  position: number,
  now: string,
): Page {
  return {
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: spec.title,
    icon: spec.icon,
    iconType: 'emoji',
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    isPublic: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    position,
    isFavorite: false,
    inTrash: false,
    createdBy: actorId,
    lastEditedBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
}

function blockRecord(pageId: string, actorId: string, spec: BlockSpec, index: number, now: string): Block {
  const type = spec.type ?? 'paragraph';
  return {
    id: crypto.randomUUID(),
    pageId,
    parentId: null,
    type,
    content: blockContent({ ...spec, type }),
    plainText: spec.text,
    position: (index + 1) * BLOCK_POSITION_STEP,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
}

export async function seedDefaultWorkspacePages(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
  locale: DefaultWorkspaceLocale = 'ko',
) {
  const pages = db.table<Page>('pages');
  const existingPages = await listAll(pages.where('workspaceId', '==', workspace.id));
  const hasRootPage = existingPages.some(
    (page) =>
      !page.inTrash &&
      (page.parentType === 'workspace' || page.parentId == null),
  );
  if (hasRootPage) return [];

  const blocks = db.table<Block>('blocks');
  const now = nowIso();
  const insertedPages: Page[] = [];
  const defaultPages = DEFAULT_WORKSPACE_PAGES[locale];
  for (let index = 0; index < defaultPages.length; index += 1) {
    const spec = defaultPages[index];
    const page = await pages.insert(
      pageRecord(workspace, actorId, spec, (index + 1) * ROOT_POSITION_STEP, now),
    );
    insertedPages.push(page);
    for (let blockIndex = 0; blockIndex < spec.blocks.length; blockIndex += 1) {
      await blocks.insert(blockRecord(page.id, actorId, spec.blocks[blockIndex], blockIndex, now));
    }
  }
  return insertedPages;
}
