import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getArg, resolveArgPath } from './infra/args.mjs';
import { isFile, readText } from './infra/fs.mjs';
import { loadYamlFile } from './infra/yaml.mjs';
import { extractXmlRootName, selectXmlNodes } from './infra/xml.mjs';
import { validateDslData, validateManifestData } from './core/schemas.mjs';

export const Engine = {
  version: '2.0.0',
  defaultManifestPath: 'specs/manifest.yaml',

  main() {
    const mode = getArg('--mode', 'validate');
    const repoRoot = resolveArgPath('--repo-root', process.cwd());
    const manifestPath = resolveArgPath('--manifest', path.join(process.cwd(), this.defaultManifestPath));

    if (mode === 'summary') {
      try {
        const response = this.runManifest(repoRoot, manifestPath);
        const summaryFile = process.env.GITHUB_STEP_SUMMARY;

        if (summaryFile) {
          fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
          fs.writeFileSync(summaryFile, this.renderSummary(response), 'utf8');
        }

        process.stdout.write(`${response.systemStatus === 'ERROR' ? 'ERROR' : 'PASS'}\n`);
        return;
      } catch (error) {
        const response = this.buildErrorResponse(manifestPath, error);
        const summaryFile = process.env.GITHUB_STEP_SUMMARY;

        if (summaryFile) {
          fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
          fs.writeFileSync(summaryFile, this.renderSummary(response), 'utf8');
        }

        process.stdout.write('ERROR\n');
        process.exitCode = 1;
        return;
      }
    }

    try {
      const response = this.runManifest(repoRoot, manifestPath);
      process.stdout.write(`${JSON.stringify(this.buildValidateResponse(response))}\n`);
    } catch (error) {
      const response = this.buildErrorResponse(manifestPath, error);
      process.stdout.write(`${JSON.stringify(response)}\n`);
      process.exitCode = 1;
    }
  },

  runManifest(repoRoot, manifestPath) {
    const manifest = validateManifestData(loadYamlFile(manifestPath), manifestPath);
    const manifestDir = path.dirname(manifestPath);
    const artifact = resolveArtifact(repoRoot, manifest.artifact);
    const context = {
      repoRoot,
      manifestPath,
      manifest,
      artifact,
      specsDir: manifestDir,
    };

    const validators = manifest.orderOfExecution.map((dslFile) => {
      const dslPath = path.resolve(manifestDir, dslFile);
      const dsl = validateDslData(loadYamlFile(dslPath), dslPath);
      return evaluateDsl(dsl, {
        ...context,
        dslPath,
      });
    });

    return buildResponse(repoRoot, manifestPath, artifact, validators);
  },

  buildValidateResponse(response) {
    return {
      manifest: response.manifest,
      status: response.status,
      systemStatus: response.systemStatus,
      lintStatus: response.lintStatus,
      summary: response.summary,
      error: response.error,
    };
  },

  renderSummary(response) {
    const lines = [];
    const validators = response.validators ?? [];
    const allChecks = validators.flatMap((validator) => (validator.checks ?? []).map((check) => ({ validator, check })));
    const actionable = allChecks.filter(({ check }) => check.status !== 'PASS');
    const ruleChecks = allChecks.map(({ check }) => check);
    const stats = collectStats(validators, allChecks);
    const status = response.lintStatus ?? response.status ?? 'UNKNOWN';
    const executive = buildExecutiveSummary(response, stats, validators, allChecks);
    const artifactPath = response.artifact?.current
      ? toRelativePath(response.repoRoot, response.artifact.current)
      : (response.artifact?.source?.path ?? 'Unknown');
    const globalScore = response.systemStatus === 'ERROR' ? null : calculateComplianceScore(ruleChecks);
    const dslSummaries = validators.map((validator) => ({
      validator,
      counts: countChecks(validator.checks ?? []),
      score: calculateComplianceScore(validator.checks ?? []),
    }));
    const headline = response.systemStatus === 'ERROR'
      ? `${statusEmoji('ERROR')} No evaluable`
      : `${statusEmoji(status)} Cumplimiento: ${formatScore(globalScore)} — ${decisionFromLintStatus(status)}`;

    lines.push('# Architecture Compliance Report');
    lines.push('');
    lines.push(`## ${headline}`);
    lines.push('');

    if (status === 'WARN') {
      lines.push('> [!WARNING]');
      lines.push(`> ${executive.summaryLine}`);
    } else if (status === 'PASS') {
      lines.push('> [!NOTE]');
      lines.push(`> ${executive.summaryLine}`);
    } else if (status === 'FAIL') {
      lines.push('> [!CAUTION]');
      lines.push(`> ${executive.summaryLine}`);
    } else if (response.systemStatus === 'ERROR') {
      lines.push(`> ⚫ ${executive.summaryLine}`);
    }

    lines.push('');
    lines.push('| Decisión | Merge permitido | Errores | Advertencias | Archivo |');
    lines.push('|---|---:|---:|---:|---|');
    lines.push(`| ${decisionFromLintStatus(status)} | ${isMergeAllowed(status) ? 'Sí' : 'No'} | \`${stats.failures}\` | \`${stats.warnings}\` | \`${escapeTableCell(artifactPath)}\` |`);

    lines.push('');
    lines.push('## Acción requerida');
    if (response.systemStatus === 'ERROR') {
      lines.push('');
      lines.push(`No se pudo evaluar el diseño: ${response.error ?? 'error técnico'}.`);
    } else if (actionable.length === 0) {
      lines.push('');
      lines.push('No hay acciones requeridas.');
    } else {
      lines.push('');
      lines.push('| Estado | Ubicación | Elemento | Corrección |');
      lines.push('|---|---|---|---|');
      for (const { check } of actionable) {
        const location = check.group ?? 'General';
        const element = escapeTableCell(check.detail ?? check.message ?? '');
        const suggestion = escapeTableCell(suggestAction(check));
        lines.push(`| ${statusVisual(check.status)} | ${escapeTableCell(location)} | ${element} | ${suggestion} |`);
      }
    }

    lines.push('');
    lines.push('## Resumen por DSL');
    lines.push('');
    lines.push('| DSL | Estado | Score | PASS | WARN | FAIL |');
    lines.push('|---|---|---:|---:|---:|---:|');
    for (const { validator, counts, score } of dslSummaries) {
      lines.push(`| ${escapeTableCell(validator.title ?? validator.id ?? 'DSL')} | ${statusVisual(validator.status ?? 'UNKNOWN')} | ${formatScore(score)} | \`${counts.PASS}\` | \`${counts.WARN}\` | \`${counts.FAIL}\` |`);
    }

    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Ver evidencia técnica completa</summary>');
    lines.push('');
    lines.push('### Información de ejecución');
    lines.push('');
    lines.push('| Indicador | Valor |');
    lines.push('|---|---|');
    lines.push(`| Estado técnico | ${statusVisual(response.systemStatus ?? 'UNKNOWN')} |`);
    lines.push(`| Manifiesto | \`${escapeTableCell(response.manifest ?? '')}\` |`);
    lines.push(`| Patrón fuente | \`${escapeTableCell(response.artifact?.source?.path ?? 'Unknown')}\` |`);
    lines.push(`| Artefacto evaluado | \`${escapeTableCell(artifactPath)}\` |`);
    lines.push(`| Motor | \`${Engine.version}\` |`);
    lines.push(`| DSLs ejecutados | \`${validators.length}\` |`);
    lines.push(`| Reglas ejecutadas | \`${allChecks.length}\` |`);
    lines.push('');
    lines.push('> Las advertencias de plataforma o runner se muestran separadas del resultado de compliance.');
    lines.push('');

    for (const validator of validators) {
      const counts = countChecks(validator.checks ?? []);
      const total = counts.PASS + counts.WARN + counts.FAIL + counts.ERROR;
      lines.push(`### ${validator.title ?? validator.id ?? 'DSL'}`);
      if (validator.description) {
        lines.push(validator.description);
      }
      lines.push('');
      lines.push(`**Estado:** ${statusVisual(validator.status ?? 'UNKNOWN')} | **Score:** ${formatScore(calculateComplianceScore(validator.checks ?? []))} | **Reglas OK:** ${counts.PASS}/${total}`);
      lines.push('');
      lines.push('| Grupo | Regla | Estado | Detalle |');
      lines.push('|---|---|---|---|');
      for (const [group, checks] of Object.entries(groupChecks(validator.checks ?? []))) {
        for (const check of checks) {
          const detail = check.detail === undefined ? '' : String(check.detail);
          lines.push(`| ${escapeTableCell(group)} | ${escapeTableCell(check.id)} | ${statusVisual(check.status ?? 'UNKNOWN')} | ${escapeTableCell(detail)} |`);
        }
      }
      lines.push('');
      if (validator.observations?.length > 0) {
        lines.push('Observaciones:');
        for (const item of validator.observations) {
          lines.push(`- ${item}`);
        }
        lines.push('');
      }
    }

    lines.push('</details>');

    return `${lines.join('\n')}\n`;
  },
};

