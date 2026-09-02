import { appConfig } from "@/config/app.config";

const LOCALE = appConfig.locale;

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

export function formatMoney(value: number): string {
  return currency.format(value);
}

/** Büyük özet rakamlarında kuruş göstermeden okunabilir biçim. */
export function formatMoneyCompact(value: number): string {
  return currencyCompact.format(value);
}

export function formatQuantity(value: number, unit: "gram" | "adet"): string {
  const digits = unit === "adet" ? 0 : 3;
  const formatted = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
  return `${formatted} ${unit}`;
}

export function formatGrams(value: number): string {
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value)} gr`;
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${percent.format(value)}%`;
}

export function formatSignedMoney(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${currency.format(value)}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium" }).format(date);
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

/** Türkçe klavyede ondalık ayırıcı virgüldür; her iki biçimi de kabul ederiz. */
export function parseDecimal(raw: string): number {
  const normalized = raw.replace(/\s/g, "").replace(",", ".");
  if (normalized === "") return Number.NaN;
  return Number(normalized);
}
