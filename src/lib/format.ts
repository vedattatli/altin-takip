import { appConfig } from "@/config/app.config";
import { AccountingDecimal, dec } from "@/domain/accounting/decimal";

/**
 * Biçimlendirme — YALNIZCA gösterim.
 *
 * Para ve miktar değerleri ondalık DİZE olarak gelir. Burada önce decimal ile
 * istenen basamağa yuvarlanır, sonra Intl ile biçimlendirilir; böylece
 * 0,1 + 0,2 gibi ikili kayan nokta artıkları hiçbir ekranda görünmez.
 */

const LOCALE = appConfig.locale;

export type NumericText = string | number;

const currency = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: appConfig.currency,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const currencyCompact = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: appConfig.currency,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const percent = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Gösterim için güvenli sayı: önce decimal ile yuvarlanır. */
function displayNumber(value: NumericText, scale: number): number {
  try {
    return Number(dec(value).toDecimalPlaces(scale, AccountingDecimal.ROUND_HALF_UP).toFixed(scale));
  } catch {
    return Number.NaN;
  }
}

export function signOf(value: NumericText): -1 | 0 | 1 {
  try {
    const d = dec(value);
    if (d.isZero()) return 0;
    return d.isNegative() ? -1 : 1;
  } catch {
    return 0;
  }
}

export function formatMoney(value: NumericText): string {
  const n = displayNumber(value, 2);
  return Number.isNaN(n) ? "—" : currency.format(n);
}

/** Büyük özet rakamlarında kuruş göstermeden okunabilir biçim. */
export function formatMoneyCompact(value: NumericText): string {
  const n = displayNumber(value, 0);
  return Number.isNaN(n) ? "—" : currencyCompact.format(n);
}

export function formatSignedMoney(value: NumericText): string {
  const sign = signOf(value) > 0 ? "+" : "";
  return `${sign}${formatMoney(value)}`;
}

export function formatQuantity(value: NumericText, unit: "gram" | "adet"): string {
  const digits = unit === "adet" ? 0 : 6;
  const n = displayNumber(value, digits);
  if (Number.isNaN(n)) return `— ${unit}`;
  const formatted = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(n);
  return `${formatted} ${unit}`;
}

export function formatGrams(value: NumericText): string {
  const n = displayNumber(value, 3);
  if (Number.isNaN(n)) return "— gr";
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(n)} gr`;
}

/** Birim fiyat gösterimi: 2 ondalık, ancak küçük kesirler için 4 ondalığa kadar. */
export function formatUnitPrice(value: NumericText): string {
  return formatMoney(value);
}

export function formatPercent(value: NumericText): string {
  const n = displayNumber(value, 2);
  if (Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${percent.format(n)}%`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium" }).format(date);
}

/** İşlem zamanı: tarih, saat girildiyse "10 Oca 2026 14:30". */
export function formatOccurred(date: string, time: string | null | undefined): string {
  const base = formatDate(date);
  return time ? `${base} ${time}` : base;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** "3 dakika önce" gibi göreli zaman — fiyatın tazeliğini dürüstçe göstermek için. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "bilinmiyor";
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 10) return "az önce";
  if (seconds < 60) return `${seconds} saniye önce`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} dakika önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} saat önce`;
  const days = Math.round(hours / 24);
  return `${days} gün önce`;
}
