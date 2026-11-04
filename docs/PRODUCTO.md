# PRODUCTO — Registro de Contratos Vigentes

Actualización 2026-11-04. Orden: problema → proceso → resultado medible → capacidad → tecnología → validación. El PRD define la entrega del reto (A); el piloto con datos reales (B) se resume como roadmap en [SOLUCION §9](../SOLUCION.md#9-cobertura).

## 1. Caso de negocio y causa raíz

El maestro quedó congelado al 2026-05-30. Comercial remite principalmente contratos con póliza y el proceso dependía de una persona que ya no está. Consecuencias: contratos ausentes, documentos dispersos y poca visibilidad de vigencias o pólizas pendientes. La falta de canal, responsabilidad y relevo no se resuelve solo cambiando de framework.

Hay dos problemas relacionados: **cobertura**, conseguir que lleguen los contratos con y sin póliza; **integridad**, registrar correctamente lo recibido y respetar la decisión humana. El ahorro de tiempo es una hipótesis adicional que debe medirse.

Analista administrativa: operadora y dueña propuesta del maestro, con suplente. Comerciales: remiten contrato firmado, otrosí y actas; no necesitan usar el chat. Gerencia: consume alertas y responde por seguimiento. TI: identidad, permisos, integración y operación. No se infiere un área legal, una revisión jurídica automática ni usuarios reales entrevistados.

## 2. Flujo de negocio esperado

Comercial envía al canal único → se identifica recepción y documento → extracción con procedencia → clasificación nuevo/actualización/duplicado/rechazado → analista revisa dudas → decisión exacta → registro y archivo con historial → reporte de vigencias/pólizas → responsable actúa y registra seguimiento.

El acuse debe distinguir recibido de registrado. La propuesta de gobierno exige responsable y suplente, contenido/asunto/plazo de envío, excepciones y escalamiento, campaña junio–agosto y cruce con facturación. Es una propuesta de A; no se han enviado acuses ni ejecutado la campaña ni acordado políticas con una organización real.

Las alertas actuales usan fechas de contratos y estado de póliza. No afirmar predicción de incumplimiento ni vencimiento de pólizas sin obtener sus fechas y evidencia. La analista administra; no se sustituye asesoría jurídica.

## 3. Prioridades y resultados

| Prioridad | Resultado | Capacidad/proceso | Evidencia de salida |
|---|---|---|---|
| P0 | Que lleguen contratos con y sin póliza | Gobierno del buzón, responsable/relevo, obligación comercial y conciliación | En A propuesta completa; en B contrastar universo con facturación, reportar faltantes no observables en el buzón |
| P0 | No escribir una decisión ambigua ni duplicar el maestro | Aprobación exacta y reglas de clasificación | Casos 001–006 según PRD, ninguna escritura no autorizada, duplicados sin inserción y otrosí con historial |
| P0 de B | Sobrevivir a reinicios, reintentos y rotación | Checkpointer durable, identidad, transacciones, relevo, backup/restore | Recuperación sin duplicación, autorizaciones vigentes y restauración medida bajo objetivos acordados |
| P1 | Menos trabajo manual con coste controlado | Contexto acotado, observabilidad, revisión comprensible | Comparación equivalente de minutos humanos y coste total por operación; hipótesis si faltan datos |
| Posterior | Consultar conocimiento adicional | Recuperación/RAG con procedencia | Necesidad y mejora demostradas frente al conocimiento actual; no agregar por aparecer en el curso |

No se habilitan multiagentes, memoria vectorial ni OCR en este bloque. Node/TypeScript y las herramientas del PRD se conservan. LangGraph organiza estado y pausa; LangChain transporta mensajes/solicitudes; LangSmith no envía trazas externas. El framework no reemplaza reglas, permisos ni pruebas de integridad.

## 4. Métricas y protocolo de medición

| Métrica | Definición operacional | Estado |
|---|---|---|
| Cobertura del maestro | Contratos únicos identificables en facturación que tienen registro válido en el maestro / contratos únicos identificables en facturación, para la misma cohorte y corte | Sin línea base; reportar aparte facturas/contratos no identificables y resolver conciliación, nunca excluirlos silenciosamente |
| Integridad | Filas duplicadas, actualizaciones perdidas e historial incoherente por operación | Cero en aceptación de fixtures; producción requiere escenarios concurrentes y recuperación |
| Escrituras autorizadas | Escrituras dudosas sin aprobación válida de operación/valores/fuente/versiones | Cero exigido; cubierto en fixtures por las pruebas adversariales del gate (`tests/agent/hitl-adversarial.test.ts`) |
| Tiempo firma → registro | Días hábiles entre firma y registro, separando demora de envío, espera humana y procesamiento | Pendiente de datos; el plazo propuesto de envío no es una medición |
| Trabajo humano | Minutos activos en leer, corregir, aprobar y resolver excepciones, comparando casos equivalentes manual/asistido | Pendiente; latencia del LLM no equivale a tiempo ahorrado |
| Calidad | Precisión por campo, falsos limpios y tasa de revisión, contrastados con respuesta de referencia | Los seis fixtures son aceptación funcional, no estimación de precisión real |
| Coste por correo | Gasto variable total del periodo / correos recibidos del mismo periodo, incluidos duplicados/rechazados | Pendiente de medición actual |
| Coste por operación completada | Gasto variable total del periodo / altas y actualizaciones completadas, incluyendo gasto de intentos fallidos y confirmaciones | Pendiente; informar denominador cero como no calculable |
| Seguimiento de alertas | Alertas emitidas con responsable, estado y evidencia de atención | Reporte no demuestra acción ni riesgo financiero evitado |

Un contrato puede recibir varios correos y un cliente tener varios contratos; no intercambiar esos denominadores. Una operación completada es un alta o actualización confirmada con archivo/historial coherentes; duplicados y rechazos no se cuentan como altas, aunque consuman recursos. La propuesta histórica de cobertura ≥95% no es un compromiso aprobado: fijar meta después de conciliar la línea base.

Antes de datos reales: validar organización, dueña/suplente, autoridad del maestro, corpus permitido, volumen/picos, presupuesto, retención y objetivos operativos (roadmap, paso 1). Protocolo inicial: registrar tiempos manual/asistido sobre los mismos tipos de casos permitidos, separar clasificación y complejidad y registrar reintentos/confirmaciones. Para evaluación real usar corpus representativo autorizado y comparación humana en shadow; los fixtures y una muestra pequeña no prueban ROI ni generalización.

## 5. Modelo económico sin cifras inventadas

Para una cohorte comparable:

- Horas ahorradas = (minutos humanos manuales − minutos humanos asistidos) / 60.
- Valor del tiempo liberado = horas ahorradas × coste/hora acordado. No equivale automáticamente a ahorro de caja.
- Beneficio neto estimado = valor del tiempo liberado − incremento de costes variables − incremento de costes fijos respecto de la línea base manual.

Contabilizar entrada/salida/caché del modelo, embeddings si se justifican, reintentos, confirmaciones, fallos, hosting, BD, almacenamiento, backups, evaluaciones y operación. No multiplicar un promedio por correo como si fuera coste por contrato registrado. Sin datos de volumen, tarifas medidas/fechadas, coste humano y operación no se calcula retorno ni punto de equilibrio.

La cifra histórica 53.358 tokens por lote corresponde a notas de una corrida AI SDK; no se aplica a LangGraph ni a cada operación. Rapidez y reducción de tokens son hipótesis. La reducción de riesgo se presenta como controles y evidencia; no monetizar probabilidades de pérdidas o penalidades no observadas. La fórmula de riesgo del documento anterior queda sustituida por este criterio.

## 6. Estado y separación de entregas

A (el reto) cumple sobre los seis fixtures: tsc limpio, suite completa en verde y demo ×2 determinista con `node scripts/verificar-entrega.ts`. B exige checkpointer durable, identidad, integridad transaccional, idempotencia, límites persistentes, observabilidad, backup restaurado y reversión; pasa de shadow a asistido con evidencia y decisión de negocio. MemorySaver no sobrevive a reinicios.

## 7. Referencias de diseño

Se usaron patrones de LangGraph (interrupt/Command, checkpoints) adaptados a Node/TypeScript. No se agregan RAG, multiagentes ni memoria vectorial sin una necesidad medida (ADR-003).

## 8. Responsabilidad y siguiente acción

| Actividad | Responsable propuesto | Criterio |
|---|---|---|
| Envío completo | Comercial; gerencia responde por cumplimiento | Contratos con y sin póliza, otrosíes y actas llegan al canal acordado |
| Maestro y excepciones | Analista con suplente | Decisiones trazables y conciliación de faltantes |
| Atención de alertas | Analista y gerencia | Responsable y seguimiento por alerta |
| Acceso, operación, backups y modelo | TI con producto | Controles probados y cambios versionados |
| Integración y documentación | Coordinador | Evidencia antes de CUMPLE; sin publicar cambios no verificados |

La cifra histórica «1 de 6» cuenta mensajes de fixtures, incluido uno sin contrato; no reutilizarla como tasa de revisión contractual.
