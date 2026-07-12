# Icon Parity Audit — hand-drawn vs Phosphor (2026-07-10)

Analysis-only audit of `web/src/icons/hanji/index.tsx` (the Hanji icon
wrapper), plus the two glyph routers `web/src/components/database/PropertyTypeIcon.tsx`
and `web/src/components/editor/BlockIcon.tsx`. No source changes were made.

Policy references:
- Library-first icon policy (internal contract candidate):
  main UI icons come from a library by default; no new hand-drawn SVG UI icons
  without explicit user approval; closest library icon first, candidate note
  before any custom vector work.
- Icon System Rule (internal Notion-reference loop): no hand-authored local
  SVG paths for parity-sensitive surfaces; imported open-source glyphs behind
  the app-owned wrapper.

## Summary

- **93 total exports** in `web/src/icons/hanji/index.tsx`.
- **48 Phosphor-backed** (`PhosphorIconSvg`, default weight `light`;
  `weight="regular"` is passed at the sidebar top-rail call sites in
  `Sidebar.tsx`, and a few wrappers hardcode `fill`).
- **45 hand-drawn** (`IconSvg`, fixed 1.7 stroke on a 20×20 viewBox,
  `data-hanji-icon-source="hanji"`). These violate the library-first policy
  and are the replacement backlog.
- Every proposed replacement glyph below was verified to exist in the
  installed `@phosphor-icons/react` 2.1.x (`web/node_modules`). **No icon
  strictly requires an Iconoir/Tabler exception**; two weak matches are
  flagged with documented-exception alternatives.
- 3 exports are currently unused by any component: hand-drawn
  `TextAlignIcon` and `VolumeIcon`, and Phosphor-backed `NoteMicIcon`
  (candidates for deletion rather than swap).
- Guard note: `first-workspace-visual-smoke`, `page-tree-ui-smoke`,
  `database-view-ui-smoke`, `basic-blocks-visual-smoke`, and
  `nested-blocks-visual-smoke` assert `data-hanji-icon-source === 'phosphor'`
  on the sidebar top rail and toggle carets. No smoke asserts the `hanji`
  source anywhere, so converting hand-drawn icons to `PhosphorIconSvg` cannot
  break an existing source assertion.
- Both glyph routers (`PropertyTypeIcon.tsx`, `BlockIcon.tsx`) contain **no
  inline SVG of their own** — they only select from the Hanji barrel, so
  fixing the barrel fixes them.
- `web/src/components/icons.tsx` is a one-line legacy shim
  (`export * from "@/icons/hanji"`); no separate glyph source.

## 1. Full inventory

Surface legend (from import-statement mapping across `web/src`, not raw name
grep — names like `X`/`ArrowUp`/`Database` collide with key-event strings and
type names):
**sidebar** = `Sidebar` / `PageTreeItem` / `HomeView`; **topbar** = `TopBar` /
`PageHeader` / `PageFindBar` / `PageBacklinks`; **ctx-menu** = `RowMenu`
(page/row context menu); **db-toolbar** = `DatabaseView` / `TableView` toolbar
chrome; **db-views** = board/calendar/gallery/list/timeline views +
`PropertyCell` / `PropValue` / `RowProperties` / `PropertyTypeConfig` /
`NotionSelect`; **prop-menu** = `PropertyTypeIcon` (property type menus);
**editor** = `Editor` / `BlockItem` / `BlockHandle` / `BlockIcon` /
`SelectionToolbar` / `BlockMoveToDialog` / `SlashMenu` (gutter, block menus,
slash menu); **dialogs** = `SearchDialog` / `MoveToDialog` / `TemplatesDialog`
/ `TrashView` / `UpdatesPanel` / `CommentsPanel` / `PageIcon`; **settings** =
`WorkspaceSettingsDialog`; **import** = `ImportDialog` / `NotionTokenGuide`.

### Phosphor-backed exports (48)

