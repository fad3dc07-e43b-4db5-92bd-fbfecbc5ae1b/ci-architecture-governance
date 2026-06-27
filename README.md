# Continuous Architecture Workflow

Repositorio de gobernanza del linter `continuous-architecture-linter`.

Este proyecto centraliza las reglas de cumplimiento para modelos ArchiMate exportados desde Archi y expone un reusable workflow para que los repos clientes validen su contenido sin duplicar lógica.

## Qué incluye

- `src/engine.mjs`: orquestador del motor.
- `src/checks/`: estrategias de validación por tipo de regla.
- `src/core/`: schemas y registro declarativo de reglas.
- `src/infra/`: utilidades de FS, YAML, XML y argumentos.
- `rules/`: manifiesto y reglas YAML.
- `.github/workflows/compliance.yml`: reusable workflow de cumplimiento.

## Requisitos

- Node.js 20 o superior.
- `npm`.

## Uso local

Instalar dependencias:

```bash
npm ci
```

Ejecutar validación:

```bash
npm run validate
```

Ejecutar el motor directamente:

```bash
node src/engine.mjs --mode validate --repo-root . --manifest rules/manifest.yaml
```

## Flujo

1. El workflow cliente hace checkout de su propio repositorio.
2. El reusable workflow hace checkout de este repositorio de gobernanza.
3. Se instalan dependencias con `npm ci`.
4. El motor evalúa el `manifest.yaml` y las reglas declaradas.
5. Se publica un resumen consolidado en GitHub Actions.

## Reglas actuales

- `archi-consistency-rule`: consistencia e integridad básica del archivo `.archimate`.
- `archi-style-rule`: convención de nombres y estilo para elementos y vistas.
