import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { internalEmailForUsername } from "@/auth/internal-identity";
import { normalizeUsername } from "@/auth/username";
import type { AdminAuditLog, UserProfile, UserStatus } from "@/auth/types";
import {
  ProviderNotSelectableError,
  type IngestionPayload,
  type IngestionResult,
  type PricePreferenceResult,
  type PricePreferenceRow,
  type PriceSourceEventRow,
  type ProviderQuotesRow,
  type ProviderStateRow,
  type ProviderSyncInput,
  type QuarantineRow,
  type ExperimentalAccessRow,
  type MappingApprovalRow,
  type WorkerLeaseState,
  ScreenRawRow,
  ScreenRowsSnapshot,
} from "@/server/prices/types";
import type {
  LedgerAppendRequest,
  LedgerEntry,
  ProductPosition,
} from "@/domain/accounting/types";
import { LedgerAmountError } from "@/domain/accounting/amounts";
import type { PortfolioMeta } from "@/domain/types";
import { serverEnv } from "@/server/env";
import type { DataScope } from "./actor";
import {
  IdempotencyConflictError,
  LedgerEntryNotActiveError,
  LedgerEntryNotFoundError,
  OversellError,
  PortfolioNotProvisionedError,
  type AuthBackend,
  type CreateUserRequest,
  type LedgerAppendResult,
  type LedgerReplaceResult,
  type LedgerVerifyResult,
  type LedgerVoidResult,
  type ResolvedSession,
  type SessionPolicy,
  type SessionRecord,
  type SessionTouch,
  type StoredSessionSummary,
  type LedgerRevision,
  type MfaCredentialRecord,
} from "./backend";

/**
 * Supabase arka ucu.
 *
 * - Parola custody'si tamamen Supabase Auth'a aittir. Uygulama tablolarında
 *   parola veya hash TUTULMAZ.
 * - service_role anahtarı yalnızca bu sunucu modülünde kullanılır ve
 *   "server-only" işareti sayesinde istemci paketine giremez.
 * - Kullanıcı adı, sunucuda deterministik olarak dahili bir e-posta kimliğine
 *   çevrilir; bu adres hiçbir yanıtta istemciye dönmez.
 * - Oturumlar app_sessions tablosunda kalıcı ve kaydırmalı ömürle tutulur;
 *   parola sıfırlama, pasifleştirme veya yönetici iptali tüm cihazlardaki
 *   oturumları düşürür.
 */

