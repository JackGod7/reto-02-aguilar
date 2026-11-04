// CSV RFC 4180 con defensa contra inyección de fórmulas (prefijo ').
const FORMULA = /^[=+\-@\t\r]/;

function escaparCelda(valor: string): string {
  let s = valor;
  if (FORMULA.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function serializarCsv(filas: string[][]): string {
  return filas.map((f) => f.map(escaparCelda).join(",")).join("\n") + "\n";
}

export function parsearCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let entrecomillado = false;
  const cerrarCelda = (): void => {
    fila.push(/^'[=+\-@\t\r]/.test(celda) ? celda.slice(1) : celda);
    celda = "";
  };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entrecomillado) {
      if (c === '"') {
        if (texto[i + 1] === '"') { celda += '"'; i++; } else entrecomillado = false;
      } else celda += c;
    } else if (c === '"') entrecomillado = true;
    else if (c === ",") cerrarCelda();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      cerrarCelda();
      filas.push(fila);
      fila = [];
    } else celda += c;
  }
  if (celda !== "" || fila.length > 0) { cerrarCelda(); filas.push(fila); }
  return filas.filter((f) => !(f.length === 1 && f[0] === ""));
}
