import { pickLabels } from "@/lib/i18n";
import type { BlockContent, BlockType, ViewType } from "@/lib/types";

export type SlashAction =
  | "duplicate"
  | "delete"
  | "move_to"
  | "turn_into"
  | "color"
  | "set_color";

export interface BlockDef {
  id?: string;
  type: BlockType;
  label: string;
  description: string;
  /** Korean display label (label is the EN default). */
  koLabel?: string;
  /** Korean display description (description is the EN default). */
  koDescription?: string;
  /** sidebar/slash icon glyph */
  glyph: string;
  group: "Basic" | "Media" | "Database" | "Advanced";
  keywords: string[];
  /** Korean search keywords — matched in addition to `keywords` in any locale. */
  koKeywords?: string[];
  placeholder?: string;
  /** continue this list/style on Enter (lists & to_do) */
  continues?: boolean;
  columnCount?: number;
  databaseView?: Extract<ViewType, "table" | "board" | "list" | "gallery" | "calendar" | "timeline">;
  action?: SlashAction;
  colorToken?: string;
  hiddenWhenEmpty?: boolean;
}

/** Display label for a block def in the active UI language. */
export function blockDefLabel(def: BlockDef): string {
  return pickLabels({ en: def.label, ko: def.koLabel ?? def.label });
}

/** Display description for a block def in the active UI language. */
export function blockDefDescription(def: BlockDef): string {
  return pickLabels({ en: def.description, ko: def.koDescription ?? def.description });
}

const COLOR_SLASH_DEFS: BlockDef[] = [
  { token: "default", label: "Default", koLabel: "기본", keywords: ["default", "clear color", "remove color"], koKeywords: ["기본", "색 제거"] },
  { token: "gray", label: "Gray", koLabel: "회색", keywords: ["gray", "grey", "text color"], koKeywords: ["회색", "글자색"] },
  { token: "brown", label: "Brown", koLabel: "갈색", keywords: ["brown", "text color"], koKeywords: ["갈색", "글자색"] },
  { token: "orange", label: "Orange", koLabel: "주황색", keywords: ["orange", "text color"], koKeywords: ["주황색", "글자색"] },
  { token: "yellow", label: "Yellow", koLabel: "노란색", keywords: ["yellow", "text color"], koKeywords: ["노란색", "글자색"] },
  { token: "green", label: "Green", koLabel: "초록색", keywords: ["green", "text color"], koKeywords: ["초록색", "글자색"] },
  { token: "blue", label: "Blue", koLabel: "파란색", keywords: ["blue", "text color"], koKeywords: ["파란색", "글자색"] },
  { token: "purple", label: "Purple", koLabel: "보라색", keywords: ["purple", "text color"], koKeywords: ["보라색", "글자색"] },
  { token: "pink", label: "Pink", koLabel: "분홍색", keywords: ["pink", "text color"], koKeywords: ["분홍색", "글자색"] },
  { token: "red", label: "Red", koLabel: "빨간색", keywords: ["red", "text color"], koKeywords: ["빨간색", "글자색"] },
  { token: "gray_background", label: "Gray background", koLabel: "회색 배경", keywords: ["gray background", "grey background", "highlight"], koKeywords: ["회색 배경", "강조"] },
  { token: "brown_background", label: "Brown background", koLabel: "갈색 배경", keywords: ["brown background", "highlight"], koKeywords: ["갈색 배경", "강조"] },
  { token: "orange_background", label: "Orange background", koLabel: "주황색 배경", keywords: ["orange background", "highlight"], koKeywords: ["주황색 배경", "강조"] },
  { token: "yellow_background", label: "Yellow background", koLabel: "노란색 배경", keywords: ["yellow background", "highlight"], koKeywords: ["노란색 배경", "강조"] },
  { token: "green_background", label: "Green background", koLabel: "초록색 배경", keywords: ["green background", "highlight"], koKeywords: ["초록색 배경", "강조"] },
  { token: "blue_background", label: "Blue background", koLabel: "파란색 배경", keywords: ["blue background", "highlight"], koKeywords: ["파란색 배경", "강조"] },
  { token: "purple_background", label: "Purple background", koLabel: "보라색 배경", keywords: ["purple background", "highlight"], koKeywords: ["보라색 배경", "강조"] },
  { token: "pink_background", label: "Pink background", koLabel: "분홍색 배경", keywords: ["pink background", "highlight"], koKeywords: ["분홍색 배경", "강조"] },
  { token: "red_background", label: "Red background", koLabel: "빨간색 배경", keywords: ["red background", "highlight"], koKeywords: ["빨간색 배경", "강조"] },
].map(({ token, label, koLabel, keywords, koKeywords }) => ({
  id: `color_${token}`,
  type: "paragraph" as BlockType,
  label,
  description:
    token === "default"
      ? "Remove text or background color from this block."
      : `Apply ${label.toLowerCase()} to this block.`,
  koLabel,
  koDescription:
    token === "default"
      ? "블록의 글자색과 배경색을 제거해요."
      : `이 블록에 ${koLabel}을 적용해요.`,
  glyph: "A",
  group: "Advanced" as const,
  keywords: ["color", "colour", "background", ...keywords],
  koKeywords: ["색", "색상", "배경", ...koKeywords],
  action: "set_color" as const,
  colorToken: token,
  hiddenWhenEmpty: true,
}));

