import type { Metadata } from "next";

import { TransactionsView, type LedgerFormKind } from "@/components/transactions-view";

export const metadata: Metadata = { title: "İşlemler" };

const FORM_BY_PARAM: Record<string, LedgerFormKind> = {
  mevcut: "opening",
  alis: "buy",
  satis: "sell",
};

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.ekle;
  const key = Array.isArray(raw) ? raw[0] : raw;
  return <TransactionsView initialForm={key ? (FORM_BY_PARAM[key] ?? null) : null} />;
}
