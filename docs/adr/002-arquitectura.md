# ADR-002 — Arquitectura: monolito modular con puertos y adaptadores

**Estado:** aceptada (implementada).

## Contexto
Un solo equipo, un solo proceso, un maestro CSV, un LLM, despliegue en Render Free. Se necesita cambiar de proveedor LLM o de almacenamiento sin tocar las reglas de negocio, y poder probar el dominio sin modelo (`demo.ts` corre sin LLM).

## Decisión
**Monolito modular** (válido según Richardson para este tamaño), con la regla de dependencia de R. C. Martin: `domain/` no depende de nada; `tools/` depende del dominio; `agent/`, `llm/`, `infra/` y `server.ts` están en el borde.
- **Puertos y adaptadores** (Cockburn): buzón, maestro, archivo y adaptador LLM (`src/llm/adapter.ts`, implementación Anthropic) son interfaces con adaptadores intercambiables.
- **Repository** (Fowler) para el maestro CSV; **Value Objects** (`Dinero`, NIT, fechas) en `domain/`.
- **Audit Log**: `historial.jsonl` y `log.jsonl` en `out/`.
- **Topes y timeouts** (inspirados en Nygard; no es un circuit breaker con estados): 25 pasos, tokens por sesión, tope diario global, timeout de 60 s por llamada, rate limit por IP.
- Idempotencia: `procesados.json` evita registrar dos veces el mismo mensaje.

## Alternativas descartadas
| Alternativa | Razón |
|---|---|
| Microservicios / Saga / Outbox / CQRS / Event Sourcing | Sin servicios distribuidos ni concurrencia que lo justifique; solo sumarían operación. |
| Framework de agentes con estado propio | Oculta el gate y los topes; aquí deben ser visibles en código. |
| Base de datos | Cero infraestructura; el maestro ya es CSV. Se reabre si hay varios escritores. |

## Consecuencias
- (+) Dominio testeable sin red ni modelo; cambiar de proveedor toca solo `llm/`.
- (−) Estado en disco local: en Render Free es **efímero** (se pierde al reiniciar o redesplegar). Aceptable para la demo, no para producción real.
- (−) Sesiones en memoria: no escalan a varias instancias. Ver `docs/RUNBOOK.md`.
