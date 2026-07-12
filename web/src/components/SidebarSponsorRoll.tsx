import { creditRoll } from "@/lib/builtWith";
import { useCreditRoll } from "@/lib/useCreditRoll";
import { CreditLine } from "./CreditLine";
import styles from "./SidebarSponsorRoll.module.css";

// Subtle, low-key credit at the bottom of the sidebar: real sponsors first, then
// the built-with credits fill up to five, and one is shown at random per load.
// This is an ADDITIVE surface — the license-protected banner is the sign-in one
// in AuthGate. It hides only when the operator turned the feature off.
export function SidebarSponsorRoll() {
  const slot = useCreditRoll({ build: creditRoll });
  if (!slot) return null;
  return (
    <div className={styles.roll} data-testid="sidebar-sponsor-roll" data-kind={slot.kind}>
      <CreditLine slot={slot} />
    </div>
  );
}
