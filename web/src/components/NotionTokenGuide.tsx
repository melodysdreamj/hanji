import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, PauseIcon, PlayIcon } from "./icons";

import { pickLabels } from "@/lib/i18n";
import styles from "./NotionTokenGuide.module.css";

// Animated walkthrough of the real Notion token flow, styled to read like a
// screen recording of the actual (dark) Notion developer portal: create a
// connection, pick the workspace, copy the access token, then connect the
// integration to the top-level pages you want to import. Scenes are faithful
// CSS replicas (no bundled screenshots) so text stays localized and crisp.
const SCENE_COUNT = 7;
const SCENE_MS = 3000;

const GUIDE_LABELS = {
  en: {
    region: "Notion token walkthrough",
    play: "Play",
    pause: "Pause",
    prev: "Previous step",
    next: "Next step",
    stepLabel: (n: number) => `Step ${n} of ${SCENE_COUNT}`,
    scenes: [
      {
        title: "Open the token page from Hanji",
        caption: "In Hanji, click “Open Notion token page” to open Notion's developer portal in a new tab.",
      },
      {
        title: "Create a connection",
        caption: "On notion.so/profile/integrations (Connections), click “New connection”.",
      },
      {
        title: "Pick the workspace, create the token",
        caption:
          "Choose “Access token”, then pick which Notion workspace this token applies to — a token always belongs to exactly one workspace.",
      },
      {
        title: "Copy the access token",
        caption: "Copy the ntn_… token and paste it into the token field below.",
      },
      {
        title: "Connect it to your pages",
        caption:
          "In Notion, open each top-level page → ··· → Connections → add this connection. Subpages are included automatically — then come back and scan.",
      },
      {
        title: "Paste the token into Hanji",
        caption: "Back in Hanji, paste the token you copied into the “Notion API token” field.",
      },
      {
        title: "Choose what to import",
        caption:
          "Import the entire workspace, or pick “Specific pages” to bring in only the pages and databases you select.",
      },
    ],
    mock: {
      url: "app.notion.com/developers/connections",
      hanjiTitle: "Hanji · Import",
      inkIntroTitle: "Import with a Notion API token",
      inkIntroDesc: "For local hosting, pasting a token you create in Notion is the most reliable setup.",
      inkMakeToken: "Open Notion token page",
      inkStep1Title: "Prepare Notion token",
      inkTokenLabel: "Notion API token",
      inkTokenValue: "ntn_••••••••",
      inkStep2Title: "Choose what to import",
      scopeAllTitle: "Entire workspace",
      scopeAllRec: "Recommended",
      scopeAllDesc: "Everything the connection can access. Database relations between pages stay intact.",
      scopeSomeTitle: "Specific pages",
      scopeSomeDesc: "Scan accessible top-level items, then import only the pages/databases you select.",
      urlPage: "notion.so/Team-Handbook-82fd91",
      backLink: "‹ Back to Notion",
      devTitle: "Developers",
      nav: ["Get started", "Worker", "Personal access tokens", "Connections"],
      navNew: "New",
      listTitle: "Connections",
      listSubtitle: "Create and manage Notion's public and private API connections.",
      learnMore: "Learn more",
      newConnection: "+ New connection",
      colConnection: "Connection",
      colWorkspaces: "Installable workspaces:",
      colAuthType: "Auth type",
      colOwner: "Owner",
      integrationName: "Hanji",
      capabilities: "Read content, update and insert content, and read user information",
      workspaceName: "My Workspace",
      authTypeCell: "Access token",
      ownerName: "You",
      modalTitle: "New connection",
      modalDesc:
        "Create a connection to authenticate apps, agents, and workflows with Notion. Choose a single-workspace or multi-workspace scope.",
      nameLabel: "Connection name",
      namePlaceholder: "My connection",
      authMethod: "Authentication method",
      accessToken: "Access token",
      accessTokenDesc:
        "A static, workspace-scoped API token shared between collaborators, with its own capability settings. Limited to 1 workspace and cannot be listed on the Marketplace.",
      oauth: "OAuth",
      oauthDesc:
        "User-scoped OAuth 2.0; permissions are limited to the logged-in user. Supports multiple workspaces.",
      wsLabel: "Installable workspaces:",
      wsDesc: "This token applies to the selected workspace.",
      terms: "By creating a connection you agree to Notion's developer terms.",
      createButton: "Create connection",
      breadcrumb: "Connections  ›  Manage connection",
      detailTabs: ["Configuration", "Content capabilities", "Webhooks", "Owners"],
      tokenSectionTitle: "API integration token",
      tokenSectionDesc:
        "Use this token to authenticate API requests for this workspace. Anyone with the token can act on the connection's behalf, so keep it secret.",
      tokenFieldLabel: "Access token",
      tokenValue: "••••••••••••••••••••••••••••",
      copied: "Copied",
      pageTitle: "Team Handbook",
      share: "Share",
      menuCopyLink: "Copy link",
      menuDuplicate: "Duplicate",
      menuConnectionsLabel: "Connections",
      menuAddConnection: "Add connections",
      searchPlaceholder: "Search for connections…",
    },
  },
  ko: {
    region: "Notion 토큰 발급 과정 안내",
    play: "재생",
    pause: "일시정지",
    prev: "이전 단계",
    next: "다음 단계",
    stepLabel: (n: number) => `${SCENE_COUNT}단계 중 ${n}단계`,
    scenes: [
      {
        title: "Hanji에서 토큰 페이지 열기",
        caption: "Hanji에서 “Notion 토큰 만들기”를 눌러 Notion 개발자 페이지를 새 탭으로 여세요.",
      },
      {
        title: "연결 만들기",
        caption: "notion.so/profile/integrations(연결)에서 “신규 연결”을 누르세요.",
      },
      {
        title: "워크스페이스 선택 후 토큰 생성",
        caption:
          "“액세스 토큰”을 고르고, 이 토큰을 쓸 Notion 워크스페이스를 선택하세요 — 토큰은 항상 워크스페이스 1개에만 속해요.",
      },
      {
        title: "액세스 토큰 복사",
        caption: "ntn_…으로 시작하는 토큰을 복사해 아래 토큰 칸에 붙여넣으세요.",
      },
      {
        title: "가져올 페이지에 연결 추가",
        caption:
          "Notion에서 가져올 최상위 페이지를 열고 → ··· → 연결 → 이 연결을 추가하세요. 하위 페이지는 자동으로 포함돼요 — 그다음 돌아와서 스캔하면 됩니다.",
      },
      {
        title: "Hanji에 토큰 붙여넣기",
        caption: "Hanji으로 돌아와 복사한 토큰을 “Notion API 토큰” 칸에 붙여넣으세요.",
      },
      {
        title: "가져올 범위 선택",
        caption:
          "워크스페이스 전체를 가져오거나, “특정 페이지만”을 골라 원하는 페이지·데이터베이스만 가져올 수 있어요.",
      },
    ],
    mock: {
      url: "app.notion.com/developers/connections",
      hanjiTitle: "Hanji · 가져오기",
      inkIntroTitle: "Notion API 토큰으로 가져오기",
      inkIntroDesc: "로컬호스팅에서는 Notion에서 만든 토큰을 붙여넣는 방식이 가장 안정적이에요.",
      inkMakeToken: "Notion 토큰 만들기",
      inkStep1Title: "Notion API 토큰 준비",
      inkTokenLabel: "Notion API 토큰",
      inkTokenValue: "ntn_••••••••",
      inkStep2Title: "가져올 범위 선택",
      scopeAllTitle: "워크스페이스 전체",
      scopeAllRec: "권장",
      scopeAllDesc: "연결이 접근할 수 있는 모든 페이지·데이터베이스를 가져와요. 페이지 사이의 관계도 유지돼요.",
      scopeSomeTitle: "특정 페이지만",
      scopeSomeDesc: "접근 가능한 최상위 항목을 스캔한 뒤, 고른 페이지·데이터베이스만 가져와요.",
      urlPage: "notion.so/82fd91",
      backLink: "‹ Notion으로 돌아가기",
      devTitle: "개발자",
      nav: ["시작하기", "Worker", "개인 액세스 토큰", "연결"],
      navNew: "신규",
      listTitle: "연결",
      listSubtitle: "Notion의 오픈 및 프라이빗 API 연결을 만들고 관리하세요.",
      learnMore: "자세히 알아보기",
      newConnection: "+ 신규 연결",
      colConnection: "연결",
      colWorkspaces: "설치 가능 워크스페이스:",
      colAuthType: "인증 유형",
      colOwner: "소유자",
      integrationName: "잉크라인",
      capabilities: "콘텐츠 읽기, 업데이트 및 삽입, 사용자 정보 읽기",
      workspaceName: "내 워크스페이스",
      authTypeCell: "액세스 토큰",
      ownerName: "나",
      modalTitle: "신규 연결",
      modalDesc:
        "Notion으로 앱과 에이전트, 워크플로를 인증하기 위한 연결을 생성하세요. 단일 워크스페이스 범위 또는 다중 워크스페이스 범위를 선택하세요.",
      nameLabel: "연결 이름",
      namePlaceholder: "새 연결",
      authMethod: "인증 방법",
      accessToken: "액세스 토큰",
      accessTokenDesc:
        "협업 참여자 간에 공유되는 워크스페이스 범위 내 정적 API 토큰으로, 자체 사용 권한 설정을 갖추고 있습니다. 워크스페이스 1개로 제한되며, 마켓플레이스에 등록할 수 없습니다.",
      oauth: "OAuth",
      oauthDesc:
        "사용자 범위 OAuth 2.0이며, 사용 권한은 로그인한 사용자로 제한됩니다. 여러 워크스페이스를 지원합니다.",
      wsLabel: "설치 가능 워크스페이스:",
      wsDesc: "이 토큰은 선택한 워크스페이스에 적용됩니다.",
      terms: "연결을 생성하면 Notion의 개발자 약관에 동의하는 것으로 간주됩니다.",
      createButton: "연결 생성하기",
      breadcrumb: "연결  ›  연결 관리하기",
      detailTabs: ["구성", "콘텐츠 사용 권한", "웹훅", "소유자"],
      tokenSectionTitle: "API 통합 토큰",
      tokenSectionDesc:
        "이 토큰을 사용하여 이 워크스페이스에 대한 API 요청을 인증하세요. 토큰을 가진 모든 사용자가 연결을 대신하여 조치를 취할 수 있으므로, 토큰을 비공개로 유지하세요.",
      tokenFieldLabel: "액세스 토큰",
      tokenValue: "••••••••••••••••••••••••••••",
      copied: "복사됨",
      pageTitle: "팀 핸드북",
      share: "공유",
      menuCopyLink: "링크 복사",
      menuDuplicate: "복제",
      menuConnectionsLabel: "연결",
      menuAddConnection: "연결 추가",
      searchPlaceholder: "연결 검색…",
    },
  },
};

