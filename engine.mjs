import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractXmlRoot, getArg, isDirectory, isFile, listVisibleEntries, loadYamlFile, readText, resolveArgPath } from './common.mjs';

export const Engine = {
  version: '1.0.0',
  defaultRepoPath: '.',

  init() {
    console.log(`Iniciando motor v${Engine.version}...`);
  },

  validateYaml(filePath) {
    return loadYamlFile(filePath);
  },

  evaluateRules(repoRoot, ruleSet) {
    const state = { status: 'PASS', observations: [], checks: [] };
    const repoName = path.basename(repoRoot);

    if (ruleSet.schemaVersion !== undefined && ruleSet.schemaVersion !== 1) {
      state.status = 'FAIL';
      state.observations.push(`Versión de esquema no soportada: '${ruleSet.schemaVersion}'.`);
    }

    for (const check of ruleSet.checks ?? []) {
      const result = evaluateCheck(repoRoot, repoName, check);
      state.checks.push({ id: result.id, description: check.description, status: result.status, detail: result.detail, failureMessage: result.failureMessage });
      if (result.status === 'FAIL') {
        state.status = 'FAIL';
        state.observations.push(result.failureMessage);
      }
    }

    state.status = state.status === 'PASS' && state.checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
    return state;
  },

  loadManifestValidators(manifestPath) {
    const manifest = loadYamlFile(manifestPath);
    const manifestDir = path.dirname(manifestPath);
    const rules = [];

    for (const entry of manifest.rules ?? []) {
      const ruleSetPath = path.resolve(manifestDir, entry.ruleFile);
      const ruleSet = loadYamlFile(ruleSetPath);
      rules.push({
        id: entry.ruleFile,
        title: entry.title ?? ruleSet.title ?? entry.ruleFile,
        description: entry.description ?? ruleSet.description,
        schemaVersion: ruleSet.schemaVersion ?? 1,
        tool: ruleSet.tool,
        format: ruleSet.format,
        dialect: ruleSet.dialect,
        target: ruleSet.target,
        purpose: ruleSet.purpose,
        scope: ruleSet.scope,
        checks: ruleSet.checks ?? [],
      });
    }

    return rules;
  },

  buildResponse(manifestPath, validators) {
    return {
      manifest: manifestPath,
      status: validators.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
      summary: { pass: validators.filter((item) => item.status === 'PASS').length, fail: validators.filter((item) => item.status === 'FAIL').length },
      validators,
    };
  },

  runManifest(repoRoot, manifestPath) {
    const validators = this.loadManifestValidators(manifestPath).map((ruleSet) => ({
      ...ruleSet,
      ...this.evaluateRules(repoRoot, ruleSet),
    }));

    return this.buildResponse(manifestPath, validators);
  },

  renderSummary(response) {
    const lines = [];
    lines.push('| Regla | Estado |');
    lines.push('|---|---|');

    for (const validator of response.validators ?? []) {
      lines.push(`| ${validator.title ?? validator.id ?? 'Sin título'} | \`${validator.status ?? 'UNKNOWN'}\` |`);
    }

    lines.push('');
    lines.push(`- Estado global: \`${response.status ?? 'UNKNOWN'}\``);
    lines.push(`- Reglas OK: \`${response.summary?.pass ?? 0}\``);
    lines.push(`- Reglas con fallo: \`${response.summary?.fail ?? 0}\``);

    for (const validator of response.validators ?? []) {
      lines.push('');
      lines.push(`### ${validator.title ?? validator.id ?? 'Regla'}`);
      lines.push(`- Esquema: \`${validator.schemaVersion ?? 'UNKNOWN'}\``);
      lines.push(`- Herramienta: \`${validator.tool ?? 'UNKNOWN'}\``);
      lines.push(`- Formato: \`${validator.format ?? 'UNKNOWN'}\``);
      lines.push(`- Dialecto: \`${validator.dialect ?? 'UNKNOWN'}\``);
      if (validator.target?.path) {
        lines.push(`- Objetivo: \`${validator.target.path}\``);
      }
      if (validator.purpose) {
        lines.push(`- Propósito: ${validator.purpose}`);
      }
      lines.push(`- Estado: \`${validator.status ?? 'UNKNOWN'}\``);
      for (const check of validator.checks ?? []) {
        const detail = check.detail === undefined ? '' : ` (${check.detail})`;
        lines.push(`- ${check.id}: ${check.description ? `${check.description} ` : ''}\`${check.status}\`${detail}`);
      }
      for (const item of validator.observations ?? []) {
        lines.push(`- ${item}`);
      }
    }

    return `${lines.join('\n')}\n`;
  },

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
    const manifestPath = resolveArgPath('--manifest', path.join(process.cwd(), 'rules/manifest.yaml'));

    const response = this.runManifest(repoRoot, manifestPath);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  },
};

