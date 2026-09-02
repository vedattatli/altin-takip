/**
 * Merkezi ürün yapılandırması.
 *
 * Uygulamanın adı, sloganı ve marka renkleri BU dosyadan yönetilir.
 * Başka hiçbir dosyada ürün adı sabit (hard-coded) yazılmamalıdır.
 */

export const appConfig = {
  /** Ürün adı. Değiştirmek için yalnızca burayı düzenleyin. */
  name: "Altın Takip",
  /** PWA kısa adı (ana ekran simgesi altında görünür, 12 karakteri aşmamalı). */
  shortName: "Altın Takip",
  /** Tek cümlelik ürün tanımı. */
  tagline: "Altın portföyünüzü tek yerden takip edin",
  description:
    "Altın portföyünüzü kaydedin, maliyetinizi görün, bozdurma ve yeniden alım değerinizi tek ekranda takip edin.",
  locale: "tr-TR",
  currency: "TRY",
  /** Uygulama sürümü — sürüm notlarında ve ayarlar ekranında gösterilir. */
  version: "0.1.0",
  /** PWA tema renkleri. globals.css içindeki değerlerle uyumlu tutun. */
  theme: {
    color: "#0d1117",
    background: "#0d1117",
  },
} as const;

export type AppConfig = typeof appConfig;
