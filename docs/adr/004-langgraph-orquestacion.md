# ADR-004: LangGraph para controlar el flujo y LangChain para el proveedor

Estado: aceptada (2026-11-04). Implementada en `src/agent/graph.ts` y `src/llm/anthropic.ts`; tsc limpio y 139/139 tests.

## Problema y decisión

El PRD §6 permite elegir framework y exige un ciclo visible, acotado y con aprobación humana. La implementación con Vercel AI SDK redujo dependencias y permitió probar las herramientas sin modelo. El diagnóstico posterior encontró brechas en la suspensión, conservación de resultados parciales y vinculación de aprobaciones.

Esa versión queda en el tag `entrega-2026-11-03`, sin modificar. La nueva implementación usa Node/TypeScript, LangGraph para estado y transiciones, y LangChain ChatAnthropic para una sola llamada al proveedor por paso. El proveedor devuelve solicitudes; no ejecuta herramientas ni decide aprobaciones.

LangGraph añade dependencias y conceptos (nodos, checkpoints, interrupts). Se acepta ese coste para aprovechar sus mecanismos de pausa y reanudación en vez de mantener otro mecanismo propio. No elimina las reglas del dominio, la autorización ni la necesidad de hacer idempotentes los efectos externos.

## Límites que deben comprobarse

Cada límite tiene pruebas con el grafo real y proveedor simulado (`tests/agent/langgraph-flow.test.ts`, `hitl-adversarial.test.ts`, `recovery-*.test.ts`). Un ID de revisión válido no autoriza un mensaje con excepción o instrucciones adicionales. Rapidez y ahorro de tokens no se han medido.

- Un nodo ejecuta una herramienta; una revisión suspende antes de ejecutar la siguiente.
- La espera humana usa interrupt y la reanudación Command; los efectos de escritura quedan fuera del nodo que puede reiniciarse al reanudar.
- El backend verifica operación, propuesta y valores exactos. Un flag generado por el modelo no concede autorización.
- El historial incluye herramientas inválidas, vetadas y resultados previos a un fallo del proveedor; uso desconocido no se presenta como cero medido.
- Los seis fixtures, la demo sin modelo y el contrato de herramientas permanecen independientes de LangGraph.
- Las pruebas con grafo real y proveedor simulado cubren rechazo, repetición, valores distintos, errores y límites.

## Persistencia y producción

MemorySaver permite comprobar continuidad e interrupciones dentro de un proceso para A. No sobrevive a reinicios. En B se requiere un checkpointer durable, identidad corporativa y transacciones para contrato, historial, aprobación y outbox. Un checkpoint del grafo no hace atómica una escritura conjunta de CSV, archivo y SharePoint.

No se afirma preparación productiva hasta probar recuperación, concurrencia, presupuestos, permisos, restauración y reversión bajo un perfil operativo definido. La entrega del reto y la habilitación de datos reales tienen criterios de salida separados.

LangSmith es una plataforma de trazas y evaluación, no un requisito para ejecutar LangGraph. Las trazas externas se deshabilitan explícitamente en esta versión; antes de habilitarlas deben definirse redacción, retención, permisos y costes.

## Alternativas

- Continuar el flujo propio sobre AI SDK: menos cambios inmediatos, pero implica implementar y mantener recuperación y pausas adicionales.
- Migrar a un agente autónomo de alto nivel: oculta decisiones del flujo que aquí deben ser verificables; no resuelve la aprobación exacta por sí mismo.
- Añadir todos los componentes de infraestructura desde el primer cambio: dificultaría comprobar qué mejora aporta la migración. Se integra por unidades y cada garantía se prueba.

## Referencias

- [LangGraph: interrupts y reinicio del nodo](https://docs.langchain.com/oss/javascript/langgraph/interrupts).
- [LangGraph: checkpointers y límites de MemorySaver](https://docs.langchain.com/oss/javascript/langgraph/persistence).
- [LangSmith: observabilidad e integraciones](https://docs.langchain.com/langsmith/observability).

Las versiones instaladas y sus tipos se contrastan antes de integrar. La decisión se defiende por pruebas de comportamiento, no por el nombre de la biblioteca.
