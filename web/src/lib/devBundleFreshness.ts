const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_DEV_PORTS = new Set(["3000", "8787"]);
const CHECK_INTERVAL_MS = 5000;

function isLocalDevSurface() {
  if (typeof window === "undefined") return false;
  return LOCAL_HOSTS.has(window.location.hostname.toLowerCase()) && LOCAL_DEV_PORTS.has(window.location.port);
}

function assetSignatureFromDocument(documentLike: Document, baseUrl: string) {
  const refs = [
    ...Array.from(documentLike.querySelectorAll<HTMLScriptElement>("script[src]")).map((script) => script.src),
    ...Array.from(documentLike.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')).map(
      (link) => link.href
    ),
  ]
    .map((value) => {
      try {
        return new URL(value, baseUrl).pathname;
      } catch {
        return "";
      }
    })
    .filter((pathname) => pathname.startsWith("/assets/"))
    .sort();

  return refs.join("|");
}

function isEditingNow() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const tag = active.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || active.isContentEditable || !!active.closest("[contenteditable]");
}

export function startLocalBundleFreshnessWatch() {
  if (!isLocalDevSurface()) return;

  const loadedSignature = assetSignatureFromDocument(document, window.location.href);
  if (!loadedSignature) return;

  let pendingReload = false;
  let checking = false;

  const reloadWhenSafe = () => {
    if (!pendingReload) return;
    if (isEditingNow()) return;
    window.location.reload();
  };

  const check = async () => {
    if (checking || pendingReload) {
      reloadWhenSafe();
      return;
    }

    checking = true;
    try {
      const url = new URL("/index.html", window.location.origin);
      url.searchParams.set("__hanji_bundle_check", String(Date.now()));
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "text/html" },
      });
      if (!response.ok) return;

      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const currentSignature = assetSignatureFromDocument(parsed, window.location.origin);
      if (currentSignature && currentSignature !== loadedSignature) {
        pendingReload = true;
        reloadWhenSafe();
      }
    } catch {
      // A transient local dev server restart is expected during bundle refresh.
    } finally {
      checking = false;
    }
  };

  window.setInterval(check, CHECK_INTERVAL_MS);
  window.addEventListener("focus", check);
  window.addEventListener("visibilitychange", check);
  window.addEventListener("focusout", reloadWhenSafe);
}