| Export | Source | Used-in surface |
| --- | --- | --- |
| ChevronRight | Phosphor:CaretRight@light | sidebar (tree expand), topbar (breadcrumbs), ctx-menu, db-toolbar, editor, import |
| CaretRightFill | Phosphor:CaretRight@fill | editor (toggle blocks) |
| PlayIcon | Phosphor:Play@light | import (token walkthrough) |
| PauseIcon | Phosphor:Pause@light | import (token walkthrough) |
| ChevronLeft | Phosphor:CaretLeft@light | db-views (calendar nav), editor, import |
| ChevronDown | Phosphor:CaretDown@light | sidebar, topbar, db-toolbar, db-views, editor |
| ChevronUp | Phosphor:CaretUp@light | db-views (row properties) |
| DoubleChevronLeft | Phosphor:CaretDoubleLeft@light | sidebar (collapse) |
| DoubleChevronRight | Phosphor:CaretDoubleRight@light | db-toolbar (side peek) |
| MenuIcon | Phosphor:SidebarSimple@light | topbar (sidebar toggle) |
| DotsHorizontal | Phosphor:DotsThree@light | sidebar (row actions), topbar, db-toolbar, editor |
| EyeIcon | Phosphor:Eye@fill | db-toolbar (property visibility) |
| EyeSlashIcon | Phosphor:EyeSlash@fill | db-toolbar, editor |
| Home | Phosphor:House@light (regular at top rail) | sidebar (top rail), dialogs (move-to) |
| Search | Phosphor:MagnifyingGlass@light (regular at top rail) | sidebar (top rail), dialogs, db-toolbar, settings, editor |
| CommentIcon | Phosphor:ChatTeardropText@light | topbar, ctx-menu, db-toolbar, editor (selection toolbar) |
| Bell | Phosphor:Bell@light | dialogs (updates panel) |
| MailIcon | Phosphor:Tray@light (regular at top rail) | sidebar (inbox), prop-menu (email) |
| NoteMicIcon | Phosphor:FileAudio@light | **unused** |
| Copy | Phosphor:CopySimple@light | ctx-menu, topbar, db-toolbar, prop-menu (fallback), editor |
| Download | Phosphor:DownloadSimple@light | ctx-menu, sidebar, topbar, db-views |
| LinkIcon | Phosphor:LinkSimple@light | topbar, ctx-menu, db-toolbar, prop-menu (relation/url), editor |
| FileText | Phosphor:FileText@light | sidebar, dialogs (page rows), db-views, prop-menu (files), editor |
| LockIcon | Phosphor:LockSimple@light | topbar, sidebar (tree), ctx-menu, settings, db-toolbar, dialogs, editor |
| UnlockIcon | Phosphor:LockSimpleOpen@light | ctx-menu, topbar |
| SharePeopleIcon | Phosphor:Users@light | topbar (share), settings, db-toolbar |
| Upload | Phosphor:UploadSimple@light | import, ctx-menu, sidebar, topbar, settings, editor |
| OpenInNew | Phosphor:ArrowSquareOut@light | ctx-menu, topbar, db-toolbar, db-views, editor (embed) |
| OpenAsPage | Phosphor:ArrowSquareOut@light | db-toolbar (row peek) |
| Trash | Phosphor:TrashSimple@light | ctx-menu, sidebar, topbar, dialogs (trash view), db-toolbar, db-views, editor |
| Star | Phosphor:Star@light | ctx-menu, topbar, db-toolbar (favorite) |
| StarFilled | Phosphor:Star@fill | ctx-menu, topbar, dialogs, db-toolbar |
| ClockIcon | Phosphor:Clock@light | ctx-menu, topbar, dialogs, db-toolbar, prop-menu (created/edited time) |
| TextIcon | Phosphor:TextT@light | prop-menu (title/text), editor (paragraph) |
| HeadingOneIcon | Phosphor:TextHOne@light | editor (blocks) |
| HeadingTwoIcon | Phosphor:TextHTwo@light | editor (blocks) |
| HeadingThreeIcon | Phosphor:TextHThree@light | editor (blocks; also H4) |
| BulletedListIcon | Phosphor:ListBullets@light | editor (blocks) |
| NumberedListIcon | Phosphor:ListNumbers@light | editor (blocks) |
| QuoteIcon | Phosphor:Quotes@light | editor (blocks) |
| CodeIcon | Phosphor:Code@light | editor (blocks) |
| DividerIcon | Phosphor:Minus@light | editor (blocks) |
| EquationIcon | Phosphor:MathOperations@light | editor (blocks) |
| ColumnsIcon | Phosphor:Columns@light | editor (columns/tab blocks) |
| CalloutIcon | Phosphor:WarningCircle@light | editor (blocks) |
| AudioIcon | Phosphor:SpeakerHigh@light | editor (audio block) |
| ChartIcon | Phosphor:ChartBar@light | db-toolbar (chart view tab) |
| CalendarIcon | Phosphor:CalendarBlank@light | dialogs, db-toolbar (view tab), prop-menu (date), editor |

### Hand-drawn exports (45) — replacement backlog