interface ProfileRow {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "user";
  status: UserStatus;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

function toProfile(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/** Postgres tarafındaki aşırı satış hatasının tanınması için işaret. */
const OVERSELL_MARKER = "ALTIN_OVERSELL";
/** Portföy provisioning eksikliğinin tanınması için işaret. */
const PROVIDER_LICENSE_MARKER = "ALTIN_PROVIDER_LICENSE_REQUIRED";
const PROVIDER_NOT_SELECTABLE_MARKER = "ALTIN_PROVIDER_NOT_SELECTABLE";
const NOT_PROVISIONED_MARKER = "ALTIN_PORTFOLIO_NOT_PROVISIONED";
/** Aynı idempotency anahtarı farklı içerikle geldi. */
const IDEMPOTENCY_MARKER = "ALTIN_IDEMPOTENCY_CONFLICT";
/** İptal edilmiş / düzeltilmiş kayıt yeniden değiştirilmeye çalışıldı. */
const NOT_ACTIVE_MARKER = "ALTIN_LEDGER_NOT_ACTIVE";

function toPortfolio(row: Record<string, unknown>): PortfolioMeta {
  return {
    id: row.id as string,
    name: row.name as string,
    displayName: (row.display_name as string) ?? "",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  idle_expires_at: string | null;
  absolute_expires_at: string;
  persistent: boolean;
  created_at: string;
  last_seen_at: string;
  renewed_at: string;
  rotated_at: string;
  revoked_at: string | null;
  device_label: string;
  previous_token_valid_until: string | null;
  mfa_verified_at: string | null;
}

const SESSION_COLUMNS =
  "id, user_id, expires_at, idle_expires_at, absolute_expires_at, persistent, created_at, last_seen_at, renewed_at, rotated_at, revoked_at, device_label, previous_token_valid_until, mfa_verified_at";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? "bilinmeyen hata"}`);
}

export class SupabaseAuthBackend implements AuthBackend {
  readonly id = "supabase" as const;
  readonly label = "Supabase";
  readonly syncsAcrossDevices = true;

  private readonly admin: SupabaseClient;

  constructor() {
    this.admin = createClient(serverEnv.supabaseUrl, serverEnv.supabaseSecretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  private internalEmail(username: string): string {
    return internalEmailForUsername(username, serverEnv.internalEmailDomain);
  }

  async ensureReady(): Promise<void> {
    const { error } = await this.admin.from("profiles").select("id").limit(1);
    if (error) {
      throw new Error(
        `Supabase'e bağlanılamadı veya migration'lar uygulanmamış olabilir: ${error.message}`,
      );
    }
  }

  // --- Kimlik doğrulama ---

  async verifyCredentials(username: string, password: string): Promise<UserProfile | null> {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;

    // Oturumu kalıcılaştırmayan geçici istemci: parola doğrulaması dışında iz bırakmaz.
    const transient = createClient(serverEnv.supabaseUrl, serverEnv.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await transient.auth.signInWithPassword({
      email: this.internalEmail(normalized),
      password,
    });

    if (error || !data.user) return null;
    await transient.auth.signOut().catch(() => undefined);

    const profile = await this.getProfile(data.user.id);
    return profile;
  }

  async verifyPasswordForUser(userId: string, password: string): Promise<boolean> {
    const profile = await this.getProfile(userId);
    if (!profile) return false;
    const verified = await this.verifyCredentials(profile.username, password);
    return verified?.id === userId;
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const { error } = await this.admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (error) fail("Parola güncellenemedi", error);
  }

  // --- Oturum (kalıcı, kaydırmalı, yenilenen kimlik) ---

  async createSession(
    userId: string,
    now: number,
    deviceLabel: string,
    policy: SessionPolicy,
  ): Promise<SessionRecord> {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(now + policy.absoluteLifetimeMs).toISOString();
    const idleExpiresAt =
      policy.idleTimeoutMs === null ? null : new Date(now + policy.idleTimeoutMs).toISOString();

    const { error } = await this.admin.from("app_sessions").insert({
      id,
      user_id: userId,
      token_hash: hashToken(token),
      device_label: deviceLabel,
      persistent: policy.persistent,
      created_at: timestamp,
      last_seen_at: timestamp,
      renewed_at: timestamp,
      rotated_at: timestamp,
      expires_at: expiresAt,
      absolute_expires_at: expiresAt,
      idle_expires_at: idleExpiresAt,
    });
    if (error) fail("Oturum oluşturulamadı", error);
    return { id, token, userId, expiresAt, createdAt: timestamp, deviceLabel, persistent: policy.persistent };
  }

  private async findSessionRow(tokenHash: string, now: number): Promise<SessionRow | null> {
    const current = await this.admin
      .from("app_sessions")
      .select(SESSION_COLUMNS)
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (current.data) return current.data as unknown as SessionRow;

    // Yenilemeden hemen sonra eski kimlik, tolerans süresi boyunca kabul edilir.
    const previous = await this.admin
      .from("app_sessions")
      .select(SESSION_COLUMNS)
      .eq("previous_token_hash", tokenHash)
      .maybeSingle();
    const row = previous.data as unknown as SessionRow | null;
    if (!row || !row.previous_token_valid_until) return null;
    if (Date.parse(row.previous_token_valid_until) <= now) return null;
    return row;
  }

  async resolveSession(token: string, now: number): Promise<ResolvedSession | null> {
    const row = await this.findSessionRow(hashToken(token), now);
    if (!row || row.revoked_at !== null) return null;

    // Kalıcı olmayan oturumda hareketsizlik, her oturumda mutlak/kaydırmalı bitiş kontrol edilir.
    const idleExpired = row.idle_expires_at !== null && Date.parse(row.idle_expires_at) <= now;
    const expired =
      Date.parse(row.expires_at) <= now || Date.parse(row.absolute_expires_at) <= now;
    if (idleExpired || expired) {
      await this.admin.from("app_sessions").delete().eq("id", row.id);
      return null;
    }

    const profile = await this.getProfile(row.user_id);
    if (!profile || profile.status !== "active") return null;

    return {
      sessionId: row.id,
      profile,
      expiresAt: row.expires_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      persistent: row.persistent,
      mfaVerifiedAt: row.mfa_verified_at ?? null,
      lastSeenAt: row.last_seen_at,
      renewedAt: row.renewed_at,
      rotatedAt: row.rotated_at,
      createdAt: row.created_at,
      deviceLabel: row.device_label,
    };
  }

  async touchSession(sessionId: string, patch: SessionTouch): Promise<void> {
    const update: Record<string, string> = { last_seen_at: patch.lastSeenAt };
    if (patch.expiresAt) {
      update.expires_at = patch.expiresAt;
      update.absolute_expires_at = patch.expiresAt;
    }
    if (patch.renewedAt) update.renewed_at = patch.renewedAt;
    if (patch.idleExpiresAt) update.idle_expires_at = patch.idleExpiresAt;
    await this.admin.from("app_sessions").update(update).eq("id", sessionId).is("revoked_at", null);
  }

  async rotateSession(sessionId: string, now: number, graceMs: number): Promise<string | null> {
    const { data: row } = await this.admin
      .from("app_sessions")
      .select("id, token_hash, revoked_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (!row || row.revoked_at !== null) return null;

    const token = randomBytes(32).toString("base64url");
    // Eski özet eşleşmesi: eşzamanlı iki yenileme birbirini ezmez.
    const { data: updated } = await this.admin
      .from("app_sessions")
      .update({
        token_hash: hashToken(token),
        previous_token_hash: row.token_hash as string,
        previous_token_valid_until: new Date(now + graceMs).toISOString(),
        rotated_at: new Date(now).toISOString(),
      })
      .eq("id", sessionId)
      .eq("token_hash", row.token_hash as string)
      .select("id");
    return (updated ?? []).length > 0 ? token : null;
  }

  async purgeExpiredSessions(now: number): Promise<number> {
    const timestamp = new Date(now).toISOString();
    const { data, error } = await this.admin
      .from("app_sessions")
      .delete()
      .or(
        `expires_at.lte.${timestamp},absolute_expires_at.lte.${timestamp},idle_expires_at.lte.${timestamp},revoked_at.not.is.null`,
      )
      .select("id");
    if (error) return 0;
    return (data ?? []).length;
  }

  async destroySession(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    await this.admin
      .from("app_sessions")
      .delete()
      .or(`token_hash.eq.${tokenHash},previous_token_hash.eq.${tokenHash}`);
  }

  async destroySessionById(userId: string, sessionId: string): Promise<boolean> {
    const { data } = await this.admin
      .from("app_sessions")
      .delete()
      .eq("id", sessionId)
      .eq("user_id", userId)
      .select("id");
    return (data ?? []).length > 0;
  }

  async destroyAllSessionsForUser(
    userId: string,
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
    let query = this.admin.from("app_sessions").delete().eq("user_id", userId);
    if (options.exceptSessionId) query = query.neq("id", options.exceptSessionId);
    const { data } = await query.select("id");
    return (data ?? []).length;
  }

  async listSessionsForUser(userId: string, now: number): Promise<StoredSessionSummary[]> {
    const { data } = await this.admin
      .from("app_sessions")
      .select("id, created_at, last_seen_at, expires_at, idle_expires_at, device_label, persistent")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .gt("expires_at", new Date(now).toISOString())
      .or(`idle_expires_at.is.null,idle_expires_at.gt.${new Date(now).toISOString()}`)
      .order("last_seen_at", { ascending: false });
    return (data ?? []).map((row) => ({
      id: row.id as string,
      createdAt: row.created_at as string,
      lastSeenAt: row.last_seen_at as string,
      expiresAt: row.expires_at as string,
      deviceLabel: (row.device_label as string | null) ?? "Bilinmeyen cihaz",
      persistent: Boolean(row.persistent),
    }));
  }

  // --- Profiller ---

  async getProfile(userId: string): Promise<UserProfile | null> {
    const { data, error } = await this.admin
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return toProfile(data as ProfileRow);
  }

  async findProfileByUsername(username: string): Promise<UserProfile | null> {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;
    const { data, error } = await this.admin
      .from("profiles")
      .select("*")
      .eq("username", normalized)
      .maybeSingle();
    if (error || !data) return null;
    return toProfile(data as ProfileRow);
  }

  async listProfiles(options: { search?: string; limit?: number } = {}): Promise<UserProfile[]> {
    let query = this.admin.from("profiles").select("*").order("username").limit(options.limit ?? 200);
    const search = normalizeUsername(options.search ?? "");
    if (search) {
      query = query.or(`username.ilike.%${search}%,display_name.ilike.%${search}%`);
    }
    const { data, error } = await query;
    if (error) fail("Kullanıcılar listelenemedi", error);
    return (data as ProfileRow[]).map(toProfile);
  }

  async countAdmins(): Promise<number> {
    const { count, error } = await this.admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("status", "active");
    if (error) fail("Yönetici sayısı okunamadı", error);
    return count ?? 0;
  }

  async createUser(request: CreateUserRequest): Promise<UserProfile> {
    const username = normalizeUsername(request.username);
    const existing = await this.findProfileByUsername(username);
    if (existing) throw new Error("Bu kullanıcı adı zaten kullanılıyor.");

    const { data, error } = await this.admin.auth.admin.createUser({
      email: this.internalEmail(username),
      password: request.temporaryPassword,
      email_confirm: true,
      user_metadata: { username },
    });
    if (error || !data.user) fail("Kimlik oluşturulamadı", error);

    const { data: profile, error: profileError } = await this.admin
      .from("profiles")
      .insert({
        id: data.user.id,
        username,
        display_name: request.displayName.trim() || username,
        role: request.role,
        status: "active",
        must_change_password: true,
      })
      .select("*")
      .single();

    if (profileError) {
      // Profil yazılamazsa yetim auth kaydı bırakmamak için geri al.
      await this.admin.auth.admin.deleteUser(data.user.id).catch(() => undefined);
      fail("Kullanıcı profili oluşturulamadı", profileError);
    }
    return toProfile(profile as ProfileRow);
  }

  private async patchProfile(userId: string, patch: Record<string, unknown>): Promise<UserProfile> {
    const { data, error } = await this.admin
      .from("profiles")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", userId)
      .select("*")
      .single();
    if (error) fail("Kullanıcı güncellenemedi", error);
    return toProfile(data as ProfileRow);
  }

  async setStatus(userId: string, status: UserStatus): Promise<UserProfile> {
    return this.patchProfile(userId, { status });
  }

  async setMustChangePassword(userId: string, value: boolean): Promise<UserProfile> {
    return this.patchProfile(userId, { must_change_password: value });
  }

  async recordLogin(userId: string): Promise<void> {
    await this.admin
      .from("profiles")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", userId);
  }

  async deleteUser(userId: string): Promise<void> {
    // profiles ve bağlı tablolar auth.users'a ON DELETE CASCADE ile bağlıdır.
    const { error } = await this.admin.auth.admin.deleteUser(userId);
    if (error) fail("Kullanıcı silinemedi", error);
  }

  // --- Denetim kaydı ---

  async appendAudit(entry: Omit<AdminAuditLog, "id" | "createdAt">): Promise<AdminAuditLog> {
    const row = {
      id: randomUUID(),
      admin_user_id: entry.adminUserId,
      admin_username: entry.adminUsername,
      target_user_id: entry.targetUserId,
      target_username: entry.targetUsername,
      action: entry.action,
      success: entry.success,
      metadata: entry.metadata,
    };
    const { data, error } = await this.admin
      .from("admin_audit_logs")
      .insert(row)
      .select("*")
      .single();
    if (error) fail("Denetim kaydı yazılamadı", error);
    return {
      ...entry,
      id: data.id as string,
      createdAt: data.created_at as string,
    };
  }

  async listAudit(limit = 100): Promise<AdminAuditLog[]> {
    const { data, error } = await this.admin
      .from("admin_audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) fail("Denetim kayıtları okunamadı", error);
    return (data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      adminUserId: row.admin_user_id as string,
      adminUsername: row.admin_username as string,
      targetUserId: (row.target_user_id as string) ?? null,
      targetUsername: (row.target_username as string) ?? null,
      action: row.action as AdminAuditLog["action"],
      success: row.success as boolean,
      metadata: (row.metadata as AdminAuditLog["metadata"]) ?? {},
      createdAt: row.created_at as string,
    }));
  }

  // --- Portföy (DataScope ile korunur) ---

  async getPortfolio(scope: DataScope): Promise<PortfolioMeta> {
    const { data } = await this.admin
      .from("portfolios")
      .select("*")
      .eq("user_id", scope.userId)
      .order("created_at")
      .limit(1)
      .maybeSingle();

    if (data) return toPortfolio(data);

    // GET yolu veri OLUŞTURMAZ. Portföy, profil oluşturulurken tetikleyiciyle
    // hazırlanır; eksikse yönetici onarımı gerekir.
    throw new PortfolioNotProvisionedError(scope.userId);
  }

  async provisionMissingDefaults(): Promise<number> {
    const { data, error } = await this.admin.rpc("provision_missing_defaults");
    if (error) fail("Provisioning onarımı çalıştırılamadı", error);
    return Array.isArray(data) ? data.length : 0;
  }

  async updatePortfolio(
    scope: DataScope,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta> {
    const portfolio = await this.getPortfolio(scope);
    const { data, error } = await this.admin
      .from("portfolios")
      .update({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", portfolio.id)
      .eq("user_id", scope.userId)
      .select("*")
      .single();
    if (error) fail("Portföy güncellenemedi", error);
    return toPortfolio(data);
  }

  // --- İşlem defteri (Postgres RPC; append-only; hard delete YOK) ---

  /**
   * Bütün finansal mutation'lar SECURITY DEFINER RPC'lerden geçer
   * (supabase/migrations/0010_accounting_rpc.sql): portföy satırı + ürün
   * düzeyinde kilit, idempotency, defter kaydı ve pozisyon yeniden oluşturma
   * TEK transaction içindedir. Sayısal alanlar JSON'da metin olarak gelir.
   */
  private async ledgerRpc<T>(
    fn: string,
    params: Record<string, unknown>,
    context: string,
    meta: { productId?: string; clientRequestId?: string | null; transactionId?: string } = {},
  ): Promise<T> {
    // PostgREST fonksiyonu parametre ADLARIYLA eşler; hata bağlamı için ek parametre GÖNDERİLMEZ.
    const { data, error } = await this.admin.rpc(fn, params);
    if (error) {
      const message = error.message ?? "";
      if (message.includes(OVERSELL_MARKER)) {
        const available = /mevcut ([0-9.]+)/.exec(message)?.[1] ?? "0";
        throw new OversellError(meta.productId ?? "", available);
      }
      if (message.includes(NOT_PROVISIONED_MARKER)) {
        throw new PortfolioNotProvisionedError(String(params.p_user_id ?? ""));
      }
      if (message.includes(IDEMPOTENCY_MARKER)) {
        throw new IdempotencyConflictError(meta.clientRequestId ?? "");
      }
      if (message.includes(NOT_ACTIVE_MARKER)) {
        throw new LedgerEntryNotActiveError(meta.transactionId ?? "");
      }
      if (message.includes("İşlem bulunamadı")) {
        throw new LedgerEntryNotFoundError(meta.transactionId ?? "");
      }
      if (error.code === "P0004") {
        throw new LedgerAmountError(message);
      }
      fail(context, error);
    }
    return data as T;
  }

  private static payloadOf(scope: DataScope, request: LedgerAppendRequest): Record<string, unknown> {
    return {
      kind: request.kind,
      product_id: request.productId,
      quantity: request.quantity,
      unit: request.unit,
      occurred_at: request.occurredAt,
      occurred_time: request.occurredTime,
      pricing_input_mode: request.pricingInputMode,
      unit_price: request.unitPrice,
      total_amount: request.totalAmount,
      fees: request.fees,
      workmanship: request.workmanship,
      cost_basis_origin: request.costBasisOrigin,
      note: request.note,
      client_request_id: request.clientRequestId,
      created_by: scope.userId,
      baseline_snapshot: request.baselineSnapshot
        ? {
            liquidation_price: request.baselineSnapshot.liquidationPrice,
            replacement_price: request.baselineSnapshot.replacementPrice,
            provider: request.baselineSnapshot.provider,
            market: request.baselineSnapshot.market,
            currency: request.baselineSnapshot.currency,
            provider_status: request.baselineSnapshot.providerStatus,
            is_real_market_data: request.baselineSnapshot.isRealMarketData,
            provider_timestamp: request.baselineSnapshot.providerTimestamp,
            fetched_at: request.baselineSnapshot.fetchedAt,
            product_id: request.baselineSnapshot.productId,
            stale_after_ms: request.baselineSnapshot.staleAfterMs ?? null,
          }
        : null,
    };
  }

  async listLedger(scope: DataScope): Promise<LedgerEntry[]> {
    const rows = await this.ledgerRpc<LedgerEntry[] | null>(
      "ledger_list",
      { p_user_id: scope.userId },
      "İşlemler okunamadı",
    );
    return rows ?? [];
  }

  async listPositions(scope: DataScope): Promise<ProductPosition[]> {
    const rows = await this.ledgerRpc<ProductPosition[] | null>(
      "positions_list",
      { p_user_id: scope.userId },
      "Pozisyonlar okunamadı",
    );
    return rows ?? [];
  }

  async appendLedgerEntry(scope: DataScope, request: LedgerAppendRequest): Promise<LedgerAppendResult> {
    const result = await this.ledgerRpc<{
      transaction: LedgerEntry;
      position: ProductPosition;
      replayed: boolean;
    }>(
      "ledger_append",
      { p_user_id: scope.userId, p_payload: SupabaseAuthBackend.payloadOf(scope, request) },
      "İşlem kaydedilemedi",
      { productId: request.productId, clientRequestId: request.clientRequestId },
    );
    return { entry: result.transaction, position: result.position, replayed: Boolean(result.replayed) };
  }

  async voidLedgerEntry(scope: DataScope, entryId: string, reason: string): Promise<LedgerVoidResult> {
    const result = await this.ledgerRpc<{ transaction: LedgerEntry; position: ProductPosition }>(
      "ledger_void",
      { p_user_id: scope.userId, p_transaction_id: entryId, p_reason: reason },
      "İşlem iptal edilemedi",
      { transactionId: entryId },
    );
    return { entry: result.transaction, position: result.position };
  }

  async replaceLedgerEntry(
    scope: DataScope,
    entryId: string,
    request: LedgerAppendRequest,
  ): Promise<LedgerReplaceResult> {
    const result = await this.ledgerRpc<{
      voided: LedgerEntry;
      transaction: LedgerEntry;
      positions: ProductPosition[];
    }>(
      "ledger_replace",
      {
        p_user_id: scope.userId,
        p_transaction_id: entryId,
        p_payload: SupabaseAuthBackend.payloadOf(scope, request),
      },
      "İşlem düzeltilemedi",
      { productId: request.productId, clientRequestId: request.clientRequestId, transactionId: entryId },
    );
    return { voided: result.voided, entry: result.transaction, positions: result.positions };
  }

  async voidAllLedgerEntries(scope: DataScope, reason: string): Promise<number> {
    const count = await this.ledgerRpc<number>(
      "ledger_void_all",
      { p_user_id: scope.userId, p_reason: reason },
      "İşlemler iptal edilemedi",
    );
    return Number(count ?? 0);
  }

  async verifyLedger(scope: DataScope): Promise<LedgerVerifyResult> {
    const result = await this.ledgerRpc<LedgerVerifyResult>(
      "ledger_verify",
      { p_user_id: scope.userId },
      "Defter doğrulanamadı",
    );
    return { checked: Number(result?.checked ?? 0), mismatches: result?.mismatches ?? [] };
  }

  async getLedgerRevision(scope: DataScope): Promise<LedgerRevision> {
    const result = await this.ledgerRpc<{ revision: number | string; updatedAt: string }>(
      "ledger_revision",
      { p_user_id: scope.userId },
      "Defter sürümü okunamadı",
    );
    return { revision: Number(result?.revision ?? 0), updatedAt: String(result?.updatedAt ?? "") };
  }

  // --- Fiyat kaynakları (Sprint 3) ---
  // Bütün fiyat işlemleri SECURITY DEFINER RPC'lerden geçer; fiyat tablolarına
  // service_role dâhil hiçbir rol doğrudan YAZAMAZ (0013 / 0014).

  private async priceRpc<T>(fn: string, params: Record<string, unknown>, context: string): Promise<T> {
    const { data, error } = await this.admin.rpc(fn, params);
    if (error) {
      const message = error.message ?? "";
      if (message.includes(PROVIDER_LICENSE_MARKER) || message.includes(PROVIDER_NOT_SELECTABLE_MARKER)) {
        throw new ProviderNotSelectableError(String(params.p_code ?? ""), message.replace(/^ALTIN_[A-Z_]+:\s*/, ""));
      }
      if (message.includes(NOT_PROVISIONED_MARKER)) {
        throw new PortfolioNotProvisionedError(String(params.p_user_id ?? ""));
      }
      fail(context, error);
    }
    return data as T;
  }

  async syncPriceProviders(providers: readonly ProviderSyncInput[]): Promise<number> {
    const count = await this.priceRpc<number>(
      "price_providers_sync",
      { p_payload: providers },
      "Fiyat sağlayıcıları eşitlenemedi",
    );
    return Number(count ?? 0);
  }

  async syncPriceMappings(code: string, mappingVersion: string, mapping: Record<string, string>): Promise<number> {
    const count = await this.priceRpc<number>(
      "price_mappings_sync",
      { p_code: code, p_mapping_version: mappingVersion, p_payload: mapping },
      "Fiyat eşlemeleri güncellenemedi",
    );
    return Number(count ?? 0);
  }

  async listPriceProviders(): Promise<ProviderStateRow[]> {
    const rows = await this.priceRpc<ProviderStateRow[] | null>(
      "price_providers_state",
      {},
      "Fiyat sağlayıcıları okunamadı",
    );
    return rows ?? [];
  }

  async setPriceProviderFlags(code: string, enabled: boolean, userSelectable: boolean): Promise<ProviderStateRow> {
    await this.priceRpc<unknown>(
      "price_provider_set_flags",
      { p_code: code, p_enabled: enabled, p_user_selectable: userSelectable },
      "Fiyat sağlayıcısı güncellenemedi",
    );
    const providers = await this.listPriceProviders();
    const updated = providers.find((provider) => provider.code === code);
    if (!updated) fail("Fiyat sağlayıcısı güncellenemedi", { message: "Kayıt bulunamadı" });
    return updated;
  }

  async setScreenRows(
    code: string,
    rows: readonly ScreenRawRow[],
    signature: string,
    observedAt: string,
  ): Promise<void> {
    await this.priceRpc(
      "price_screen_rows_set",
      { p_code: code, p_rows: rows, p_signature: signature, p_observed: observedAt },
      "Ekran satırları kaydedilemedi",
    );
  }

  async screenRows(code: string): Promise<ScreenRowsSnapshot | null> {
    const result = await this.priceRpc<ScreenRowsSnapshot | null>(
      "price_screen_rows_get",
      { p_code: code },
      "Ekran satırları okunamadı",
    );
    if (!result) return null;
    return {
      rows: Array.isArray(result.rows) ? result.rows : [],
      screenSignature: String(result.screenSignature ?? ""),
      observedAt: String(result.observedAt ?? ""),
      updatedAt: String(result.updatedAt ?? ""),
    };
  }

  async applyPriceIngestion(code: string, runKey: string, payload: IngestionPayload): Promise<IngestionResult> {
    const result = await this.priceRpc<IngestionResult>(
      "price_ingestion_apply",
      { p_code: code, p_run_key: runKey, p_payload: payload },
      "Fiyat alımı kaydedilemedi",
    );
    return {
      runId: String(result?.runId ?? ""),
      status: String(result?.status ?? "FAILED"),
      skipped: Boolean(result?.skipped),
      quoteCount: Number(result?.quoteCount ?? 0),
      rejectedCount: Number(result?.rejectedCount ?? 0),
      replayed: Boolean(result?.replayed),
    };
  }

  async currentPriceQuotes(code: string): Promise<ProviderQuotesRow | null> {
    const row = await this.priceRpc<ProviderQuotesRow | null>(
      "price_quotes_current",
      { p_code: code },
      "Güncel fiyatlar okunamadı",
    );
    return row ?? null;
  }

  async comparePriceQuotes(codes: readonly string[]): Promise<ProviderQuotesRow[]> {
    const rows = await this.priceRpc<ProviderQuotesRow[] | null>(
      "price_quotes_compare",
      { p_codes: codes },
      "Fiyat karşılaştırması okunamadı",
    );
    return rows ?? [];
  }

  async getPricePreference(scope: DataScope): Promise<PricePreferenceRow> {
    const row = await this.priceRpc<PricePreferenceRow | null>(
      "price_preference_get",
      { p_user_id: scope.userId },
      "Fiyat kaynağı tercihi okunamadı",
    );
    return (
      row ?? { portfolioId: null, providerCode: null, marketId: null, selectedAt: null, selectedBy: null }
    );
  }

  async setPricePreference(
    scope: DataScope,
    code: string,
    actorId: string,
    role: "user" | "admin",
    reason: string,
  ): Promise<PricePreferenceResult> {
    return this.priceRpc<PricePreferenceResult>(
      "price_preference_set",
      { p_user_id: scope.userId, p_code: code, p_actor: actorId, p_role: role, p_reason: reason },
      "Fiyat kaynağı değiştirilemedi",
    );
  }

  async listPriceQuarantine(code: string | null, limit = 50): Promise<QuarantineRow[]> {
    const rows = await this.priceRpc<QuarantineRow[] | null>(
      "price_quarantine_list",
      { p_code: code, p_limit: limit },
      "Karantina kayıtları okunamadı",
    );
    return rows ?? [];
  }

  async setDefaultPriceProvider(code: string | null): Promise<string | null> {
    const row = await this.priceRpc<{ providerCode: string | null }>(
      "price_provider_set_default",
      { p_code: code },
      "Varsayılan fiyat kaynağı ayarlanamadı",
    );
    return row?.providerCode ?? null;
  }

  async defaultPriceProvider(): Promise<string | null> {
    const providers = await this.listPriceProviders();
    return providers.find((provider) => provider.isDefault)?.code ?? null;
  }

  // --- Deneysel özel pilot (Sprint 3.2) ---

  async setExperimentalAccess(
    userId: string,
    code: string,
    enabled: boolean,
    adminId: string,
    reason: string,
    expiresAt: string | null,
  ): Promise<void> {
    await this.priceRpc<unknown>(
      "experimental_access_set",
      {
        p_user_id: userId,
        p_code: code,
        p_enabled: enabled,
        p_admin: adminId,
        p_reason: reason,
        p_expires: expiresAt,
      },
      "Deneysel erişim güncellenemedi",
    );
  }

  async experimentalAccessAllowed(userId: string, code: string): Promise<boolean> {
    const allowed = await this.priceRpc<boolean | null>(
      "experimental_access_allowed",
      { p_user_id: userId, p_code: code },
      "Deneysel erişim okunamadı",
    );
    return allowed === true;
  }

  async listExperimentalAccess(code: string): Promise<ExperimentalAccessRow[]> {
    const rows = await this.priceRpc<ExperimentalAccessRow[] | null>(
      "experimental_access_list",
      { p_code: code },
      "Deneysel erişim listesi okunamadı",
    );
    return rows ?? [];
  }

  async approvePriceMapping(input: {
    code: string;
    rawLabel: string;
    canonicalProductId: string;
    mappingVersion: string;
    adminId: string;
    evidenceLiquidation: string | null;
    evidenceReplacement: string | null;
    evidenceObservedAt: string | null;
    revoke: boolean;
  }): Promise<void> {
    await this.priceRpc<unknown>(
      "price_mapping_approve",
      {
        p_code: input.code,
        p_label: input.rawLabel,
        p_product: input.canonicalProductId,
        p_version: input.mappingVersion,
        p_admin: input.adminId,
        p_liquidation: input.evidenceLiquidation,
        p_replacement: input.evidenceReplacement,
        p_observed: input.evidenceObservedAt,
        p_revoke: input.revoke,
      },
      "Eşleme onayı kaydedilemedi",
    );
  }

  async listMappingApprovals(code: string): Promise<MappingApprovalRow[]> {
    const rows = await this.priceRpc<MappingApprovalRow[] | null>(
      "price_mapping_approvals_list",
      { p_code: code },
      "Eşleme onayları okunamadı",
    );
    return rows ?? [];
  }

  async claimWorkerNonce(nonce: string, workerId: string): Promise<boolean> {
    const claimed = await this.priceRpc<boolean | null>(
      "price_worker_nonce_claim",
      { p_nonce: nonce, p_worker_id: workerId },
      "Worker nonce doğrulanamadı",
    );
    return claimed === true;
  }

  async acquireWorkerLease(
    code: string,
    workerId: string,
    ttlSeconds: number,
  ): Promise<{ held: boolean; workerId: string; takeover: boolean }> {
    const row = await this.priceRpc<{ held: boolean; workerId: string; takeover: boolean }>(
      "price_worker_lease_acquire",
      { p_code: code, p_worker_id: workerId, p_ttl_seconds: ttlSeconds },
      "Worker kirası alınamadı",
    );
    return row ?? { held: false, workerId, takeover: false };
  }

  async workerLeaseState(code: string): Promise<WorkerLeaseState | null> {
    const row = await this.priceRpc<WorkerLeaseState | null>(
      "price_worker_lease_state",
      { p_code: code },
      "Worker kirası okunamadı",
    );
    return row ?? null;
  }

  async listPriceSourceEvents(scope: DataScope, limit = 50): Promise<PriceSourceEventRow[]> {
    const rows = await this.priceRpc<PriceSourceEventRow[] | null>(
      "price_source_events",
      { p_user_id: scope.userId, p_limit: limit },
      "Kaynak değişim geçmişi okunamadı",
    );
    return rows ?? [];
  }

  // --- Yönetici ikinci faktörü (Sprint 3) ---
  // Secret ŞİFRELİ saklanır (uygulama katmanı); kurtarma kodları yalnızca özet.

  async getMfaCredential(userId: string): Promise<MfaCredentialRecord | null> {
    const { data, error } = await this.admin
      .from("admin_mfa_credentials")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("İkinci faktör bilgisi okunamadı", error);
    if (!data) return null;
    return {
      userId,
      secretCiphertext: data.secret_ciphertext as string,
      secretNonce: data.secret_nonce as string,
      confirmedAt: (data.confirmed_at as string | null) ?? null,
      lastVerifiedAt: (data.last_verified_at as string | null) ?? null,
      failedAttempts: Number(data.failed_attempts ?? 0),
      lockedUntil: (data.locked_until as string | null) ?? null,
      lastUsedCounter:
        data.last_used_counter === null || data.last_used_counter === undefined
          ? null
          : Number(data.last_used_counter),
    };
  }

  /**
   * TOTP zaman adımını ATOMİK olarak talep eder.
   *
   * Tek bir koşullu UPDATE kullanılır: iki eşzamanlı istek aynı sayacı
   * gönderirse yalnızca birinin WHERE koşulu tutar, diğeri satır döndürmez.
   * Oku-sonra-yaz yapılsaydı ikisi de geçebilirdi.
   */
  async claimMfaCounter(userId: string, counter: number): Promise<boolean> {
    const { data, error } = await this.admin
      .from("admin_mfa_credentials")
      .update({ last_used_counter: counter })
      .eq("user_id", userId)
      .or(`last_used_counter.is.null,last_used_counter.lt.${counter}`)
      .select("user_id");
    if (error) fail("İkinci faktör sayacı güncellenemedi", error);
    return Array.isArray(data) && data.length > 0;
  }

  async saveMfaCredential(userId: string, secret: { ciphertext: string; nonce: string }): Promise<void> {
    const { error } = await this.admin.from("admin_mfa_credentials").upsert(
      {
        user_id: userId,
        secret_ciphertext: secret.ciphertext,
        secret_nonce: secret.nonce,
        confirmed_at: null,
        failed_attempts: 0,
        locked_until: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) fail("İkinci faktör kaydedilemedi", error);
  }

  async confirmMfaCredential(userId: string, at: string): Promise<void> {
    const { error } = await this.admin
      .from("admin_mfa_credentials")
      .update({ confirmed_at: at, last_verified_at: at, failed_attempts: 0, locked_until: null, updated_at: at })
      .eq("user_id", userId);
    if (error) fail("İkinci faktör onaylanamadı", error);
  }

  async deleteMfaCredential(userId: string): Promise<void> {
    const { error } = await this.admin.from("admin_mfa_credentials").delete().eq("user_id", userId);
    if (error) fail("İkinci faktör kaydı silinemedi", error);
    const { error: codesError } = await this.admin.from("admin_mfa_recovery_codes").delete().eq("user_id", userId);
    if (codesError) fail("Kurtarma kodları silinemedi", codesError);
  }

  async recordMfaAttempt(userId: string, success: boolean, at: string): Promise<MfaCredentialRecord | null> {
    const current = await this.getMfaCredential(userId);
    if (!current) return null;
    const failedAttempts = success ? 0 : current.failedAttempts + 1;
    // Art arda 5 hatalı denemede 15 dakika kilit.
    const lockedUntil =
      !success && failedAttempts >= 5 ? new Date(Date.parse(at) + 15 * 60_000).toISOString() : null;
    const { error } = await this.admin
      .from("admin_mfa_credentials")
      .update({
        failed_attempts: failedAttempts,
        locked_until: lockedUntil,
        last_verified_at: success ? at : current.lastVerifiedAt,
        updated_at: at,
      })
      .eq("user_id", userId);
    if (error) fail("İkinci faktör denemesi kaydedilemedi", error);
    return { ...current, failedAttempts, lockedUntil, lastVerifiedAt: success ? at : current.lastVerifiedAt };
  }

  async replaceRecoveryCodes(userId: string, hashes: readonly string[]): Promise<void> {
    const { error: deleteError } = await this.admin.from("admin_mfa_recovery_codes").delete().eq("user_id", userId);
    if (deleteError) fail("Kurtarma kodları güncellenemedi", deleteError);
    if (hashes.length === 0) return;
    const { error } = await this.admin
      .from("admin_mfa_recovery_codes")
      .insert(hashes.map((hash) => ({ user_id: userId, code_hash: hash })));
    if (error) fail("Kurtarma kodları yazılamadı", error);
  }

  async consumeRecoveryCode(userId: string, hash: string, at: string): Promise<boolean> {
    const { data, error } = await this.admin
      .from("admin_mfa_recovery_codes")
      .update({ used_at: at })
      .eq("user_id", userId)
      .eq("code_hash", hash)
      .is("used_at", null)
      .select("id");
    if (error) fail("Kurtarma kodu doğrulanamadı", error);
    return Array.isArray(data) && data.length > 0;
  }

  async countRecoveryCodes(userId: string): Promise<number> {
    const { count, error } = await this.admin
      .from("admin_mfa_recovery_codes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("used_at", null);
    if (error) fail("Kurtarma kodu sayısı okunamadı", error);
    return count ?? 0;
  }

  async markSessionMfaVerified(sessionId: string, at: string): Promise<void> {
    const { error } = await this.admin
      .from("app_sessions")
      .update({ mfa_verified_at: at })
      .eq("id", sessionId);
    if (error) fail("Oturum ikinci faktör durumu yazılamadı", error);
  }
}
