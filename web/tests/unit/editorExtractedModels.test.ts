import { describe, expect, it } from "vitest";
import {
  localIsoDateFromDate,
  mentionCalendar,
  parseLocalIsoDate,
  shiftDateByMonths,
  weekEdgeDate,
} from "@/components/editor/mentionCalendarModel";
import {
  blockTypeForPastedAssetUrl,
  providerEmbedUrl,
  streamingVideoEmbed,
} from "@/components/editor/mediaEmbeds";

describe("editor extracted models", () => {
  it("keeps local calendar arithmetic independent from the editor component", () => {
    expect(parseLocalIsoDate("2024-02-29")).not.toBeNull();
    expect(parseLocalIsoDate("2023-02-29")).toBeNull();
    expect(shiftDateByMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(weekEdgeDate("2024-07-17", "start")).toBe("2024-07-14");
    expect(weekEdgeDate("2024-07-17", "end")).toBe("2024-07-20");
    expect(localIsoDateFromDate(new Date(2024, 6, 17))).toBe("2024-07-17");

    const calendar = mentionCalendar("2024-07-01", "2024-07-17");
    expect(calendar.days).toHaveLength(42);
    expect(calendar.days.find((day) => day.selected)?.iso).toBe("2024-07-17");
  });

  it("normalizes provider embeds and pasted media types outside BlockItem", () => {
    expect(providerEmbedUrl("https://youtu.be/abc123")).toBe(
      "https://www.youtube.com/embed/abc123"
    );
    expect(streamingVideoEmbed("https://vimeo.com/12345")).toBe(
      "https://player.vimeo.com/video/12345"
    );
    expect(blockTypeForPastedAssetUrl("https://example.com/photo.webp?size=2")).toBe("image");
    expect(blockTypeForPastedAssetUrl("https://youtu.be/abc123")).toBe("video");
    expect(blockTypeForPastedAssetUrl("https://example.com/archive.zip")).toBe("file");
    expect(blockTypeForPastedAssetUrl("https://example.com/page")).toBeNull();
  });
});
