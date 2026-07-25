import { foldNfcText } from "../../../shared/database/natural-order.mjs";

export interface CanonicalTextRange {
  start: number;
  end: number;
}

interface FoldedSegment {
  foldedStart: number;
  foldedEnd: number;
  sourceStart: number;
  sourceEnd: number;
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("und", { granularity: "grapheme" })
    : null;

function sourceSegments(value: string) {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(value), (item) => ({
      text: item.segment,
      start: item.index,
      end: item.index + item.segment.length,
    }));
  }

  const segments: Array<{ text: string; start: number; end: number }> = [];
  for (let start = 0; start < value.length; ) {
    const codePoint = value.codePointAt(start);
    const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const end = start + width;
    segments.push({ text: value.slice(start, end), start, end });
    start = end;
  }
  return segments;
}

function foldedTextWithSourceMap(value: string) {
  let folded = "";
  const segments: FoldedSegment[] = [];
  for (const source of sourceSegments(value)) {
    const foldedSegment = foldNfcText(source.text);
    if (!foldedSegment) continue;
    const foldedStart = folded.length;
    folded += foldedSegment;
    segments.push({
      foldedStart,
      foldedEnd: folded.length,
      sourceStart: source.start,
      sourceEnd: source.end,
    });
  }
  return { folded, segments };
}

/**
 * Find non-overlapping canonical/case-equivalent matches and map them back to
 * valid UTF-16 ranges in the untouched source string. Mapping at grapheme
 * boundaries keeps decomposed Korean and case-expanding characters intact.
 */
export function canonicalTextRanges(text: string, query: string): CanonicalTextRange[] {
  const needle = foldNfcText(query);
  if (!needle || !text) return [];

  const mapped = foldedTextWithSourceMap(text);
  const ranges: CanonicalTextRange[] = [];
  let searchFrom = 0;
  let segmentIndex = 0;
  while (searchFrom <= mapped.folded.length - needle.length) {
    const matchStart = mapped.folded.indexOf(needle, searchFrom);
    if (matchStart < 0) break;
    const matchEnd = matchStart + needle.length;
    while (
      segmentIndex < mapped.segments.length &&
      mapped.segments[segmentIndex].foldedEnd <= matchStart
    ) {
      segmentIndex += 1;
    }
    const first = mapped.segments[segmentIndex];
    let lastIndex = segmentIndex;
    while (
      lastIndex < mapped.segments.length &&
      mapped.segments[lastIndex].foldedEnd < matchEnd
    ) {
      lastIndex += 1;
    }
    const last = mapped.segments[lastIndex];
    if (first && last) {
      const range = { start: first.sourceStart, end: last.sourceEnd };
      const previous = ranges.at(-1);
      if (!previous || previous.start !== range.start || previous.end !== range.end) {
        ranges.push(range);
      }
    }
    searchFrom = matchStart + Math.max(needle.length, 1);
  }
  return ranges;
}
