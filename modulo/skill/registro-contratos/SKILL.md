---
name: registro-contratos
description: "Reglas del proceso de registro de contratos vigentes: clasificación, revisión humana y campos."
---

# Registro de contratos vigentes — conocimiento del proceso

Documento de referencia para el agente. Define cómo se clasifica un contrato, cuándo se pide revisión humana y qué significa cada campo. Las reglas se aplican en código (`src/domain/`); este texto las explica.

## Glosario

| Término | Significado |
|---|---|
| Maestro | Registro de contratos vigentes (`maestro-contratos.csv`). Una fila por contrato. |
| Mensaje | Correo del buzón con, en su caso, un adjunto de contrato. Se identifica como `msg-NNN`. |
| Contrato | Documento que empieza por `CONTRATO`. |
| Otrosí | Documento que empieza por `OTROSÍ` y modifica un contrato existente. |
| Cotización u otro documento | Cualquier adjunto que no sea contrato ni otrosí. Se rechaza. |
| Parte propia | Periferia IT Group, identificada por su NIT `900123456`. Nunca es el cliente. |
| Cliente | La otra parte del contrato. |
| Comercial | Remitente del correo, resuelto contra `comerciales.json` por correo electrónico. |
| Póliza | Garantía exigida por el contrato (`requiere_poliza`, `tipo_poliza`). |
| Estado de póliza | `vigente`, `pendiente`, `vencida` o `no_aplica`. |
| Confianza | Número de 0 a 1 por campo. Indica qué tan seguro es el valor. |
| `requiere_revision` | Lista de campos que una persona debe confirmar antes de registrar. |

## Escala de confianza

| Valor | Cuándo |
|---|---|
| 1.0 | Dato explícito en el texto. |
| 0.8 | Inferido de forma acotada (por ejemplo, el mes de inicio del contrato de un correo, tomado del texto). |
| 0.6 | Calculado (por ejemplo, fin = inicio + 12 meses). |
| 0.5 | Indeterminado (por ejemplo, "no tiene un valor determinado": valor 0 con `valor_indeterminado = true`). |
| 0 | Ausente. El campo es `null`. Nunca se inventa. |

**Umbral: un campo con confianza menor que 0.8 entra en `requiere_revision`. Con 0.8 exacto no entra.**

## Reglas de negocio

| # | Regla | Efecto |
|---|---|---|
| RN1 | **Duplicado**: mismo `id_contrato` y mismos `valor`, `fecha_inicio` y `fecha_fin`. | `duplicado`. No se escribe nada. Se reporta. |
| RN2 | **Actualización**: mismo `id_contrato` (o mismo `nit_cliente` con objeto similar, similitud ≥ 0.9) y algún campo distinto, o el documento es un otrosí. | `actualizacion`. Se modifica la fila y se añade una línea a `historial.jsonl`. |
| RN3 | **Nuevo**: no hay coincidencia. | `nuevo`. Se inserta la fila. |
| RN4 | **Rechazado**: sin adjunto de contrato, o texto sin partes ni objeto identificables. | `rechazado`, con motivo. |
| RN5 | Campos con confianza < 0.8 se reportan en `requiere_revision`. Registrar con revisión pendiente exige aprobación humana. | El registro se detiene hasta que una persona lo confirme. |

Reglas de infraestructura (no de negocio):
- RN6: el maestro de origen es de solo lectura. La primera ejecución copia el archivo a `out/sharepoint/`.
- RN7: toda acción deja una línea en `out/log.jsonl` con `ts`, `herramienta`, `mensaje_id`, `ok` y `resumen`, sin datos sensibles.

Notas de criterio:
- No se deduplica solo por NIT. Un cliente existente puede firmar un contrato nuevo con otro objeto; ese caso es `nuevo`.
- El remitente no registrado en `comerciales.json` no bloquea el registro. Genera una advertencia y el comercial queda vacío.
- Una póliza ampliada en un otrosí pasa a `estado_poliza = pendiente`.
- Un contrato vencido se reporta en una sección aparte de alertas, no como "por vencer".

## Cómo se extraen los datos

- **Determinista primero**: los campos salen de expresiones regulares sobre las cláusulas (partes, OBJETO, VALOR, PLAZO, GARANTÍAS). El modelo no extrae valores registrables.
- **Partes**: se toma la parte distinta de Periferia. El NIT se normaliza quitando puntos y dígito de verificación. Los RUC de Ecuador (13 dígitos) y Perú (11 dígitos) se conservan.
- **País del cliente**: por identificador o domicilio del cliente. Nunca por el domicilio de Periferia.
- **Valor**: se normaliza el separador decimal. Si el valor no es legible, se usa el texto en letras como respaldo, con confianza menor.
- **Fechas**: se usa el número entre paréntesis (por ejemplo, "primero (1) de agosto de 2026").

## Gobierno del proceso (resumen)

Propuesta completa en `SOLUCION.md`, sección 6.

1. **Canal único**: un buzón de contratos administrado por la analista administrativa, dueña del maestro.
2. **Obligación del comercial**: enviar el PDF firmado, los otrosíes y las actas de terminación en un plazo máximo de 3 días hábiles desde la firma, con asunto `[CONTRATO|OTROSÍ|TERMINACIÓN] <cliente> - <id>`.
3. **Acuse automático**: el agente responde en un máximo de 15 minutos con la clasificación, los campos dudosos y lo que falta.
4. **Excepciones**: contrato sin firma se devuelve. Contrato sin valor o plazo claro pasa a revisión humana. Sin respuesta del comercial en 5 días hábiles, se escala al director comercial.
5. **Cierre del gap** (junio–agosto de 2026): una campaña de 2 semanas en la que cada comercial reenvía sus contratos firmados desde el 2026-05-30. Se cruza con facturación para detectar faltantes.
6. **Indicador mensual**: porcentaje de clientes facturados en el mes que tienen contrato vigente en el maestro (meta ≥ 95 %), más el tiempo entre firma y registro.
