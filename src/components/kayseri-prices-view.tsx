import { formatDateTime, formatMoney, formatRelativeTime } from "@/lib/format";
import { SARRAF_TV_URL } from "./kayseri-live-panel";
import { Alert, Card, SectionTitle, cx } from "./ui";

/**
 * KAYSERİ FİYATLARI
 *
 * Sarraf TV Kayseri ekranındaki BÜTÜN ham satırlar burada görünür.
 *
 * İki kavram bilinçli olarak AYRI tutulur:
 *  1. Ekranda görünmek — her satır gösterilir, ham adıyla.
 *  2. Portföy hesabına girmek — yalnız güvenilir ve açık eşlemeler girer.
 *
 * Tek fiyatlı satırlarda (HAS, 22/14/8 ayar) yön kanıtlanamadığı için aynı
 * rakam alış ve satış olarak İKİ KEZ yazılmaz.
 */

export interface ScreenRow {
  rawLabel: string;
  buy: string | null;
  sell: string | null;
  single: string | null;
  canonicalProductId: string | null;
  confidence: string | null;
  usedInValuation: boolean;
  reason: string | null;
  observedValues?: string[] | null;
}

export interface KayseriSnapshot {
  rows: ScreenRow[];
  observedAt: string | null;
  screenSignature: string;
  freshness: "fresh" | "stale" | "unusable" | "none";
  ageMinutes: number | null;
  /**
   * Geriye dönük uyum alanı: kullanıcı bazlı izin listesi kaldırıldı (0023) ve
   * sunucu bu alanı her koşulda true döndürür. Bu ekranda karar için OKUNMAZ.
   */
  allowed: boolean;
}

/** Çözülemeyen satırların sebeplerini kullanıcı diline çevirir. */
const REASON_TEXT: Record<string, string> = {
  YÖN_DOĞRULANAMADI: "Tek fiyat yazıyor; bozdurma mı yeniden alım mı belli değil",
  KATALOGDA_KARŞILIĞI_BELİRSİZ: "Hangi ürün olduğu belli değil",
  ALTIN_DEĞİL: "Altın değil",
  DEGERLEMEYE_GIRMEDI: "Hesaba katılmadı",
};

function reasonText(reason: string | null): string {
  if (reason === null) return "";
  if (reason.startsWith("ONAY_BEKLIYOR_")) return "Yönetici onayı bekliyor";
  // Tanınmayan sebep kodu kullanıcıya HAM basılmaz (MAKAS_TERS, GOZLEM_BAYAT gibi
  // kodlar toplayıcıda üretiliyor); genel ama doğru bir cümleye düşülür.
  return REASON_TEXT[reason] ?? "Bu fiyat hesaba katılmadı";
}

/** Fiyat metni; değer yoksa sayı UYDURULMAZ. Biçim uygulamanın geri kalanıyla aynıdır. */
function money(value: string | null): string {
  return value === null ? "—" : formatMoney(value);
}

function FreshnessBadge({ snapshot }: { snapshot: KayseriSnapshot }) {
  const { freshness, observedAt } = snapshot;
  if (freshness === "none") {
    return <span className="badge">Fiyat yok</span>;
  }
  const label =
    freshness === "fresh" ? "Güncel" : freshness === "stale" ? "Gecikmeli" : "Kullanılamıyor";
  return (
    <span
      className={cx(
        "badge",
        freshness === "fresh"
          ? "badge-positive"
          : freshness === "stale"
            ? "badge-notice"
            : "badge-negative",
      )}
      data-testid="kayseri-freshness"
    >
      {label}
      {observedAt === null ? "" : ` · ${formatRelativeTime(observedAt)}`}
    </span>
  );
}

export function KayseriPricesView({ snapshot }: { snapshot: KayseriSnapshot }) {
  const used = snapshot.rows.filter((row) => row.usedInValuation);
  const reference = snapshot.rows.filter((row) => !row.usedInValuation);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Kayseri fiyatları"
        description="Sarraf TV Kayseri ekranındaki bütün fiyatlar."
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted" data-testid="kayseri-observed-at">
            Son ekran gözlemi:{" "}
            {snapshot.observedAt === null ? "yok" : formatDateTime(snapshot.observedAt)}
          </p>
          <FreshnessBadge snapshot={snapshot} />
        </div>

        <p className="mt-3 break-words text-xs text-subtle">
          Bu fiyatlar Sarraf TV&apos;nin Kayseri ekranından okunur; resmî veya lisanslı bir fiyat
          listesi değildir ve bağlayıcı bir teklif sayılmaz.
        </p>
      </Card>

      {snapshot.freshness === "unusable" ? (
        <Alert tone="danger">Son fiyat 3 saatten eski; portföy değeriniz hesaplanmıyor.</Alert>
      ) : null}

      {snapshot.rows.length === 0 ? (
        <Alert tone="info">Fiyatlar henüz gelmedi; kısa süre sonra tekrar bakın.</Alert>
      ) : (
        <>
          <Card>
            <p className="text-sm font-semibold text-ink">Portföyümde kullanılan fiyatlar</p>
            {used.length === 0 ? (
              <p className="mt-1 text-xs text-muted">
                Şu an hiçbir fiyat portföyünüzde kullanılmıyor.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[320px] text-left text-xs" data-testid="kayseri-used">
                  <thead className="text-subtle">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Ekrandaki ad</th>
                      <th className="py-1 pr-3 text-right font-medium">Bozdurma</th>
                      <th className="py-1 pr-3 text-right font-medium">Yeniden alım</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Ham etiket benzersiz DEĞİLDİR (aynı ürün ekranda iki kez görülebilir). */}
                    {used.map((row, index) => (
                      <tr key={`${row.rawLabel}#${String(index)}`} className="border-t border-line">
                        <td className="py-1.5 pr-3 font-medium text-ink">{row.rawLabel}</td>
                        <td className="tabular py-1.5 pr-3 text-right">{money(row.buy)}</td>
                        <td className="tabular py-1.5 pr-3 text-right">{money(row.sell)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {reference.length > 0 ? (
            <Card>
              <p className="text-sm font-semibold text-ink">
                Ekranda görünen diğer fiyatlar (hesaba katılmaz)
              </p>
              <div className="mt-3 overflow-x-auto">
                <table
                  className="w-full min-w-[420px] text-left text-xs"
                  data-testid="kayseri-reference"
                >
                  <thead className="text-subtle">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Ekrandaki ad</th>
                      <th className="py-1 pr-3 text-right font-medium">Ekranda yazan</th>
                      <th className="py-1 pr-3 font-medium">Neden kullanılmıyor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reference.map((row, index) => (
                      <tr key={`${row.rawLabel}#${String(index)}`} className="border-t border-line">
                        <td className="py-1.5 pr-3 font-medium text-ink">{row.rawLabel}</td>
                        <td className="tabular py-1.5 pr-3 text-right">
                          {row.single !== null ? (
                            money(row.single)
                          ) : row.observedValues && row.observedValues.length > 0 ? (
                            // Yön ATFEDİLMEZ: rakamlar ekrandaki sırayla, etiketsiz.
                            row.observedValues.map(money).join(" · ")
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-muted">{reasonText(row.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </>
      )}

      <p className="text-xs">
        <a
          className="text-accent underline"
          href={SARRAF_TV_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Sarraf TV ekranını aç
        </a>
      </p>
    </div>
  );
}
