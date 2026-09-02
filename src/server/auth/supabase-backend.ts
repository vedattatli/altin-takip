import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { internalEmailForUsername } from "@/auth/internal-identity";
import { normalizeUsername } from "@/auth/username";
import type { AdminAuditLog, DeviceMode, UserProfile, UserStatus } from "@/auth/types";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import { serverEnv } from "@/server/env";
import type {
  AuthBackend,
  CreateUserRequest,
  ResolvedSession,
  SessionRecord,
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
 * - Oturumlar app_sessions tablosunda tutulur; parola sıfırlama veya
 *   pasifleştirme tüm cihazlardaki oturumları düşürür.
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

interface TransactionRow {
  id: string;
  portfolio_id: string;
  product_id: string;
  side: "buy" | "sell";
  quantity: number;
  unit: "gram" | "adet";
  traded_at: string;
  unit_price: number;
  fee_amount: number;
  note: string;
  created_at: string;
  updated_at: string;
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    productId: row.product_id,
    side: row.side,
    quantity: Number(row.quantity),
    unit: row.unit,
    tradedAt: row.traded_at,
    unitPrice: Number(row.unit_price),
    feeAmount: Number(row.fee_amount),
    note: row.note ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
    this.admin = createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
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

  // --- Oturum ---

  async createSession(
    userId: string,
    ttlMs: number,
    deviceMode: DeviceMode,
  ): Promise<SessionRecord> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const { error } = await this.admin.from("app_sessions").insert({
      id: randomUUID(),
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      device_mode: deviceMode,
    });
    if (error) fail("Oturum oluşturulamadı", error);
    return { token, userId, expiresAt, deviceMode };
  }

  async resolveSession(token: string): Promise<ResolvedSession | null> {
    const { data, error } = await this.admin
      .from("app_sessions")
      .select("user_id, expires_at, device_mode")
      .eq("token_hash", hashToken(token))
      .maybeSingle();

    if (error || !data) return null;
    if (Date.parse(data.expires_at as string) <= Date.now()) {
      await this.destroySession(token);
      return null;
    }
    const profile = await this.getProfile(data.user_id as string);
    if (!profile || profile.status !== "active") return null;
    return {
      profile,
      // Bilinmeyen değer gelirse en kısıtlayıcı mod varsayılır.
      deviceMode: data.device_mode === "personal" ? "personal" : "shared",
    };
  }

  async destroySession(token: string): Promise<void> {
    await this.admin.from("app_sessions").delete().eq("token_hash", hashToken(token));
  }

  async destroyAllSessionsForUser(userId: string): Promise<void> {
    await this.admin.from("app_sessions").delete().eq("user_id", userId);
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

  // --- Portföy ---

  async getPortfolio(userId: string): Promise<PortfolioMeta> {
    const { data } = await this.admin
      .from("portfolios")
      .select("*")
      .eq("user_id", userId)
      .order("created_at")
      .limit(1)
      .maybeSingle();

    if (data) {
      return {
        id: data.id as string,
        name: data.name as string,
        displayName: (data.display_name as string) ?? "",
        createdAt: data.created_at as string,
        updatedAt: data.updated_at as string,
      };
    }

    const { data: created, error } = await this.admin
      .from("portfolios")
      .insert({ user_id: userId, name: "Portföyüm" })
      .select("*")
      .single();
    if (error) fail("Portföy oluşturulamadı", error);
    return {
      id: created.id as string,
      name: created.name as string,
      displayName: (created.display_name as string) ?? "",
      createdAt: created.created_at as string,
      updatedAt: created.updated_at as string,
    };
  }

  async updatePortfolio(
    userId: string,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta> {
    const portfolio = await this.getPortfolio(userId);
    const { data, error } = await this.admin
      .from("portfolios")
      .update({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", portfolio.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) fail("Portföy güncellenemedi", error);
    return {
      id: data.id as string,
      name: data.name as string,
      displayName: (data.display_name as string) ?? "",
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
  }

  async listTransactions(userId: string): Promise<Transaction[]> {
    const { data, error } = await this.admin
      .from("transactions")
      .select("*")
      .eq("user_id", userId)
      .order("traded_at", { ascending: true });
    if (error) fail("İşlemler okunamadı", error);
    return (data as TransactionRow[]).map(toTransaction);
  }

  async createTransaction(userId: string, input: TransactionInput): Promise<Transaction> {
    const portfolio = await this.getPortfolio(userId);
    const { data, error } = await this.admin
      .from("transactions")
      .insert({
        user_id: userId,
        portfolio_id: portfolio.id,
        product_id: input.productId,
        side: input.side,
        quantity: input.quantity,
        unit: input.unit,
        traded_at: input.tradedAt,
        unit_price: input.unitPrice,
        fee_amount: input.feeAmount,
        note: input.note,
      })
      .select("*")
      .single();
    if (error) fail("İşlem kaydedilemedi", error);
    return toTransaction(data as TransactionRow);
  }

  async updateTransaction(
    userId: string,
    id: string,
    input: TransactionInput,
  ): Promise<Transaction> {
    const { data, error } = await this.admin
      .from("transactions")
      .update({
        product_id: input.productId,
        side: input.side,
        quantity: input.quantity,
        unit: input.unit,
        traded_at: input.tradedAt,
        unit_price: input.unitPrice,
        fee_amount: input.feeAmount,
        note: input.note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) fail("İşlem güncellenemedi", error);
    return toTransaction(data as TransactionRow);
  }

  async deleteTransaction(userId: string, id: string): Promise<void> {
    const { error } = await this.admin
      .from("transactions")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);
    if (error) fail("İşlem silinemedi", error);
  }

  async clearTransactions(userId: string): Promise<void> {
    const { error } = await this.admin.from("transactions").delete().eq("user_id", userId);
    if (error) fail("İşlemler silinemedi", error);
  }
}
