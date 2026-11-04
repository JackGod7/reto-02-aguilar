import "./sin-trazas.ts"; // primero: fuerza tracing externo apagado
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { z } from "zod";
import type { LLMAdapter, Herramienta, MensajePaso, OpcionesPasoLLM, PasoLLM } from "./adapter.ts";

interface EsquemaHerramienta {
  name: string;
  description: string;
  schema: z.ZodType;
}

interface ModeloAnthropicPaso {
  bindTools(herramientas: EsquemaHerramienta[]): {
    invoke(mensajes: BaseMessage[], opciones: { signal: AbortSignal; callbacks: [] }): Promise<AIMessage>;
  };
}

export type FactoriaAnthropic = (config: ConstructorParameters<typeof ChatAnthropic>[0]) => ModeloAnthropicPaso;

function positivo(valor: string | undefined, defecto: number): number {
  if (valor === undefined || valor === "") return defecto;
  const numero = Number(valor);
  if (!Number.isSafeInteger(numero) || numero <= 0) throw new Error("Configuración LLM inválida: se requiere un entero positivo");
  return numero;
}

function historial(mensajes: MensajePaso[], system?: string): BaseMessage[] {
  const resultado: BaseMessage[] = system ? [new SystemMessage(system)] : [];
  for (const mensaje of mensajes) {
    if (mensaje.role === "user") resultado.push(new HumanMessage(mensaje.content));
    else if (mensaje.role === "tool") {
      if (!mensaje.toolCallId) throw new Error("Resultado de herramienta sin identificador");
      resultado.push(new ToolMessage({ content: mensaje.content, tool_call_id: mensaje.toolCallId }));
    } else {
      resultado.push(new AIMessage({
        content: mensaje.content,
        tool_calls: mensaje.toolCalls?.map((llamada) => {
          const args = llamada.args && typeof llamada.args === "object" && !Array.isArray(llamada.args)
            ? llamada.args as Record<string, unknown>
            : { _argumentos_invalidos: true };
          return { id: llamada.id, name: llamada.name, args, type: "tool_call" as const };
        }),
      }));
    }
  }
  return resultado;
}

/** Solo transporte modelo<->mensajes. El grafo conserva el control de herramientas y topes. */
export function crearAnthropicAdapter(
  env: NodeJS.ProcessEnv = process.env,
  crearModelo: FactoriaAnthropic = (config) => new ChatAnthropic(config),
): LLMAdapter {
  const model = env.LLM_MODEL || "claude-haiku-5-5";
  const apiKey = env.ANTHROPIC_API_KEY;
  const timeoutMs = positivo(env.LLM_TIMEOUT_MS, 60_000);
  const maxTokens = positivo(env.LLM_MAX_OUTPUT_TOKENS, 4096);

  async function generarPaso(mensajes: MensajePaso[], herramientas: Herramienta[], opciones: OpcionesPasoLLM): Promise<PasoLLM> {
    if (!apiKey) throw new Error("LLM no configurado: falta ANTHROPIC_API_KEY");
    const maxSalida = opciones.maxOutputTokens ?? maxTokens;
    if (!Number.isSafeInteger(maxSalida) || maxSalida <= 0) throw new Error("Tope de salida LLM inválido");
    const signal = opciones.signal
      ? AbortSignal.any([opciones.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const mensajesModelo = historial(mensajes, opciones.system);
    // Los modelos 5.x no admiten prefill: un historial terminado en assistant es un 400 seguro.
    if (mensajesModelo.at(-1) instanceof AIMessage) throw new Error("Historial inválido: no puede terminar en assistant (prefill no soportado)");
    try {
      signal.throwIfAborted();
      const modelo = crearModelo({ model, apiKey, maxTokens: Math.min(maxSalida, maxTokens), maxRetries: 0, clientOptions: { timeout: timeoutMs, maxRetries: 0 } });
      const respuesta = await modelo.bindTools(herramientas.map((h) => ({
        name: h.name, description: h.description, schema: h.inputSchema,
      }))).invoke(mensajesModelo, { signal, callbacks: [] });
      const validas = respuesta.tool_calls ?? [];
      const invalidas = respuesta.invalid_tool_calls ?? [];
      const ids = new Set([...validas, ...invalidas].map((llamada) => llamada.id).filter(Boolean));
      function idIntento(id: string | undefined, indice: number): string {
        if (id) return id;
        let sintetico = `invalid-tool-call-${indice}`;
        while (ids.has(sintetico)) sintetico += "-invalid";
        ids.add(sintetico);
        return sintetico;
      }
      // Conservar intentos malformados y su uso para que el grafo los rechace y audite.
      // Una llamada sin ID jamás puede convertirse en una ejecución válida.
      const llamadas = [
        ...validas.map((llamada, indice) => ({
          id: idIntento(llamada.id, indice), name: llamada.name || "herramienta_invalida",
          args: llamada.id && llamada.name ? llamada.args : null,
        })),
        ...invalidas.map((llamada, indice) => ({
          id: idIntento(llamada.id, validas.length + indice), name: llamada.name || "herramienta_invalida",
          args: llamada.args ?? null,
        })),
      ];
      const texto = typeof respuesta.content === "string" ? respuesta.content : respuesta.content
        .filter((bloque) => bloque.type === "text" && typeof bloque.text === "string")
        .map((bloque) => bloque.text).join("");
      const total = respuesta.usage_metadata?.total_tokens;
      const usoConocido = typeof total === "number" && Number.isSafeInteger(total) && total >= 0;
      return { texto, llamadas, tokens: usoConocido ? total : 0, usoConocido };
    } catch {
      // Los errores del SDK pueden incluir cabeceras o contenido privado; no se propagan.
      throw new Error(signal.aborted ? "La solicitud al proveedor LLM fue cancelada o agotó su tiempo" : "No se pudo completar la solicitud al proveedor LLM");
    }
  }

  return { provider: "anthropic", model, configurado: Boolean(apiKey), generarPaso };
}
