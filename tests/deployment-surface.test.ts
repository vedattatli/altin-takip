import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Dağıtım yüzeyi denetimleri.
 *
 * Uygulama şirket bilgisayarlarında HİÇBİR yerel program kurulmadan
 * kullanılabilmelidir. Bu testler depoya kurulum gerektiren bir bileşenin
 * sızmadığını ve ortak cihaz kurallarının kodda korunduğunu doğrular.
 */

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".data", "test-results", "playwright-report"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const REPO_FILES = walk(".");
const SOURCE_FILES = REPO_FILES.filter((file) => /\.(ts|tsx)$/.test(file) && file.startsWith("src"));
const read = (file: string) => readFileSync(file, "utf8");

/** Yorumları ayıklar; denetimler yalnızca çalışan koda bakar. */
const readCode = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("yerel kurulum gerektiren bileşen yoktur", () => {
  it("çalıştırılabilir veya kurulum dosyası bulunmaz", () => {
    const installers = REPO_FILES.filter((file) =>
      /\.(exe|msi|bat|cmd|ps1|dmg|pkg|appx|msix|deb|rpm)$/i.test(file),
    );
    expect(installers).toEqual([]);
  });

  it("tarayıcı eklentisi veya yerel yardımcı yapılandırması bulunmaz", () => {
    const extensionArtifacts = REPO_FILES.filter((file) =>
      /(^|[\\/])(manifest\.json|native-host\.json|background\.js|content-script\.js)$/i.test(file),
    );
    expect(extensionArtifacts).toEqual([]);

    for (const file of SOURCE_FILES) {
      expect(read(file), file).not.toMatch(/chrome\.runtime|browser\.runtime|nativeMessaging/);
    }
  });

  it("uygulama Electron veya benzeri bir kabuk kullanmaz", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(all)) {
      expect(name).not.toMatch(/electron|tauri|nw\.js|node-webkit/i);
    }
  });
});

describe("PWA kurulumu isteğe bağlıdır", () => {
  it("hiçbir özellik standalone görüntüleme moduna bağlı değildir", () => {
    for (const file of SOURCE_FILES) {
      expect(read(file), file).not.toMatch(/display-mode:\s*standalone/);
    }
  });

  it("kurulum çağrısı hiçbir yerde tetiklenmez", () => {
    for (const file of SOURCE_FILES) {
      // beforeinstallprompt yalnızca BASTIRMAK için kullanılabilir (prompt() çağrılmaz).
      expect(read(file), file).not.toMatch(/\.prompt\(\)/);
    }
  });

  it("servis çalışanı yalnızca üretim derlemesinde kaydedilir; cihaz türüne bakmaz", () => {
    const registrar = read(join("src", "components", "service-worker-registrar.tsx"));
    expect(registrar).toContain('process.env.NODE_ENV !== "production"');
    expect(registrar).not.toMatch(/deviceMode|shared|personal/);
  });
});

describe("cihaz izinleri istenmez", () => {
  it("bildirim, push, konum veya kamera izni talep edilmez", () => {
    for (const file of SOURCE_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/Notification\.requestPermission/);
      expect(source, file).not.toMatch(/pushManager|PushSubscription/);
      expect(source, file).not.toMatch(/navigator\.geolocation/);
      expect(source, file).not.toMatch(/getUserMedia/);
    }
  });
});

describe("kimlik bilgisi ve portföy verisi tarayıcı deposuna yazılmaz", () => {
  it("localStorage veya sessionStorage kullanılmaz", () => {
    // Yorumlar ayıklanır: denetlenen şey kural metni değil, çalışan koddur.
    const offenders = SOURCE_FILES.filter((file) =>
      /\b(localStorage|sessionStorage)\b/.test(readCode(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("IndexedDB yalnızca geliştirme demo deposunda kullanılır", () => {
    const users = SOURCE_FILES.filter((file) => /\bindexedDB\b/.test(read(file)));
    expect(users.sort()).toEqual(
      [
        join("src", "storage", "index.ts"),
        join("src", "storage", "indexeddb-repository.ts"),
      ].sort(),
    );
  });

  it("oturum açmış kullanıcının verisi sunucu deposunda tutulur", () => {
    const storage = read(join("src", "storage", "index.ts"));
    expect(storage).toMatch(/if \(mode === "account"\) return new ServerPortfolioRepository\(\);/);

    const serverRepo = read(join("src", "storage", "server-repository.ts"));
    expect(serverRepo).toMatch(/syncsAcrossDevices = true/);
    expect(serverRepo).not.toMatch(/localStorage|indexedDB/);
  });

  it("oturum jetonu yalnızca HttpOnly çerezde tutulur", () => {
    const cookies = read(join("src", "server", "auth", "cookies.ts"));
    expect(cookies).toMatch(/httpOnly: true/);
    expect(cookies).toMatch(/sameSite: "lax"/);

    // İstemci kodunda çerez okuma girişimi olmamalıdır.
    for (const file of SOURCE_FILES.filter((f) => /^"use client"/m.test(read(f)))) {
      expect(read(file), file).not.toMatch(/document\.cookie/);
    }
  });
});

describe("servis çalışanı hassas yanıtları önbelleğe almaz", () => {
  const sw = read(join("public", "sw.js"));

  it("API yanıtları önbelleğe alınmaz", () => {
    expect(sw).toMatch(/if \(url\.pathname\.startsWith\("\/api\/"\)\) return;/);
  });

  it("kimliği doğrulanmış sayfa yanıtları önbelleğe yazılmaz", () => {
    const navigationBlock = sw.slice(sw.indexOf('request.mode === "navigate"'));
    const beforeStatic = navigationBlock.slice(0, navigationBlock.indexOf("_next/static"));
    expect(beforeStatic).not.toMatch(/cache\.put|caches\.open/);
  });

  it("çevrimdışında yalnızca statik bilgi sayfası gösterilir", () => {
    expect(sw).toMatch(/caches\.match\(OFFLINE_URL\)/);
  });
});

describe("giriş ekranı: tek ve kalıcı oturum modeli", () => {
  const form = readCode(join("src", "app", "giris", "login-form.tsx"));

  it("cihaz türü seçimi SUNMAZ", () => {
    expect(form).not.toContain("Şirket / ortak cihaz");
    expect(form).not.toContain("Kişisel cihaz");
    expect(form).not.toMatch(/deviceMode/);
  });

  it('"beni hatırla" seçeneği bulunmaz (oturum zaten kalıcıdır)', () => {
    expect(form).not.toMatch(/beni hatırla/i);
    expect(form).not.toMatch(/rememberMe|remember_me/);
  });

  it("sunucu istemciden cihaz türü okumaz", () => {
    const route = readCode(join("src", "app", "api", "auth", "login", "route.ts"));
    expect(route).not.toMatch(/deviceMode/);
  });

  it("istemcide hareketsizlik sayacı veya otomatik çıkış yoktur", () => {
    for (const file of SOURCE_FILES) {
      const source = readCode(file);
      expect(source, file).not.toMatch(/zaman-asimi|IDLE_TIMEOUT|idleTimeoutMs|DeviceGuard/);
    }
  });
});
