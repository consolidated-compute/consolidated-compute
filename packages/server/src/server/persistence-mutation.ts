import { resolve } from "node:path";

const mutationTails = new Map<string, Promise<unknown>>();

export function hostPersistenceBoundaryKey(paseoHome: string): string {
  return resolve(paseoHome);
}

export async function serializeHostPersistenceMutation<T>(
  boundaryKey: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(boundaryKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(mutation);
  mutationTails.set(boundaryKey, next);
  try {
    return await next;
  } finally {
    if (mutationTails.get(boundaryKey) === next) {
      mutationTails.delete(boundaryKey);
    }
  }
}
