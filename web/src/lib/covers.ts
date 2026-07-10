export const COVER_PRESETS = [
  "linear-gradient(135deg,#a8c0ff,#3f2b96)",
  "linear-gradient(135deg,#f6d365,#fda085)",
  "linear-gradient(135deg,#84fab0,#8fd3f4)",
  "linear-gradient(135deg,#ff9a9e,#fad0c4)",
  "linear-gradient(135deg,#d4a5ff,#a18cd1)",
  "linear-gradient(135deg,#cfd9df,#e2ebf0)",
  "linear-gradient(135deg,#fbc2eb,#a6c1ee)",
  "linear-gradient(135deg,#d9afd9,#97d9e1)",
  "linear-gradient(135deg,#fddb92,#d1fdff)",
  "linear-gradient(135deg,#b7f8db,#50a7c2)",
  "linear-gradient(135deg,#f5f7fa,#c3cfe2)",
  "linear-gradient(135deg,#e0c3fc,#8ec5fc)",
];

export function randomCover() {
  return COVER_PRESETS[Math.floor(Math.random() * COVER_PRESETS.length)];
}

export function nextCover(current?: string) {
  const index = COVER_PRESETS.indexOf(current ?? "");
  return COVER_PRESETS[(index + 1 + COVER_PRESETS.length) % COVER_PRESETS.length];
}
