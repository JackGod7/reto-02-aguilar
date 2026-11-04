import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { crearAnthropicAdapter } from "../../src/llm/anthropic.ts";
import type { FactoriaAnthropic } from "../../src/llm/anthropic.ts";
import type { Herramienta } from "../../src/llm/adapter.ts";

const env = { ANTHROPIC_API_KEY: "clave-ficticia-no-real", LLM_MODEL: "modelo-ficticio" };

function transporte(responder: (mensajes: BaseMessage[], signal: AbortSignal) => Promise<AIMessage>) {
  const configs: Parameters<FactoriaAnthropic>[0][] = [];
  const esquemas: unknown[] = [];
  const crear: FactoriaAnthropic = (config) => {
    configs.push(config);
    return { bindTools(herramientas) {
      esquemas.push(...herramientas);
      return { invoke(mensajes, opciones) {
        assert.deepEqual(opciones.callbacks, []);
        return responder(mensajes, opciones.signal);
      } };
    } };
  };
  return { crear, configs, esquemas };
}

test("LangChain: invoca una vez, conserva historial y solo declara herramientas", async () => {
  let invocaciones = 0;
  const schema = z.object({ mensaje_id: z.string().describe("Identificador de correo") }).strict();
  const herramienta: Herramienta = {
    name: "contratos_extraer", description: "Extraer contrato", inputSchema: schema,
  };
  const fake = transporte(async (mensajes) => {
    invocaciones++;
    assert.ok(mensajes[0] instanceof SystemMessage);
    assert.ok(mensajes[1] instanceof HumanMessage);
    assert.ok(mensajes[2] instanceof AIMessage);
    assert.ok(mensajes[3] instanceof ToolMessage);
    assert.equal(mensajes[3].tool_call_id, "anterior");
    assert.equal(mensajes[2].tool_calls?.[0]?.id, "anterior");
    return new AIMessage({
      content: [{ type: "text", text: "Consultaré el contrato." }, { type: "tool_use", name: "contratos_extraer", id: "nueva", input: { mensaje_id: "msg-006" } }],
      tool_calls: [{ id: "nueva", name: "contratos_extraer", args: { mensaje_id: "msg-006" } }],
      usage_metadata: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
    });
  });
  const adapter = crearAnthropicAdapter(env, fake.crear);
  const paso = await adapter.generarPaso([
    { role: "user", content: "procesa" },
    { role: "assistant", content: "", toolCalls: [{ id: "anterior", name: "contratos_leer_buzon", args: {} }] },
    { role: "tool", content: '{"ok":true}', toolCallId: "anterior" },
  ], [herramienta], { system: "instrucciones", maxOutputTokens: 128 });
  assert.deepEqual(paso, { texto: "Consultaré el contrato.", llamadas: [{ id: "nueva", name: "contratos_extraer", args: { mensaje_id: "msg-006" } }], tokens: 20, usoConocido: true });
  assert.equal(invocaciones, 1);
  assert.deepEqual(fake.esquemas, [{ name: herramienta.name, description: herramienta.description, schema }]);
  assert.equal(fake.configs[0]?.maxTokens, 128);
  assert.equal(fake.configs[0]?.maxRetries, 0);
  assert.equal(fake.configs[0]?.clientOptions?.timeout, 60_000);
  assert.equal(fake.configs[0]?.model, "modelo-ficticio");
});

test("LangChain: uso ausente no se presenta como medición conocida", async () => {
  const fake = transporte(async () => new AIMessage("Respuesta"));
  const paso = await crearAnthropicAdapter(env, fake.crear).generarPaso!([], [], {});
  assert.deepEqual(paso, { texto: "Respuesta", llamadas: [], tokens: 0, usoConocido: false });
});

test("LangChain: env impone techo a maxOutputTokens", async () => {
  let invocaciones = 0;
  const fake = transporte(async () => { invocaciones++; return new AIMessage("Hola"); });
  const adapter = crearAnthropicAdapter({ ...env, LLM_MAX_OUTPUT_TOKENS: "256" }, fake.crear);
  await adapter.generarPaso([], [], { maxOutputTokens: 900 });
  assert.equal(fake.configs[0]?.maxTokens, 256);
  assert.equal(invocaciones, 1);
});

test("LangChain: rechaza configuración y topes inválidos antes de invocar", async () => {
  const fake = transporte(async () => new AIMessage("no"));
  for (const valor of ["0", "-1", "abc", "1.5", "Infinity"]) {
    assert.throws(() => crearAnthropicAdapter({ ...env, LLM_TIMEOUT_MS: valor }, fake.crear), /entero positivo/);
    assert.throws(() => crearAnthropicAdapter({ ...env, LLM_MAX_OUTPUT_TOKENS: valor }, fake.crear), /entero positivo/);
  }
  const adapter = crearAnthropicAdapter(env, fake.crear);
  await assert.rejects(adapter.generarPaso([], [], { maxOutputTokens: 0 }), /salida/);
  assert.equal(fake.configs.length, 0);
});

