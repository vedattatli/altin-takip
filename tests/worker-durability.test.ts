import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HEALTH_GRACE_MS,
  OBSERVATION_MAX_AGE_MS,
  backoffMs,
  healthyForPlatform,
  observationFresh,
  restartReason,
} from "../services/sarraf-screen-worker/src/policy";
import { SCREEN_OBSERVATION_MAX_AGE_MS } from "@/prices/providers/sarraf-tv-screen-collector";

/**
 * WORKER DAYANIKLILIĞI
 *
 * Buradaki testler tarayıcı, ağ veya container gerektirmez: yeniden başlatma
 * ve geri çekilme kararları saf fonksiyonlara ayrıldığı için doğrudan
 * doğrulanabilir. Container davranışının kendisi ayrıca `smoke` ile ölçülür.
 */

const LIMITS = { browserMaxAgeMs: 6 * 60 * 60_000, memoryLimitMb: 900 };

const HEALTHY = {
  browserCreated: true,
  browserConnected: true,
  sessionAlive: true,
  browserAgeMs: 60_000,
  memoryMb: 300,
};

describe("1. yeniden başlatma kararı", () => {
  it("sağlıklı durumda yeniden başlatma YOKTUR", () => {
    expect(restartReason(HEALTHY, LIMITS)).toBeNull();
  });

  it("ilk açılış 'initial' der", () => {
    expect(restartReason({ ...HEALTHY, browserCreated: false }, LIMITS)).toBe("initial");
  });

  it("tarayıcı çökerse 'disconnected' der", () => {
    expect(restartReason({ ...HEALTHY, browserConnected: false }, LIMITS)).toBe("disconnected");
  });

  it("sayfa ölürse tarayıcı bağlı olsa bile 'disconnected' der", () => {
    // Tarayıcı süreci ayakta ama sekme kapanmış olabilir; bu da kurtarma gerektirir.
    expect(restartReason({ ...HEALTHY, sessionAlive: false }, LIMITS)).toBe("disconnected");
  });

  it("planlı yenileme süresi dolunca 'scheduled' der", () => {
    expect(restartReason({ ...HEALTHY, browserAgeMs: LIMITS.browserMaxAgeMs + 1 }, LIMITS)).toBe(
      "scheduled",
    );
  });

  it("bellek sınırı aşılınca 'memory' der", () => {
    expect(restartReason({ ...HEALTHY, memoryMb: LIMITS.memoryLimitMb + 1 }, LIMITS)).toBe("memory");
  });

  it("ölü tarayıcıda yaş/bellek değil, önce bağlantı kararı verilir", () => {
    // Sıra önemlidir: ölü bir tarayıcıda "planlı yenileme" demek yanlış teşhistir.
    const dead = {
      ...HEALTHY,
      browserConnected: false,
      browserAgeMs: LIMITS.browserMaxAgeMs + 1,
      memoryMb: LIMITS.memoryLimitMb + 1,
    };
    expect(restartReason(dead, LIMITS)).toBe("disconnected");
  });

  it("hiç tarayıcı yokken 'initial' her şeyin önündedir", () => {
    const fresh = { ...HEALTHY, browserCreated: false, browserConnected: false, sessionAlive: false };
    expect(restartReason(fresh, LIMITS)).toBe("initial");
  });
});