function evaluateCheck(repoRoot, repoName, check) {
  const id = check.id || check.type;
  const defaultMessages = {
    'repository-name': `El nombre del repositorio no coincide con '${check.pattern}'.`,
    path: `La ruta '${check.path}' no existe o no tiene el tipo esperado.`,
    'single-visible-file': `La carpeta '${check.path}' no contiene exactamente el archivo '${check.name}'.`,
    'file-not-empty': `El archivo '${check.path}' está vacío.`,
    'xml-root': `El archivo '${check.path}' no tiene la raíz XML esperada '${check.root}'.`,
    'text-contains': `El archivo '${check.path}' no contiene el texto esperado.`,
    'xml-name-regex': `El archivo '${check.path}' no cumple la convención de nombres esperada.`,
    'xml-name-not-contains': `El archivo '${check.path}' contiene nombres no permitidos.`,
  };
  const failureMessage = check.failureMessage || defaultMessages[check.type] || `Regla desconocida: '${check.type}'.`;

  if (check.type === 'repository-name') {
    const pattern = new RegExp(check.pattern);
    const ok = pattern.test(repoName);
    return { id, description: check.description, status: ok ? 'PASS' : 'FAIL', detail: repoName, failureMessage: ok ? undefined : failureMessage };
  }

  const absolutePath = path.resolve(repoRoot, check.path);

  if (check.type === 'path') {
    if (check.kind !== 'file' && check.kind !== 'dir') {
      return { id, description: check.description, status: 'FAIL', detail: check.kind, failureMessage: `Tipo de ruta no válido: '${check.kind}'.` };
    }
    const ok = check.kind === 'file' ? isFile(absolutePath) : isDirectory(absolutePath);
    return { id, description: check.description, status: ok ? 'PASS' : 'FAIL', detail: check.kind, failureMessage: ok ? undefined : failureMessage };
  }

  if (check.type === 'single-visible-file') {
    let ok = false;
    if (isDirectory(absolutePath)) {
      const entries = listVisibleEntries(absolutePath);
      ok = entries.length === 1 && entries[0].name === check.name && entries[0].isFile && !entries[0].isDirectory;
    }
    return { id, description: check.description, status: ok ? 'PASS' : 'FAIL', detail: check.name, failureMessage: ok ? undefined : failureMessage };
  }

  if (check.type === 'file-not-empty') {
    const ok = isFile(absolutePath) && readText(absolutePath).trim().length > 0;
    return { id, description: check.description, status: ok ? 'PASS' : 'FAIL', detail: check.path, failureMessage: ok ? undefined : failureMessage };
  }

  if (check.type === 'xml-root') {
    if (!isFile(absolutePath)) {
      return { id, description: check.description, status: 'FAIL', detail: check.root, failureMessage };
    }
    const { root } = extractXmlRoot(readText(absolutePath));
    const ok = root === check.root;
    return { id, description: check.description, status: ok ? 'PASS' : 'FAIL', detail: root, failureMessage: ok ? undefined : failureMessage };
  }

  if (check.type === 'text-contains') {
    const ok = isFile(absolutePath) && readText(absolutePath).includes(check.text);
    return { id, description: check.description, status: ok ? 'PASS' : 'FAIL', detail: check.text, failureMessage: ok ? undefined : failureMessage };
  }

  if (check.type === 'xml-name-regex') {
    if (!isFile(absolutePath)) {
      return { id, description: check.description, status: 'FAIL', detail: check.selector ?? check.path, failureMessage };
    }

    const entries = selectXmlEntries(readText(absolutePath), check.selector);
    if (entries.length === 0) {
      return { id, description: check.description, status: 'PASS', detail: 'sin coincidencias' };
    }
    const pattern = new RegExp(check.pattern);
    const firstFailure = entries.find((entry) => !pattern.test(entry.name ?? ''));
    return {
      id,
      description: check.description,
      status: firstFailure ? 'FAIL' : 'PASS',
      detail: firstFailure ? firstFailure.name : `${entries.length} entradas`,
      failureMessage: firstFailure ? failureMessage : undefined,
    };
  }

  if (check.type === 'xml-name-not-contains') {
    if (!isFile(absolutePath)) {
      return { id, description: check.description, status: 'FAIL', detail: check.selector ?? check.path, failureMessage };
    }

    const entries = selectXmlEntries(readText(absolutePath), check.selector);
    if (entries.length === 0) {
      return { id, description: check.description, status: 'PASS', detail: 'sin coincidencias' };
    }
    const forbidden = new Set(check.forbidden ?? []);
    const firstFailure = entries.find((entry) => forbidden.has(entry.name ?? ''));
    return {
      id,
      description: check.description,
      status: firstFailure ? 'FAIL' : 'PASS',
      detail: firstFailure ? firstFailure.name : `${entries.length} entradas`,
      failureMessage: firstFailure ? failureMessage : undefined,
    };
  }

  return { id, description: check.description, status: 'FAIL', detail: check.type, failureMessage: `Regla desconocida: '${check.type}'.` };
}

function selectXmlEntries(xmlText, selector) {
  const entries = parseXmlEntries(xmlText);

  if (!selector || selector === 'any') {
    return entries;
  }

  if (selector === 'folder') {
    return entries.filter((entry) => entry.tag === 'folder');
  }

  if (selector === 'folder[name]') {
    return entries.filter((entry) => entry.tag === 'folder' && entry.attrs.name !== undefined);
  }

  const elementTypeMatch = selector.match(/^element\[xsi:type="([^"]+)"\]$/);
  if (elementTypeMatch) {
    const expectedType = elementTypeMatch[1];
    return entries.filter((entry) => entry.tag === 'element' && entry.attrs['xsi:type'] === expectedType);
  }

  return [];
}

function parseXmlEntries(xmlText) {
  const normalized = xmlText.replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>\s*/, '');
  const entries = [];
  const tagPattern = new RegExp('<(?!\\?|\\/|!--)([A-Za-z0-9_.:-]+)([^>]*)\\/?>(?!>)', 'g');
  let match;

  while ((match = tagPattern.exec(normalized)) !== null) {
    const tag = match[1];
    const attrs = {};
    const attrText = match[2] || '';
    const attrPattern = /([A-Za-z0-9_.:-]+)="([^"]*)"/g;
    let attrMatch;

    while ((attrMatch = attrPattern.exec(attrText)) !== null) {
      attrs[attrMatch[1]] = decodeXmlEntities(attrMatch[2]);
    }

    entries.push({ tag, attrs, name: attrs.name });
  }

  return entries;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Engine.main();
}
