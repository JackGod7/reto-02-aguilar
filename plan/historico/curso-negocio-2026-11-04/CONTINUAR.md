# CONTINUAR — estado vigente al 2026-11-04

## Fuente y arquitectura vigentes

Trabajar en `/Users/jackaguilar/reto-periferia-ia-integracion`, rama `codex/langgraph-reto`, HEAD `e7350944cfe5ee83d809fbc4fe90c54068122fae`.
Plan: [PLAN-ATOMICO.md](/Users/jackaguilar/reto-periferia-ia-integracion/plan/PLAN-ATOMICO.md). Decisión: [ADR-004](/Users/jackaguilar/reto-periferia-ia-integracion/docs/adr/004-langgraph-orquestacion.md).

Node + LangGraph gobierna el flujo y los checkpoints; LangChain integra Anthropic mediante una llamada por paso. LangSmith permanece sin envío externo de trazas. Las herramientas y las reglas del PRD se conservan. Las dependencias exactas autorizadas son las del manifiesto del checkout de integración; la prohibición antigua de sustituir AI SDK quedó revocada para esta migración.

## Estado de Git y trabajo conservado

- A1 CUMPLE, commit e735094: tsc limpio, 55/55 y demo ×2 exit 0 determinista; fixtures intactos en esa unidad.
- Referencia anterior: `release/ai-sdk-referencia` en e735094; release/tag entregados sin modificar.
- Migración PARCIAL: cambios de proveedor, grafo, API/UI y documentación sin commit, push ni despliegue.
- El checkout `/Users/jackaguilar/reto-periferia-ia` conserva sus borradores. No copiar sus archivos ni restaurarlos encima de la integración de forma indiscriminada.
- Integración tiene node_modules propio; ya no es el enlace inicial al checkout original.
- Última comprobación disponible de la migración: tsc limpio y 86/86; no reejecutada en esta sincronización documental. No cierra seguridad ni preparación productiva.

## P0 abierto y siguiente acción exacta

Cerrar A4-P0: una confirmación con reviewId válido y texto adicional ambiguo/exceptivo/condicionado no puede autorizar una escritura. La revisión reprodujo «confirmo revisión <UUID> pero espera mi segundo mensaje», además de variantes con excepción/cambio de valor. Hubo cambios parciales, pero la revisión terminó incompleta por límite de uso del agente: no considerar el defecto corregido.

Implementar validación de decisión completa mediante acción estructurada o gramática cerrada, conservar el ejemplo textual del PRD y agregar regresiones. Otro agente debe intentar refutar el resultado. Después cerrar A3–A8, A2 y las demás unidades del plan; no omitir clasificación por haberse cambiado el motor.

## Producción y verificación

A acredita el reto; B exige checkpoint durable LangGraph, identidad, transacciones/idempotencia, recuperación, límites persistentes, backups restaurados y reversión. MemorySaver solo conserva continuidad dentro del proceso. Mayor velocidad y menor coste/token son hipótesis por medir.

Antes de cada commit/push: tsc, suite completa, demo ×2 desde out limpio, comparación salvo timestamps, fixtures intactos y diff sin secretos, revisión independiente y contenido exacto. Solo el coordinador integra/publica. No exponer datos reales ni declarar producción lista por tests o health.

## Responsables

Proveedor: `langchain_provider`; grafo: `langgraph_flow`; revisión adversarial: `review_langgraph`; integración/documentación: coordinador. Reutilizar contexto útil y limitar paralelismo al consumo; no relanzar diagnósticos completos.

## Histórico

El traspaso previo se conserva en `plan/historico/antes-langgraph-2026-11-04/CONTINUAR.md`; sus rutas, stack, cifras y afirmaciones de publicación no son instrucciones actuales.
