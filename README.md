# opencode-usage-plugin

Widget para el sidebar de [opencode](https://opencode.ai) que muestra, siempre visible, el consumo de la cuota del plan **OpenCode Go** (ventanas de 5h, semanal y mensual).

## Qué hace

- Muestra el **porcentaje usado** de cada ventana de cuota: `5h`, `Semanal` y `Mensual`, con color según severidad (verde → ámbar → rojo).
- Muestra la **cuenta atrás hasta el reset** de cada ventana (`↻ 4h 13m`).
- Muestra la **frescura del dato** en la cabecera (`hace 1m`) y **estados de error** legibles.
- **Cachea** el último snapshot correcto para pintar al instante al abrir opencode.
- Se **refresca solo** (al abrir, cada 5 min y al terminar un turno) y también **a mano**.

## Captura

Salida real del sidebar:

```
OpenCode Go · hace 1m
5h 1% ↻ 4h 13m
Semanal 4% ↻ 2d 5h
Mensual 9% ↻ 19d 22h
```

## Requisitos

- **opencode >= 1.18**.
- Un plan **OpenCode Go** activo (con su API key configurada en opencode). Sin plan, el endpoint responde `403` y el widget lo indica.
- **Node >= 20** — solo para desarrollo del plugin. El runtime de opencode (Bun) compila el `.tsx` directamente, por lo que **no hace falta bundler ni build**.

## Instalación

### Opción A — Local (la verificada)

1. Instala dependencias (solo si vas a editarlo):

   ```sh
   npm install
   ```

2. Registra el plugin en la configuración de la **TUI** (no en `opencode.json`). Crea o edita `~/.config/opencode/tui.json` con una **ruta absoluta** al entrypoint:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["/home/oasr/workspace/opencode-usage-plugin/src/tui.tsx"]
   }
   ```

   > `plugin` es un array; cada entrada puede ser un `string` o un par `[spec, opciones]`. La forma con **ruta absoluta** es la que está verificada.

3. **Reinicia opencode.** El bloque "OpenCode Go" debe aparecer en el sidebar de la sesión.

### Opción B — npm (cuando el paquete esté publicado)

Instálalo con el comando de plugins de opencode (actualiza la config por ti):

```sh
opencode plugin opencode-usage-plugin
```

O añádelo a mano en `~/.config/opencode/tui.json` usando el spec del paquete:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-usage-plugin"]
}
```

> El paquete expone su entrypoint en el subpath `./tui` (`exports["./tui"]`). Si tu versión del loader no resuelve el export por defecto, usa el subpath explícito: `opencode-usage-plugin/tui`.

Después, **reinicia opencode**.

## Refresco

El plugin consulta el endpoint oficial de uso con esta política:

| Disparador | Cuándo |
| --- | --- |
| **Al abrir** (`mount`) | Pinta el cache (si existe) y lanza un fetch en paralelo. |
| **Timer** | Cada **5 min**, solo si el último fetch tiene 5 min o más. |
| **Fin de turno** (`session.idle`) | Al terminar un turno, con un *debounce* de **60 s** para absorber ráfagas. |
| **Manual** | Comando **"Refrescar uso OpenCode Go"**: `Ctrl+X` y luego `o`, o `Ctrl+P` → paleta → *"Refrescar uso OpenCode Go"*. Tiene un **cooldown de 30 s**. |

**Suelo duro:** nunca se hace más de **1 petición cada 60 s**, sea cual sea el disparador. Si hay error, el reintento hace *backoff* `5 → 10 → 20 → 30 min` (con tope), y se reinicia en el primer éxito.

La cuenta atrás de reset se recalcula **cada segundo en local**, sin red.

## Privacidad

- La **API key se lee en tiempo de ejecución** desde `auth.json` de opencode (se buscan las entradas de proveedor `opencode-go` y, si no, `opencode`). El plugin **nunca la registra ni la persiste**: no se escribe en logs, KV cache ni mensajes de error.
- La única llamada de red es `GET https://opencode.ai/zen/go/v1/usage` (endpoint oficial de uso), con `Authorization: Bearer <key>`. El error de red original se descarta deliberadamente para no filtrar cabeceras.
- El **KV cache** guarda únicamente el snapshot de porcentajes y fechas, nunca la clave.

## Troubleshooting

- **El plugin no aparece**
  - Comprueba que el plugin está registrado con `/plugins` dentro de opencode.
  - Arranca con logs detallados: `opencode --print-logs --log-level DEBUG` y busca errores del plugin o del slot `sidebar_content`.
  - Verifica que la ruta en `tui.json` sea **absoluta** y que el archivo exista.

- **"Sin clave API de OpenCode Go"**
  - No se encontró `auth.json` o no contiene una entrada `opencode-go`/`opencode` con `key`.
  - Autentícate en opencode con tu cuenta OpenCode Go y reintenta.

- **"Sin plan OpenCode Go activo"**
  - El endpoint respondió `403`: la cuenta no tiene un plan OpenCode Go activo (o la key es de otro proveedor).

- **"Clave API rechazada (401)"**
  - La key existe pero el servicio la rechazó; vuelve a autenticarte.

- **"Sin conexión con el servicio" / "Respuesta inválida del servicio"**
  - Fallo de red, timeout (10 s) o payload inesperado. El widget mantiene visible el último dato bueno mientras muestra el error.

- **Desactivarlo**
  - Pon `plugin_enabled` en `false` en `tui.json` o elimina la entrada del array `plugin`, y reinicia opencode.

## Desarrollo

```sh
npm install        # dependencias
npm run typecheck  # npx tsc --noEmit
npm test           # npx vitest run
```

No hay paso de build: opencode carga `src/tui.tsx` directamente.

## Licencia

[MIT](./LICENSE).