export const BLOCK_DEFS: BlockDef[] = [
  {
    type: "paragraph",
    label: "Text",
    description: "Just start writing with plain text.",
    koLabel: "텍스트",
    koDescription: "일반 텍스트로 바로 글을 써 보세요.",
    glyph: "¶",
    group: "Basic",
    keywords: ["text", "paragraph", "plain"],
    koKeywords: ["텍스트", "글", "본문", "문단"],
    placeholder: "Type '/' for commands",
  },
  {
    type: "child_page",
    label: "Page",
    description: "Create a sub-page inside this page.",
    koLabel: "페이지",
    koDescription: "이 페이지 안에 하위 페이지를 만들어요.",
    glyph: "▣",
    group: "Basic",
    keywords: ["page", "subpage", "child", "document"],
    koKeywords: ["페이지", "하위 페이지", "문서"],
  },
  {
    type: "link_to_page",
    label: "Link to page",
    description: "Link to an existing page.",
    koLabel: "페이지 링크",
    koDescription: "기존 페이지로 연결해요.",
    glyph: "↗",
    group: "Basic",
    keywords: ["page", "link", "reference", "existing", "mention"],
    koKeywords: ["페이지", "링크", "연결", "멘션"],
  },
  {
    type: "heading_1",
    label: "Heading 1",
    description: "Big section heading.",
    koLabel: "제목1",
    koDescription: "큰 섹션 제목이에요.",
    glyph: "H₁",
    group: "Basic",
    keywords: ["h1", "heading", "title", "big"],
    koKeywords: ["제목", "제목1", "헤딩", "큰 제목"],
    placeholder: "Heading 1",
  },
  {
    type: "toggle_heading_1",
    label: "Toggle heading 1",
    description: "Large heading that can hide nested content.",
    koLabel: "토글 제목1",
    koDescription: "내용을 접을 수 있는 큰 제목이에요.",
    glyph: "▸H₁",
    group: "Advanced",
    keywords: ["toggle", "heading", "h1", "collapse", "section"],
    koKeywords: ["토글", "제목", "접기", "섹션"],
    placeholder: "Toggle heading 1",
  },
  {
    type: "heading_2",
    label: "Heading 2",
    description: "Medium section heading.",
    koLabel: "제목2",
    koDescription: "중간 크기 섹션 제목이에요.",
    glyph: "H₂",
    group: "Basic",
    keywords: ["h2", "heading", "subtitle"],
    koKeywords: ["제목", "제목2", "부제목"],
    placeholder: "Heading 2",
  },
  {
    type: "toggle_heading_2",
    label: "Toggle heading 2",
    description: "Medium heading that can hide nested content.",
    koLabel: "토글 제목2",
    koDescription: "내용을 접을 수 있는 중간 크기 제목이에요.",
    glyph: "▸H₂",
    group: "Advanced",
    keywords: ["toggle", "heading", "h2", "collapse", "section"],
    koKeywords: ["토글", "제목", "접기", "섹션"],
    placeholder: "Toggle heading 2",
  },
  {
    type: "heading_3",
    label: "Heading 3",
    description: "Small section heading.",
    koLabel: "제목3",
    koDescription: "작은 섹션 제목이에요.",
    glyph: "H₃",
    group: "Basic",
    keywords: ["h3", "heading"],
    koKeywords: ["제목", "제목3"],
    placeholder: "Heading 3",
  },
  {
    type: "toggle_heading_3",
    label: "Toggle heading 3",
    description: "Small heading that can hide nested content.",
    koLabel: "토글 제목3",
    koDescription: "내용을 접을 수 있는 작은 제목이에요.",
    glyph: "▸H₃",
    group: "Advanced",
    keywords: ["toggle", "heading", "h3", "collapse", "section"],
    koKeywords: ["토글", "제목", "접기", "섹션"],
    placeholder: "Toggle heading 3",
  },
  {
    type: "heading_4",
    label: "Heading 4",
    description: "Compact section heading.",
    koLabel: "제목4",
    koDescription: "가장 작은 섹션 제목이에요.",
    glyph: "H₄",
    group: "Basic",
    keywords: ["h4", "heading", "small"],
    koKeywords: ["제목", "제목4", "작은 제목"],
    placeholder: "Heading 4",
  },
  {
    type: "toggle_heading_4",
    label: "Toggle heading 4",
    description: "Compact heading that can hide nested content.",
    koLabel: "토글 제목4",
    koDescription: "내용을 접을 수 있는 가장 작은 제목이에요.",
    glyph: "▸H₄",
    group: "Advanced",
    keywords: ["toggle", "heading", "h4", "collapse", "section"],
    koKeywords: ["토글", "제목", "접기", "섹션"],
    placeholder: "Toggle heading 4",
  },
  {
    type: "to_do",
    label: "To-do list",
    description: "Track tasks with a checkbox.",
    koLabel: "할 일 목록",
    koDescription: "체크박스로 할 일을 관리해요.",
    glyph: "☑",
    group: "Basic",
    keywords: ["todo", "task", "checkbox", "check"],
    koKeywords: ["할 일", "체크", "체크박스", "작업"],
    placeholder: "To-do",
    continues: true,
  },
  {
    type: "bulleted_list_item",
    label: "Bulleted list",
    description: "Create a simple bulleted list.",
    koLabel: "글머리 기호 목록",
    koDescription: "간단한 글머리 기호 목록을 만들어요.",
    glyph: "•",
    group: "Basic",
    keywords: ["bullet", "list", "unordered", "ul"],
    koKeywords: ["글머리", "글머리 기호", "목록", "리스트"],
    placeholder: "List",
    continues: true,
  },
  {
    type: "numbered_list_item",
    label: "Numbered list",
    description: "Create a list with numbering.",
    koLabel: "번호 매기기 목록",
    koDescription: "번호가 붙는 목록을 만들어요.",
    glyph: "1.",
    group: "Basic",
    keywords: ["number", "ordered", "list", "ol"],
    koKeywords: ["번호", "번호 목록", "순서", "목록"],
    placeholder: "List",
    continues: true,
  },
  {
    type: "toggle",
    label: "Toggle list",
    description: "Toggles can hide and show content.",
    koLabel: "토글 목록",
    koDescription: "토글로 내용을 접었다 펼 수 있어요.",
    glyph: "▸",
    group: "Basic",
    keywords: ["toggle", "collapse", "expand", "details"],
    koKeywords: ["토글", "접기", "펼치기"],
    placeholder: "Toggle",
  },
  {
    type: "quote",
    label: "Quote",
    description: "Capture a quote.",
    koLabel: "인용",
    koDescription: "인용문을 담아 보세요.",
    glyph: "❝",
    group: "Basic",
    keywords: ["quote", "blockquote"],
    koKeywords: ["인용", "인용문", "인용구"],
    placeholder: "Empty quote",
  },
  {
    type: "callout",
    label: "Callout",
    description: "Make writing stand out.",
    koLabel: "콜아웃",
    koDescription: "글을 눈에 띄게 강조해요.",
    glyph: "💡",
    group: "Basic",
    keywords: ["callout", "note", "info", "tip"],
    koKeywords: ["콜아웃", "강조", "메모", "알림"],
    placeholder: "Type something…",
  },
  {
    type: "divider",
    label: "Divider",
    description: "Visually divide blocks.",
    koLabel: "구분선",
    koDescription: "블록 사이를 시각적으로 나눠요.",
    glyph: "—",
    group: "Basic",
    keywords: ["divider", "separator", "line", "hr"],
    koKeywords: ["구분선", "분리선", "가로선", "줄"],
  },
  {
    type: "code",
    label: "Code",
    description: "Capture a code snippet.",
    koLabel: "코드",
    koDescription: "코드 스니펫을 담아요.",
    glyph: "</>",
    group: "Media",
    keywords: ["code", "snippet", "mono"],
    koKeywords: ["코드", "스니펫", "프로그래밍"],
    placeholder: "Write code, or paste a snippet…",
  },
  {
    type: "equation",
    label: "Equation",
    description: "Display a math equation.",
    koLabel: "수식",
    koDescription: "수학 수식을 표시해요.",
    glyph: "∑",
    group: "Advanced",
    keywords: ["equation", "math", "latex", "formula"],
    koKeywords: ["수식", "수학", "라텍스", "공식"],
  },
  {
    type: "table_of_contents",
    label: "Table of contents",
    description: "Show links to headings in this page.",
    koLabel: "목차",
    koDescription: "이 페이지의 제목으로 가는 링크를 보여줘요.",
    glyph: "☰",
    group: "Advanced",
    keywords: ["toc", "contents", "outline", "headings", "table"],
    koKeywords: ["목차", "개요", "차례"],
  },
  {
    type: "synced_block",
    label: "Synced block",
    description: "Reuse content across pages.",
    koLabel: "동기화 블록",
    koDescription: "여러 페이지에서 콘텐츠를 재사용해요.",
    glyph: "↔",
    group: "Advanced",
    keywords: ["synced", "sync", "reuse", "linked", "copy"],
    koKeywords: ["동기화", "싱크", "재사용", "연결"],
  },
  {
    type: "button",
    label: "Button",
    description: "Insert reusable content with one click.",
    koLabel: "버튼",
    koDescription: "클릭 한 번으로 콘텐츠를 삽입해요.",
    glyph: "▣",
    group: "Advanced",
    keywords: ["button", "template", "action", "insert"],
    koKeywords: ["버튼", "템플릿", "동작"],
  },
  {
    type: "tab",
    label: "Tabs",
    description: "Group content into labeled tabs.",
    koLabel: "탭",
    koDescription: "콘텐츠를 탭으로 묶어 정리해요.",
    glyph: "▤",
    group: "Advanced",
    keywords: ["tab", "tabs", "section", "organize", "container"],
    koKeywords: ["탭", "섹션", "정리"],
    placeholder: "Tabs",
  },
  {
    type: "breadcrumb",
    label: "Breadcrumb",
    description: "Show where this page lives.",
    koLabel: "이동 경로",
    koDescription: "이 페이지의 위치를 보여줘요.",
    glyph: "›",
    group: "Advanced",
    keywords: ["breadcrumb", "path", "navigation", "page", "parent"],
    koKeywords: ["이동 경로", "경로", "탐색", "내비게이션"],
  },
  {
    id: "action_duplicate",
    type: "paragraph",
    label: "Duplicate",
    description: "Create an exact copy of this block.",
    koLabel: "복제",
    koDescription: "이 블록의 사본을 만들어요.",
    glyph: "⧉",
    group: "Advanced",
    keywords: ["duplicate", "copy", "clone"],
    koKeywords: ["복제", "복사"],
    action: "duplicate",
  },
  {
    id: "action_move_to",
    type: "paragraph",
    label: "Move to",
    description: "Move this block to another page.",
    koLabel: "옮기기",
    koDescription: "이 블록을 다른 페이지로 옮겨요.",
    glyph: "↗",
    group: "Advanced",
    keywords: ["move", "moveto", "move to", "page"],
    koKeywords: ["옮기기", "이동"],
    action: "move_to",
  },
  {
    id: "action_delete",
    type: "paragraph",
    label: "Delete",
    description: "Delete this block.",
    koLabel: "삭제",
    koDescription: "이 블록을 삭제해요.",
    glyph: "⌫",
    group: "Advanced",
    keywords: ["delete", "remove", "trash"],
    koKeywords: ["삭제", "제거", "지우기"],
    action: "delete",
  },
  {
    id: "action_turn_into",
    type: "paragraph",
    label: "Turn into",
    description: "Change this block's type.",
    koLabel: "전환",
    koDescription: "이 블록의 유형을 바꿔요.",
    glyph: "↪",
    group: "Advanced",
    keywords: ["turn", "turn into", "convert", "change type"],
    koKeywords: ["전환", "변환", "바꾸기", "유형 변경"],
    action: "turn_into",
  },
  {
    id: "action_color",
    type: "paragraph",
    label: "Color",
    description: "Change this block's text or background color.",
    koLabel: "색",
    koDescription: "블록의 글자색이나 배경색을 바꿔요.",
    glyph: "A",
    group: "Advanced",
    keywords: ["color", "colour", "background", "highlight", "default"],
    koKeywords: ["색", "색상", "배경", "강조"],
    action: "color",
  },
  ...COLOR_SLASH_DEFS,
  {
    type: "simple_table",
    label: "Table",
    description: "Add a simple table to this page.",
    koLabel: "표",
    koDescription: "이 페이지에 간단한 표를 추가해요.",
    glyph: "▤",
    group: "Basic",
    keywords: ["table", "simple", "grid", "cells"],
    koKeywords: ["표", "테이블", "그리드", "셀"],
  },
  {
    id: "column_list_2",
    type: "column_list",
    label: "2 columns",
    description: "Place blocks side by side.",
    koLabel: "2개의 열",
    koDescription: "블록을 나란히 배치해요.",
    glyph: "▥▥",
    group: "Advanced",
    keywords: ["column", "columns", "layout", "two", "side"],
    koKeywords: ["열", "단", "레이아웃", "2단"],
    columnCount: 2,
  },
  {
    id: "column_list_3",
    type: "column_list",
    label: "3 columns",
    description: "Arrange blocks in three columns.",
    koLabel: "3개의 열",
    koDescription: "블록을 3개의 열로 배치해요.",
    glyph: "▥▥▥",
    group: "Advanced",
    keywords: ["column", "columns", "layout", "three", "side"],
    koKeywords: ["열", "단", "레이아웃", "3단"],
    columnCount: 3,
  },
  {
    id: "column_list_4",
    type: "column_list",
    label: "4 columns",
    description: "Arrange blocks in four columns.",
    koLabel: "4개의 열",
    koDescription: "블록을 4개의 열로 배치해요.",
    glyph: "▥▥▥▥",
    group: "Advanced",
    keywords: ["column", "columns", "layout", "four", "side"],
    koKeywords: ["열", "단", "레이아웃", "4단"],
    columnCount: 4,
  },
  {
    id: "column_list_5",
    type: "column_list",
    label: "5 columns",
    description: "Arrange blocks in five columns.",
    koLabel: "5개의 열",
    koDescription: "블록을 5개의 열로 배치해요.",
    glyph: "▥▥▥▥▥",
    group: "Advanced",
    keywords: ["column", "columns", "layout", "five", "side"],
    koKeywords: ["열", "단", "레이아웃", "5단"],
    columnCount: 5,
  },
  {
    type: "image",
    label: "Image",
    description: "Upload or embed with a link.",
    koLabel: "이미지",
    koDescription: "업로드하거나 링크로 임베드해요.",
    glyph: "▧",
    group: "Media",
    keywords: ["image", "photo", "picture", "media", "embed"],
    koKeywords: ["이미지", "사진", "그림", "미디어"],
  },
  {
    type: "video",
    label: "Video",
    description: "Embed a video with a link.",
    koLabel: "동영상",
    koDescription: "링크로 동영상을 임베드해요.",
    glyph: "▶",
    group: "Media",
    keywords: ["video", "movie", "media", "mp4", "embed"],
    koKeywords: ["동영상", "비디오", "영상", "미디어"],
  },
  {
    type: "audio",
    label: "Audio",
    description: "Embed audio with a link.",
    koLabel: "오디오",
    koDescription: "링크로 오디오를 임베드해요.",
    glyph: "♫",
    group: "Media",
    keywords: ["audio", "sound", "music", "mp3", "media"],
    koKeywords: ["오디오", "소리", "음악", "음성"],
  },
  {
    type: "bookmark",
    label: "Web bookmark",
    description: "Save a web link as a card.",
    koLabel: "웹 북마크",
    koDescription: "웹 링크를 카드로 저장해요.",
    glyph: "🔖",
    group: "Media",
    keywords: ["bookmark", "link", "url", "web", "preview"],
    koKeywords: ["북마크", "링크", "주소", "웹"],
  },
  {
    type: "embed",
    label: "Embed",
    description: "Embed content from a link.",
    koLabel: "임베드",
    koDescription: "링크의 콘텐츠를 임베드해요.",
    glyph: "▣",
    group: "Media",
    keywords: ["embed", "iframe", "website", "link", "url"],
    koKeywords: ["임베드", "삽입", "웹사이트", "링크"],
  },
  {
    type: "file",
    label: "File",
    description: "Attach a file link to this page.",
    koLabel: "파일",
    koDescription: "이 페이지에 파일 링크를 첨부해요.",
    glyph: "▭",
    group: "Media",
    keywords: ["file", "attachment", "download", "pdf", "document"],
    koKeywords: ["파일", "첨부", "다운로드", "문서"],
  },
  {
    type: "child_database",
    label: "Database - Full page",
    description: "Add a new database as a sub-page.",
    koLabel: "데이터베이스 - 전체 페이지",
    koDescription: "하위 페이지로 새 데이터베이스를 추가해요.",
    glyph: "▦",
    group: "Database",
    keywords: ["database", "table", "board", "db", "grid"],
    koKeywords: ["데이터베이스", "표", "보드"],
  },
  {
    id: "child_database_table",
    type: "child_database",
    label: "Table - Full page",
    description: "Add a full-page database as a table.",
    koLabel: "표 - 전체 페이지",
    koDescription: "전체 페이지 데이터베이스를 표로 추가해요.",
    glyph: "▦",
    group: "Database",
    keywords: ["database", "full", "page", "table", "view", "grid"],
    koKeywords: ["데이터베이스", "전체 페이지", "표", "보기"],
    databaseView: "table",
  },
  {
    id: "child_database_board",
    type: "child_database",
    label: "Board - Full page",
    description: "Add a full-page kanban board.",
    koLabel: "보드 - 전체 페이지",
    koDescription: "전체 페이지 칸반 보드를 추가해요.",
    glyph: "▤",
    group: "Database",
    keywords: ["database", "full", "page", "board", "kanban", "status"],
    koKeywords: ["데이터베이스", "전체 페이지", "보드", "칸반"],
    databaseView: "board",
  },
  {
    id: "child_database_list",
    type: "child_database",
    label: "List - Full page",
    description: "Add a full-page database as a list.",
    koLabel: "목록 - 전체 페이지",
    koDescription: "전체 페이지 데이터베이스를 목록으로 추가해요.",
    glyph: "≣",
    group: "Database",
    keywords: ["database", "full", "page", "list", "view"],
    koKeywords: ["데이터베이스", "전체 페이지", "목록", "보기"],
    databaseView: "list",
  },
  {
    id: "child_database_timeline",
    type: "child_database",
    label: "Timeline - Full page",
    description: "Add a full-page database timeline.",
    koLabel: "타임라인 - 전체 페이지",
    koDescription: "전체 페이지 데이터베이스 타임라인을 추가해요.",
    glyph: "⊞",
    group: "Database",
    keywords: ["database", "full", "page", "timeline", "roadmap", "date"],
    koKeywords: ["데이터베이스", "전체 페이지", "타임라인", "로드맵", "날짜"],
    databaseView: "timeline",
  },
  {
    id: "child_database_calendar",
    type: "child_database",
    label: "Calendar - Full page",
    description: "Add a full-page calendar database.",
    koLabel: "캘린더 - 전체 페이지",
    koDescription: "전체 페이지 캘린더 데이터베이스를 추가해요.",
    glyph: "▩",
    group: "Database",
    keywords: ["database", "full", "page", "calendar", "date"],
    koKeywords: ["데이터베이스", "전체 페이지", "캘린더", "달력", "날짜"],
    databaseView: "calendar",
  },
  {
    id: "child_database_gallery",
    type: "child_database",
    label: "Gallery - Full page",
    description: "Add a full-page database gallery.",
    koLabel: "갤러리 - 전체 페이지",
    koDescription: "전체 페이지 데이터베이스 갤러리를 추가해요.",
    glyph: "▥",
    group: "Database",
    keywords: ["database", "full", "page", "gallery", "cards"],
    koKeywords: ["데이터베이스", "전체 페이지", "갤러리", "카드"],
    databaseView: "gallery",
  },
  {
    type: "inline_database",
    label: "Database - Inline",
    description: "Add a database inside this page.",
    koLabel: "데이터베이스 - 인라인",
    koDescription: "이 페이지 안에 데이터베이스를 추가해요.",
    glyph: "▥",
    group: "Database",
    keywords: ["database", "inline", "table", "board", "db", "grid"],
    koKeywords: ["데이터베이스", "인라인", "표", "보드"],
  },
  {
    id: "inline_database_table",
    type: "inline_database",
    label: "Table view",
    description: "Add an inline database as a table.",
    koLabel: "표 보기",
    koDescription: "인라인 데이터베이스를 표로 추가해요.",
    glyph: "▦",
    group: "Database",
    keywords: ["database", "inline", "table", "view", "grid"],
    koKeywords: ["데이터베이스", "인라인", "표", "보기"],
    databaseView: "table",
  },
  {
    id: "inline_database_board",
    type: "inline_database",
    label: "Board view",
    description: "Add an inline kanban board.",
    koLabel: "보드 보기",
    koDescription: "인라인 칸반 보드를 추가해요.",
    glyph: "▤",
    group: "Database",
    keywords: ["database", "inline", "board", "kanban", "status"],
    koKeywords: ["데이터베이스", "인라인", "보드", "칸반"],
    databaseView: "board",
  },
  {
    id: "inline_database_list",
    type: "inline_database",
    label: "List view",
    description: "Add an inline database as a list.",
    koLabel: "목록 보기",
    koDescription: "인라인 데이터베이스를 목록으로 추가해요.",
    glyph: "≣",
    group: "Database",
    keywords: ["database", "inline", "list", "view"],
    koKeywords: ["데이터베이스", "인라인", "목록", "보기"],
    databaseView: "list",
  },
  {
    id: "inline_database_timeline",
    type: "inline_database",
    label: "Timeline view",
    description: "Add an inline database timeline.",
    koLabel: "타임라인 보기",
    koDescription: "인라인 데이터베이스 타임라인을 추가해요.",
    glyph: "⊞",
    group: "Database",
    keywords: ["database", "inline", "timeline", "roadmap", "date"],
    koKeywords: ["데이터베이스", "인라인", "타임라인", "로드맵", "날짜"],
    databaseView: "timeline",
  },
  {
    id: "inline_database_calendar",
    type: "inline_database",
    label: "Calendar view",
    description: "Add an inline calendar database.",
    koLabel: "캘린더 보기",
    koDescription: "인라인 캘린더 데이터베이스를 추가해요.",
    glyph: "▩",
    group: "Database",
    keywords: ["database", "inline", "calendar", "date"],
    koKeywords: ["데이터베이스", "인라인", "캘린더", "달력", "날짜"],
    databaseView: "calendar",
  },
  {
    id: "inline_database_gallery",
    type: "inline_database",
    label: "Gallery view",
    description: "Add an inline database gallery.",
    koLabel: "갤러리 보기",
    koDescription: "인라인 데이터베이스 갤러리를 추가해요.",
    glyph: "▥",
    group: "Database",
    keywords: ["database", "inline", "gallery", "cards"],
    koKeywords: ["데이터베이스", "인라인", "갤러리", "카드"],
    databaseView: "gallery",
  },
];