describe("2. geri çekilme", () => {
  it("üstel büyür", () => {
    const first = backoffMs(0, 0);
    const second = backoffMs(1, 0);
    const third = backoffMs(2, 0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("60 saniyede tavan yapar", () => {
    // Kalıcı bir kesinti worker'ı saatlerce sessize almamalıdır.
    for (const attempt of [5, 10, 100, 10_000]) {
      expect(backoffMs(attempt, 0)).toBeLessThanOrEqual(60_000);
    }
  });

  it("jitter eklenir ama tavanı 1 saniyeden fazla aşmaz", () => {
    // Aynı anda düşen worker'lar aynı anda geri gelmesin diye.
    expect(backoffMs(10, 0.999)).toBeLessThan(61_000);
    expect(backoffMs(10, 0.999)).toBeGreaterThan(backoffMs(10, 0));
  });

  it("negatif deneme sayısı taban değeri bozmaz", () => {
    expect(backoffMs(-5, 0)).toBe(backoffMs(0, 0));
  });
});

describe("3. gözlem tazeliği", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");

  it("yeni gözlem tazedir", () => {
    expect(observationFresh(now - 30_000, now)).toBe(true);
  });

  it("120 saniyeden eski gözlem bayattır", () => {
    expect(observationFresh(now - 120_001, now)).toBe(false);
  });

  it("gelecekten gelen gözlem taze SAYILMAZ", () => {
    // Saat kayması bir gözlemi "sonsuza kadar taze" yapmamalıdır.
    expect(observationFresh(now + 1_000, now)).toBe(false);
  });

  it("worker eşiği uygulama eşiğiyle AYNIDIR", () => {
    // Farklı olsalardı worker, sunucunun reddedeceği gözlemi göndermeye devam
    // eder ve sorunu log'da "sunucu hatası" gibi gösterirdi.
    expect(OBSERVATION_MAX_AGE_MS).toBe(SCREEN_OBSERVATION_MAX_AGE_MS);
  });
});

describe("4. container ve süreç sözleşmesi", () => {
  const root = join(process.cwd(), "services", "sarraf-screen-worker");

  function sourceOf(file: string): string {
    return readFileSync(join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*(\/\/|#).*$/gm, "");
  }

  it("SIGTERM ve SIGINT karşılanır", () => {
    // Platform yeniden başlatırken tarayıcı düzgün kapanmalıdır.
    const source = sourceOf("src/index.ts");
    expect(source).toMatch(/SIGTERM/);
    expect(source).toMatch(/SIGINT/);
  });

  it("sağlık ucu vardır", () => {
    expect(sourceOf("src/index.ts")).toMatch(/healthz/);
  });

  it("Dockerfile healthcheck tanımlar ve root olmayan kullanıcıya düşer", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/USER\s+pwuser/);
  });

  it("Dockerfile resmî Playwright imajını sabit sürümle kullanır", () => {
    // "latest" etiketi tarayıcı ile playwright-core sürümünü sessizce ayırır.
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+/);
    expect(dockerfile).not.toMatch(/playwright:latest/);
  });

  it("sayfa çökmesi oturumu ÖLÜ işaretler", () => {
    // Chromium çöken sayfayı kapatmaz ve tarayıcı bağlantısı da kopmaz.
    // İşaretlenmezse worker ölü sayfayı sonsuza kadar okur ve kendi kendine
    // hiç kurtulmaz — fizibilite koşumunda gerçekten "Page crashed" görüldü.
    const source = sourceOf("src/screen-session.ts");
    expect(source).toMatch(/page\.on\(\s*["']crash["']/);
    expect(source).toMatch(/!this\.crashed/);
  });

  it("tarayıcı paylaşımlı bellek tükenmesine karşı sertleştirilmiş açılır", () => {
    // --disable-dev-shm-usage olmadan uzun headless koşumlarda sayfa çöküyor.
    // Worker ve fizibilite aracı AYNI argümanları kullanmalıdır; yoksa araç
    // pilotun gerçekte çalıştırdığı yapılandırmayı ölçmemiş olur.
    for (const source of [
      sourceOf("src/index.ts"),
      readFileSync(
        join(process.cwd(), "tools", "experimental", "sarraf-tv-kayseri", "feasibility.ts"),
        "utf8",
      ),
    ]) {
      expect(source).toMatch(/--disable-dev-shm-usage/);
      expect(source).toMatch(/--no-sandbox/);
    }
  });

  it("worker imajına Supabase anahtarı girmez", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8")
      .replace(/^\s*#.*$/gm, "");
    expect(dockerfile).not.toMatch(/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|service_role/);
  });
});

describe("5. platform sağlık kararı", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const base = {
    status: "ok" as const,
    lastErrorCode: null,
    startedAtMs: now - 3_600_000,
    intervalMs: 60_000,
  };

  it("yeni başarılı gözlem sağlıklıdır", () => {
    expect(healthyForPlatform({ ...base, lastSuccessAtMs: now - 30_000 }, now)).toBe(true);
  });

  it("uzun süredir gözlem üretmeyen worker SAĞLIKSIZDIR", () => {
    // "Süreç yaşıyor" yetmez; yoksa platform kurtarmayı hiç tetiklemez.
    expect(healthyForPlatform({ ...base, lastSuccessAtMs: now - 600_000 }, now)).toBe(false);
  });

  it("hiç başarı üretmemiş worker açılış payı dolunca sağlıksızdır", () => {
    expect(healthyForPlatform({ ...base, lastSuccessAtMs: null }, now)).toBe(false);
  });

  it("yeni açılmış worker açılış payı boyunca hoş görülür", () => {
    const booting = { ...base, lastSuccessAtMs: null, startedAtMs: now - 10_000 };
    expect(healthyForPlatform(booting, now)).toBe(true);
  });

  it("açılış payı en az 3 dakikadır", () => {
    const booting = { ...base, lastSuccessAtMs: null, startedAtMs: now - (HEALTH_GRACE_MS - 1_000) };
    expect(healthyForPlatform(booting, now)).toBe(true);
  });

  it("kirayı başka worker tutuyorsa yedek SAĞLIKLIDIR", () => {
    // Yedek worker yeniden başlatılmamalıdır; hatası yoktur, sırası yoktur.
    const standby = {
      ...base,
      status: "degraded" as const,
      lastErrorCode: "LEASE_NOT_HELD",
      lastSuccessAtMs: null,
    };
    expect(healthyForPlatform(standby, now)).toBe(true);
  });

  it("uygulamaya ulaşılamıyorsa sağlıksızdır (yedek sayılmaz)", () => {
    const unreachable = {
      ...base,
      status: "unavailable" as const,
      lastErrorCode: "APP_UNREACHABLE",
      lastSuccessAtMs: null,
    };
    expect(healthyForPlatform(unreachable, now)).toBe(false);
  });

  it("döngü hatası degraded yapsa bile yedek SAYILMAZ", () => {
    // Tarayıcı açılamıyorsa statü degraded olur; bu "sıra bekliyor" değildir.
    const failing = {
      ...base,
      status: "degraded" as const,
      lastErrorCode: "Error",
      lastSuccessAtMs: null,
    };
    expect(healthyForPlatform(failing, now)).toBe(false);
  });

  it("CAPTCHA nedeniyle bloke worker sağlıksızdır", () => {
    const blocked = { ...base, status: "blocked" as const, lastSuccessAtMs: now - 600_000 };
    expect(healthyForPlatform(blocked, now)).toBe(false);
  });

  it("durdurulmuş worker sağlıklı sayılmaz", () => {
    expect(healthyForPlatform({ ...base, status: "stopped" as const, lastSuccessAtMs: now }, now)).toBe(false);
  });

  it("uzun aralıklı worker'da eşik aralığa göre büyür", () => {
    // 10 dakikalık aralıkta 6 dakikalık sessizlik normaldir.
    const slow = { ...base, intervalMs: 600_000, lastSuccessAtMs: now - 360_000 };
    expect(healthyForPlatform(slow, now)).toBe(true);
  });
});
