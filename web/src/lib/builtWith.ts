// Static "built with" credits and the sponsor CTA target, shared by the
// sidebar rolling credit and the settings Support section.
//
// These are honest acknowledgements of the tools/platforms that helped build
// Hanji — NOT paid sponsors — so they link to each project's official site.
// They also serve as the always-present filler so the rolling credit is never
// awkwardly empty before the sponsor feed has five entries.
import type { SponsorEntry } from "@/lib/edgebase";

export interface BuiltWithEntry {
  name: string;
  url: string;
}

export const BUILT_WITH: readonly BuiltWithEntry[] = [
  { name: "Cloudflare", url: "https://www.cloudflare.com" },
  { name: "Claude", url: "https://claude.com" },
  { name: "ChatGPT", url: "https://openai.com" },
  { name: "GLM", url: "https://z.ai" },
  { name: "GitHub", url: "https://github.com" },
];

// GitHub Sponsors page for the project (also the settings CTA target).
export const SPONSOR_CTA_URL = "https://github.com/sponsors/melodysdreamj";

export const SPONSOR_SLOTS = 5;

export type CreditSlot =
  | { kind: "sponsor"; name: string; url: string | null }
  | { kind: "builtWith"; name: string; url: string };

// Sponsors only, capped at five.
export function sponsorRoll(sponsors: readonly SponsorEntry[]): CreditSlot[] {
  return sponsors
    .slice(0, SPONSOR_SLOTS)
    .map((sponsor) => ({ kind: "sponsor" as const, name: sponsor.name, url: sponsor.url }));
}

// The built-with credits as slots.
export function builtWithRoll(): CreditSlot[] {
  return BUILT_WITH.map((entry) => ({ kind: "builtWith" as const, name: entry.name, url: entry.url }));
}

// Sign-in banner: show the real sponsors when the feed/snapshot has any;
// otherwise fall back to the built-with credits so it is never empty. Sponsors
// are shown whenever they exist, so the license surface always surfaces them.
export function loginRoll(sponsors: readonly SponsorEntry[]): CreditSlot[] {
  return sponsors.length > 0 ? sponsorRoll(sponsors) : builtWithRoll();
}

// Real sponsors first, then built-with credits fill the remaining slots up to
// five, so the rolling line always has something genuine to show. Used by the
// additive surfaces (sidebar, settings), never the license banner.
export function creditRoll(sponsors: readonly SponsorEntry[]): CreditSlot[] {
  const slots = sponsorRoll(sponsors);
  for (const entry of BUILT_WITH) {
    if (slots.length >= SPONSOR_SLOTS) break;
    slots.push({ kind: "builtWith", name: entry.name, url: entry.url });
  }
  return slots;
}