function blockDefKey(def: Pick<BlockDef, "id" | "type">) {
  return def.id ?? def.type;
}

const SLASH_ORDER_KEYS = [
  "paragraph",
  "child_page",
  "to_do",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "simple_table",
  "bulleted_list_item",
  "numbered_list_item",
  "toggle",
  "quote",
  "divider",
  "link_to_page",
  "callout",
  "image",
  "bookmark",
  "video",
  "audio",
  "code",
  "file",
  "embed",
  "inline_database_table",
  "inline_database_board",
  "inline_database_gallery",
  "inline_database_list",
  "inline_database_calendar",
  "inline_database_timeline",
  "inline_database",
  "child_database_table",
  "child_database_board",
  "child_database_gallery",
  "child_database_list",
  "child_database_calendar",
  "child_database_timeline",
  "child_database",
  "table_of_contents",
  "breadcrumb",
  "action_duplicate",
  "action_move_to",
  "action_delete",
  "action_turn_into",
  "action_color",
  "button",
  "tab",
  "synced_block",
  "equation",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
  "toggle_heading_4",
  "column_list_2",
  "column_list_3",
  "column_list_4",
  "column_list_5",
] as const;

const SLASH_ORDER = new Map<string, number>(
  SLASH_ORDER_KEYS.map((key, index) => [key, index])
);

