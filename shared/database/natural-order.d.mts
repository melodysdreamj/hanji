/**
 * Locale-independent NFC and ordinary-lowercase key used by content matching.
 */
export function foldNfcText(value: unknown): string;

/**
 * Comparator-equivalent token stream for persistent sortable text keys.
 */
export function naturalOrderTokens(value: unknown): number[];

/**
 * Locale-independent NFC, case-folded Unicode code-point comparison with
 * numeric ASCII digit runs.
 */
export function compareNaturalText(left: unknown, right: unknown): number;
