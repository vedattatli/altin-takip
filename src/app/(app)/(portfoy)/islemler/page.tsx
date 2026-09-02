import type { Metadata } from "next";

import { TransactionsView } from "@/components/transactions-view";

export const metadata: Metadata = { title: "İşlemler" };

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <TransactionsView initialFormOpen={params.yeni === "1"} />;
}
