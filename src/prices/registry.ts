import {
  type CanonicalPriceProvider,
  type LicenseStatus,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderId,
} from "./contract";
import { PROVIDER_DESCRIPTORS } from "./descriptors";
import { DEV_ONLY_BLOCKED_MESSAGE, devOnlyProviderBlocked, experimentalScreenAllowed } from "./dev-gate";
import { createProvider } from "./providers";

/**
 * SAĞLAYICI KAYIT DEFTERİ
 *
 * "Hangi kaynak kullanıcıya sunulabilir?" sorusunun tek yeri. Kurallar:
 *  - Test sağlayıcısı ÜRETİMDE hiçbir koşulda seçilebilir değildir.
 *  - Lisans durumu LICENSED olmayan sağlayıcı kullanıcıya sunulmaz (fail closed).
 *  - REFERENCE_ONLY sağlayıcı birincil değerleme kaynağı olamaz.
 */

export interface ProviderStatusView {
  providerId: ProviderId;
  displayName: string;
  technicalName: string;
  marketId: string;
  marketDisplayName: string;
  providerType: string;
  capabilities: readonly ProviderCapability[];
  licenseStatus: LicenseStatus;
  licenseReference: string | null;
  /** Değerlemede birincil kaynak olabilir mi? */
  canBePrimary: boolean;
  /** Kullanıcıya seçenek olarak gösterilebilir mi? */
  selectable: boolean;
  /** Neden seçilemiyor (kullanıcıya gösterilebilir Türkçe metin). */
  blockedReason: string | null;
  attribution: string;
  referenceUrl: string | null;
  /** Eksik ortam değişkeni ADLARI (değer YOK). */
  missingConfig: readonly string[];
  requiresPersistentWorker: boolean;
  /** Sağlayıcının sunduğunu söylediği ama bizde adapter'ı OLMAYAN yetenekler. */
  advertisedCapabilities: readonly ProviderCapability[];
  supportedProductCount: number;
  devOnly: boolean;
}

/** Test sağlayıcısı bu ortamda kapalı mı? (Playwright üretim derlemesi hariç.) */
function isProduction(): boolean {
  return devOnlyProviderBlocked();
}

export function listProviderDescriptors(): readonly ProviderDescriptor[] {
  return PROVIDER_DESCRIPTORS;
}

export function getProviderInstance(providerId: string): CanonicalPriceProvider | null {
  return createProvider(providerId);
}

function blockedReasonFor(provider: CanonicalPriceProvider, status: LicenseStatus): string | null {
  if (provider.descriptor.devOnly && isProduction()) {
    return DEV_ONLY_BLOCKED_MESSAGE;
  }
  if (!provider.getCapabilities().canBePrimary) {
    return "Bu kaynak yalnızca referans/kontrol amaçlıdır; değerleme kaynağı olarak seçilemez.";
  }
  switch (status) {
    case "LICENSED":
      return null;
    case "LICENSE_REQUIRED":
      return "Yeniden gösterim izni veya lisans referansı bulunmadığı için kullanılamıyor.";
    case "NOT_CONFIGURED":
      return "Sağlayıcı yapılandırılmadı (API adresi/anahtarı eksik).";
    case "DEV_ONLY":
      return isProduction() ? DEV_ONLY_BLOCKED_MESSAGE : null;
    case "EXPERIMENTAL_PRIVATE":
      // Deneysel kaynak genel listede seçilebilir GÖRÜNMEZ. Erişim, yöneticinin
      // portföy bazlı izin listesiyle ayrıca açılır; bu kontrol sunucudadır.
      return experimentalScreenAllowed()
        ? "Deneysel özel pilot kaynağı. Yalnızca yöneticinin izin verdiği portföylerde kullanılabilir."
        : "Deneysel ekran kaynağı bu ortamda kapalıdır.";
  }
}

export function describeProvider(providerId: string): ProviderStatusView | null {
  const provider = getProviderInstance(providerId);
  if (!provider) return null;
  const status = provider.licenseStatus();
  const validation = provider.validateConfiguration();
  const capabilities = provider.getCapabilities();
  const blockedReason = blockedReasonFor(provider, status);
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    technicalName: provider.technicalName,
    marketId: provider.marketId,
    marketDisplayName: provider.marketDisplayName,
    providerType: provider.providerType,
    capabilities: capabilities.capabilities,
    licenseStatus: status,
    licenseReference: provider.licenseReference(),
    canBePrimary: capabilities.canBePrimary,
    selectable: blockedReason === null,
    blockedReason,
    attribution: provider.descriptor.attribution,
    referenceUrl: provider.descriptor.referenceUrl,
    missingConfig: validation.issues.map((issue) => issue.variable).filter((name) => name !== "—"),
    requiresPersistentWorker: capabilities.requiresPersistentWorker,
    advertisedCapabilities: provider.descriptor.advertisedCapabilities ?? [],
    supportedProductCount: provider.listSupportedProducts().length,
    devOnly: provider.descriptor.devOnly,
  };
}

export function listProviderStatuses(): ProviderStatusView[] {
  return PROVIDER_DESCRIPTORS.map((descriptor) => describeProvider(descriptor.providerId)).filter(
    (view): view is ProviderStatusView => view !== null,
  );
}

/** Kullanıcıya sunulabilecek kaynaklar: lisanslı, birincil olabilen ve ortama uygun olanlar. */
export function listSelectableProviders(): ProviderStatusView[] {
  return listProviderStatuses().filter((view) => view.selectable);
}

/** Bir kaynağın değerleme için birincil seçilip seçilemeyeceğini fail-closed doğrular. */
export function assertSelectableProvider(providerId: string): ProviderStatusView {
  const view = describeProvider(providerId);
  if (!view) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${providerId}`);
  if (!view.selectable) {
    throw new Error(view.blockedReason ?? "Bu fiyat kaynağı kullanılamaz.");
  }
  return view;
}
