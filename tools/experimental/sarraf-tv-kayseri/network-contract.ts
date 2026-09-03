/**
 * DOĞAL TARAYICI OTURUMUNDAKİ YANITLARIN GÜVENLİ ŞEMA ÖZETİ
 *
 * Sayfa açılırken tarayıcının KENDİ yüklediği yanıtlar gözlenir. Bu uçlar
 * tarayıcı dışında bağımsız API gibi ÇAĞRILMAZ, tekrar oynatılmaz ve
 * kaydedilmez.
 *
 * Gözlemde hassas veri bulunduğu ÖLÇÜLDÜ: `/pricetv` yanıtı bir JWT ve ekran
 * parolası taşıyor. Bu yüzden özetleyici "önce reddet" mantığıyla çalışır:
 *   - Değerler VARSAYILAN OLARAK yazılmaz; yalnızca alan ADI ve TÜRÜ tutulur.
 *   - Değer örneği yalnızca açık bir izin listesindeki alanlar için ve yalnızca
 *     ekranda zaten görünen fiyat/başlık verisi için yazılır.
 *   - Hassas görünen her alan adı REDACTED işaretlenir.
 *   - Jeton benzeri her dize (uzun base64/JWT) izin listesinde olsa bile atılır.
 */

/** Adı hassas olan alanlar: değeri hiçbir koşulda yazılmaz. */
const SENSITIVE_FIELD = /(token|secret|password|pass|auth|cookie|session|key|id$|_id$|Id$|jwt|signature|sig|file|logo|url|link|drive)/iu;

/** Değer örneği yazılabilecek alanlar (ekranda zaten görünen veri). */
const SAFE_VALUE_FIELDS = new Set([
  "title",
  "short",
  "code",
  "buying",
  "sales",
  "selling",
  "order",
  "unitName",
  "unit",
  "quantity",
  "milyem",
  "noDecimal",
  "onlyBuying",
  "onlySalable",
  "isFavorite",
  "isFooter",
  "isManual",
  "status",
  "updatedAt",
  "dateDay",
  "category",
  "channel",
  "slug",
]);

const TOKEN_LIKE = /^[A-Za-z0-9._-]{24,}$/u;

export type SchemaType = "string" | "number" | "boolean" | "null" | "array" | "object" | "unknown";

export interface FieldSummary {
  name: string;
  type: SchemaType;
  /** Değer örneği yalnızca güvenli alanlarda ve jeton benzeri değilse yazılır. */
  sample?: string | number | boolean | null;
  redacted?: true;
}

export interface SchemaSummary {
  type: SchemaType;
  /** Dizi ise eleman sayısı. */
  length?: number;
  fields?: FieldSummary[];
  /** İç içe dizi elemanının şeması. */
  item?: SchemaSummary;
}

function typeOf(value: unknown): SchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

/** Bir alanın değeri artefakta yazılabilir mi? */
export function valueIsSafe(name: string, value: unknown): boolean {
  if (SENSITIVE_FIELD.test(name)) return false;
  if (!SAFE_VALUE_FIELDS.has(name)) return false;
  if (typeof value === "string") {
    if (value.length > 64) return false;
    if (TOKEN_LIKE.test(value)) return false;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
}

function summarizeObject(value: Record<string, unknown>): FieldSummary[] {
  return Object.keys(value)
    .sort()
    .map((name) => {
      const raw = value[name];
      const field: FieldSummary = { name, type: typeOf(raw) };
      if (valueIsSafe(name, raw)) {
        field.sample = raw as string | number | boolean | null;
      } else if (SENSITIVE_FIELD.test(name)) {
        field.redacted = true;
      }
      return field;
    });
}

/** Yanıt gövdesinin güvenli şema özeti. Değerler varsayılan olarak yazılmaz. */
export function summarizeSchema(value: unknown, depth = 0): SchemaSummary {
  const type = typeOf(value);
  if (depth > 3) return { type };
  if (type === "array") {
    const array = value as unknown[];
    return {
      type,
      length: array.length,
      item: array.length > 0 ? summarizeSchema(array[0], depth + 1) : undefined,
    };
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const fields = summarizeObject(record);
    // "result" gibi sarmalayıcıların içi de özetlenir.
    const nested = record.result;
    if (nested !== undefined) {
      return { type, fields, item: summarizeSchema(nested, depth + 1) };
    }
    return { type, fields };
  }
  return { type };
}

/** Ekran fiyat listesinden çıkarılan güvenli satır. */
export interface NetworkPriceRow {
  title: string;
  buying: number;
  sales: number;
  order: number;
  isFavorite: boolean;
  isFooter: boolean;
  /** Kaynak bu satırı tek yönlü (yalnız satılabilir) işaretliyor mu? */
  onlySalable: boolean;
  onlyBuying: boolean;
  noDecimal: boolean;
  quantity: number;
  updatedAt: string | null;
}

/**
 * Satır çift yönlü bir fiyat mı bildiriyor?
 *
 * `buying === sales` olan satırlar ekranda TEK bir sayı olarak görünür ve
 * kaynak onları `onlySalable` gibi tek yönlü bayraklarla işaretler. Böyle bir
 * değeri hem bozdurma hem yeniden alım fiyatı saymak, sıfır makaslı bir alım
 * satım iddiası olurdu. Bu yüzden çift yönlü sayılmazlar.
 */
export function isTwoSidedRow(row: NetworkPriceRow): boolean {
  return row.buying !== row.sales;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * `price/list` yanıtından güvenli fiyat satırlarını çıkarır.
 *
 * ÖNEMLİ: `buying` ve `sales` AYRI ALAN ADLARIDIR. Yön bu adlardan bilinir;
 * sıraya, renge veya sütun konumuna bakılmaz. Kimlik alanları okunmaz.
 */
export function extractNetworkPriceRows(body: unknown): NetworkPriceRow[] {
  if (typeof body !== "object" || body === null) return [];
  const result = (body as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];
  const rows: NetworkPriceRow[] = [];
  for (const raw of result) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const buying = asNumber(record.buying);
    const sales = asNumber(record.sales);
    if (title === "" || buying === null || sales === null) continue;
    rows.push({
      title,
      buying,
      sales,
      order: asNumber(record.order) ?? 0,
      isFavorite: record.isFavorite === true,
      isFooter: record.isFooter === true,
      onlySalable: record.onlySalable === true,
      onlyBuying: record.onlyBuying === true,
      noDecimal: record.noDecimal === true,
      quantity: asNumber(record.quantity) ?? 1,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    });
  }
  return rows.sort((a, b) => a.order - b.order);
}

/** Şema özetinde belirli bir alan adı var mı? */
export function schemaHasField(summary: SchemaSummary, name: string): boolean {
  if (summary.fields?.some((field) => field.name === name)) return true;
  if (summary.item) return schemaHasField(summary.item, name);
  return false;
}

/** Sözleşme sorularının yanıtları (rapora yazılır). */
export interface ContractAnswers {
  feedsPriceTable: string | null;
  hasProductTitle: boolean;
  hasSeparateBuySell: boolean;
  hasNewOldDistinction: boolean;
  ataResatSeparated: boolean;
  singlePriceDirectionKnown: boolean;
  hasUpstreamTimestamp: boolean;
  currencyExplicit: boolean;
}
