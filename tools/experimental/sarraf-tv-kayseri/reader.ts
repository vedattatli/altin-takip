/**
 * SAYFA İÇİ EKRAN OKUYUCU (string olarak enjekte edilir)
 *
 * Neden yalnız DOM sırasına güvenilmez:
 *   Ekranda iki ayrı bölge var. Üstte tek fiyatlı "favori" kartları (HAS, 22/14/8
 *   AYAR), altta ALIŞ/SATIŞ başlıklı iki sütunlu tablo. Düz bir yaprak-düğüm
 *   sırası okuması, üstteki tek fiyatı yanlışlıkla bir sütuna bağlayabilir:
 *   ölçtüğümüz düzende "8 AYAR" fiyatının yatay merkezi ALIŞ sütununun merkeziyle
 *   neredeyse birebir çakışıyor. Bu yüzden yön ataması İKİ koşula bağlanır:
 *
 *     1. DÜŞEY: hücre, ALIŞ/SATIŞ başlıklarının ALTINDA olmalı.
 *     2. YATAY: hücrenin merkezi ilgili başlığın sütun aralığına düşmeli.
 *
 *   Ayrıca her fiyat, kendi SATIR KABI içinde çözülür; ürün etiketi ile fiyatın
 *   aynı satıra ait olduğu kap üzerinden doğrulanır. Sıra numarasına, renk
 *   sınıfına veya "ikinci sayı satıştır" varsayımına güvenilmez.
 *
 * Görünmeyen düğümler (display:none, görünürlük kapalı, sıfır alan) ve mobil/masaüstü
 * kopyaları elenir; aynı satırda ikiden fazla fiyat bulunursa satır belirsiz sayılır.
 */
export const READ_SCREEN_SCRIPT = String.raw`(() => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const upper = (s) => norm(s).toLocaleUpperCase("tr-TR");

  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    return true;
  }

  const NUMBER_ONLY = /^[0-9][0-9.,]*$/;

  function isMoneyLeaf(el) {
    if (el.children.length !== 0) return false;
    const text = norm(el.textContent);
    if (!text) return false;
    const cls = (el.className || "").toString();
    if (cls.indexOf("font-money") >= 0) return true;
    return NUMBER_ONLY.test(text);
  }

  const leaves = Array.from(document.querySelectorAll("body *")).filter(
    (el) => el.children.length === 0 && norm(el.textContent) !== "",
  );

  // --- Başlıklar ve sütun geometrisi ---
  const headerCells = [];
  for (const el of leaves) {
    const text = upper(el.textContent);
    if (text !== "ALIŞ" && text !== "SATIŞ") continue;
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    headerCells.push({
      kind: text === "ALIŞ" ? "buy" : "sell",
      label: norm(el.textContent),
      top: rect.top,
      bottom: rect.bottom,
      center: rect.left + rect.width / 2,
      width: rect.width,
    });
  }
  const headerTop = headerCells.length > 0 ? Math.min.apply(null, headerCells.map((h) => h.top)) : null;

  // --- Fiyat düğümleri ve satır kapları ---
  const moneyLeaves = leaves.filter((el) => isMoneyLeaf(el) && visible(el));

  function labelOf(container, moneyEls) {
    const moneySet = new Set(moneyEls);
    const parts = [];
    for (const el of container.querySelectorAll("*")) {
      if (el.children.length !== 0) continue;
      if (moneySet.has(el)) continue;
      if (!visible(el)) continue;
      const text = norm(el.textContent);
      if (!text) continue;
      if (NUMBER_ONLY.test(text)) continue;
      parts.push(text);
    }
    return parts.join(" ").trim();
  }

  /** Bir fiyat düğümü için, etiketi de barındıran EN YAKIN kabı bulur. */
  function rowContainerFor(el) {
    let cur = el.parentElement;
    for (let depth = 0; depth < 6 && cur; depth += 1) {
      const money = Array.from(cur.querySelectorAll("*")).filter((c) => isMoneyLeaf(c) && visible(c));
      const label = labelOf(cur, money);
      if (label !== "" && money.length >= 1 && money.length <= 2) return { container: cur, label: label, money: money };
      cur = cur.parentElement;
    }
    return null;
  }

  const rowMap = new Map();
  for (const el of moneyLeaves) {
    const found = rowContainerFor(el);
    if (!found) continue;
    if (rowMap.has(found.container)) continue;
    rowMap.set(found.container, found);
  }

  const rows = [];
  for (const entry of rowMap.values()) {
    const cells = entry.money.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: norm(el.textContent),
        top: rect.top,
        center: rect.left + rect.width / 2,
      };
    });
    if (cells.length === 0) continue;

    const rowTop = Math.min.apply(null, cells.map((c) => c.top));
    const belowHeaders = headerTop !== null && rowTop > headerTop;

    const assigned = {};
    let directionResolved = false;
    if (belowHeaders && headerCells.length >= 2 && cells.length === 2) {
      // Her hücre, merkezi en yakın olan başlığa atanır; iki hücre AYNI başlığa
      // düşerse yön belirsizdir ve satır atlanır.
      const picks = cells.map((cell) => {
        let best = null;
        let bestDistance = Infinity;
        for (const header of headerCells) {
          const distance = Math.abs(header.center - cell.center);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = header;
          }
        }
        return { cell: cell, header: best, distance: bestDistance };
      });
      const kinds = picks.map((p) => (p.header ? p.header.kind : null));
      const withinColumn = picks.every((p) => p.header !== null && p.distance <= Math.max(60, p.header.width));
      if (withinColumn && kinds.indexOf("buy") >= 0 && kinds.indexOf("sell") >= 0) {
        for (const pick of picks) assigned[pick.header.label] = pick.cell.text;
        directionResolved = true;
      }
    }
    if (!directionResolved) {
      // Yön doğrulanamadı: hücreler başlıksız yazılır, çıkarıcı satırı atlar.
      for (let index = 0; index < cells.length; index += 1) {
        assigned["TEK_SUTUN" + (index === 0 ? "" : "_" + String(index + 1))] = cells[index].text;
      }
    }

    rows.push({
      label: entry.label,
      cells: assigned,
      directionResolved: directionResolved,
      top: Math.round(rowTop),
      cellCount: cells.length,
    });
  }

  rows.sort((a, b) => a.top - b.top);

  // --- Yapısal imza ---
  const signatureParts = [
    "headers:" + headerCells.map((h) => h.kind).sort().join(","),
    "rows:" + rows.length,
    "directional:" + rows.filter((r) => r.directionResolved).length,
  ];
  const signature = signatureParts.join("|");

  return {
    rows: rows,
    headers: headerCells.map((h) => h.label),
    headerTop: headerTop,
    signature: signature,
    canvasCount: document.querySelectorAll("canvas").length,
    bodyText: norm(document.body.innerText || document.body.textContent).slice(0, 4000),
    hiddenMoneyCount: Array.from(document.querySelectorAll("body *")).filter(
      (el) => el.children.length === 0 && NUMBER_ONLY.test(norm(el.textContent)) && !visible(el),
    ).length,
  };
})()`;
