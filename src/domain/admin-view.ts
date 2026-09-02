import type { UserProfile } from "@/auth/types";
import type { PortfolioSummary } from "./portfolio";
import type { Transaction } from "./types";

/**
 * Yöneticinin gördüğü kullanıcı portföyü özeti.
 *
 * Tür sunucu modüllerinden bağımsız bir yerde durur; böylece istemci
 * bileşenleri "server-only" işaretli bir modüle bağımlı olmaz.
 */
export interface AdminUserPortfolioView {
  user: UserProfile;
  summary: PortfolioSummary;
  transactions: Transaction[];
  /** Adminin bu portföyü düzenleme yetkisi. İlk sürümde kapalı. */
  canEdit: boolean;
}
