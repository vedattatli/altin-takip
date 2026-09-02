import type { UserProfile } from "@/auth/types";
import type { AccountingSummary, LedgerEntry } from "./accounting/types";

/**
 * Yöneticinin gördüğü kullanıcı portföyü özeti (SALT OKUNUR).
 *
 * Tür sunucu modüllerinden bağımsız bir yerde durur; böylece istemci
 * bileşenleri "server-only" işaretli bir modüle bağımlı olmaz.
 */
export interface AdminUserPortfolioView {
  user: UserProfile;
  summary: AccountingSummary;
  ledger: LedgerEntry[];
  /** Adminin bu portföyü düzenleme yetkisi. Bu sürümde KAPALI: admin yalnızca okur. */
  canEdit: boolean;
}
