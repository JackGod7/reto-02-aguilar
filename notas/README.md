# Notas internas para continuar (rama `notas/continuar`)

Esta rama no se fusiona a `main`: solo guarda el traspaso entre equipos y herramientas.
El código vigente es `main` (desplegado en Render). La versión entregada es el tag `entrega-2026-11-03`.

## Retomar en otra PC
```bash
git clone https://github.com/JackGod7/reto-02-aguilar.git && cd reto-02-aguilar
git fetch origin notas/continuar
git show origin/notas/continuar:notas/plan/CONTINUAR.md   # estado y siguiente paso
cp .env.example .env   # poner ANTHROPIC_API_KEY (key del workspace de desarrollo)
npm ci && npx tsc --noEmit && node --test 'tests/**/*.test.ts' && node scripts/verificar-entrega.ts
```
Las rutas `/Users/jackaguilar/...` de las notas corresponden a la Mac original. En otra PC, reemplázalas por el clon.

## Contenido
- `plan/CONTINUAR.md` y `plan/PROGRESO.md`: estado, puertas y pendientes.
- `defensa/DEFENSA-RELEASE.md`: trazabilidad del release, los 9 trade-offs, las debilidades y el guion de 2 minutos.
- `defensa/AUDITORIA.md` y `REVISION-*.md`: auditorías previas.
- `memoria/`: reglas del dueño ("borrar antes de escribir", "el coordinador solo orquesta").
- En `main`: `AGENTS.md` (método), `evals/MATRIZ.md` (evals por HU en Gherkin) y `evals/redteam-jailbreak.md`.

Prompt para Codex o Claude: «Lee AGENTS.md y notas/plan/CONTINUAR.md (rama notas/continuar) y sigue el método al pie de la letra».
