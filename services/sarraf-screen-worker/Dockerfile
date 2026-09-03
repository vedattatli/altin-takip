# =============================================================================
# Sarraf TV Kayseri ekran worker'ı — deneysel, özel pilot
#
# Resmî Playwright imajı kullanılır: Chromium ve Linux bağımlılıkları hazır
# gelir, sürüm uyuşmazlığı riski ortadan kalkar.
#
# Bu container SÜREKLİ çalışır. Vercel fonksiyonu içinde kalıcı Chromium
# çalıştırılamayacağı için worker ayrı bir servistir.
# =============================================================================
FROM mcr.microsoft.com/playwright:v1.56.0-noble

ENV NODE_ENV=production \
    PORT=8080 \
    OBSERVE_INTERVAL_MS=60000

WORKDIR /app

# Yalnızca worker'ın ihtiyaç duyduğu kaynaklar kopyalanır; uygulama bütünü değil.
COPY services/sarraf-screen-worker/package.json ./services/sarraf-screen-worker/package.json
COPY services/sarraf-screen-worker/src ./services/sarraf-screen-worker/src
COPY tools/experimental/sarraf-tv-kayseri ./tools/experimental/sarraf-tv-kayseri
COPY src/prices/providers/sarraf-tv-screen-mapping.ts ./src/prices/providers/sarraf-tv-screen-mapping.ts

# /app kökünde bir package.json BULUNMALIDIR. Yoksa Node, worker'ın dışındaki
# .ts dosyalarını (tools/, src/) CommonJS sayar ve "does not provide an export
# named ..." hatasıyla ESM içe aktarmaları kırılır. Depo kökünde bu çözümlemeyi
# yapan bir package.json zaten var; imajda karşılığını açıkça oluşturuyoruz.
RUN echo '{ "name": "altin-takip-worker-root", "private": true, "type": "module" }' > /app/package.json

# tsx yalnızca TypeScript'i çalışma anında çözmek için; playwright-core imajdaki
# tarayıcıyı kullanır (ayrı indirme yapılmaz).
RUN npm install --no-save --omit=dev tsx@4.21.1 playwright-core@1.56.0

# Root dışı kullanıcı: imaj `pwuser` ile gelir.
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8080

# Healthcheck: worker canlı gözlem üretemiyorsa 503 döner ve platform yeniden başlatır.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "services/sarraf-screen-worker/src/index.ts"]
