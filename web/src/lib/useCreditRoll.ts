import { useEffect, useMemo, useState } from "react";
import { fetchSponsorsRemote, type SponsorEntry } from "@/lib/edgebase";
import { type CreditSlot } from "@/lib/builtWith";

// Shared credit logic: fetch the sponsor feed once, turn it into slots with the
// given `build` strategy (sidebar fills with built-with, sign-in prefers
// sponsors and falls back to built-with), then show ONE at random when the
// surface loads — not a continuous rotation, so a reload surfaces a different
// one. Returns null when the operator turned the banner off (AGPL mode) or
// there is nothing to show.
export function useCreditRoll(options: {
  build: (sponsors: readonly SponsorEntry[]) => CreditSlot[];
  enabled?: boolean;
}): CreditSlot | null {
  const enabled = options.enabled ?? true;
  const { build } = options;
  const [sponsors, setSponsors] = useState<SponsorEntry[]>([]);
  const [disabled, setDisabled] = useState(false);
  // A stable random fraction picked once per mount, so the chosen credit is
  // random per page load but does not change between renders.
  const [pick] = useState(() => Math.random());

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    fetchSponsorsRemote()
      .then((feed) => {
        if (!mounted) return;
        setSponsors(feed.sponsors);
        setDisabled(feed.disabled);
      })
      .catch(() => {
        // The static built-with roll remains a useful fallback when the sponsor
        // feed is unavailable, including during an offline/local-first boot.
      });
    return () => {
      mounted = false;
    };
  }, [enabled]);

  const slots = useMemo(() => build(sponsors), [build, sponsors]);

  if (!enabled || disabled || slots.length === 0) return null;
  return slots[Math.floor(pick * slots.length)] ?? slots[0];
}
