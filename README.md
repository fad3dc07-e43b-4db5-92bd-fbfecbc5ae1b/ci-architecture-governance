# ci-architecture-governance

Repositorio central de gobernanza para activos arquitectónicos.

## Filosofía

- Un motor declarativo ejecuta una regla declarativa centralizada.
- Los desarrolladores ajustan el manifest o la regla, no scripts por cada cambio.
- El workflow reutilizable solo orquesta el engine.

## Estructura

- `rules/`: manifest y reglas declarativas en YAML.
- `scripts/`: engine, componentes compartidos y render del resumen.
- `.github/workflows/validate.yml`: workflow reusable para el repo llamador.