test("LangChain: falta de clave y errores del proveedor no exponen secretos", async () => {
  const fake = transporte(async () => { throw new Error(`Authorization: ${env.ANTHROPIC_API_KEY}`); });
  await assert.rejects(crearAnthropicAdapter({}, fake.crear).generarPaso!([], [], {}), /falta ANTHROPIC_API_KEY/);
  await assert.rejects(crearAnthropicAdapter(env, fake.crear).generarPaso!([], [], {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "No se pudo completar la solicitud al proveedor LLM");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("LangChain: transmite cancelación al transporte sin reintentos", async () => {
  const controller = new AbortController();
  const fake = transporte(async (_mensajes, signal) => {
    controller.abort();
    assert.equal(signal.aborted, true);
    throw new Error("petición cancelada");
  });
  await assert.rejects(crearAnthropicAdapter(env, fake.crear).generarPaso!([], [], { signal: controller.signal }), /cancelada/);
  assert.equal(fake.configs.length, 1);
});

test("LangChain: timeout aborta transporte y no expone su error", async () => {
  const fake = transporte(async (_mensajes, signal) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    signal.throwIfAborted();
    return new AIMessage("no");
  });
  await assert.rejects(crearAnthropicAdapter({ ...env, LLM_TIMEOUT_MS: "5" }, fake.crear).generarPaso!([], [], {}), /agotó su tiempo/);
});

test("LangChain: llamadas malformadas conservan intento y consumo sin argumentos ejecutables", async () => {
  let invocaciones = 0;
  const fake = transporte(async (mensajes) => {
    if (invocaciones++ > 0) {
      assert.ok(mensajes[0] instanceof AIMessage);
      assert.deepEqual(mensajes[0].tool_calls?.[0]?.args, { _argumentos_invalidos: true });
      assert.ok(mensajes[1] instanceof ToolMessage);
      assert.equal(mensajes[1].tool_call_id, "malformada");
    }
    return new AIMessage({
      content: "",
      tool_calls: [{ name: "contratos_extraer", args: { mensaje_id: "msg-006" } }],
      invalid_tool_calls: [{ id: "malformada", name: "contratos_extraer", args: '{"mensaje_id":', error: "JSON incompleto" }],
      usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });
  });
  const adapter = crearAnthropicAdapter(env, fake.crear);
  const paso = await adapter.generarPaso([], [], {});
  assert.equal(paso.tokens, 13);
  assert.equal(paso.usoConocido, true);
  assert.deepEqual(paso.llamadas, [
    { id: "invalid-tool-call-0", name: "contratos_extraer", args: null },
    { id: "malformada", name: "contratos_extraer", args: '{"mensaje_id":' },
  ]);
  const schema = z.object({ mensaje_id: z.string() }).strict();
  for (const llamada of paso.llamadas) assert.equal(schema.safeParse(llamada.args).success, false);
  const repetido = await adapter.generarPaso([
    { role: "assistant", content: "", toolCalls: [paso.llamadas[1]!] },
    { role: "tool", content: '{"ok":false,"error":"argumentos inválidos"}', toolCallId: "malformada" },
  ], [], {});
  assert.deepEqual(repetido, paso);
  await assert.rejects(adapter.generarPaso([{ role: "tool", content: "resultado" }], [], {}), /sin identificador/);
});


test("LangChain: tracing externo desactivado aunque el proceso lo herede habilitado", () => {
  const script = `
    import assert from "node:assert/strict";
    import { crearAnthropicAdapter } from "./src/llm/anthropic.ts";
    import { AIMessage } from "@langchain/core/messages";
    import { CallbackManager } from "@langchain/core/callbacks/manager";
    let red = 0;
    globalThis.fetch = async () => { red++; throw new Error("No se permite red"); };
    const adapter = crearAnthropicAdapter({ ANTHROPIC_API_KEY: "ficticia" }, () => ({
      bindTools() { return { async invoke() {
        const manager = CallbackManager.configure([]);
        assert.equal(manager?.handlers.some(h => h.name === "langchain_tracer"), false);
        return new AIMessage("local");
      } }; }
    }));
    await adapter.generarPaso([], [], {});
    assert.equal(red, 0);
  `;
  const resultado = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(resultado.status, 0, resultado.stderr);
});


test("LangChain: ChatAnthropic real serializa schemas e historial y deserializa tool_use sin red", async () => {
  const solicitudes: unknown[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    solicitudes.push(await request.json());
    return Response.json({
      id: "msg_prueba", type: "message", role: "assistant", model: "modelo-ficticio",
      content: [
        { type: "text", text: "Consultaré el contrato." },
        { type: "tool_use", id: "tool_prueba", name: "contratos_extraer", input: { mensaje_id: "msg-006" } },
      ],
      stop_reason: "tool_use", stop_sequence: null,
      usage: { input_tokens: 21, output_tokens: 9 },
    });
  };
  const adapter = crearAnthropicAdapter(env, (config) => new ChatAnthropic({
    ...config, clientOptions: { ...config?.clientOptions, fetch: fakeFetch },
  }));
  const paso = await adapter.generarPaso([
    { role: "user", content: "procesa" },
    { role: "assistant", content: "Reviso el buzón.", toolCalls: [{ id: "tool_anterior", name: "contratos_leer_buzon", args: {} }] },
    { role: "tool", content: '{"ok":true}', toolCallId: "tool_anterior" },
  ], [{
    name: "contratos_extraer", description: "Extraer contrato",
    inputSchema: z.object({ mensaje_id: z.string().describe("Identificador de correo") }).strict(),
  }], { system: "instrucciones", maxOutputTokens: 128 });
  assert.equal(solicitudes.length, 1);
  const body = z.object({
    model: z.string(), max_tokens: z.number(), system: z.unknown(), messages: z.unknown(),
    tools: z.array(z.object({ name: z.string(), description: z.string(), input_schema: z.object({
      type: z.literal("object"), properties: z.object({ mensaje_id: z.object({ type: z.literal("string"), description: z.string() }) }),
      required: z.array(z.string()), additionalProperties: z.literal(false),
    }) })),
  }).parse(solicitudes[0]);
  assert.equal(body.model, "modelo-ficticio");
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.system, [{ type: "text", text: "instrucciones", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(body.messages, [
    { role: "user", content: "procesa" },
    { role: "assistant", content: [{ type: "text", text: "Reviso el buzón." }, { type: "tool_use", id: "tool_anterior", name: "contratos_leer_buzon", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_anterior", content: '{"ok":true}' }] },
  ]);
  assert.equal(body.tools[0]?.name, "contratos_extraer");
  assert.equal(body.tools[0]?.description, "Extraer contrato");
  assert.deepEqual(body.tools[0]?.input_schema.required, ["mensaje_id"]);
  assert.equal(body.tools[0]?.input_schema.properties.mensaje_id.description, "Identificador de correo");
  assert.deepEqual(paso, { texto: "Consultaré el contrato.", llamadas: [{ id: "tool_prueba", name: "contratos_extraer", args: { mensaje_id: "msg-006" } }], tokens: 30, usoConocido: true, cache: { creacion: 0, lectura: 0 } });
});

test("LangChain: el prefijo estable (tools + system) lleva cache_control y el uso cacheado se informa", async () => {
  const solicitudes: unknown[] = [];
  const usos = [
    { input_tokens: 40, output_tokens: 10, cache_creation_input_tokens: 2500, cache_read_input_tokens: 0 },
    { input_tokens: 55, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 2500 },
  ];
  const fakeFetch: typeof fetch = async (input, init) => {
    solicitudes.push(await new Request(input, init).json());
    return Response.json({
      id: `msg_${solicitudes.length}`, type: "message", role: "assistant", model: "modelo-ficticio",
      content: [{ type: "text", text: "Listo." }], stop_reason: "end_turn", stop_sequence: null,
      usage: usos[solicitudes.length - 1],
    });
  };
  const adapter = crearAnthropicAdapter(env, (config) => new ChatAnthropic({
    ...config, clientOptions: { ...config?.clientOptions, fetch: fakeFetch },
  }));
  const tools: Herramienta[] = [
    { name: "contratos_leer_buzon", description: "Leer buzón", inputSchema: z.object({}).strict() },
    { name: "contratos_extraer", description: "Extraer", inputSchema: z.object({ mensaje_id: z.string().describe("Correo") }).strict() },
  ];
  const primero = await adapter.generarPaso([{ role: "user", content: "hola" }], tools, { system: "prompt estable" });
  const segundo = await adapter.generarPaso([{ role: "user", content: "hola" }, { role: "assistant", content: "Listo." }, { role: "user", content: "otra" }], tools, { system: "prompt estable" });
  const cuerpo = z.object({ system: z.unknown(), tools: z.array(z.record(z.string(), z.unknown())), messages: z.array(z.object({ content: z.unknown() })) });
  for (const solicitud of solicitudes) {
    const body = cuerpo.parse(solicitud);
    // Un único breakpoint, en el último bloque del system: cubre tools (renderizadas antes) y system.
    assert.deepEqual(body.system, [{ type: "text", text: "prompt estable", cache_control: { type: "ephemeral" } }]);
    assert.ok(body.tools.every((tool) => !("cache_control" in tool)));
    assert.ok(!JSON.stringify(body.messages).includes("cache_control"));
  }
  assert.deepEqual(primero.cache, { creacion: 2500, lectura: 0 });
  assert.equal(primero.tokens, 2550);
  assert.deepEqual(segundo.cache, { creacion: 0, lectura: 2500 });
  assert.equal(segundo.tokens, 2567);
});
