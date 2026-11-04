// Puertas offline del producto en una copia limpia; npm ci solo accede al registro npm.
// Uso (Node >=24): node scripts/verificar-entrega.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { setTimeout as esperar } from "node:timers/promises";

type Huellas = Record<string, string>;
const raiz = resolve(import.meta.dirname, "..");
const MAX_ARRANQUE_MS = 120_000;
const excluido = (nombre: string): boolean => nombre === ".env" || nombre.startsWith(".env.") || ["node_modules", "out", ".git"].includes(nombre);
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function copiar(origen: string, destino: string): void {
  if (excluido(basename(origen))) return;
  const estado = lstatSync(origen);
  assert.ok(!estado.isSymbolicLink(), `No se copian enlaces simbólicos: ${relative(raiz, origen)}`);
  if (estado.isDirectory()) {
    mkdirSync(destino, { recursive: true });
    for (const nombre of readdirSync(origen).sort()) copiar(join(origen, nombre), join(destino, nombre));
  } else {
    assert.ok(estado.isFile(), `Tipo de archivo no admitido: ${relative(raiz, origen)}`);
    copyFileSync(origen, destino);
  }
}

// Conserva todos los bytes salvo valores ISO de las claves JSON ts/timestamp.
// No se normalizan fechas contractuales, orden, espacios, rutas ni stdout.
function normalizarAuditoria(texto: string): string {
  return texto.replace(/(?<!\\)("(?:ts|timestamp)"\s*:\s*")(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)(")/g,
    (completo: string, inicio: string, fecha: string, fin: string) => Number.isFinite(Date.parse(fecha)) ? `${inicio}<TIMESTAMP>${fin}` : completo);
}

function huellas(carpeta: string, auditoria = false): Huellas {
  const salida: Huellas = {};
  function recorrer(actual: string): void {
    for (const nombre of readdirSync(actual).sort()) {
      const archivo = join(actual, nombre);
      const estado = lstatSync(archivo);
      assert.ok(!estado.isSymbolicLink(), `Enlace inesperado: ${archivo}`);
      if (estado.isDirectory()) recorrer(archivo);
      else {
        assert.ok(estado.isFile(), `Archivo irregular: ${archivo}`);
        const bytes = readFileSync(archivo);
        const texto = auditoria && /\.jsonl?$/.test(nombre) ? normalizarAuditoria(bytes.toString("utf8")) : bytes;
        salida[relative(carpeta, archivo)] = hash(texto);
      }
    }
  }
  assert.ok(existsSync(carpeta), `Falta directorio: ${carpeta}`);
  recorrer(carpeta);
  return salida;
}

function iguales(a: Huellas, b: Huellas, etapa: string): void {
  const diferencias = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((ruta) => a[ruta] !== b[ruta]);
  assert.deepEqual(diferencias, [], `${etapa}: cambiaron ${diferencias.join(", ")}`);
}

