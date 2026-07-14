import { safeUrl } from "./richtext";

export type PastedAssetBlockType = "image" | "video" | "audio" | "file";

/** Provider URL normalization and pasted-asset classification for editor media blocks. */
export function blockTypeForPastedAssetUrl(url: string): PastedAssetBlockType | null {
  const lower = url.trim().toLowerCase();
  let pathname = lower;
  try {
    pathname = new URL(url, "https://hanji.local").pathname.toLowerCase();
  } catch {
    /* keep the lower-cased input */
  }

  if (/\.(?:apng|avif|gif|jpe?g|png|svg|webp)$/i.test(pathname)) return "image";
  if (streamingVideoEmbed(url) || /\.(?:m4v|mov|mp4|ogv|webm)$/i.test(pathname)) return "video";
  if (/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/i.test(pathname)) return "audio";
  if (
    /\.(?:7z|csv|docx?|gz|key|md|numbers|odp|ods|odt|pages|pdf|pptx?|rar|rtf|tar|tsv|txt|xlsx?|xml|yaml|yml|zip)$/i.test(
      pathname
    )
  ) {
    return "file";
  }
  return null;
}

/**
 * Convert a common provider share/watch URL into its embeddable iframe URL.
 * Returns null when the URL isn't a recognized provider (caller falls back to
 * the raw URL for already-embeddable links).
 */
export function providerEmbedUrl(raw: string): string | null {
  const safe = safeUrl(raw.trim());
  if (!safe || !/^https?:/i.test(safe)) return null;
  let u: URL;
  try {
    u = new URL(safe);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  // YouTube
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    if (id) return `https://www.youtube.com/embed/${id}`;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (u.pathname.startsWith("/embed/")) return safe;
    if (u.pathname.startsWith("/shorts/")) {
      const id = u.pathname.split("/")[2];
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
  }

  // Vimeo
  if (host === "vimeo.com") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
  }
  if (host === "player.vimeo.com") return safe;

  // Loom
  if (host === "loom.com") {
    const id = u.pathname.replace(/^\/(share|embed)\//, "").split("/")[0];
    if (id) return `https://www.loom.com/embed/${id}`;
  }

  // Google Maps
  if (host === "google.com" || host === "maps.google.com") {
    if (u.pathname.startsWith("/maps")) {
      if (u.pathname.includes("/embed")) return safe;
      return `https://maps.google.com/maps?q=${encodeURIComponent(
        u.searchParams.get("q") ?? u.pathname
      )}&output=embed`;
    }
  }

  // SoundCloud (audio) — uses its player widget.
  if (host === "soundcloud.com") {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(safe)}`;
  }

  // Figma / CodePen / Twitter use embed wrappers; pass through their embed forms.
  if (host === "figma.com" && u.pathname.startsWith("/embed")) return safe;
  if (host === "codepen.io" && u.pathname.includes("/embed/")) return safe;

  return null;
}

/** Streaming providers whose video can't play in a native <video> element. */
export function streamingVideoEmbed(raw: string): string | null {
  const embed = providerEmbedUrl(raw);
  if (!embed) return null;
  return /youtube\.com\/embed|player\.vimeo\.com|loom\.com\/embed/.test(embed)
    ? embed
    : null;
}
