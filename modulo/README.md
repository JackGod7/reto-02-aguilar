# Módulo reutilizable: registro de contratos

Agente empaquetado a partir de las fuentes del proyecto (sin copias divergentes).

- `agent.md`: definición del agente (frontmatter YAML + prompt de `agent/prompt.md`). Permisos: sin edición ni bash.
- `tools/contratos.ts`: las 5 tools (`leer_buzon`, `extraer`, `validar`, `registrar`, `alertas`), cada una con `description`, `args` (zod) y `execute(args, { directory, sessionId })`. No requiere servidor.
- `skill/registro-contratos/SKILL.md`: conocimiento del proceso (de `src/knowledge/registro-contratos.md`).

## Integración

1. Copia `modulo/` junto con `src/` (las tools importan de `../../src/tools/contratos.ts`) al proyecto destino.
2. Registra `agent.md` como agente primario y `skill/` como skill; expón las tools con el prefijo `contratos_`.
3. Pasa `directory` con el buzón (`fixtures/`) en el contexto de cada `execute`.

## Regeneración

Los archivos de este directorio se generan: ejecuta `npm run build:modulo` tras cambiar `agent/prompt.md` o `src/knowledge/`.
