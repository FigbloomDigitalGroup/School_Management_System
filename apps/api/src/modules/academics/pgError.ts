export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export function pgMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}