async function ejecutar(comando: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, etapa: string): Promise<{ stdout: string; ms: number }> {
  const inicio = performance.now();
  const hijo = spawn(comando, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  hijo.stdout.setEncoding("utf8").on("data", (parte: string) => { stdout += parte; });
  hijo.stderr.setEncoding("utf8").on("data", (parte: string) => { stderr += parte; });
  const timer = setTimeout(() => hijo.kill("SIGKILL"), MAX_ARRANQUE_MS);
  try {
    const codigo = await new Promise<number | null>((aceptar, rechazar) => {
      hijo.once("error", rechazar);
      hijo.once("close", aceptar);
    });
    assert.equal(codigo, 0, `${etapa}: exit ${String(codigo)}\n${(stderr || stdout).slice(-5000)}`);
  } finally { clearTimeout(timer); }
  const ms = Math.round(performance.now() - inicio);
  console.log(`OK ${etapa} (${ms} ms)`);
  return { stdout, ms };
}

async function puertoLibre(): Promise<number> {
  const servidor = createServer();
  await new Promise<void>((aceptar, rechazar) => { servidor.once("error", rechazar); servidor.listen(0, "127.0.0.1", aceptar); });
  const direccion = servidor.address();
  assert.ok(direccion && typeof direccion !== "string");
  await new Promise<void>((aceptar, rechazar) => servidor.close((error) => error ? rechazar(error) : aceptar()));
  return direccion.port;
}

async function detener(hijo: ChildProcess): Promise<void> {
  if (hijo.exitCode !== null || hijo.signalCode !== null) return;
  const terminado = new Promise<void>((aceptar) => hijo.once("close", () => aceptar()));
  hijo.kill("SIGTERM");
  const timer = setTimeout(() => hijo.kill("SIGKILL"), 3000);
  try { await terminado; } finally { clearTimeout(timer); }
}

async function comprobarArranque(cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const puerto = await puertoLibre();
  const inicio = performance.now();
  const hijo = spawn(process.execPath, ["--env-file-if-exists=.env", "src/server.ts"], { cwd, env: { ...env, PORT: String(puerto) }, stdio: "ignore" });
  let errorProceso: Error | undefined;
  hijo.once("error", (error) => { errorProceso = error; });
  try {
    while (performance.now() - inicio < MAX_ARRANQUE_MS) {
      if (errorProceso) throw errorProceso;
      assert.ok(hijo.exitCode === null && hijo.signalCode === null, "El servidor terminó antes de estar listo");
      try {
        const base = `http://127.0.0.1:${puerto}`;
        const salud = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        const pagina = await fetch(base, { signal: AbortSignal.timeout(1000) });
        if (salud.ok && pagina.ok && (await salud.json() as { ok?: unknown }).ok === true && /<html\b/i.test(await pagina.text())) {
          const ms = Math.round(performance.now() - inicio);
          console.log(`OK arranque backend + front (${ms} ms; sin invocar proveedor)`);
          return ms;
        }
      } catch { /* Esperar únicamente a que el proceso escuche. */ }
      await esperar(100);
    }
    throw new Error("El arranque de backend + front excedió 120000 ms");
  } finally { await detener(hijo); }
}

async function verificar(): Promise<void> {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Se requiere Node >=24");
  const originales = huellas(join(raiz, "fixtures"));
  const temporal = mkdtempSync(join(tmpdir(), "reto-entrega-"));
  const copia = join(temporal, "app");
  mkdirSync(copia);
  // Lista positiva: no se leen ni copian .env, .npmrc, .git, out o node_modules del checkout.
  const rutas = ["package.json", "package-lock.json", "tsconfig.json", "Dockerfile", "demo.ts", "src", "agent", "web", "fixtures", "tests", "scripts", "modulo"];
  try {
    for (const ruta of rutas) copiar(join(raiz, ruta), join(copia, ruta));
    iguales(originales, huellas(join(copia, "fixtures")), "fixtures de la copia");
    const usuarioNpm = join(temporal, "npm-usuario-vacio");
    const globalNpm = join(temporal, "npm-global-vacio");
    writeFileSync(usuarioNpm, "");
    writeFileSync(globalNpm, "");
    const env: NodeJS.ProcessEnv = {};
    for (const nombre of ["PATH", "SystemRoot", "COMSPEC", "TMPDIR", "TMP", "TEMP"]) if (process.env[nombre]) env[nombre] = process.env[nombre];
    Object.assign(env, { CI: "1", NO_COLOR: "1", LANGSMITH_TRACING: "false", LANGCHAIN_TRACING_V2: "false", NPM_CONFIG_USERCONFIG: usuarioNpm, NPM_CONFIG_GLOBALCONFIG: globalNpm, NPM_CONFIG_CACHE: join(temporal, "npm-cache") });
    const node = process.execPath;
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const inicioLimpio = performance.now();
    const instalacion = await ejecutar(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], copia, env, "npm ci limpio");
    const arranqueMs = await comprobarArranque(copia, env);
    const limpioListoMs = Math.round(performance.now() - inicioLimpio);
    assert.ok(limpioListoMs < MAX_ARRANQUE_MS, `Instalación + arranque excedieron 2 min: ${limpioListoMs} ms`);
    await ejecutar(node, ["node_modules/typescript/bin/tsc", "--noEmit"], copia, env, "TypeScript");
    await ejecutar(node, ["node_modules/typescript/bin/tsc", "--ignoreConfig", "--noEmit", "--strict", "--target", "es2023", "--module", "nodenext", "--moduleResolution", "nodenext", "--types", "node", "--allowImportingTsExtensions", "--erasableSyntaxOnly", "--verbatimModuleSyntax", "--skipLibCheck", "scripts/verificar-entrega.ts"], copia, env, "TypeScript del verificador");
    const pruebas = await ejecutar(node, ["--test", "--test-reporter=spec", "tests/**/*.test.ts"], copia, env, "suite completa");
    for (const linea of pruebas.stdout.split("\n")) if (/^ℹ (tests|pass|fail) /.test(linea)) console.log(linea);
    const modulo = huellas(join(copia, "modulo"));
    await ejecutar(node, ["scripts/build-modulo.ts"], copia, env, "generar módulo");
    iguales(modulo, huellas(join(copia, "modulo")), "módulo entregado frente a fuentes");
    await ejecutar(node, ["scripts/build-modulo.ts"], copia, env, "regenerar módulo");
    iguales(modulo, huellas(join(copia, "modulo")), "generación idempotente del módulo");
    await ejecutar(node, ["--input-type=module", "-e", 'import assert from "node:assert/strict"; const [m,s] = await Promise.all([import("./modulo/tools/contratos.ts"),import("./src/tools/contratos.ts")]); for (const k of ["leer_buzon","extraer","validar","registrar","alertas"]) assert.equal(m[k],s[k],k);'], copia, env, "tools del módulo idénticas/importables sin HTTP");
    rmSync(join(copia, "out"), { recursive: true, force: true });
    const primera = await ejecutar(node, ["demo.ts"], copia, env, "demo 1 desde out limpio");
    const artefactos = huellas(join(copia, "out"), true);
    iguales(originales, huellas(join(copia, "fixtures")), "fixtures tras demo 1");
    rmSync(join(copia, "out"), { recursive: true, force: true });
    const segunda = await ejecutar(node, ["demo.ts"], copia, env, "demo 2 desde out limpio");
    assert.equal(segunda.stdout, primera.stdout, "stdout de las demos distinto");
    iguales(artefactos, huellas(join(copia, "out"), true), "artefactos de las demos");
    iguales(originales, huellas(join(copia, "fixtures")), "fixtures tras demo 2");
    console.log(JSON.stringify({ ok: true, node: process.version, instalacionMs: instalacion.ms, arranqueMs, limpioListoMs, fixtures: Object.keys(originales).length, artefactos: Object.keys(artefactos).length, stdoutSha256: hash(primera.stdout), artefactosSha256: hash(JSON.stringify(artefactos)), normalizacion: "solo valores ISO en claves JSON ts/timestamp; stdout exacto", proveedorInvocado: false }, null, 2));
  } finally {
    try { iguales(originales, huellas(join(raiz, "fixtures")), "fixtures originales"); }
    finally { rmSync(temporal, { recursive: true, force: true }); }
  }
}

verificar().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Verificación fallida"); process.exitCode = 1; });
