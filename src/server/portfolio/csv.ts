import "server-only";

import type { LedgerEntry, ProductPosition } from "@/domain/accounting";
import { requireProduct } from "@/domain/catalog";

/**
 * KULLANICI VERİSİ DIŞA AKTARMA (CSV)
 *
 * Kullanıcının uygulamaya kaydettiği altın portföyünü kendi cihazına indirmesi
 * içindir. Sayılar ondalık DİZE olarak yazılır (kayan nokta dönüşümü yapılmaz);
 * Excel'in Türkçe yerelinde bozulmaması için ayırıcı noktalı virgüldür ve dosya
 * UTF-8 BOM ile sunulur.
 */

/**
 * Formül enjeksiyonu koruması.
 *
 * Kullanıcının yazdığı not veya iptal sebebi "=", "+", "-", "@" ya da sekme/CR ile
 * başlarsa Excel/LibreOffice bunu FORMÜL olarak çalıştırabilir. Metnin başına tek
 * tırnak eklenerek hücre düz metne zorlanır; içerik kaybolmaz.
 */
function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function escapeCell(value: string | null | undefined): string {
  const text = neutralizeFormula(value ?? "");
  if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toRow(cells: (string | null | undefined)[]): string {
  return cells.map(escapeCell).join(";");
}

const LEDGER_HEADER = [
  "Tarih",
  "Saat",
  "İşlem türü",
  "Ürün",
  "Miktar",
  "Birim",
  "Girilen birim fiyat",
  "Efektif birim maliyet",
  "Brüt tutar",
  "İşçilik",
  "Masraf",
  "Toplam ödenen",
  "Net tahsilat",
  "Maliyet kökeni",
  "Durum",
  "İptal sebebi",
  "Not",
];

const KIND_LABELS: Record<LedgerEntry["kind"], string> = {
  OPENING_BALANCE: "Mevcut altın",
  BUY: "Alış",
  SELL: "Satış",
};

const STATUS_LABELS: Record<LedgerEntry["status"], string> = {
  ACTIVE: "Aktif",
  VOID: "İptal edildi",
  REPLACED: "Düzeltildi",
};

export function ledgerCsv(entries: readonly LedgerEntry[]): string {
  const rows = [toRow(LEDGER_HEADER)];
  for (const entry of entries) {
    rows.push(
      toRow([
        entry.occurredAt,
        entry.occurredTime ?? "",
        KIND_LABELS[entry.kind],
        requireProduct(entry.productId).name,
        entry.quantity,
        entry.unit,
        entry.quotedAcquisitionUnitPrice ?? entry.quotedDisposalUnitPrice ?? "",
        entry.effectiveAcquisitionUnitCost ?? entry.effectiveNetUnitProceeds ?? "",
        entry.grossAmount,
        entry.workmanship,
        entry.fees,
        entry.totalPaid ?? "",
        entry.netProceeds ?? "",
        entry.costBasisOrigin,
        STATUS_LABELS[entry.status],
        entry.voidReason ?? "",
        entry.note,
      ]),
    );
  }
  return rows.join("\r\n");
}

const POSITION_HEADER = [
  "Ürün",
  "Miktar",
  "Birim",
  "Ortalama maliyet",
  "Elde kalan maliyet",
  "Gerçekleşmiş K/Z",
  "Maliyet kökeni (elde kalan)",
  "Maliyet kökeni (gerçekleşmiş)",
];

function originLabel(flags: { actual: boolean; estimated: boolean; baseline: boolean }): string {
  const parts: string[] = [];
  if (flags.actual) parts.push("Gerçek");
  if (flags.estimated) parts.push("Tahmini");
  if (flags.baseline) parts.push("Takip başlangıcı");
  return parts.join(" + ") || "—";
}

export function positionsCsv(positions: readonly ProductPosition[]): string {
  const rows = [toRow(POSITION_HEADER)];
  for (const position of positions) {
    const product = requireProduct(position.productId);
    rows.push(
      toRow([
        product.name,
        position.quantity,
        product.unit,
        position.averageCost ?? "",
        position.remainingCostBasis,
        position.realizedPnl,
        originLabel(position.holdingCostOrigins),
        originLabel(position.realizedPnlOrigins),
      ]),
    );
  }
  return rows.join("\r\n");
}
