# ADR-004: LangGraph para controlar el flujo y LangChain para el proveedor

Estado: decisión aceptada por el dueño; migración PARCIAL, A4-P0 abierto. Plan y traspaso sincronizados al 2026-11-04; sin commit/despliegue de la migración.

## Problema y decisión

El PRD §6 permite elegir framework y exige un ciclo visible, acotado y con aprobación humana. La implementación con Vercel AI SDK redujo dependencias y permitió probar las herramientas sin modelo. El diagnóstico posterior encontró brechas en la suspensión, conservación de resultados parciales y vinculación de aprobaciones.

Se conserva esa versión en la rama local `release/ai-sdk-referencia` (e735094), sin modificar el release entregado de noviembre de 2026. La nueva implementación usa Node/TypeScript, LangGraph para estado y transiciones, y LangChain ChatAnthropic para una sola llamada al proveedor por paso. El proveedor devuelve solicitudes; no ejecuta herramientas ni decide aprobaciones.

LangGraph añade dependencias y conceptos (nodos, checkpoints, interrupts). Se acepta ese coste para aprovechar sus mecanismos de pausa y reanudación en vez de mantener otro mecanismo propio. No elimina las reglas del dominio, la autorización ni la necesidad de hacer idempotentes los efectos externos.

## Límites que deben comprobarse

P0 abierto: un ID de revisión válido no autoriza un mensaje con excepción o instrucciones adicionales. La última suite disponible pasa 86/86 y TypeScript, pero falta fijar las regresiones del hallazgo y completar la revisión adversarial. Rapidez y ahorro de tokens son hipótesis por medir.

- Un nodo ejecuta una herramienta; una revisión suspende antes de ejecutar la siguiente.
- La espera humana usa interrupt y la reanudación Command; los efectos de escritura quedan fuera del nodo que puede reiniciarse al reanudar.
- El backend verifica operación, propuesta y valores exactos. Un flag generado por el modelo no concede autorización.
- El historial incluye herramientas inválidas, vetadas y resultados previos a un fallo del proveedor; uso desconocido no se presenta como cero medido.
- Los seis fixtures, la demo sin modelo y el contrato de herramientas permanecen independientes de LangGraph.
- Pruebas con grafo real y proveedor simulado deben cubrir rechazo, repetición, valores distintos, errores y límites.

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
