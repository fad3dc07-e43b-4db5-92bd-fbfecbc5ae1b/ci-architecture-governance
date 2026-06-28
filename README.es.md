# CALinter

[English](README.md) | [Español](README.es.md)

CALinter es un linter de gobernanza reutilizable para repositorios de diseño ArchiMate.

Valida artefactos mediante un manifest y DSLs ordenados dentro de `specs/`.

## Autoría de DSL

Los DSL viven en `specs/` y se listan en `specs/manifest.yaml`.

El manifest declara el artefacto y el orden de ejecución. Cada DSL se despacha por su clave raíz, no solo por el nombre del archivo.

Ejemplo:

```yaml
schemaVersion: 1
artifact:
  type: archimate
  tool: archi
  source:
    path: artifact/source/*.archimate
    mode: single-file
orderOfExecution:
  - archi-consistency-dsl.yaml
  - archi_style_dsl.yaml
```

## Forma del DSL

Cada DSL declara:

- `archi_consistency_dsl` o `archi_style_dsl`
- `metadata`
- `consistencyGuide` o `styleGuide`
- `rules`

El engine resuelve `target: current` desde el artefacto del manifest y ejecuta las reglas en orden.

## Workflow

El GitHub Action reutilizable vive en `.github/workflows/compliance.yml` y usa `specs/manifest.yaml` por defecto.

## Semántica De Salida

- `PASS`: no hay problemas bloqueantes.
- `WARN`: hay hallazgos no bloqueantes, pero la ejecución puede continuar.
- `FAIL`: hay problemas bloqueantes y el workflow debe detenerse.
- `ERROR`: el motor o el workflow tuvieron un problema técnico.

La respuesta JSON usa el mismo valor en `status`.
