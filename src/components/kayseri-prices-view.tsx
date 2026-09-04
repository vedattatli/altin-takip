import { formatDateTime } from "@/lib/format";
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
 * rakam alış ve satış olarak İKİ KEZ yazılmaz; "tek yönlü referans" denir.
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
  allowed: boolean;
}

/** Çözülemeyen satırların sebeplerini kullanıcı diline çevirir. */
const REASON_TEXT: Record<string, string> = {
  YÖN_DOĞRULANAMADI: "Tek yönlü referans — kaynak alış/satış ayrımı yayımlamıyor",
  TEK_YÖNLÜ_REFERANS_FİYAT: "Tek yönlü referans fiyat",
  TEK_SATIRDA_İKİ_ÜRÜN: "Kaynak bu satırda iki ürünü birleştiriyor",
  KATALOGDA_KARŞILIĞI_BELİRSİZ: "Uygulamadaki karşılığı kesin değil",
  ALTIN_DEĞİL: "Altın değil — altın portföyüne katılmaz",
  DEGERLEMEYE_GIRMEDI: "Değerlemeye girmedi",
};

/**
 * Eşleme güveni kullanıcı diline çevrilir.
 *
 * NETWORK_VERIFIED / GROUPED_EXPLICIT gibi teknik enum'lar kullanıcıya
 * gösterilmez; bunlar iç denetim kavramlarıdır.
 */
const CONFIDENCE_TEXT: Record<string, string> = {
  NETWORK_VERIFIED: "Kaynak alış/satış ayrımını kendi verisinde belirtiyor",
  GROUPED_EXPLICIT: "Kaynak bu fiyatın birden çok ürünü kapsadığını yazıyor",
  OPERATOR_VERIFIED: "Yönetici ekran kanıtını görüp onayladı",
  EXACT: "Başlık ürünü tek anlamlı belirtiyor",
  CONVENTION: "Piyasa teamülü — onay olmadan hesaba girmez",
};

function confidenceText(confidence: string | null): string {
  if (confidence === null) return "—";
  return CONFIDENCE_TEXT[confidence] ?? confidence;
}

function reasonText(reason: string | null): string {
  if (reason === null) return "";
  if (reason.startsWith("ONAY_BEKLIYOR_")) return "Yönetici onayı bekliyor";
  return REASON_TEXT[reason] ?? reason;
}

