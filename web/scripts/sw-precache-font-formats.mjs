const FONT_FORMAT_PREFERENCE = ['woff2', 'woff', 'ttf'];

/**
 * Plans removal of alternate font encodings from an already-reachable offline
 * graph. Vite source keys, not hashed output names, define logical families.
 */
export function planOfflineFontFormatSelection(
  viteManifest,
  includedAssets,
  protectedAssets = [],
) {
  const included = new Set(includedAssets);
  const protectedSet = new Set(protectedAssets);
  const groups = new Map();

  for (const [sourceKey, entry] of Object.entries(viteManifest)) {
    const match = /^(.*)\.(woff2|woff|ttf)$/i.exec(sourceKey);
    if (!match || typeof entry?.file !== 'string') continue;

    const [, family, rawFormat] = match;
    const asset = `/${entry.file.replace(/^\/+/, '')}`;
    if (!included.has(asset)) continue;

    const formats = groups.get(family) ?? new Map();
    const format = rawFormat.toLowerCase();
    const assets = formats.get(format) ?? [];
    assets.push(asset);
    formats.set(format, assets);
    groups.set(family, formats);
  }

  const removedAssets = [];
  const retainedAssets = [];
  for (const formats of groups.values()) {
    const preferredFormat = FONT_FORMAT_PREFERENCE.find((format) => formats.has(format));
    for (const [format, assets] of formats) {
      for (const asset of assets) {
        if (format === preferredFormat || protectedSet.has(asset)) {
          retainedAssets.push(asset);
        } else {
          removedAssets.push(asset);
        }
      }
    }
  }

  return {
    familyCount: groups.size,
    removedAssets: removedAssets.sort(),
    retainedAssets: retainedAssets.sort(),
  };
}
