/**
 * İŞLEM ZAMANI — tek saat dilimi, açık kurallar.
 *
 * - Kullanıcı tarihi YYYY-MM-DD, isteğe bağlı saati HH:MM olarak girer.
 * - Bütün girdiler Europe/Istanbul yerel saati kabul edilir (uygulamanın varsayılan
 *   kullanıcı saat dilimi). Türkiye 2016'dan beri sabit UTC+03:00 kullanır; daha eski
 *   tarihlerde tarihsel DST kuralları IANA tzdata üzerinden (Intl / Postgres) uygulanır.
 * - Saat girilmeyen kayıt o günün BAŞLANGICI (00:00 Europe/Istanbul) sayılır; aynı gün
 *   içinde gerçek sıra gerekiyorsa her iki kayda da saat girilir.
 * - Sıralama anahtarı `occurredAtInstant` (UTC ISO) + created_at + ledger_sequence + id'dir.
 *   Aynı kural Postgres'te `occurred_at timestamptz` sütunuyla uygulanır
 *   (`(date + time) at time zone 'Europe/Istanbul'`).
 */

export const ACCOUNTING_TIME_ZONE = "Europe/Istanbul";

/** Sunucu saatiyle küçük sapmalara tolerans; bunun ötesi "gelecek tarih" sayılır. */
export const OCCURRED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Gerçek bir takvim tarihi mi? (2026-02-30 → false, 2028-02-29 → true) */
export function isValidCalendarDate(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const match = DATE_PATTERN.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

export function isValidTimeOfDay(text: unknown): text is string {
  return typeof text === "string" && TIME_PATTERN.test(text);
}

let formatter: Intl.DateTimeFormat | null = null;

function zoneFormatter(): Intl.DateTimeFormat {
  formatter ??= new Intl.DateTimeFormat("en-US", {
    timeZone: ACCOUNTING_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(utcMs: number): ZonedParts {
  const parts = zoneFormatter().formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/** Verilen UTC anında Europe/Istanbul'un UTC'ye göre kayması (ms). */
function zoneOffsetMs(utcMs: number): number {
  const parts = partsInZone(utcMs);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Europe/Istanbul yerel tarih (+ isteğe bağlı saat) → UTC an (ms).
 * Geçersiz tarih/saat için null.
 */
export function zonedToInstantMs(date: string, time: string | null | undefined): number | null {
  if (!isValidCalendarDate(date)) return null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  let hour = 0;
  let minute = 0;
  if (time !== null && time !== undefined && time !== "") {
    if (!isValidTimeOfDay(time)) return null;
    [hour, minute] = time.split(":").map(Number) as [number, number];
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  // İki adımlı düzeltme: kayma, aynı anın kendi kaymasıyla hesaplanır (DST geçişleri dâhil).
  let instant = wall - zoneOffsetMs(wall);
  const secondOffset = zoneOffsetMs(instant);
  if (wall - secondOffset !== instant) instant = wall - secondOffset;
  return instant;
}

/** Europe/Istanbul yerel tarih (+ saat) → UTC ISO dizesi. Geçersiz girdi için null. */
export function occurredAtInstantISO(date: string, time: string | null | undefined): string | null {
  const ms = zonedToInstantMs(date, time);
  return ms === null ? null : new Date(ms).toISOString();
}

/** UTC an → Europe/Istanbul yerel tarih ve saat. */
export function instantToZoned(input: string | number): { date: string; time: string } | null {
  const ms = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  const parts = partsInZone(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
  };
}

/** Bugünün tarihi (Europe/Istanbul). Sunucu UTC'de çalışsa bile kullanıcının günü esas alınır. */
export function todayISO(now: Date = new Date()): string {
  return instantToZoned(now.getTime())?.date ?? now.toISOString().slice(0, 10);
}

/** Karşılaştırma için an değeri; ayrıştırılamıyorsa NaN yerine null. */
export function instantMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