/** Ondalık metni biçimlendirir; sayıya çevrilemezse olduğu gibi gösterir. */
function money(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function FreshnessBadge({ snapshot }: { snapshot: KayseriSnapshot }) {
  const { freshness, ageMinutes } = snapshot;
  if (freshness === "none") {
    return <span className="rounded px-2 py-0.5 text-xs text-subtle">Gözlem yok</span>;
  }
  const label = freshness === "fresh" ? "Güncel" : freshness === "stale" ? "Bayat" : "Kullanılamıyor";
  const tone =
    freshness === "fresh"
      ? "bg-emerald-500/15 text-emerald-700"
      : freshness === "stale"
        ? "bg-amber-500/15 text-amber-700"
        : "bg-red-500/15 text-red-700";
  return (
    <span className={cx("rounded px-2 py-0.5 text-xs font-medium", tone)} data-testid="kayseri-freshness">
      {label}
      {ageMinutes === null ? "" : ` · ${String(ageMinutes)} dk önce`}
    </span>
  );
}

export function KayseriPricesView({ snapshot }: { snapshot: KayseriSnapshot }) {
  if (!snapshot.allowed) {
    return (
      <div className="space-y-4">
        <SectionTitle title="Kayseri fiyatları" />
        <Alert tone="info">
          Bu ekran özel pilot kapsamındadır ve yöneticinin izin verdiği hesaplara açıktır. Erişim
          isterseniz yöneticinize başvurun.
        </Alert>
      </div>
    );
  }

  const used = snapshot.rows.filter((row) => row.usedInValuation);
  const reference = snapshot.rows.filter((row) => !row.usedInValuation);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Kayseri fiyatları"
        description="Sarraf TV Kayseri ekranındaki bütün satırlar. Görünmek ile portföy hesabına girmek ayrı kavramlardır."
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-ink">Sarraf TV Kayseri ekran gözlemi</p>
            <p className="mt-1 text-xs text-muted" data-testid="kayseri-observed-at">
              Son ekran gözlemi:{" "}
              {snapshot.observedAt === null ? "yok" : formatDateTime(snapshot.observedAt)}
            </p>
          </div>
          <FreshnessBadge snapshot={snapshot} />
        </div>

        <p className="mt-3 break-words text-xs text-subtle">
          Fiyatlar ücretsiz bulut zamanlayıcısıyla <strong>saatte bir</strong> toplanır ve
          gecikebilir. Bu <strong>resmî bir API değildir</strong>; ekranda görünen değerlerin
          gözlemidir ve bağlayıcı bir alım satım teklifi değildir. Kaynak veri vermezse başka
          kaynağa veya test verisine geçilmez; fiyat açıkça bayat gösterilir.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold text-ink">Sarraf TV Kayseri — canlı ekran</p>
        <p className="mt-1 break-words text-xs text-muted">
          Aşağıdaki pencere kaynağın kendi canlı ekranıdır ve <strong>görsel referanstır</strong>.
          Portföy hesabı bu pencereden değil, yukarıdaki doğrulanmış gözlemden hesaplanır; ekran
          kendi kendini sürekli güncellediği için hesaptan daha yeni bir fiyat gösteriyor olabilir.
        </p>
        <iframe
          title="Sarraf TV Kayseri canlı ekranı"
          src={SARRAF_TV_URL}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin"
          className="mt-3 h-[420px] w-full rounded-[var(--radius-sm)] border border-line bg-black sm:h-[560px]"
          data-testid="sarraf-tv-frame"
        />
        <p className="mt-2 text-xs text-subtle">
          Pencere açılmazsa kaynak framelemeye izin vermiyor olabilir; koruma aşılmaz. Fiyatlar
          yukarıdaki tablolarda zaten yazılıdır.{" "}
          <a className="text-accent underline" href={SARRAF_TV_URL} target="_blank" rel="noreferrer noopener">
            Ekranı yeni sekmede aç
          </a>
        </p>
      </Card>

      {snapshot.freshness === "unusable" ? (
        <Alert tone="danger">
          Son gözlem 3 saatten eski. Fiyatlar <strong>kullanılamıyor</strong> sayılır ve portföy
          değerlemesine katılmaz.
        </Alert>
      ) : null}

      {snapshot.rows.length === 0 ? (
        <Alert tone="info">
          Henüz ekran gözlemi kaydedilmedi. Bulut toplayıcısı çalıştığında satırlar burada
          görünecek.
        </Alert>
      ) : (
        <>
          <Card>
            <p className="text-sm font-semibold text-ink">Portföy hesabında kullanılan satırlar</p>
            <p className="mt-1 text-xs text-muted">
              {used.length === 0
                ? "Şu anda hiçbir satır değerlemeye girmiyor."
                : `${String(used.length)} satır değerlemeye giriyor.`}
            </p>
            {used.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs" data-testid="kayseri-used">
                  <thead className="text-subtle">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Ekrandaki ad</th>
                      <th className="py-1 pr-3 text-right font-medium">Bozdurma (alış)</th>
                      <th className="py-1 pr-3 text-right font-medium">Yeniden alma (satış)</th>
                      <th className="py-1 pr-3 font-medium">Neden güvenilir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {used.map((row) => (
                      <tr key={row.rawLabel} className="border-t border-hairline">
                        <td className="py-1.5 pr-3 font-medium text-ink">{row.rawLabel}</td>
                        <td className="tabular py-1.5 pr-3 text-right">{money(row.buy)}</td>
                        <td className="tabular py-1.5 pr-3 text-right">{money(row.sell)}</td>
                        <td className="py-1.5 pr-3 text-muted">{confidenceText(row.confidence)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>

          <Card>
            <p className="text-sm font-semibold text-ink">
              Ekranda görünen diğer satırlar (hesaba katılmaz)
            </p>
            <p className="mt-1 break-words text-xs text-muted">
              Bu satırlar bilgi amaçlıdır. Kaynak yön ayrımı yayımlamadığı veya uygulamadaki
              karşılığı kesin olmadığı için portföy değerlemesine <strong>girmezler</strong>. Aynı
              rakam yapay olarak hem alış hem satış gibi gösterilmez.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs" data-testid="kayseri-reference">
                <thead className="text-subtle">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Ekrandaki ad</th>
                    <th className="py-1 pr-3 text-right font-medium">Referans fiyat</th>
                    <th className="py-1 pr-3 font-medium">Neden kullanılmıyor</th>
                  </tr>
                </thead>
                <tbody>
                  {reference.map((row) => (
                    <tr key={row.rawLabel} className="border-t border-hairline">
                      <td className="py-1.5 pr-3 font-medium text-ink">{row.rawLabel}</td>
                      <td className="tabular py-1.5 pr-3 text-right">
                        {row.single !== null ? (
                          <>
                            {money(row.single)}
                            <span className="ml-1 text-[10px] font-normal text-subtle">tek yönlü</span>
                          </>
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
        </>
      )}
    </div>
  );
}
