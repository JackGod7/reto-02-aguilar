# Verificación de entrega

Con Node >=24, desde el checkout:

```sh
node scripts/verificar-entrega.ts
```

El script crea una copia temporal por lista de rutas permitidas, instala con `npm ci --ignore-scripts`, verifica backend + front en localhost en menos de dos minutos (incluida la instalación), ejecuta TypeScript y la suite, comprueba que el módulo coincide con sus fuentes y corre la demo dos veces desde `out/` limpio. Compara stdout exacto y todos los artefactos; únicamente sustituye timestamps ISO en las claves JSON `ts`/`timestamp`. Compara hashes de fixtures antes/después y elimina la copia incluso ante errores.

No lee ni copia `.env`, `.npmrc`, `.git`, `out/` o `node_modules` del checkout. Los procesos reciben un entorno mínimo sin claves heredadas y configuraciones npm vacías. Solo `npm ci` necesita red; no invoca al proveedor LLM. El `out/` del checkout queda intacto. La salida final informa duraciones y hashes; cualquier puerta fallida devuelve exit 1.

Docker se comprueba por separado. La base fijada en `Dockerfile` es la Docker Official Image de Node 24.22.2, con el digest del índice multi arquitectura verificado el 2026-11-04 contra el [registro oficial](https://registry-1.docker.io/v2/library/node/manifests/24-slim). [Docker documenta la fijación por digest](https://docs.docker.com/reference/cli/docker/image/pull/). Actualizarlo requiere consultar otra vez el registro y repetir la verificación.
