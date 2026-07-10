// Named color → chip background/text, using the global color tokens.

export const COLOR_NAMES = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export type ColorName = (typeof COLOR_NAMES)[number];

const BG: Record<string, string> = {
  default: "var(--c-bg-gray)",
  gray: "var(--c-bg-gray)",
  brown: "var(--c-bg-brown)",
  orange: "var(--c-bg-orange)",
  yellow: "var(--c-bg-yellow)",
  green: "var(--c-bg-green)",
  blue: "var(--c-bg-blue)",
  purple: "var(--c-bg-purple)",
  pink: "var(--c-bg-pink)",
  red: "var(--c-bg-red)",
};

export function chipStyle(color?: string): React.CSSProperties {
  return {
    background: BG[color ?? "gray"] ?? BG.gray,
    color: "var(--text-default)",
  };
}

export function nextColor(i: number): ColorName {
  // skip "default" for new options
  return COLOR_NAMES[1 + (i % (COLOR_NAMES.length - 1))];
}
