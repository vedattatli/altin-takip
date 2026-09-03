/**
 * Worker dayanıklılık politikası — SAF fonksiyonlar.
 *
 * Yeniden başlatma ve geri çekilme kararları buraya ayrıldı ki tarayıcı, ağ
 * veya container olmadan test edilebilsinler. `index.ts` bu kararları uygular;
 * kuralı iki yerde tekrarlamaz.
 */

/** Tarayıcının neden yeniden başlatılması gerektiği; gerekmiyorsa null. */
export type RestartReason = "initial" | "disconnected" | "scheduled" | "memory" | "error";

export interface RuntimeState {
  /** Tarayıcı nesnesi hiç oluşturulmadıysa false. */
  readonly browserCreated: boolean;
  /** Playwright bağlantısı canlı mı. */
  readonly browserConnected: boolean;
  /** Ekran oturumu canlı mı (sayfa kapanmış olabilir). */
  readonly sessionAlive: boolean;
  /** Tarayıcının açıldığı andan bu yana geçen süre (ms). */
  readonly browserAgeMs: number;
  /** Sürecin şu anki bellek kullanımı (MB). */
  readonly memoryMb: number;
}

export interface RuntimeLimits {
  readonly browserMaxAgeMs: number;
  readonly memoryLimitMb: number;
}

/**
 * Sıra önemlidir: önce "tarayıcı yok/ölü", sonra planlı yenileme, sonra bellek.
 * Ölü bir tarayıcıda yaş veya bellek kontrolü yapmanın anlamı yoktur.
 */
export function restartReason(state: RuntimeState, limits: RuntimeLimits): RestartReason | null {
  if (!state.browserCreated) return "initial";
  if (!state.browserConnected || !state.sessionAlive) return "disconnected";
  if (state.browserAgeMs > limits.browserMaxAgeMs) return "scheduled";
  if (state.memoryMb > limits.memoryLimitMb) return "memory";
  return null;
}

/**
 * Üstel geri çekilme + jitter. Üst sınır 60 sn; sonsuza kadar büyümez ki
 * geçici bir kesinti kalıcı sessizliğe dönüşmesin.
 */
export function backoffMs(attempt: number, jitter = Math.random()): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(attempt, 0), 5));
  return base + Math.floor(jitter * 1_000);
}

/**
 * Gözlem "taze" mi? Uygulama tarafındaki 120 sn'lik sınırla AYNI eşiktir;
 * worker bayat bir gözlemi göndermeye çalışıp boşuna reddedilmez.
 */
export const OBSERVATION_MAX_AGE_MS = 180 * 60_000;

export function observationFresh(observedAt: number, now: number): boolean {
  const age = now - observedAt;
  return age >= 0 && age <= OBSERVATION_MAX_AGE_MS;
}

/**
 * Sağlık kararı.
 *
 * Kural şudur: worker "ayakta" değil, "gözlem üretiyor" olmalıdır. Süreç
 * yaşıyor ama saatlerdir fiyat okuyamıyorsa bu SAĞLIKLI DEĞİLDİR — 200 dönmek
 * platformu yanıltır ve kurtarma hiç tetiklenmez.
 *
 * Tek istisna: kirayı başka bir worker tuttuğu için beklemede olan yedek.
 * O gerçekten sağlıklıdır ve yeniden başlatılmamalıdır.
 */
export type HealthStatus = "starting" | "ok" | "degraded" | "unavailable" | "blocked" | "stopped";

export interface HealthInput {
  readonly status: HealthStatus;
  /** Son hata kodu; yedeklik kararı için "LEASE_NOT_HELD" ayırt edicidir. */
  readonly lastErrorCode: string | null;
  /** Son BAŞARILI gözlem anı (ms); hiç olmadıysa null. */
  readonly lastSuccessAtMs: number | null;
  /** Sürecin başlangıcı (ms). */
  readonly startedAtMs: number;
  /** Gözlem aralığı (ms). */
  readonly intervalMs: number;
}

/** Açılışta kurtarmayı tetiklememek için tanınan süre. */
export const HEALTH_GRACE_MS = 180_000;

/** Bu kadar aralık boyunca başarı yoksa worker sağlıksızdır. */
export const HEALTH_MISSED_INTERVALS = 3;

export function healthyForPlatform(input: HealthInput, now: number): boolean {
  if (input.status === "stopped") return false;
  // Yedeklik YALNIZCA şu durumda geçerlidir: sunucuya ulaşıldı ve kirayı başka
  // bir worker tutuyor. "degraded" tek başına yetmez — döngü hatası da statüyü
  // degraded yapar ve bu bir sağlıksızlıktır, sıra beklemek değil.
  if (input.status === "degraded" && input.lastErrorCode === "LEASE_NOT_HELD") return true;

  const deadline = Math.max(HEALTH_GRACE_MS, input.intervalMs * HEALTH_MISSED_INTERVALS);

  if (input.lastSuccessAtMs === null) {
    // Hiç başarılı gözlem yok: yalnızca açılış payı boyunca hoş görülür.
    return now - input.startedAtMs <= deadline;
  }
  return now - input.lastSuccessAtMs <= deadline;
}

/**
 * Sayısal ortam değişkeni okur — BOŞ DEĞER "AYARLANMAMIŞ" SAYILIR.
 *
 * `Number(process.env.X ?? "60000")` kalıbı, değişken tanımlı ama boşsa
 * varsayılanı atlayıp `Number("")` = 0 üretir. Worker'da bu, gözlem aralığının
 * veya bellek sınırının sessizce sıfırlanması anlamına gelirdi.
 *
 * Uygulama tarafındaki `src/lib/env.ts` ile aynı kuraldır; worker `@/` alias'ını
 * kullanamadığı için ayrı durur.
 */
export function numberFromEnv(name: string, fallback: number, min?: number): number {
  const value = process.env[name];
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (min !== undefined && parsed < min) return fallback;
  return parsed;
}

/**
 * Metin ayarı okur; boş/boşluk değer "ayarlanmamış" sayılır.
 *
 * Önemi: `WORKER_ID=""` verilirse worker kimliği boş kalır ve kira sahipliği
 * boş bir kimliğe yazılır — iki worker aynı anda "sahip" görünebilir.
 */
export function stringFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  const raw = typeof value === "string" ? value.trim() : "";
  return raw === "" ? fallback : raw;
}
