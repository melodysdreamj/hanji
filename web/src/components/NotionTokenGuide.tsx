import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, PauseIcon, PlayIcon } from "./icons";

import styles from "./NotionTokenGuide.module.css";

// Animated walkthrough of the real Notion token flow, styled to read like a
// screen recording of the actual (dark) Notion developer portal: create a
// connection, pick the workspace, copy the access token, then connect the
// integration to the top-level pages you want to import. Scenes are faithful
// CSS replicas (no bundled screenshots) so text stays localized and crisp.
const SCENE_COUNT = 7;
const SCENE_MS = 3000;

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
  const { t } = useTranslation(["notionTokenGuide", "common"]);
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

  const scenes = t("notionTokenGuide:scenes", { returnObjects: true }) as {
    title: string;
    caption: string;
  }[];
  const M = t("notionTokenGuide:mock", { returnObjects: true }) as Record<string, string> & {
    nav: string[];
    detailTabs: string[];
  };
  const region = t("notionTokenGuide:region");
  const active = scenes[scene];

  return (
    <div className={styles.guide}>
      <section
        className={styles.player}
        aria-label={region}
        data-walkthrough=""
        data-playing={playing ? "true" : undefined}
      >
          <div className={styles.progressRow} role="navigation" aria-label={region}>
            {scenes.map((entry, index) => (
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
              <span className={styles.stepCounter}>
                {t("notionTokenGuide:stepLabel", { n: scene + 1, total: SCENE_COUNT })}
              </span>
              <button
                type="button"
                aria-label={t("notionTokenGuide:prev")}
                onClick={() => goTo(scene - 1)}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={playing ? t("notionTokenGuide:pause") : t("notionTokenGuide:play")}
                onClick={() => setPlaying((current) => !current)}
              >
                {playing ? <PauseIcon size={13} aria-hidden="true" /> : <PlayIcon size={13} aria-hidden="true" />}
              </button>
              <button
                type="button"
                aria-label={t("notionTokenGuide:next")}
                onClick={() => goTo(scene + 1)}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
      </section>
    </div>
  );
}