function collectStats(validators, allChecks) {
  const warnings = allChecks.filter(({ check }) => check.status === 'WARN').length;
  const failures = allChecks.filter(({ check }) => check.status === 'FAIL').length;
  const systemErrors = validators.filter((validator) => validator.systemStatus === 'ERROR').length;
  return { warnings, failures, systemErrors };
}

function buildExecutiveSummary(response, stats, validators, allChecks) {
  if (response.systemStatus === 'ERROR') {
    return {
      actionRequired: 'Resolver el error técnico del motor',
      summaryLine: 'No se pudo evaluar el diseño por un error técnico.',
    };
  }

  if (response.lintStatus === 'FAIL') {
    const failureLabel = stats.failures === 1 ? 'error bloqueante' : 'errores bloqueantes';
    return {
      actionRequired: `${stats.failures} ${failureLabel} deben corregirse`,
      summaryLine: `El diseño no cumple: hay ${stats.failures} error(es) bloqueante(s).`,
    };
  }

  if (response.lintStatus === 'WARN') {
    const firstWarning = allChecks.find(({ check }) => check.status === 'WARN');
    const warningLabel = firstWarning ? `${firstWarning.check.id} en ${firstWarning.check.group ?? 'General'}` : 'una advertencia de estilo';
    const warningCountLabel = stats.warnings === 1 ? 'advertencia de estilo' : 'advertencias de estilo';
    return {
      actionRequired: `Corregir ${stats.warnings} ${warningCountLabel}`,
      summaryLine: `El diseño puede continuar. Revisar ${warningLabel}.`,
    };
  }

  return {
    actionRequired: 'No aplica',
    summaryLine: `El diseño cumple sin observaciones bloqueantes. ${validators.length} DSLs ejecutados y ${allChecks.length} reglas evaluadas.`,
  };
}

