/** Una línea JSON por evento a stdout. Solo metadatos: nunca claves ni texto del usuario. */
export function log(nivel: "info" | "warn" | "error", evento: string, campos: Record<string, string | number | boolean | null | undefined> = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), nivel, evento, ...campos }) + "\n");
}
