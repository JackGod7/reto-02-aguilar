import type { FilaMaestro } from "./contrato.ts";
import { addDays, diasEntre } from "./fechas.ts";

export const CORTE_MAESTRO = "2026-05-30";
const VENTANA_DIAS = 60;

interface ItemAlerta {
  id_contrato: string;
  cliente: string;
  fecha_fin: string;
  dias: number;
  estado_poliza: string;
  fecha_registro: string;
}
interface Alertas {
  vencen: ItemAlerta[];
  vencidos: ItemAlerta[];
  polizas_pendientes: ItemAlerta[];
  registrados_desde_corte: ItemAlerta[];
}

export function calcularAlertas(filas: FilaMaestro[], hoy: string): Alertas {
  const item = (f: FilaMaestro): ItemAlerta => ({
    id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin,
    dias: diasEntre(hoy, f.fecha_fin), estado_poliza: f.estado_poliza, fecha_registro: f.fecha_registro,
  });
  const limite = addDays(hoy, VENTANA_DIAS);
  const porFin = (a: ItemAlerta, b: ItemAlerta): number => a.fecha_fin.localeCompare(b.fecha_fin);
  return {
    vencen: filas.filter((f) => f.fecha_fin >= hoy && f.fecha_fin <= limite).map(item).sort(porFin),
    vencidos: filas.filter((f) => f.fecha_fin < hoy).map(item).sort(porFin),
    polizas_pendientes: filas.filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente").map(item),
    registrados_desde_corte: filas.filter((f) => f.fecha_registro >= CORTE_MAESTRO).map(item),
  };
}

function tabla(items: ItemAlerta[], extra: (i: ItemAlerta) => string, cab: string): string {
  if (items.length === 0) return "_Ninguno._\n";
  const filas = items.map((i) => `| ${i.id_contrato} | ${i.cliente} | ${i.fecha_fin} | ${extra(i)} |`);
  return [`| Contrato | Cliente | Fin | ${cab} |`, "|---|---|---|---|", ...filas].join("\n") + "\n";
}

export function renderAlertasMd(a: Alertas, hoy: string): string {
  return [
    `# Alertas de contratos (hoy = ${hoy})`,
    "",
    `## 1. Vencen en ≤ ${VENTANA_DIAS} días`,
    tabla(a.vencen, (i) => `${i.dias} días`, "Días"),
    "### Ya vencidos",
    tabla(a.vencidos, (i) => `${-i.dias} días`, "Vencido hace"),
    "## 2. Póliza requerida y no vigente",
    tabla(a.polizas_pendientes, (i) => i.estado_poliza, "Estado póliza"),
    `## 3. Registrados desde el corte (${CORTE_MAESTRO})`,
    tabla(a.registrados_desde_corte, (i) => i.fecha_registro, "Registro"),
  ].join("\n");
}
