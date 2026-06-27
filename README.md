# ci-architecture-governance

Repositorio central de gobernanza para activos arquitectónicos.

## Filosofía

- Un motor declarativo ejecuta una regla declarativa centralizada.
- Los desarrolladores ajustan el manifest o la regla, no scripts por cada cambio.
- El workflow reusable solo orquesta el engine.

## Estructura

- `rules/`: `manifest.yaml` y reglas declarativas en YAML.
- `linter-engine.mjs`: motor declarativo.
- `report.mjs`: render del resumen.
- `.github/workflows/validate.yml`: workflow reusable para el repo llamador.
