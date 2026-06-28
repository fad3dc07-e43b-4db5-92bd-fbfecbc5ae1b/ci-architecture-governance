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

    if (mode === 'summary') {
      const response = JSON.parse(process.env.VALIDATION_RESPONSE?.trim() || '{}');
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;

      if (summaryFile) {
        fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
        fs.writeFileSync(summaryFile, this.renderSummary(response), 'utf8');
      }

      process.stdout.write(`${response.status ?? 'FAIL'}\n`);
      return;
    }

    const repoRoot = resolveArgPath('--repo-root', process.cwd());
    const manifestPath = resolveArgPath('--manifest', path.join(process.cwd(), this.defaultManifestPath));

    try {
      const response = this.runManifest(repoRoot, manifestPath);
      process.stdout.write(`${JSON.stringify(response)}\n`);
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

    return buildResponse(manifestPath, artifact, validators);
  },

  renderSummary(response) {
    const lines = [];
    lines.push('| DSL | Estado |');
    lines.push('|---|---|');

    for (const validator of response.validators ?? []) {
      lines.push(`| ${validator.title ?? validator.id ?? 'Sin título'} | \`${validator.status ?? 'UNKNOWN'}\` |`);
    }

    lines.push('');
    lines.push(`- Estado global: \`${response.status ?? 'UNKNOWN'}\``);
    lines.push(`- Estado del sistema: \`${response.systemStatus ?? 'UNKNOWN'}\``);
    lines.push(`- Estado del linter: \`${response.lintStatus ?? 'UNKNOWN'}\``);
    lines.push(`- DSLs OK: \`${response.summary?.pass ?? 0}\``);
    lines.push(`- DSLs con advertencia: \`${response.summary?.warn ?? 0}\``);
    lines.push(`- DSLs con fallo: \`${response.summary?.fail ?? 0}\``);
    if (response.error) {
      lines.push(`- Error: ${response.error}`);
    }

    for (const validator of response.validators ?? []) {
      lines.push('');
      lines.push(`### ${validator.title ?? validator.id ?? 'DSL'}`);
      lines.push(`- Tipo: \`${validator.dslType ?? 'UNKNOWN'}\``);
      lines.push(`- Estado: \`${validator.status ?? 'UNKNOWN'}\``);
      if (validator.file) {
        lines.push(`- Archivo: \`${validator.file}\``);
      }
      if (validator.purpose) {
        lines.push(`- Propósito: ${validator.purpose}`);
      }

      for (const [group, checks] of Object.entries(groupChecks(validator.checks ?? []))) {
        lines.push(`#### ${group}`);
        for (const check of checks) {
          const detail = check.detail === undefined ? '' : ` (${check.detail})`;
          lines.push(`- ${check.id}: ${check.description ? `${check.description} ` : ''}\`${check.status}\`${detail}`);
        }
      }

      for (const item of validator.observations ?? []) {
        lines.push(`- ${item}`);
      }
    }

    return `${lines.join('\n')}\n`;
  },
};

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
    const seen = new Set();
    for (const value of values) {
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

function buildResponse(manifestPath, artifact, validators) {
  const summary = {
    pass: validators.filter((item) => item.status === 'PASS').length,
    warn: validators.filter((item) => item.status === 'WARN').length,
    fail: validators.filter((item) => item.status === 'FAIL').length,
  };

  const lintStatus = summary.fail > 0 ? 'FAIL' : (summary.warn > 0 ? 'WARN' : 'PASS');

  return {
    manifest: manifestPath,
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
