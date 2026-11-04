// Fechas en español → ISO YYYY-MM-DD. Sin Date local: todo en UTC.
const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const pad = (n: number): string => String(n).padStart(2, "0");

function diasDelMes(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > diasDelMes(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// "primero (1) de agosto de 2026" usa el número entre paréntesis; respaldo "27 de agosto de 2026".
export function parseFechaEs(texto: string): string | null {
  const t = texto.toLowerCase();
  const re = /(?:\((\d{1,2})\)|\b(\d{1,2}))\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/;
  const m = re.exec(t);
  if (!m) return null;
  const mes = MESES[m[3] ?? ""];
  if (!mes) return null;
  return iso(Number(m[4]), mes, Number(m[1] ?? m[2]));
}

export function todasLasFechasEs(texto: string): string[] {
  const out: string[] = [];
  const re = /(?:\(\d{1,2}\)|\b\d{1,2})\s+de\s+[a-záéíóú]+\s+de\s+\d{4}/gi;
  for (const m of texto.matchAll(re)) {
    const f = parseFechaEs(m[0]);
    if (f) out.push(f);
  }
  return out;
}

function partes(f: string): [number, number, number] {
  const [y, m, d] = f.split("-").map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

export function addMonths(f: string, n: number): string {
  const [y, m, d] = partes(f);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(d, diasDelMes(ny, nm))) ?? f;
}

export function addDays(f: string, n: number): string {
  const [y, m, d] = partes(f);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function diasEntre(a: string, b: string): number {
  const [ya, ma, da] = partes(a);
  const [yb, mb, db] = partes(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

export function esFechaIso(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = partes(s);
  return iso(y, m, d) === s;
}
