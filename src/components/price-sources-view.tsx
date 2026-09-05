"use client";

import { useState } from "react";

import { formatDateTime } from "@/lib/format";
import { SHARED_CATEGORY_NOTE } from "@/prices/valuation-plan";
import { Alert, Card, SectionTitle } from "./ui";

/**
 * FİYAT KAYNAKLARI — BİLGİ EKRANI
 *
 * Normal kullanıcıdan teknik sağlayıcı seçmesi İSTENMEZ. Tek bir değerleme
 * planı vardır ve bu ekran o planın kullanıcıyı ilgilendiren tek yanını
 * gösterir: fiyatlar ne kadar güncel ve listedeki "—" ne demek.
 *
 * Hangi ürünün fiyatı hangi kaynaktan geliyor sorusunun cevabı fiyat
 * listesinde, ürünün adının hemen altındaki rozette yazılıdır; burada ikinci
 * kez gösterilmez. Teknik sağlayıcı kimliği, lisans durumu ve güven seviyeleri
 * de gösterilmez — bunlar yönetim ekranının konusudur.
 */

export interface SourceOption {
  providerCode: string;
  displayName: string;
  coverage: number;
  lastSuccessAt: string | null;
}

export interface ActiveSource {
  lastQuoteAt: string | null;
  status: "ok" | "stale" | "unavailable" | "not_selected";
  coverage: number;
}

export interface CompareProvider {
  providerCode: string;
  displayName: string;
  quotes: {
    productId: string;
    liquidationPrice: string;
    replacementPrice: string;
    providerTimestamp: string;
    fetchedAt: string;
    status: string;
  }[];
}

/**
 * Kullanıcı bu ekranda kaynak SEÇEMEZ; bu yüzden etiketler bir görevi değil
 * olguyu anlatır. "Kaynak seçilmedi" demek, kullanıcıya yapması gereken ama
 * atladığı bir iş varmış hissi verirdi.
 */
const STATUS_LABELS: Record<ActiveSource["status"], string> = {
  ok: "Güncel",
  stale: "Güncel değil",
  unavailable: "Fiyat alınamıyor",
  not_selected: "Fiyat yok",
};

export function PriceSourcesView({
  initialActive,
}: {
  initialActive: ActiveSource;
  /**
   * Sayfa kaynak listesini ve karşılaştırmayı hâlâ yükleyip geçiyor olabilir;
   * ekran artık ikisini de basmıyor. Prop'lar isteğe bağlı tutulur ki çağıran
   * taraf sadeleşene kadar da, sadeleştikten sonra da tip denetimi geçsin.
   */
  initialOptions?: SourceOption[];
  initialCompare?: { providers: CompareProvider[] };
}) {
  const [active] = useState(initialActive);

  return (
    <div className="space-y-5">
      <SectionTitle title="Fiyatların durumu" />

      <Card className="p-4" data-testid="active-source">
        <p className="tabular text-sm font-medium text-ink">
          {STATUS_LABELS[active.status]}
          {active.lastQuoteAt ? ` · Son güncelleme ${formatDateTime(active.lastQuoteAt)}` : ""}
        </p>
      </Card>

      {/*
        Fiyatı olmayan ürün için 0 TL değil "—" gösterilir; kullanıcı listede o
        işareti görünce ne anlama geldiğini bilmeli. Ortak kategori notu da
        kalır: eski ve yeni ziynet aynı iki rakamı gösterdiği için, açıklama
        olmadan kullanıcı bunu uygulamanın hatası sanır.
      */}
      <Alert tone="info">Fiyatı alınamayan ürün listede — ile gösterilir. {SHARED_CATEGORY_NOTE}</Alert>
    </div>
  );
}
