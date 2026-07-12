type CatalogModule = { default: Record<string, unknown> };

const modules = import.meta.glob(["./id/*.json", "!./id/_meta.json"], {
  eager: true,
}) as Record<string, CatalogModule>;

export const catalogs = Object.fromEntries(
  Object.entries(modules).map(([path, module]) => {
    const namespace = path.split("/").at(-1)?.replace(/\.json$/, "") ?? "";
    return [namespace, module.default];
  }),
);