function guideLabels() {
  return pickLabels(GUIDE_LABELS);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function MacCursor({ className }: { className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg className={styles.cursorArrow} viewBox="0 0 24 24" width="17" height="17">
        <path
          d="M5.2 2.7 17.9 14a.55.55 0 0 1-.37.96h-6.2l2.45 5.55a.6.6 0 0 1-.3.79l-1.83.8a.6.6 0 0 1-.79-.3l-2.45-5.57-4.06 4.42A.55.55 0 0 1 3.4 20.3V3.1a.55.55 0 0 1 .92-.4Z"
          fill="#111"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function ClickRipple({ delayMs }: { delayMs: number }) {
  return (
    <span
      className={styles.clickRipple}
      style={{ "--click-at": `${delayMs}ms` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

export default function NotionTokenGuide() {
  const L = guideLabels();
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const [scene, setScene] = useState(0);
  // Auto-plays by default; reduced-motion users start paused. The in-player
  // pause/prev/next controls are the only way to stop it — there is no
  // collapse toggle since the walkthrough is always shown on the Notion tab.
  const [playing, setPlaying] = useState(!reducedMotion);
  // Remount the active scene each time it (re)activates so its CSS animations
  // restart from the beginning.
  const [sceneRun, setSceneRun] = useState(0);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      setScene((current) => (current + 1) % SCENE_COUNT);
      setSceneRun((run) => run + 1);
    }, SCENE_MS);
    return () => window.clearTimeout(timer);
  }, [playing, scene, sceneRun]);

  const goTo = (next: number) => {
    setScene(((next % SCENE_COUNT) + SCENE_COUNT) % SCENE_COUNT);
    setSceneRun((run) => run + 1);
  };

  const M = L.mock;
  const active = L.scenes[scene];

  return (
    <div className={styles.guide}>
      <section
        className={styles.player}
        aria-label={L.region}
        data-walkthrough=""
        data-playing={playing ? "true" : undefined}
      >
          <div className={styles.progressRow} role="navigation" aria-label={L.region}>
            {L.scenes.map((entry, index) => (
              <button
                key={entry.title}
                type="button"
                className={styles.progressSegment}
                aria-label={`${index + 1}. ${entry.title}`}
                aria-current={index === scene ? "step" : undefined}
                data-state={index < scene ? "done" : index === scene ? "active" : undefined}
                style={index === scene ? ({ "--guide-scene-ms": `${SCENE_MS}ms` } as CSSProperties) : undefined}
                onClick={() => goTo(index)}
              >
                <span />
              </button>
            ))}
          </div>
          <div className={styles.stage} key={`${scene}-${sceneRun}`}>
            <div className={styles.recording}>
              <div className={styles.chrome}>
                <span className={styles.trafficLights} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className={styles.chromeUrl}>
                  {scene === 0 || scene >= 5 ? M.hanjiTitle : scene === 4 ? M.urlPage : M.url}
                </span>
              </div>
              {scene === 0 ? (
                <div className={styles.hanjiPanel}>
                  <div className={styles.hanjiHead}>
                    <span className={styles.hanjiBadge} aria-hidden="true">1</span>
                    <strong>{M.inkStep1Title}</strong>
                  </div>
                  <div className={styles.introCard}>
                    <span className={styles.introText}>
                      <strong>{M.inkIntroTitle}</strong>
                      <span>{M.inkIntroDesc}</span>
                    </span>
                    <span className={styles.introButton}>
                      {M.inkMakeToken}
                      <ClickRipple delayMs={1600} />
                      <MacCursor className={`${styles.cursor} ${styles.cursorIntro}`} />
                    </span>
                  </div>
                </div>
              ) : null}
              {scene === 1 ? (
                <div className={styles.devShell}>
                  <div className={styles.devSidebar}>
                    <span className={styles.devBack}>{M.backLink}</span>
                    <span className={styles.devBrand}>
                      <i className={styles.devLogo} aria-hidden="true">
                        N
                      </i>
                      {M.devTitle}
                    </span>
                    <div className={styles.devNav}>
                      {M.nav.map((item, index) => (
                        <span key={item} data-active={index === 3 ? "true" : undefined}>
                          {item}
                          {index === 1 ? <em className={styles.navBadge}>{M.navNew}</em> : null}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className={styles.devMain}>
                    <div className={styles.devHeading}>
                      <strong>{M.listTitle}</strong>
                      <span>
                        {M.listSubtitle} <span className={styles.textLink}>{M.learnMore}</span>
                      </span>
                    </div>
                    <div className={styles.devToolbar}>
                      <span className={styles.toolbarIcon} aria-hidden="true">
                        ≔
                      </span>
                      <span className={styles.toolbarIcon} aria-hidden="true">
                        ⌕
                      </span>
                      <span className={styles.notionPrimary}>
                        {M.newConnection}
                        <ClickRipple delayMs={2050} />
                        <MacCursor className={`${styles.cursor} ${styles.cursorScene1}`} />
                      </span>
                    </div>
                    <div className={styles.devTableHead}>
                      <span>{M.colConnection}</span>
                      <span>{M.colWorkspaces}</span>
                      <span>{M.colAuthType}</span>
                      <span>{M.colOwner}</span>
                    </div>
                    <div className={styles.devRow}>
                      <span className={styles.rowMain}>
                        <i className={styles.integrationAvatar} aria-hidden="true">
                          {M.integrationName.slice(0, 1)}
                        </i>
                        <span className={styles.rowText}>
                          <strong>{M.integrationName}</strong>
                          <span>{M.capabilities}</span>
                        </span>
                      </span>
                      <span className={styles.wsCell}>
                        <i aria-hidden="true">{M.workspaceName.slice(0, 1)}</i> {M.workspaceName}
                      </span>
                      <span className={styles.plainCell}>{M.authTypeCell}</span>
                      <span className={styles.ownerCell}>
                        <i className={styles.ownerAvatar} aria-hidden="true" />
                        {M.ownerName}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
              {scene === 2 ? (
                <div className={styles.modalBackdrop}>
                  <div className={styles.notionModal}>
                    <div className={styles.modalHead}>
                      <strong>{M.modalTitle}</strong>
                      <span aria-hidden="true">✕</span>
                    </div>
                    <p className={styles.modalDesc}>{M.modalDesc}</p>
                    <span className={styles.fieldLabel}>{M.nameLabel}</span>
                    <span className={styles.notionInput}>
                      {M.namePlaceholder}
                      <i className={styles.caret} aria-hidden="true" />
                    </span>
                    <span className={styles.fieldLabel}>{M.authMethod}</span>
                    <div className={`${styles.authOption} ${styles.authOptionSelected}`}>
                      <span className={styles.radioDot} aria-hidden="true" />
                      <span className={styles.authText}>
                        <strong>{M.accessToken}</strong>
                        <span>{M.accessTokenDesc}</span>
                      </span>
                    </div>
                    <div className={styles.authOption}>
                      <span className={styles.radioDot} aria-hidden="true" />
                      <span className={styles.authText}>
                        <strong>{M.oauth}</strong>
                        <span>{M.oauthDesc}</span>
                      </span>
                    </div>
                    <div className={styles.wsRow}>
                      <span className={styles.wsRowText}>
                        <strong>{M.wsLabel}</strong>
                        <span>{M.wsDesc}</span>
                      </span>
                      <span className={styles.wsSelect}>
                        {M.workspaceName} <i aria-hidden="true">⌄</i>
                      </span>
                    </div>
                    <div className={styles.modalFooter}>
                      <span>{M.terms}</span>
                      <span className={styles.notionPrimary}>
                        {M.createButton}
                        <ClickRipple delayMs={2050} />
                        <MacCursor className={`${styles.cursor} ${styles.cursorScene2}`} />
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
              {scene === 3 ? (
                <div className={styles.detailShell}>
                  <span className={styles.breadcrumb}>{M.breadcrumb}</span>
                  <strong className={styles.detailTitle}>{M.integrationName}</strong>
                  <div className={styles.detailTabs}>
                    {M.detailTabs.map((tab, index) => (
                      <span key={tab} data-active={index === 0 ? "true" : undefined}>
                        {tab}
                      </span>
                    ))}
                  </div>
                  <div className={styles.detailSection}>
                    <strong>{M.tokenSectionTitle}</strong>
                    <p>{M.tokenSectionDesc}</p>
                  </div>
                  <div className={styles.detailFields}>
                    <span className={styles.detailField}>
                      <span className={styles.fieldLabel}>{M.wsLabel}</span>
                      <span className={styles.notionInput}>
                        <i className={styles.wsMiniChip} aria-hidden="true">
                          {M.workspaceName.slice(0, 1)}
                        </i>
                        {M.workspaceName}
                      </span>
                    </span>
                    <span className={styles.detailField}>
                      <span className={styles.fieldLabel}>{M.tokenFieldLabel}</span>
                      <span className={`${styles.notionInput} ${styles.tokenInput}`}>
                        <span className={styles.tokenDots}>{M.tokenValue}</span>
                        <i className={styles.tokenIcon} aria-hidden="true">
                          👁
                        </i>
                        <i className={`${styles.tokenIcon} ${styles.copyIcon}`} aria-hidden="true">
                          ⧉
                          <ClickRipple delayMs={1500} />
                          <MacCursor className={`${styles.cursor} ${styles.cursorScene3}`} />
                        </i>
                        <span className={styles.copiedBubble}>{M.copied}</span>
                      </span>
                    </span>
                  </div>
                </div>
              ) : null}
              {scene === 4 ? (
                <div className={styles.pageShell}>
                  <div className={styles.pageTopbar}>
                    <span className={styles.pageCrumb}>{M.pageTitle}</span>
                    <span className={styles.pageActions}>
                      <span>{M.share}</span>
                      <i aria-hidden="true">☆</i>
                      <i className={styles.pageMoreButton} aria-hidden="true">
                        ⋯
                        <ClickRipple delayMs={700} />
                      </i>
                    </span>
                  </div>
                  <div className={styles.pageBody}>
                    <strong>{M.pageTitle}</strong>
                    <span className={styles.skeletonLine} style={{ width: "72%" }} />
                    <span className={styles.skeletonLine} style={{ width: "58%" }} />
                    <span className={styles.skeletonLine} style={{ width: "64%" }} />
                  </div>
                  <div className={styles.pageMenu}>
                    <span className={styles.pageMenuItem}>{M.menuCopyLink}</span>
                    <span className={styles.pageMenuItem}>{M.menuDuplicate}</span>
                    <span className={styles.pageMenuDivider} aria-hidden="true" />
                    <span className={styles.pageMenuLabel}>{M.menuConnectionsLabel}</span>
                    <span className={`${styles.pageMenuItem} ${styles.pageMenuItemHover}`}>
                      {M.menuAddConnection}
                      <i aria-hidden="true">›</i>
                    </span>
                  </div>
                  <div className={styles.connectSubmenu}>
                    <span className={styles.submenuSearch}>{M.searchPlaceholder}</span>
                    <span className={styles.submenuRow}>
                      <i className={styles.integrationAvatar} aria-hidden="true">
                        {M.integrationName.slice(0, 1)}
                      </i>
                      {M.integrationName}
                      <ClickRipple delayMs={2200} />
                      <MacCursor className={`${styles.cursor} ${styles.cursorScene4}`} />
                    </span>
                  </div>
                </div>
              ) : null}
              {scene === 5 ? (
                <div className={styles.hanjiPanel}>
                  <div className={styles.hanjiHead}>
                    <span className={styles.hanjiBadge} aria-hidden="true">1</span>
                    <strong>{M.inkStep1Title}</strong>
                  </div>
                  <div className={styles.hanjiField}>
                    <span className={styles.fieldLabel}>{M.inkTokenLabel}</span>
                    <span className={`${styles.notionInput} ${styles.hanjiTokenField}`}>
                      {M.inkTokenValue}
                      <i className={styles.caret} aria-hidden="true" />
                      <ClickRipple delayMs={1400} />
                      <MacCursor className={`${styles.cursor} ${styles.cursorScene5}`} />
                    </span>
                  </div>
                </div>
              ) : null}
              {scene === 6 ? (
                <div className={styles.hanjiPanel}>
                  <div className={styles.hanjiHead}>
                    <span className={styles.hanjiBadge} aria-hidden="true">2</span>
                    <strong>{M.inkStep2Title}</strong>
                  </div>
                  <div className={styles.scopeOpt}>
                    <span className={styles.radioDot} aria-hidden="true" />
                    <span className={styles.authText}>
                      <strong>
                        {M.scopeAllTitle}
                        <em className={styles.recBadge}>{M.scopeAllRec}</em>
                      </strong>
                      <span>{M.scopeAllDesc}</span>
                    </span>
                  </div>
                  <div className={`${styles.scopeOpt} ${styles.scopeOptSelected}`}>
                    <span className={styles.radioDot} aria-hidden="true" />
                    <span className={styles.authText}>
                      <strong>{M.scopeSomeTitle}</strong>
                      <span>{M.scopeSomeDesc}</span>
                    </span>
                    <ClickRipple delayMs={1700} />
                    <MacCursor className={`${styles.cursor} ${styles.cursorScene6}`} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className={styles.captionRow}>
            <p className={styles.caption}>
              <strong>
                {scene + 1}. {active.title}
              </strong>
              <span>{active.caption}</span>
            </p>
            <div className={styles.controls}>
              <span className={styles.stepCounter}>{L.stepLabel(scene + 1)}</span>
              <button type="button" aria-label={L.prev} onClick={() => goTo(scene - 1)}>
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={playing ? L.pause : L.play}
                onClick={() => setPlaying((current) => !current)}
              >
                {playing ? <PauseIcon size={13} aria-hidden="true" /> : <PlayIcon size={13} aria-hidden="true" />}
              </button>
              <button type="button" aria-label={L.next} onClick={() => goTo(scene + 1)}>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
      </section>
    </div>
  );
}
