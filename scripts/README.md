# Scripts de Gobernanza

Estos scripts viven en el repo central `ci-architecture-governance` y son usados por workflows reutilizables.

## `common.mjs`

Contiene componentes compartidos para leer argumentos, crear estado de validación, agregar checks, construir reportes y persistir texto o JSON de forma consistente.

## `validation-engine.mjs`

Es el motor declarativo. Lee un manifest YAML y ejecuta reglas sin código por validador.

### Archivos esperados

- `rules/validators.yaml`
- `rules/archi-archimate-source.yaml`

### Tipos de reglas soportadas

- `repository-name`
- `path`
- `single-visible-file`
- `file-not-empty`
- `xml-root`
- `text-contains`

## `render-validation-summary.mjs`

Toma el reporte JSON consolidado y lo convierte en el resumen Markdown del workflow.
