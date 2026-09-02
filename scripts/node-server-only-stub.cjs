/**
 * Node (tsx) betikleri için "server-only" paketini boş modüle eşler.
 *
 * "server-only" paketi Next.js dışında içe aktarıldığında bilerek hata fırlatır
 * (istemci bileşenlerine sunucu modülü sızmasını derleme zamanında engellemek
 * için). CLI betikleri (admin:create, admin:repair, accounting:verify) aynı
 * sunucu modüllerini Node içinde kullandığından bu koruma burada anlamsızdır;
 * yalnızca bu betiklerde etkisizleştirilir. Uygulama derlemesini ETKİLEMEZ.
 *
 * Kullanım: node -r ./scripts/node-server-only-stub.cjs --import tsx scripts/x.ts
 */
const Module = require("node:module");
const path = require("node:path");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithStub(request, ...rest) {
  if (request === "server-only") {
    return path.join(__dirname, "server-only-empty.cjs");
  }
  return originalResolve.call(this, request, ...rest);
};
