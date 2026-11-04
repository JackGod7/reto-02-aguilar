import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import type { LLMAdapter, Herramienta, Mensaje, OpcionesLLM, RespuestaLLM } from "./adapter.ts";

export function crearAnthropicAdapter(env: NodeJS.ProcessEnv = process.env): LLMAdapter {
  const model = env.LLM_MODEL || "claude-haiku-5-5";
  const apiKey = env.ANTHROPIC_API_KEY;
  const provider = createAnthropic({ apiKey });
  return {
    provider: "anthropic",
    model,
    async enviar(mensajes: Mensaje[], herramientas: Herramienta[], opciones: OpcionesLLM): Promise<RespuestaLLM> {
      if (!apiKey) throw new Error("LLM no configurado: falta ANTHROPIC_API_KEY");
      const tools = Object.fromEntries(
        herramientas.map((h) => [
          h.name,
          tool({ description: h.description, inputSchema: h.inputSchema, execute: (args: unknown) => h.execute(args) }),
        ]),
      );
      const r = await generateText({
        model: provider(model),
        system: opciones.system,
        messages: mensajes,
        tools,
        stopWhen: stepCountIs(opciones.maxPasos),
        timeout: { totalMs: 60_000 },
      });
      return { texto: r.text, pasos: r.steps.length, tokens: r.usage.totalTokens ?? 0 };
    },
  };
}