function slashOrder(def: BlockDef, fallback: number) {
  return SLASH_ORDER.get(blockDefKey(def)) ?? SLASH_ORDER_KEYS.length + fallback;
}

const DEF_MAP: Record<string, BlockDef> = {};
for (const def of BLOCK_DEFS) {
  DEF_MAP[def.type] ??= def;
}

export function getDef(type: BlockType): BlockDef {
  return DEF_MAP[type] ?? DEF_MAP["paragraph"];
}

/** Slash-menu results for a query (label + keyword match). */
export function matchBlocks(query: string): BlockDef[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return BLOCK_DEFS.filter((def) => !def.hiddenWhenEmpty)
      .map((def, index) => ({ def, index }))
      .sort((a, b) => slashOrder(a.def, a.index) - slashOrder(b.def, b.index))
      .map((item) => item.def);
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  return BLOCK_DEFS.map((def, index) => ({
    def,
    index,
    rank: blockSearchRank(def, q, tokens),
  }))
    .filter((item) => Number.isFinite(item.rank))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        slashOrder(a.def, a.index) - slashOrder(b.def, b.index)
    )
    .map((item) => item.def);
}

/** Every searchable keyword for a def — EN and ko match in any locale. */
export function blockDefSearchKeywords(def: BlockDef): string[] {
  return def.koKeywords ? [...def.keywords, ...def.koKeywords] : def.keywords;
}

