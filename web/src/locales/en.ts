type CatalogModule = { default: Record<string, unknown> };

// Keep one lazy chunk per language instead of one network request per
// namespace. `_meta.json` is translation bookkeeping and must never ship.
const modules = import.meta.glob(["./en/*.json", "!./en/_meta.json"], {
  eager: true,
}) as Record<string, CatalogModule>;

export const catalogs = Object.fromEntries(
  Object.entries(modules).map(([path, module]) => {
    const namespace = path.split("/").at(-1)?.replace(/\.json$/, "") ?? "";
    return [namespace, module.default];
  })
);
