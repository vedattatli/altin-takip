import { beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_TOUCH_INTERVAL_MS,
  SHARED_DEVICE_ABSOLUTE_LIFETIME_MS,
  SHARED_DEVICE_IDLE_TIMEOUT_MS,
  sessionPolicyFor,
} from "@/auth/types";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService } from "@/server/auth/service";
import { MemoryLoginRateLimiter } from "@/server/rate-limit/memory";

/**
 * SUNUCU TARAFI OTURUM SÜRESİ.
 *
 * İstemcideki 15 dakikalık sayaç yalnızca kullanıcı deneyimi içindir.
 * Gerçek sınır burada test edilir: arka uç hem hareketsizlik hem mutlak
 * süreyi kontrol eder ve süresi geçen oturumu siler.
 */

const PASSWORD = "Kuyumcu7Defter";
const START = Date.parse("2026-03-01T09:00:00.000Z");

let clock = START;
let backend: LocalAuthBackend;
let service: AuthService;

function advance(ms: number) {
  clock += ms;
}

beforeEach(async () => {
  clock = START;
  backend = new LocalAuthBackend({ inMemory: true, now: () => clock });
  service = new AuthService(backend, {
    rateLimiter: new MemoryLoginRateLimiter("test-pepper"),
    now: () => clock,
  });

  const user = await backend.createUser({
    username: "ayse",
    displayName: "Ayşe Kullanıcı",
    temporaryPassword: PASSWORD,
    role: "user",
  });
  await backend.setMustChangePassword(user.id, false);
});

describe("ortak cihaz: hareketsizlik zaman aşımı", () => {
  it("15 dakikadan kısa hareketsizlikte oturum yaşar", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");

    advance(SHARED_DEVICE_IDLE_TIMEOUT_MS - 1000);
    expect(await service.resolveSession(token)).not.toBeNull();
  });

  it("15 dakika hareketsizlikte sunucu oturumu reddeder", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");

    advance(SHARED_DEVICE_IDLE_TIMEOUT_MS + 1000);
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("süresi geçen oturum kaydı silinir", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");
    advance(SHARED_DEVICE_IDLE_TIMEOUT_MS + 1000);

    await service.resolveSession(token);
    // Aynı jeton bir daha da çalışmaz (kayıt gerçekten silinmiştir).
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("hareket oldukça pencere ileri alınır", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");

    // 14 dakikada bir istek: oturum sonsuza dek yaşamamalı ama düşmemeli de.
    for (let round = 0; round < 5; round += 1) {
      advance(14 * 60 * 1000);
      expect(await service.resolveSession(token), `tur ${round}`).not.toBeNull();
    }
  });

  it("askıya alınmış sekme: uzun aradan sonra oturum düşer", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");

    // Dizüstü kapağı kapandı, sekme askıya alındı; istemci sayacı çalışmadı.
    advance(3 * 60 * 60 * 1000);
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("tarayıcı yeniden açılsa bile sunucu süresi geçmiş oturumu kabul etmez", async () => {
    // Çerez bir şekilde geri yüklense bile sunucu reddeder.
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");
    advance(SHARED_DEVICE_IDLE_TIMEOUT_MS + 60_000);
    expect(await service.resolveSession(token)).toBeNull();
  });
});

describe("ortak cihaz: mutlak süre", () => {
  it("sürekli hareket olsa bile 8 saatte oturum sona erer", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");

    // Her 10 dakikada bir istek yapılır; hareketsizlik hiç dolmaz.
    let elapsed = 0;
    let alive = true;
    while (elapsed < SHARED_DEVICE_ABSOLUTE_LIFETIME_MS + 20 * 60 * 1000 && alive) {
      advance(10 * 60 * 1000);
      elapsed += 10 * 60 * 1000;
      alive = (await service.resolveSession(token)) !== null;
    }

    expect(alive).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(SHARED_DEVICE_ABSOLUTE_LIFETIME_MS);
  });
});

describe("kişisel cihaz", () => {
  it("hareketsizlik sınırı yoktur", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "personal");

    advance(3 * 24 * 60 * 60 * 1000);
    expect(await service.resolveSession(token)).not.toBeNull();
  });

  it("mutlak süre yine de uygulanır", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "personal");

    advance(sessionPolicyFor("personal").absoluteLifetimeMs + 1000);
    expect(await service.resolveSession(token)).toBeNull();
  });
});

describe("last_seen_at yazma sıklığı", () => {
  it("her istekte veritabanına yazılmaz", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "shared");

    let touches = 0;
    const original = backend.touchSession.bind(backend);
    backend.touchSession = async (...args) => {
      touches += 1;
      return original(...args);
    };

    // Aynı saniye içinde 5 istek: tazeleme yapılmamalı.
    for (let index = 0; index < 5; index += 1) {
      await service.resolveSession(token);
    }
    expect(touches).toBe(0);

    // Eşik geçildiğinde tek bir tazeleme yapılır.
    advance(SESSION_TOUCH_INTERVAL_MS + 1000);
    await service.resolveSession(token);
    expect(touches).toBe(1);

    backend.touchSession = original;
  });
});

describe("süresi geçmiş oturumların temizlenmesi", () => {
  it("purgeExpiredSessions süresi dolanları siler", async () => {
    const shared = await service.login("ayse", PASSWORD, "10.0.0.1", "shared");
    const personal = await service.login("ayse", PASSWORD, "10.0.0.2", "personal");

    advance(SHARED_DEVICE_IDLE_TIMEOUT_MS + 1000);
    const removed = await service.purgeExpiredSessions();

    expect(removed).toBe(1);
    expect(await service.resolveSession(shared.token)).toBeNull();
    expect(await service.resolveSession(personal.token)).not.toBeNull();
  });
});