| Export | Source | Used-in surface | Proposed Phosphor glyph |
| --- | --- | --- | --- |
| ArrowLeft | hand-drawn | dialogs (updates), db-toolbar (sort dir), editor (block handle) | `ArrowLeft` |
| ArrowRight | hand-drawn | dialogs (updates), db-toolbar | `ArrowRight` |
| ArrowUp | hand-drawn | topbar (find bar), db-toolbar (sort), editor | `ArrowUp` |
| ArrowDown | hand-drawn | topbar (find bar), db-toolbar (sort), editor | `ArrowDown` |
| Plus | hand-drawn | sidebar (new page), ctx-menu, dialogs, all db views ("+ New"), editor gutter | `Plus` |
| CheckIcon | hand-drawn | topbar, ctx-menu, sidebar, dialogs, db-toolbar, db-views (menus/selects), editor | `Check` |
| X | hand-drawn | dialogs/panels (close), import, db-toolbar, db-views (chips), editor | `X` |
| Settings | hand-drawn | sidebar, topbar, ctx-menu, db-views | `GearSix` (alt `Gear`) |
| LogOutIcon | hand-drawn | sidebar (account menu) | `SignOut` |
| SmileIcon | hand-drawn | topbar (page header "add icon"), ctx-menu, editor | `Smiley` |
| ImageIcon | hand-drawn | topbar (add cover), editor (image block) | `Image` |
| Pencil | hand-drawn | ctx-menu, editor | `PencilSimpleLine` (alt `PencilSimple`) |
| GlobeIcon | hand-drawn | topbar (share/publish), settings, import | `Globe` (meridian style matches drawn glyph) |
| LibraryIcon | hand-drawn | sidebar (templates/library entry) | `Books` |
| MoveIcon | hand-drawn | topbar, ctx-menu ("Move to"), editor (block handle) | `ArrowLineRight` — **weak match** (bar sits on the arrowhead side, not the origin). Documented exception candidate: Tabler `arrow-bar-right` (exact bar-then-arrow shape); Phosphor alt `ArrowSquareRight` |
| TurnIntoIcon | hand-drawn | editor (block handle "Turn into") | `Swap` (alt `ArrowsClockwise`; keep distinct from SyncIcon) |
| PaletteIcon | hand-drawn | settings (theme), editor (block color) | `Palette` |
| DragHandleIcon | hand-drawn (fill dots) | sidebar (tree rows), db-toolbar/views (rows, property list), editor gutter | `DotsSixVertical` (exact Notion-style 2×3 handle) |
| TextAlignIcon | hand-drawn | **unused** | delete (or `TextAlignCenter`) |
| HashIcon | hand-drawn | prop-menu (number) | `Hash` |
| CheckboxIcon | hand-drawn | prop-menu (checkbox), editor (to-do) | `CheckSquare` |
| UserIcon | hand-drawn | sidebar (account), settings, prop-menu (person), editor | `User` |
| PhoneIcon | hand-drawn | prop-menu (phone) | `Phone` |
| IdIcon | hand-drawn | prop-menu (unique_id) | `IdentificationCard` |
| FormulaIcon | hand-drawn | prop-menu (formula) | `Function` (alt `Sigma`) |
| RollupIcon | hand-drawn | prop-menu (rollup) | `ListMagnifyingGlass` — **weak match** (drawn glyph is list+arrow, Notion's is list+magnifier). Alt `ArrowsMerge`; exception candidate: Tabler `list-search` |
| Database | hand-drawn | dialogs (`PageIcon` → sidebar tree, breadcrumbs, tabs), import, editor | `Database` |
| LayoutIcon | hand-drawn | db-toolbar (layout menu), editor | `Layout` |
| PropertiesIcon | hand-drawn | db-toolbar (properties menu) | `SlidersHorizontal` |
| FilterIcon | hand-drawn | db-toolbar (filter) | `FunnelSimple` (alt `Funnel`) |
| SortIcon | hand-drawn | db-toolbar (sort) | `ArrowsDownUp` |
| SelectIcon | hand-drawn | db-toolbar, prop-menu (select/multi-select) | `Tag` (alts `CaretCircleDown`, `RowsPlusBottom`) |
| StatusIcon | hand-drawn | db-toolbar, prop-menu (status) | `SpinnerGap` (Notion's status loader look; alts `CircleHalf`, `ClockCountdown`) |
| TableIcon | hand-drawn | db-toolbar (view tab), import, editor (block/db views) | `Table` (alt `GridNine`) |
| BoardIcon | hand-drawn | db-toolbar (view tab), editor | `Kanban` |
| ListIcon | hand-drawn | db-toolbar (view tab), dialogs, editor (TOC block) | `ListDashes` (alt `Rows`; keeps distance from `ListBullets` used by BulletedListIcon) |
| TimelineIcon | hand-drawn | db-toolbar (view tab), editor | `ChartBarHorizontal` — approximate gantt. Exception candidate: Tabler `chart-gantt` |
| GalleryIcon | hand-drawn | db-toolbar (view tab), editor | `SquaresFour` |
| VideoIcon | hand-drawn | editor (video block) | `MonitorPlay` (alts `VideoCamera`, `FilmStrip`) |
| VolumeIcon | hand-drawn | **unused** | delete (AudioIcon already = `SpeakerHigh`) |
| BookmarkIcon | hand-drawn | editor (bookmark block) | `BookmarkSimple` |
| AlignLeftIcon | hand-drawn | editor (image alignment) | `TextAlignLeft` |
| AlignCenterIcon | hand-drawn | editor (image alignment) | `TextAlignCenter` |
| AlignRightIcon | hand-drawn | editor (image alignment) | `TextAlignRight` |
| SyncIcon | hand-drawn | db-toolbar (synced source badge), editor (synced block) | `ArrowsClockwise` |

All proposed primary glyphs verified present in the installed
`@phosphor-icons/react` 2.1.x. Default wrapper weight `light` applies unless a
surface already overrides (sidebar top rail uses `regular`).

## 2. Recommended swap list (ordered by surface visibility)

Sidebar/topbar chrome first, then database toolbar, then property/editor
menus, then unused cleanup:

1. **Plus → `Plus`** — sidebar new-page affordances, every database view's
   "+ New", editor gutter. Single most ubiquitous hand-drawn glyph.
2. **Settings → `GearSix`** — sidebar/topbar/context menus.
3. **DragHandleIcon → `DotsSixVertical`** — sidebar tree rows, editor gutter,
   table rows; always-on-hover chrome.
4. **CheckIcon → `Check`** — every menu checkmark and select across
   sidebar/topbar/db/editor.
5. **X → `X`** — dialog/panel close buttons and filter/select chips.
6. **Database → `Database`** — rendered by `PageIcon`, so it appears in the
   sidebar tree, breadcrumbs, and tabs for every database page.
7. **UserIcon → `User`** — sidebar account row, settings, person property.
8. **LibraryIcon → `Books`** — sidebar entry.
9. **GlobeIcon → `Globe`** — topbar share/publish popover, settings, import.
10. **MoveIcon → `ArrowLineRight`** (or approve Tabler `arrow-bar-right` as a
    documented exception) — topbar/page context menu "Move to", block handle.
11. LogOutIcon → `SignOut`; SmileIcon → `Smiley`; ImageIcon → `Image` (page
    header affordances + account menu).
12. Arrow set (ArrowUp/Down/Left/Right) → Phosphor arrows — find bar, sort
    direction menus, block-handle move actions.
13. Database toolbar cluster: FilterIcon → `FunnelSimple`, SortIcon →
    `ArrowsDownUp`, PropertiesIcon → `SlidersHorizontal`, LayoutIcon →
    `Layout`.
14. View-tab cluster: TableIcon → `Table`, BoardIcon → `Kanban`, ListIcon →
    `ListDashes`, GalleryIcon → `SquaresFour`, TimelineIcon →
    `ChartBarHorizontal` (weakest of the set).
15. Property-type cluster (`PropertyTypeIcon`): HashIcon → `Hash`,
    CheckboxIcon → `CheckSquare`, SelectIcon → `Tag`, StatusIcon →
    `SpinnerGap`, PhoneIcon → `Phone`, IdIcon → `IdentificationCard`,
    FormulaIcon → `Function`, RollupIcon → `ListMagnifyingGlass`.
16. Editor odds and ends: Pencil → `PencilSimpleLine`, PaletteIcon →
    `Palette`, TurnIntoIcon → `Swap`, SyncIcon → `ArrowsClockwise`,
    VideoIcon → `MonitorPlay`, BookmarkIcon → `BookmarkSimple`,
    AlignLeft/Center/Right → `TextAlignLeft/Center/Right`.
17. Cleanup: delete unused `TextAlignIcon`, `VolumeIcon` (hand-drawn) and
    `NoteMicIcon` (Phosphor, unused).

## 3. Notes for the implementing slice

- Swaps are name-stable: change each wrapper body from `IconSvg` to
  `PhosphorIconSvg` inside `web/src/icons/hanji/index.tsx`; no call sites need
  edits. `weight` prop then becomes functional on these icons (it is ignored
  today on hand-drawn glyphs).
- Two weak matches (MoveIcon, RollupIcon) plus TimelineIcon should be checked
  against the real Notion reference (internal Notion-reference loop)
  before choosing between the Phosphor approximation and a documented
  Tabler/Iconoir exception (per the Library-first policy: closest library
  icon first, candidate note before custom vector work).
- Optical size/weight must be re-verified against the live Notion reference
  (Phosphor `light` at 14–18px per the 2026-07-02 topbar pass), not just
  swapped 1:1 — several hand-drawn glyphs are visually heavier (1.7/20
  stroke ≈ Phosphor `regular`, not `light`).
- Existing visual smokes only assert `data-hanji-icon-source === 'phosphor'`
  (sidebar top rail, toggle carets); none pin the `hanji` source, so
  conversions cannot break those guards. Grep target if new guards are added:
  `data-hanji-icon-source` in `scripts/*.mjs`.
