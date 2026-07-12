import { Trans, useTranslation } from "react-i18next";
import type { CreditSlot } from "@/lib/builtWith";

// Renders a single rolling credit as a graceful sentence with only the name
// linked: "Thank you, <name>, for supporting the project" for a sponsor, or
// "Hanji is built with the help of <name>" for a built-with credit.
export function CreditLine({ slot }: { slot: CreditSlot }) {
  const { t } = useTranslation(["sponsors", "common"]);
  const linkNode = slot.url ? (
    // <Trans> injects the sponsor name as this anchor's content at runtime.
    // eslint-disable-next-line jsx-a11y/anchor-has-content
    <a href={slot.url} target="_blank" rel="noreferrer noopener" />
  ) : (
    <span />
  );
  return (
    <Trans
      t={t}
      i18nKey={slot.kind === "sponsor" ? "thanksSponsor" : "builtWith"}
      values={{ name: slot.name }}
      components={{ a: linkNode }}
    />
  );
}