function blockSearchRank(def: BlockDef, query: string, tokens: string[]) {
  // English and Korean labels/keywords/descriptions all match regardless of
  // the active locale, so mixed-language teams can filter either way.
  const labels = [def.label, ...(def.koLabel ? [def.koLabel] : [])].map((label) =>
    label.toLowerCase()
  );
  const descriptions = [
    def.description,
    ...(def.koDescription ? [def.koDescription] : []),
  ].map((description) => description.toLowerCase());
  const keywords = blockDefSearchKeywords(def).map((keyword) => keyword.toLowerCase());
  const haystack = `${labels.join(" ")} ${descriptions.join(" ")} ${keywords.join(" ")}`;

  if (labels.some((label) => label === query)) return 0;
  if (labels.some((label) => label.startsWith(query))) return 1;
  if (keywords.some((keyword) => keyword === query)) return 2;
  if (keywords.some((keyword) => keyword.startsWith(query))) return 3;
  if (labels.some((label) => label.includes(query))) return 4;
  if (haystack.includes(query)) return 5;
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return 6;
  return Number.POSITIVE_INFINITY;
}

/** Markdown-style shortcuts: trigger text (before a space) → block type. */
export const MD_SHORTCUTS: { trigger: string; type: BlockType; content?: Partial<BlockContent> }[] = [
  { trigger: "#", type: "heading_1" },
  { trigger: "##", type: "heading_2" },
  { trigger: "###", type: "heading_3" },
  { trigger: "####", type: "heading_4" },
  { trigger: "-", type: "bulleted_list_item" },
  { trigger: "*", type: "bulleted_list_item" },
  { trigger: "+", type: "bulleted_list_item" },
  { trigger: "1.", type: "numbered_list_item" },
  { trigger: "1)", type: "numbered_list_item" },
  { trigger: "[]", type: "to_do", content: { checked: false } },
  { trigger: "[ ]", type: "to_do", content: { checked: false } },
  { trigger: "[x]", type: "to_do", content: { checked: true } },
  { trigger: "[X]", type: "to_do", content: { checked: true } },
  { trigger: "- [ ]", type: "to_do", content: { checked: false } },
  { trigger: "* [ ]", type: "to_do", content: { checked: false } },
  { trigger: "- [x]", type: "to_do", content: { checked: true } },
  { trigger: "- [X]", type: "to_do", content: { checked: true } },
  { trigger: "* [x]", type: "to_do", content: { checked: true } },
  { trigger: "* [X]", type: "to_do", content: { checked: true } },
  { trigger: ">#", type: "toggle_heading_1" },
  { trigger: ">##", type: "toggle_heading_2" },
  { trigger: ">###", type: "toggle_heading_3" },
  { trigger: ">####", type: "toggle_heading_4" },
  { trigger: ">", type: "toggle" },
  { trigger: '"', type: "quote" },
  { trigger: "```", type: "code" },
  { trigger: "$$", type: "equation" },
  { trigger: "---", type: "divider" },
  { trigger: "***", type: "divider" },
];

/** Block types that render text content. */
export const TEXT_BLOCKS: Set<BlockType> = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
  "toggle_heading_4",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
]);
