export type DeleteResult = { ok: true } | { error: string }

/** Stop at the first failure and return it so selection state can be retained. */
export async function deleteEach<T>(
  items: T[],
  deleteOne: (item: T) => Promise<DeleteResult>
): Promise<DeleteResult> {
  for (const item of items) {
    const result = await deleteOne(item)
    if ("error" in result) return result
  }
  return { ok: true }
}
