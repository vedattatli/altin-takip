import { getAuthBackend, requireCurrentUser } from "@/server/auth";
import { failure, ok, readJson } from "@/server/http";
import { parseTransactionInput } from "@/server/transactions";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const actor = await requireCurrentUser();
    const { id } = await context.params;
    const body = await readJson<unknown>(request);
    const input = await parseTransactionInput(actor.id, body, { editingTransactionId: id });
    return ok(await getAuthBackend().updateTransaction(actor.id, id, input));
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const actor = await requireCurrentUser();
    const { id } = await context.params;
    await getAuthBackend().deleteTransaction(actor.id, id);
    return ok(null);
  } catch (error) {
    return failure(error);
  }
}
