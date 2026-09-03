/**
 * AĞ ÖZETİ TEMİZLEME
 *
 * Fizibilite aracı ağ trafiğini yalnızca "hangi kanaldan veri geliyor" sorusunu
 * yanıtlamak için gözler. Artefaktlara ASLA şunlar yazılmaz:
 *   - cookie, authorization başlığı, API anahtarı
 *   - sorgu dizesindeki jetonlar
 *   - yanıt gövdesi
 *   - kişisel veri
 *
 * Yalnızca host, şablonlanmış yol, HTTP yöntemi, kaynak türü ve durum kodu tutulur.
 */

/** Yoldaki değişken parçaları sabit yer tutucularla değiştirir. */
export function templatePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      if (/^\d+$/u.test(segment)) return "{n}";
      if (/^[0-9a-f]{8,}$/iu.test(segment)) return "{hex}";
      if (/^[A-Za-z0-9_-]{24,}$/u.test(segment)) return "{token}";
      return segment;
    })
    .join("/");
}

export interface SafeRequestSummary {
  host: string;
  pathTemplate: string;
  method: string;
  resourceType: string;
  /** Sorgu ANAHTARLARI (değerler değil) — hangi parametrelerin var olduğunu görmek için. */
  queryKeys: string[];
  status: number | null;
  contentType: string | null;
  count: number;
}

const SENSITIVE_QUERY_KEYS = /(token|key|secret|auth|session|sig|password|code)/iu;

/** Sorgu anahtarlarını güvenli hâle getirir: hassas adlar bile maskelenir. */
export function safeQueryKeys(search: string): string[] {
  const params = new URLSearchParams(search);
  const keys = new Set<string>();
  for (const key of params.keys()) {
    keys.add(SENSITIVE_QUERY_KEYS.test(key) ? `${key}:(maskelendi)` : key);
  }
  return [...keys].sort();
}

/** Tek bir isteği güvenli özete çevirir. */
export function summarizeRequest(
  rawUrl: string,
  method: string,
  resourceType: string,
  status: number | null,
  contentType: string | null,
): SafeRequestSummary | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // data:/blob: gibi şemalar özete girmez.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    host: url.host,
    pathTemplate: templatePath(url.pathname),
    method: method.toUpperCase(),
    resourceType,
    queryKeys: safeQueryKeys(url.search),
    status,
    contentType: contentType ? contentType.split(";")[0]!.trim() : null,
    count: 1,
  };
}

/** Aynı host+yol+yöntem kayıtlarını tek satırda toplar. */
export function mergeSummaries(items: readonly SafeRequestSummary[]): SafeRequestSummary[] {
  const map = new Map<string, SafeRequestSummary>();
  for (const item of items) {
    const key = `${item.method} ${item.host}${item.pathTemplate} ${item.resourceType} ${item.status ?? "-"}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      for (const queryKey of item.queryKeys) {
        if (!existing.queryKeys.includes(queryKey)) existing.queryKeys.push(queryKey);
      }
      continue;
    }
    map.set(key, { ...item, queryKeys: [...item.queryKeys] });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Bir metnin artefakta yazılmadan önce hassas iz taşıyıp taşımadığını denetler.
 * Fizibilite aracı her artefaktı yazmadan ÖNCE bu kontrolden geçirir.
 */
export const FORBIDDEN_ARTIFACT_PATTERNS: readonly { label: string; test: RegExp }[] = [
  { label: "cookie", test: /\bcookie\s*[:=]/iu },
  { label: "authorization", test: /\bauthorization\s*[:=]/iu },
  { label: "bearer token", test: /\bbearer\s+[A-Za-z0-9._-]{10,}/iu },
  { label: "api key", test: /\bapi[_-]?key\s*[:=]\s*\S/iu },
  { label: "set-cookie", test: /\bset-cookie\b/iu },
  { label: "jwt", test: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u },
];

/** Hassas iz bulunursa etiketlerini döndürür; boş dizi = temiz. */
export function findForbiddenTraces(content: string): string[] {
  return FORBIDDEN_ARTIFACT_PATTERNS.filter((pattern) => pattern.test.test(content)).map(
    (pattern) => pattern.label,
  );
}
