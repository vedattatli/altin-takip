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
  /**
   * TEK İSTİSNA: görünüm modu tercihi (basit/detaylı).
   *
   * Kural kaldırılmadı, DARALTILDI. Bu bir GÖRÜNÜM tercihidir; kimlik bilgisi
   * veya portföy verisi değildir. Aşağıdaki ikinci test o dosyanın gerçekten
   * yalnızca iki sabit değerden birini yazdığını ayrıca kanıtlar.
   */
  const VIEW_MODE_FILE = join("src", "state", "view-mode.tsx");

  it("localStorage veya sessionStorage kullanılmaz", () => {
    // Yorumlar ayıklanır: denetlenen şey kural metni değil, çalışan koddur.
    const offenders = SOURCE_FILES.filter(
      (file) => file !== VIEW_MODE_FILE && /\b(localStorage|sessionStorage)\b/.test(readCode(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("görünüm modu deposu yalnızca iki sabit değer tutar", () => {
    const code = readCode(VIEW_MODE_FILE);
    // Tek anahtar, tek tür değer.
    expect(code).toContain('const STORAGE_KEY = "altin-takip:gorunum-modu"');
    expect(code.match(/localStorage\.setItem\(/gu)).toHaveLength(1);
    expect(code).toContain("window.localStorage.setItem(STORAGE_KEY, mode)");
    // Kimlik bilgisi, oturum veya portföy verisi ADI BİLE geçmez.
    expect(code).not.toMatch(/token|password|parola|session|portfolio|portfoy|quantity|cost/i);
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

  it('"beni hatırla" ifadesi bulunmaz; tek tercih "oturumumu açık tut" kutusudur', () => {
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
      expect(source, file).not.toMatch(/zaman-asimi|SHARED_DEVICE_IDLE|DeviceGuard|beforeinstallprompt/);
    }
  });
});

describe("arayüz sözleşmesi: test kancaları DOM'a ulaşır", () => {
  it("data-testid verilen paylaşılan bileşen bunu DOM'a geçirir", () => {
    // JSX'te data-* nitelikleri fazlalık özellik denetiminden muaftır: karşılanmayan
    // bir prop sessizce DÜŞER ve test kancası hiç oluşmaz. Bu test o sessiz kaybı yakalar.
    const ui = read(join("src", "components", "ui.tsx"));
    const sources = SOURCE_FILES.filter((file) => file.endsWith(".tsx"));

    const used = new Set<string>();
    for (const file of sources) {
      const content = read(file);
      // [^<>] iç içe öğeye taşmayı engeller: bir prop içindeki <button data-testid>
      // dıştaki bileşene ait sayılmamalıdır.
      for (const match of content.matchAll(/<([A-Z][A-Za-z0-9]*)[^<>]*data-testid=/g)) {
        used.add(match[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(0);

    for (const component of used) {
      const marker = `export function ${component}(`;
      const at = ui.indexOf(marker);
      if (at < 0) continue; // ui.tsx dışında tanımlı bileşenler bu testin kapsamı değil.
      const next = ui.indexOf(`${String.fromCharCode(10)}export `, at + marker.length);
      const body = ui.slice(at, next < 0 ? ui.length : next);
      expect(body, `${component} data-testid'yi DOM'a geçirmelidir`).toContain("data-testid");
    }
  });
});

describe("E2E ortamı .env.local sızıntısına kapalıdır", () => {
  /**
   * Next.js `.env.local` dosyasını sunucu açılışında yükler ama zaten ayarlı
   * ortam değişkenlerini EZMEZ. Dolayısıyla `webServer.env` içinde AÇIKÇA
   * ayarlanmayan her değişken, geliştiricinin makinesindeki `.env.local`
   * değerini alır ve testlerin ölçtüğü davranışı sessizce değiştirir.
   *
   * Bu gerçekten yaşandı: `AUTH_SESSION_COOKIE` sızdı, sunucu çerezi başka
   * adla yazdı ve oturum çerezi testleri çerezi hiç bulamadı.
   */
  function envKeys(file: string): string[] {
    return readFileSync(join(process.cwd(), file), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")).trim());
  }

  it(".env.example içindeki HER değişken playwright.config.ts testEnv'inde sabitlenir", () => {
    const config = readFileSync(join(process.cwd(), "playwright.config.ts"), "utf8");
    const testEnvStart = config.indexOf("const testEnv = {");
    expect(testEnvStart).toBeGreaterThan(-1);
    const testEnvBlock = config.slice(testEnvStart, config.indexOf("};", testEnvStart));

    // Satır bazlı KESİN eşleme: template literal içinde `\s` kaçışı yutulduğu
    // için regex kurmak yerine anahtarın kendi satırında tanımlandığı aranır.
    const declared = new Set(
      testEnvBlock
        .split(/\r?\n/u)
        .map((line) => /^\s*([A-Z0-9_]+)\s*:/u.exec(line)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    const leaked = envKeys(".env.example").filter((key) => !declared.has(key));
    expect(leaked, `testEnv'de sabitlenmemiş değişkenler: ${leaked.join(", ")}`).toEqual([]);
  });

  it("E2E sunucusu her koşumda yeniden başlatılır", () => {
    // Sunucu yeniden kullanılırsa Playwright `env` bloğunu UYGULAMAZ ve bütün
    // takım sessizce yanlış yapılandırmayla koşar.
    const config = readFileSync(join(process.cwd(), "playwright.config.ts"), "utf8");
    expect(config).toMatch(/reuseExistingServer:\s*false/u);
  });

  it("E2E oturum çerezi adı testlerin aradığı adla aynıdır", () => {
    const config = readFileSync(join(process.cwd(), "playwright.config.ts"), "utf8");
    const spec = readFileSync(join(process.cwd(), "e2e", "session.spec.ts"), "utf8");
    const suffix = /SESSION_COOKIE_SUFFIX = "([^"]+)"/u.exec(spec)?.[1];
    expect(suffix).toBeTruthy();
    expect(config).toContain(`AUTH_SESSION_COOKIE: "${suffix}"`);
  });
});
