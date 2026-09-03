import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

const SCREEN_CODE = "sarraf-tv-kayseri-screen";

/**
 * Yönetici: ekran etiketi ↔ kanonik ürün eşleme onayları.
 *
 * Onay, piyasa teamülüne dayanan (CONVENTION) bir eşlemeyi OPERATOR_VERIFIED'a
 * yükseltir. Onaysız eşleme portföy değerlemesine ve MARKET_BASELINE'a GİREMEZ.
 */
export const GET = apiRoute(async () => {
  const actor = await requireCurrentAdmin();
  return ok(await getAdminService().listMappingApprovals(actor, SCREEN_CODE));
});

export const PUT = apiRoute(async (request) => {
  const actor = await requireCurrentAdmin();
  const body = await readJson<{
    rawLabel?: unknown;
    canonicalProductId?: unknown;
    mappingVersion?: unknown;
    evidenceLiquidation?: unknown;
    evidenceReplacement?: unknown;
    evidenceObservedAt?: unknown;
    revoke?: unknown;
  }>(request);
  const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const asOptional = (value: unknown): string | null => {
    const text = asText(value);
    return text === "" ? null : text;
  };
  await getAdminService().approveMapping(actor, {
    code: SCREEN_CODE,
    rawLabel: asText(body.rawLabel),
    canonicalProductId: asText(body.canonicalProductId),
    mappingVersion: asText(body.mappingVersion),
    evidenceLiquidation: asOptional(body.evidenceLiquidation),
    evidenceReplacement: asOptional(body.evidenceReplacement),
    evidenceObservedAt: asOptional(body.evidenceObservedAt),
    revoke: body.revoke === true,
  });
  return ok({ rawLabel: asText(body.rawLabel), revoked: body.revoke === true });
});