function countChecks(checks) {
  return checks.reduce((acc, check) => {
    const key = check.status ?? 'UNKNOWN';
    if (acc[key] === undefined) {
      acc[key] = 0;
    }
    acc[key] += 1;
    return acc;
  }, { PASS: 0, WARN: 0, FAIL: 0, ERROR: 0 });
}

function decisionFromLintStatus(status) {
  if (status === 'PASS') return 'Cumple';
  if (status === 'WARN') return 'Cumple con advertencias';
  if (status === 'FAIL') return 'No cumple';
  return 'Error técnico';
}

function isMergeAllowed(status) {
  return status === 'PASS' || status === 'WARN';
}

function calculateComplianceScore(checks) {
  let score = 10;

  for (const check of checks) {
    if (check.status === 'FAIL') {
      score -= 4;
    } else if (check.status === 'WARN') {
      score -= 1;
    }
  }

  return Math.max(0, score);
}

function formatScore(score) {
  return `${score}/10`;
}

function statusEmoji(status) {
  if (status === 'PASS') return '🟢';
  if (status === 'WARN') return '🟡';
  if (status === 'FAIL') return '🔴';
  return '⚫';
}

function statusVisual(status) {
  return `${statusEmoji(status)} \`${status ?? 'UNKNOWN'}\``;
}

function escapeTableCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}

function toRelativePath(root, target) {
  if (!root || !target) {
    return String(target ?? 'Unknown');
  }

  return path.relative(root, target).replace(/\\/g, '/');
}

function suggestAction(check) {
  if (check.status === 'WARN') {
    if (/may[uú]scula/i.test(String(check.message ?? ''))) {
      return 'Renombrar el elemento para que inicie con mayúscula.';
    }

    return 'Revisar la convención y ajustar el elemento.';
  }

  if (check.status === 'FAIL') {
    return check.message ?? 'Bloquea el cumplimiento y requiere corrección.';
  }

  return 'Sin acción.';
}

function evaluateDsl(dsl, context) {
  if (dsl.archi_consistency_dsl) {
    return evaluateGuideDsl(dsl, context, 'consistencyGuide', 'archi-consistency');
  }

  if (dsl.archi_style_dsl) {
    return evaluateGuideDsl(dsl, context, 'styleGuide', 'archi-style');
  }

  throw new Error(`DSL desconocido en ${context.dslPath}.`);
}

