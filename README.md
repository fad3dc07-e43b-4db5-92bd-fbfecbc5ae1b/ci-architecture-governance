# CALinter

[English](README.md) | [Español](README.es.md)

CALinter is a reusable governance linter for ArchiMate design repositories.

It validates artifacts through a manifest plus ordered DSLs under `specs/`.

## DSL Authoring

DSLs live in `specs/` and are listed in `specs/manifest.yaml`.

The manifest declares the artifact and the execution order. Each DSL is dispatched by its root key, not by filename alone.

Example:

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

## DSL Shape

Each DSL declares:

- `archi_consistency_dsl` or `archi_style_dsl`
- `metadata`
- `consistencyGuide` or `styleGuide`
- `rules`

The engine resolves `target: current` from the manifest artifact and executes the rules in order.

## Workflow

The reusable GitHub Action lives in `.github/workflows/compliance.yml` and defaults to `specs/manifest.yaml`.

## Output Semantics

- `PASS`: no blocking issues.
- `WARN`: non-blocking findings were detected, but the run can continue.
- `FAIL`: blocking issues were detected and the workflow should stop.
- `ERROR`: the engine or workflow hit a technical problem.

The JSON response uses the same top-level `status` value.
