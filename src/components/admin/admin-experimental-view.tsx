"use client";

import { useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { Alert, Card, cx, SectionTitle } from "../ui";

/**
 * Yönetici — Deneysel Kayseri Ekran Kaynağı (özel pilot).
 *
 * Bu ekran üç işi yapar:
 *  1. Kalıcı tarayıcı worker'ının kira ve heartbeat durumunu gösterir.
 *  2. Hangi kullanıcının deneysel kaynağı kullanabileceğini belirler.
 *  3. Ekran etiketi ↔ ürün eşlemelerini kanıtıyla onaylar.
 *
 * Onaysız (CONVENTION) eşleme portföy değerlemesine ve MARKET_BASELINE'a GİRMEZ.
 */

export interface WorkerStateView {
  workerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  active: boolean;
}

export interface AccessRow {
  username: string;
  displayName: string;
  portfolioId: string;
  enabled: boolean;
  approvedAt: string;
  expiresAt: string | null;
  reason: string;
}

export interface ApprovalRow {
  rawLabel: string;
  canonicalProductId: string;
  confidence: string;
  mappingVersion: string;
  evidenceLiquidation: string | null;
  evidenceReplacement: string | null;
  evidenceObservedAt: string | null;
  approvedBy: string | null;
  approvedAt: string;
  /**
   * Bu onay DEĞERLEMEDE geçerli mi? Kararı sunucu verir
   * (`approvalAppliesToCurrentMapping`); ekran kendi başına sürüm
   * karşılaştırmaz, yoksa fiyat yolundan sapar.
   */
  appliesToCurrentMapping: boolean;
}

export interface UserOption {
  id: string;
  username: string;
  displayName: string;
}

export interface ProductOption {
  id: string;
  name: string;
}

export function AdminExperimentalView({
  initialWorker,
  initialAccess,
  initialApprovals,
  users,
  products,
  mappingVersion,
  enabledInEnvironment,
}: {
  initialWorker: WorkerStateView | null;
  initialAccess: AccessRow[];
  initialApprovals: ApprovalRow[];
  users: UserOption[];
  products: ProductOption[];
  mappingVersion: string;
  enabledInEnvironment: boolean;
}) {
  const [worker, setWorker] = useState(initialWorker);
  const [access, setAccess] = useState(initialAccess);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [label, setLabel] = useState("");
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [liquidation, setLiquidation] = useState("");
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Geçersiz onaylar: fiyat yolu bunları saymıyor. Karar sunucudan gelir
   * (`appliesToCurrentMapping`); bu ekran sürümü kendi başına karşılaştırmaz,
   * yoksa hesapla ekran birbirinden sapar — ki tam olarak bu yaşandı:
   * yönetici yeşil "onaylı" görürken ürün fiyatsız kalıyordu.
   */
  const staleApprovals = approvals.filter((row) => row.appliesToCurrentMapping === false);

  async function reload() {
    const [state, list] = await Promise.all([
      apiFetch<{ access: AccessRow[]; worker: WorkerStateView | null }>("/api/admin/price-sources/experimental"),
      apiFetch<ApprovalRow[]>("/api/admin/price-sources/mappings"),
    ]);
    setAccess(state.access);
    setWorker(state.worker);
    setApprovals(list);
  }

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "İşlem tamamlanamadı.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="admin-experimental">
      <SectionTitle
        title="Deneysel Kayseri Ekran Kaynağı"
        description="Sarraf TV Kayseri ekran gözlemi. Resmî API değildir, lisanslı veri değildir; yalnızca izin verilen portföylerde kullanılır."
      />

      {!enabledInEnvironment ? (
        <Alert tone="notice">
          Bu ortamda deneysel kaynak kapalıdır. Açmak için sunucuda
          <code className="mx-1">PRICE_EXPERIMENTAL_SARRAF_SCREEN=true</code>
          gerekir; gerçek üretim dağıtımında bu bayrak yok sayılır.
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card className="p-4" data-testid="worker-state">
        <p className="text-sm font-semibold text-ink">Tarayıcı worker durumu</p>
        {worker ? (
          <dl className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
            <div>
              Worker: <span className="text-ink">{worker.workerId}</span>
            </div>
            <div>
              Durum:{" "}
              <span className={worker.active ? "text-positive" : "text-[var(--notice)]"}>
                {worker.active ? "Kira aktif" : "Kira süresi doldu"}
              </span>
            </div>
            <div>Son heartbeat: {formatDateTime(worker.heartbeatAt)}</div>
            <div>Kira bitişi: {formatDateTime(worker.expiresAt)}</div>
          </dl>
        ) : (
          <p className="mt-1 text-xs text-muted">
            Henüz hiçbir worker kira almadı. Fiyat gelmiyorsa worker çalışmıyor demektir.
          </p>
        )}
      </Card>

      <Card className="p-4" data-testid="experimental-access">
        <p className="text-sm font-semibold text-ink">Kullanıcı izin listesi</p>
        <p className="mt-1 break-words text-xs text-muted">
          Kullanıcı bu kaynağı kendi kendine açamaz. İzin kaldırılırsa başka kaynağa geçilmez;
          değerleme boş kalır.
        </p>
        <p className="mt-1 break-words text-xs text-muted">
          <span className="font-medium text-ink">İzin, değerleme planının ÜÇ kaynağı için birden verilir:</span>{" "}
          Kayseri ekranı, Kapalıçarşı tablosu ve Türkiye geneli. Hibrit değerleme üçünü birlikte
          kullanır; yalnız birine izin verilirse portföyün bir kısmı fiyatsız kalır ve uygulama
          bozuk görünür.
        </p>
        <div className="mt-3 flex w-full flex-wrap items-end gap-2">
          <label className="text-xs text-subtle">
            Kullanıcı
            <select
              className="control mt-1 min-h-11 w-full min-w-48"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              data-testid="experimental-user"
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.username}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-subtle">
            Gerekçe
            <input
              className="control mt-1 min-h-11 w-full min-w-48"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="kapalı pilot"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary min-h-11"
            disabled={busy || userId === ""}
            data-testid="grant-access"
            onClick={() =>
              void run(async () => {
                await apiFetch("/api/admin/price-sources/experimental", {
                  method: "PUT",
                  body: JSON.stringify({ userId, enabled: true, reason }),
                });
                return "Deneysel kaynak erişimi açıldı.";
              })
            }
          >
            Erişim ver
          </button>
        </div>

        {access.length === 0 ? (
          <p className="mt-3 text-xs text-subtle">Henüz izin verilmiş kullanıcı yok.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {access.map((row) => (
              <li
                key={row.portfolioId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-line p-2 text-xs"
              >
                <span className="break-words">
                  <span className="font-semibold text-ink">{row.username}</span>{" "}
                  <span className={row.enabled ? "text-positive" : "text-muted"}>
                    {row.enabled ? "açık" : "kapalı"}
                  </span>{" "}
                  · {formatDateTime(row.approvedAt)}
                  {row.reason ? ` · ${row.reason}` : ""}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs"
                  disabled={busy}
                  data-testid={`revoke-${row.username}`}
                  onClick={() =>
                    void run(async () => {
                      const user = users.find((candidate) => candidate.username === row.username);
                      await apiFetch("/api/admin/price-sources/experimental", {
                        method: "PUT",
                        body: JSON.stringify({ userId: user?.id ?? "", enabled: !row.enabled, reason: row.reason }),
                      });
                      return row.enabled ? "Erişim kapatıldı." : "Erişim açıldı.";
                    })
                  }
                >
                  {row.enabled ? "Kapat" : "Aç"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4" data-testid="mapping-approvals">
        <p className="text-sm font-semibold text-ink">Ekran eşleme onayları</p>
        <p className="mt-1 break-words text-xs text-muted">
          Ekranda yeni/eski ayrımı yazmayan satırlar (ÇEYREK, YARIM, TAM ALTIN) piyasa teamülüne
          göre eşlenir. Bu bir kanıt değildir: onaylamadan önce ekrandaki ham adı, alış/satış
          fiyatını ve gözlem zamanını doğrulayın. Onaysız eşleme değerlemeye ve MARKET_BASELINE
          oluşturmaya GİRMEZ.
        </p>
        <div className="mt-3 flex w-full flex-wrap items-end gap-2">
          <label className="text-xs text-subtle">
            Ekrandaki ham ad
            <input
              className="control mt-1 min-h-11 w-full min-w-40"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="ÇEYREK"
              data-testid="mapping-label"
            />
          </label>
          <label className="text-xs text-subtle">
            Uygulama ürünü
            <select
              className="control mt-1 min-h-11 w-full min-w-48"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              data-testid="mapping-product"
            >
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-subtle">
            Alış (kanıt)
            <input
              className="control tabular mt-1 min-h-11 w-full min-w-28"
              value={liquidation}
              onChange={(event) => setLiquidation(event.target.value)}
              inputMode="decimal"
            />
          </label>
          <label className="text-xs text-subtle">
            Satış (kanıt)
            <input
              className="control tabular mt-1 min-h-11 w-full min-w-28"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              inputMode="decimal"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary min-h-11"
            disabled={busy || label.trim() === "" || productId === ""}
            data-testid="approve-mapping"
            onClick={() =>
              void run(async () => {
                await apiFetch("/api/admin/price-sources/mappings", {
                  method: "PUT",
                  body: JSON.stringify({
                    rawLabel: label.trim(),
                    canonicalProductId: productId,
                    mappingVersion,
                    evidenceLiquidation: liquidation.trim(),
                    evidenceReplacement: replacement.trim(),
                    evidenceObservedAt: new Date().toISOString(),
                    revoke: false,
                  }),
                });
                return "Eşleme onaylandı; bu ürün artık değerlemeye girebilir.";
              })
            }
          >
            Onayla
          </button>
        </div>

        {staleApprovals.length > 0 ? (
          <div className="mt-3 rounded-md border border-notice-line bg-notice-soft p-3" data-testid="stale-approval-warning">
            <p className="text-xs font-semibold text-notice">
              {staleApprovals.length} onay eski eşleme sürümünde alınmış — değerlemeye GİRMİYOR.
            </p>
            <p className="mt-1 break-words text-xs text-muted">
              Onay, eşleme tablosunun belirli bir sürümü için verilir. Tablo değiştiğinde eski onay
              düşer ve o ürünler fiyatsız kalır. Şu an kullanılan sürüm{" "}
              <span className="break-words font-medium text-ink">{mappingVersion}</span>. Aşağıdaki
              satırlarda &quot;Yeniden onayla&quot;ya basın, ekrandaki güncel alış/satış değerlerini
              yazın ve onaylayın.
            </p>
          </div>
        ) : null}

        {approvals.length === 0 ? (
          <p className="mt-3 text-xs text-subtle">Onaylanmış eşleme yok.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-subtle">
                <tr>
                  <th className="py-1 pr-3 font-medium">Ekran adı</th>
                  <th className="py-1 pr-3 font-medium">Ürün</th>
                  <th className="py-1 pr-3 font-medium">Güven</th>
                  <th className="py-1 pr-3 font-medium">Kanıt (alış/satış)</th>
                  <th className="py-1 pr-3 font-medium">Gözlem</th>
                  <th className="py-1 pr-3 font-medium">Onaylayan</th>
                  <th className="py-1 pr-3 font-medium"> </th>
                </tr>
              </thead>
              <tbody className="text-muted">
                {approvals.map((row) => {
                  const stale = row.appliesToCurrentMapping === false;
                  return (
                  <tr key={`${row.rawLabel}-${row.mappingVersion}`} data-testid={stale ? "approval-stale" : "approval-active"}>
                    <td className="py-1 pr-3 break-words">{row.rawLabel}</td>
                    <td className="py-1 pr-3">{row.canonicalProductId}</td>
                    <td className={cx("py-1 pr-3", stale ? "text-notice" : "text-positive")}>
                      {stale ? "Geçersiz — eski eşleme sürümü" : row.confidence}
                    </td>
                    <td className="tabular py-1 pr-3">
                      {row.evidenceLiquidation ?? "—"} / {row.evidenceReplacement ?? "—"}
                    </td>
                    <td className="py-1 pr-3">
                      {row.evidenceObservedAt ? formatDateTime(row.evidenceObservedAt) : "—"}
                    </td>
                    <td className="py-1 pr-3">{row.approvedBy ?? "—"}</td>
                    <td className="py-1 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {stale ? (
                          <button
                            type="button"
                            className="btn btn-ghost min-h-8 px-2 py-0.5 text-xs"
                            data-testid="reapprove-mapping"
                            onClick={() => {
                              // Ham ad ve ürün doldurulur; KANIT DOLDURULMAZ.
                              // Eski kanıt eski gözlemdir: yönetici ekrandaki
                              // güncel alış/satışı kendisi yazmalıdır.
                              setLabel(row.rawLabel);
                              setProductId(row.canonicalProductId);
                              setLiquidation("");
                              setReplacement("");
                              setNotice(
                                `"${row.rawLabel}" forma taşındı. Ekrandaki güncel alış/satış değerlerini yazıp onaylayın.`,
                              );
                            }}
                          >
                            Yeniden onayla
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost min-h-8 px-2 py-0.5 text-xs"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await apiFetch("/api/admin/price-sources/mappings", {
                                method: "PUT",
                                body: JSON.stringify({
                                  rawLabel: row.rawLabel,
                                  canonicalProductId: row.canonicalProductId,
                                  mappingVersion: row.mappingVersion,
                                  revoke: true,
                                }),
                              });
                              return "Onay geri alındı.";
                            })
                          }
                        >
                          Geri al
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