function evaluateGuideDsl(dsl, context, guideKey, dslType) {
  const guide = dsl[guideKey] ?? {};
  const rules = dsl.rules ?? {};
  const ruleResults = [];

  for (const [section, ruleIds] of Object.entries(guide)) {
    if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
      continue;
    }

    const sectionContext = dslType === 'archi-style' ? resolveStyleSectionContext(context.artifact.current, section) : undefined;
    const sectionContextNodes = sectionContext ? selectXmlNodes(readText(context.artifact.current), sectionContext, { language: 'xpath' }) : undefined;

    if (dslType === 'archi-style' && Array.isArray(sectionContextNodes) && sectionContextNodes.length === 0) {
      for (const ruleId of ruleIds) {
        const rule = rules[ruleId];
        ruleResults.push(buildRuleResult(ruleId, rule, severityStatus(rule?.severity), 'missing-context', rule?.failureMessage ?? `No se encontró el contexto ${section}.`));
      }
      continue;
    }

    for (const ruleId of ruleIds) {
      const rule = rules[ruleId];
      if (!rule) {
        ruleResults.push(buildRuleResult(ruleId, rule, 'FAIL', 'missing-rule', `No se definió la regla '${ruleId}'.`));
        continue;
      }

      const result = evaluateRule(rule, context, {
        section,
        sectionContextNodes,
        dslType,
      });
      ruleResults.push(buildRuleResult(ruleId, rule, result.status, result.detail, rule.failureMessage, section));
    }
  }

  const hasErrorFailure = ruleResults.some((result) => result.status === 'FAIL');
  const hasWarningFailure = ruleResults.some((result) => result.status === 'WARN');
  const lintStatus = hasErrorFailure ? 'FAIL' : (hasWarningFailure ? 'WARN' : 'PASS');

  return {
    id: context.dslPath ? path.basename(context.dslPath) : dslType,
    file: context.dslPath,
    dslType,
    kind: dsl.archi_consistency_dsl ? 'archi_consistency_dsl' : 'archi_style_dsl',
    title: dsl.metadata?.title ?? path.basename(context.dslPath),
    description: dsl.metadata?.description,
    author: dsl.metadata?.author,
    purpose: dsl.metadata?.purpose,
    status: lintStatus,
    systemStatus: 'PASS',
    lintStatus,
    checks: ruleResults,
    observations: ruleResults
      .filter((check) => check.status !== 'PASS')
      .map((check) => check.message)
      .filter(Boolean),
  };
}

function evaluateRule(rule, context, { section, sectionContextNodes, dslType }) {
  const validation = rule.validate ?? {};
  const artifactText = readText(context.artifact.current);

  if (validation.textPlain) {
    return evaluateTextPlain(context.artifact.current, validation);
  }

  if (validation.xmlWellFormed) {
    return evaluateXmlWellFormed(context.artifact.current);
  }

  if (validation.xmlRoot) {
    const root = extractXmlRootName(artifactText);
    const ok = root === validation.xmlRoot;
    return { status: ok ? 'PASS' : severityStatus(rule.severity), detail: root, message: ok ? undefined : rule.failureMessage };
  }

  if (validation.namespace) {
    const ok = hasNamespace(artifactText, validation.namespace);
    return { status: ok ? 'PASS' : severityStatus(rule.severity), detail: validation.namespace.prefix, message: ok ? undefined : rule.failureMessage };
  }

  if (validation.xpath) {
    return evaluateXpathRule(artifactText, validation, rule, { sectionContextNodes, dslType });
  }

    return { status: 'ERROR', detail: 'unsupported', message: rule.failureMessage ?? `La regla '${section ?? rule.description ?? 'sin nombre'}' no tiene validación soportada.` };
  }

function evaluateTextPlain(filePath) {
  const buffer = fs.readFileSync(filePath);
  const binary = buffer.includes(0);
  const encoding = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF ? 'utf-8-bom' : 'utf-8';
  return {
    status: binary ? 'FAIL' : 'PASS',
    detail: binary ? 'binary' : encoding,
  };
}

function evaluateXmlWellFormed(filePath) {
  try {
    extractXmlRootName(readText(filePath));
    return { status: 'PASS', detail: 'xml' };
  } catch (error) {
    return { status: 'FAIL', detail: 'xml', message: error instanceof Error ? error.message : String(error) };
  }
}

