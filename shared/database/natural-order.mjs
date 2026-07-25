const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

function isAsciiDigit(code) {
  return code >= ASCII_ZERO && code <= ASCII_NINE;
}

/**
 * Build the locale-independent canonical text key shared by database ordering
 * and primary content matching.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function foldNfcText(value) {
  // ECMAScript's ordinary lower-case mapping is locale-independent. Folding
  // can introduce a combining sequence, so normalize once more afterwards.
  return String(value).normalize("NFC").toLowerCase().normalize("NFC");
}

function digitRunEnd(value, start) {
  let end = start;
  while (end < value.length && isAsciiDigit(value.charCodeAt(end))) end += 1;
  return end;
}

function significantDigitStart(value, start, end) {
  let significant = start;
  while (significant < end && value.charCodeAt(significant) === ASCII_ZERO) significant += 1;
  return significant;
}

/**
 * Return the comparison tokens consumed by `compareNaturalText`.
 *
 * Each ordinary code point is emitted as-is. An ASCII digit run emits the
 * digit marker, its significant length, and its significant digits. Leading
 * zeroes therefore disappear exactly as they do in the comparator. Callers
 * that persist a sortable key must still add component terminators/escaping;
 * this function owns only the comparator-equivalent token stream.
 *
 * @param {unknown} value
 * @returns {number[]}
 */
export function naturalOrderTokens(value) {
  const folded = foldNfcText(value);
  const tokens = [];
  let index = 0;
  while (index < folded.length) {
    const code = folded.codePointAt(index);
    if (isAsciiDigit(code)) {
      const end = digitRunEnd(folded, index);
      const significant = significantDigitStart(folded, index, end);
      tokens.push(ASCII_ZERO, end - significant);
      for (let offset = significant; offset < end; offset += 1) {
        tokens.push(folded.charCodeAt(offset) - ASCII_ZERO);
      }
      index = end;
      continue;
    }
    tokens.push(code);
    index += code > 0xffff ? 2 : 1;
  }
  return tokens;
}

/**
 * Compare text with one runtime- and locale-independent natural order.
 *
 * Text is NFC-normalized and case-folded before Unicode code-point comparison.
 * When both sides contain an ASCII digit run at the same position, the runs
 * are compared by significant length and then digit-by-digit, avoiding Number
 * precision loss. Numerically equal spellings and canonically/case-equivalent
 * text compare equal so each caller's existing stable row order remains the
 * tie-break.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
export function compareNaturalText(left, right) {
  const a = foldNfcText(left);
  const b = foldNfcText(right);
  let aIndex = 0;
  let bIndex = 0;

  while (aIndex < a.length && bIndex < b.length) {
    const aCode = a.codePointAt(aIndex);
    const bCode = b.codePointAt(bIndex);

    if (isAsciiDigit(aCode) && isAsciiDigit(bCode)) {
      const aEnd = digitRunEnd(a, aIndex);
      const bEnd = digitRunEnd(b, bIndex);
      const aSignificant = significantDigitStart(a, aIndex, aEnd);
      const bSignificant = significantDigitStart(b, bIndex, bEnd);
      const aLength = aEnd - aSignificant;
      const bLength = bEnd - bSignificant;

      if (aLength !== bLength) return aLength < bLength ? -1 : 1;
      for (let offset = 0; offset < aLength; offset += 1) {
        const difference = a.charCodeAt(aSignificant + offset) - b.charCodeAt(bSignificant + offset);
        if (difference !== 0) return difference < 0 ? -1 : 1;
      }

      aIndex = aEnd;
      bIndex = bEnd;
      continue;
    }

    if (aCode !== bCode) return aCode < bCode ? -1 : 1;
    aIndex += aCode > 0xffff ? 2 : 1;
    bIndex += bCode > 0xffff ? 2 : 1;
  }

  if (aIndex < a.length) return 1;
  if (bIndex < b.length) return -1;
  return 0;
}
