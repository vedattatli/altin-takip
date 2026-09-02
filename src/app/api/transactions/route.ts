import { getAuthBackend, requireCurrentUser } from "@/server/auth";
import { failure, ok, readJson } from "@/server/http";
import { parseTransactionInput } from "@/server/transactions";

export async function GET() {
  try {
    const actor = await requireCurrentUser();
    return ok(await getAuthBackend().listTransactions(actor.id));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireCurrentUser();
    const body = await readJson<unknown>(request);
    const input = await parseTransactionInput(actor.id, body);
    return ok(await getAuthBackend().createTransaction(actor.id, input), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE() {
  try {
    const actor = await requireCurrentUser();
    await getAuthBackend().clearTransactions(actor.id);
    return ok(null);
  } catch (error) {
    return failure(error);
  }
}