function evaluateXpathRule(xmlText, validation, rule, { sectionContextNodes, dslType }) {
  const nodes = selectXmlNodes(xmlText, validation.xpath, {
    language: 'xpath',
    contextNodes: sectionContextNodes,
  });

  if (nodes.length === 0) {
    if (validation.optional) {
      return { status: 'PASS', detail: 'sin coincidencias' };
    }

    return { status: severityStatus(rule.severity), detail: 'sin coincidencias', message: rule.failureMessage };
  }

  const field = validation.field ?? 'name';
  const values = nodes.map((node) => readField(node, field));

  if (validation.containsAll) {
    const missing = validation.containsAll.filter((value) => !values.includes(value));
    if (missing.length > 0) {
      return { status: severityStatus(rule.severity), detail: missing.join(', '), message: rule.failureMessage };
    }
  }

  if (validation.regex) {
    const regex = new RegExp(validation.regex);
    const failing = values.find((value) => !regex.test(String(value ?? '')));
    if (failing !== undefined) {
      return { status: severityStatus(rule.severity), detail: String(failing), message: rule.failureMessage };
    }
  }

  if (validation.requiredAttributes) {
    const missing = nodes.find((node) => validation.requiredAttributes.some((attr) => !hasAttribute(node, attr)));
    if (missing) {
      return { status: severityStatus(rule.severity), detail: 'missing-attributes', message: rule.failureMessage };
    }
  }

  if (validation.requiredAttribute) {
    const missing = nodes.find((node) => !hasAttribute(node, validation.requiredAttribute));
    if (missing) {
      return { status: severityStatus(rule.severity), detail: validation.requiredAttribute, message: rule.failureMessage };
    }
  }

  if (validation.attributeValueStartsWith) {
    const { attribute, value } = validation.attributeValueStartsWith;
    const failing = nodes.find((node) => !String(getAttribute(node, attribute) ?? '').startsWith(value));
    if (failing) {
      return { status: severityStatus(rule.severity), detail: attribute, message: rule.failureMessage };
    }
  }

  if (validation.attributeValueEndsWith) {
    const { attribute, value } = validation.attributeValueEndsWith;
    const failing = nodes.find((node) => !String(getAttribute(node, attribute) ?? '').endsWith(value));
    if (failing) {
      return { status: severityStatus(rule.severity), detail: attribute, message: rule.failureMessage };
    }
  }

  if (validation.requiredAny) {
    const failing = nodes.find((node) => !validation.requiredAny.some((condition) => matchesNodeCondition(node, condition)));
    if (failing) {
      return { status: severityStatus(rule.severity), detail: 'requiredAny', message: rule.failureMessage };
    }
  }

  if (validation.uniqueField) {
    const uniqueValues = nodes.map((node) => readField(node, validation.uniqueField));
    const seen = new Set();
    for (const value of uniqueValues) {
      if (seen.has(value)) {
        return { status: severityStatus(rule.severity), detail: String(value), message: rule.failureMessage };
      }
      seen.add(value);
    }
  }

  if (validation.referencesExist) {
    const source = validation.referencesExist.source;
    const target = validation.referencesExist.target;
    if (source) {
      const targetValues = new Set(selectXmlNodes(xmlText, source.in, { language: 'xpath' }).map((node) => readField(node, source.field ?? 'name')).filter(Boolean));
      const failing = nodes.find((node) => !targetValues.has(readField(node, source.field ?? 'name')));
      if (failing) {
        return { status: severityStatus(rule.severity), detail: source.field ?? 'source', message: rule.failureMessage };
      }
    }

    if (target) {
      const targetValues = new Set(selectXmlNodes(xmlText, target.in, { language: 'xpath' }).map((node) => readField(node, target.field ?? 'name')).filter(Boolean));
      const failing = nodes.find((node) => !targetValues.has(readField(node, target.field ?? 'name')));
      if (failing) {
        return { status: severityStatus(rule.severity), detail: target.field ?? 'target', message: rule.failureMessage };
      }
    }
  }

  return { status: 'PASS', detail: `${nodes.length} entradas` };
}

function hasNamespace(xmlText, namespace) {
  const prefix = namespace.prefix;
  const uri = namespace.uri;
  if (!prefix || !uri) {
    return false;
  }

  const pattern = new RegExp(`xmlns:${escapeRegExp(prefix)}="${escapeRegExp(uri)}"`);
  return pattern.test(xmlText);
}

function hasAttribute(node, attribute) {
  return getAttribute(node, attribute) !== undefined;
}

function getAttribute(node, attribute) {
  return node?.attribs?.[attribute];
}

function readField(node, field) {
  if (field === 'name') {
    return node?.attribs?.name;
  }

  if (field.startsWith('attrs.')) {
    return node?.attribs?.[field.slice('attrs.'.length)];
  }

  if (node?.attribs && field in node.attribs) {
    return node.attribs[field];
  }

  return node?.[field];
}

function matchesNodeCondition(node, condition) {
  if (!condition) {
    return false;
  }

  const attribute = condition.attribute ?? condition.field;
  if (!attribute) {
    return false;
  }

  const value = String(getAttribute(node, attribute) ?? '');
  if (condition.equals !== undefined && value !== String(condition.equals)) {
    return false;
  }

  if (condition.startsWith !== undefined && !value.startsWith(String(condition.startsWith))) {
    return false;
  }

  if (condition.endsWith !== undefined && !value.endsWith(String(condition.endsWith))) {
    return false;
  }

  if (condition.contains !== undefined && !value.includes(String(condition.contains))) {
    return false;
  }

  return true;
}

function resolveStyleSectionContext(xmlPath, section) {
  const sectionName = sectionToFolderName(section);
  return `/archimate:model/folder[@name="${sectionName}"]`;
}

function sectionToFolderName(section) {
  const mapping = {
    TechnologyAndPhysical: 'Technology & Physical',
    ImplementationAndMigration: 'Implementation & Migration',
  };

  return mapping[section] ?? section;
}

function buildRuleResult(id, rule, status, detail, failureMessage, group) {
  return {
    id,
    description: rule?.description,
    group,
    severity: rule?.severity ?? 'error',
    status,
    detail,
    message: status === 'PASS' ? undefined : (failureMessage ?? rule?.failureMessage),
  };
}

function buildResponse(repoRoot, manifestPath, artifact, validators) {
  const summary = {
    pass: validators.filter((item) => item.status === 'PASS').length,
    warn: validators.filter((item) => item.status === 'WARN').length,
    fail: validators.filter((item) => item.status === 'FAIL').length,
  };

  const lintStatus = summary.fail > 0 ? 'FAIL' : (summary.warn > 0 ? 'WARN' : 'PASS');

  return {
    manifest: manifestPath,
    repoRoot,
    artifact,
    status: lintStatus,
    systemStatus: 'PASS',
    lintStatus,
    summary,
    validators,
  };
}

function resolveArtifact(repoRoot, artifact) {
  if (!artifact?.source?.path) {
    throw new Error('El manifest debe declarar artifact.source.path.');
  }

  const candidates = resolveArtifactCandidates(repoRoot, artifact.source.path);
  if (artifact.source.mode === 'single-file') {
    if (candidates.length === 0) {
      throw new Error(`No se encontró ningún artefacto para '${artifact.source.path}'.`);
    }

    if (candidates.length > 1) {
      throw new Error(`Se esperaban un único artefacto para '${artifact.source.path}', pero se encontraron ${candidates.length}.`);
    }
  }

  const current = candidates[0];
  if (!current) {
    throw new Error(`No se pudo resolver el artefacto '${artifact.source.path}'.`);
  }

  if (!isFile(current)) {
    throw new Error(`El artefacto resuelto no existe: ${current}.`);
  }

  return {
    type: artifact.type,
    tool: artifact.tool,
    source: artifact.source,
    current,
  };
}

function resolveArtifactCandidates(repoRoot, sourcePath) {
  if (!hasGlob(sourcePath)) {
    return [path.resolve(repoRoot, sourcePath)];
  }

  const normalized = sourcePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const folderPart = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '.';
  const patternPart = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const folderPath = path.resolve(repoRoot, folderPart);

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return [];
  }

  const matcher = globPatternToRegExp(patternPart);
  return fs.readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => path.join(folderPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function hasGlob(value) {
  return /[*?\[]/.test(value);
}

function globPatternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[-/\\^$+?.()|{}]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function severityStatus(severity) {
  return severity === 'warning' ? 'WARN' : 'FAIL';
}

function groupChecks(checks) {
  const grouped = {};
  for (const check of checks) {
    const group = check.group ?? 'General';
    if (!grouped[group]) {
      grouped[group] = [];
    }
    grouped[group].push(check);
  }
  return grouped;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildErrorResponse(manifestPath, error) {
  return {
    manifest: manifestPath,
    status: 'ERROR',
    systemStatus: 'ERROR',
    lintStatus: 'UNKNOWN',
    summary: { pass: 0, warn: 0, fail: 0 },
    validators: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

Engine.buildErrorResponse = buildErrorResponse;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Engine.main();
}
