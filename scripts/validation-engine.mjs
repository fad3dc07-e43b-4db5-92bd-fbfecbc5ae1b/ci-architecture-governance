import fs from 'node:fs';
import path from 'node:path';
import {
  addValidationCheck,
  createValidationReport,
  createValidationState,
  failValidation,
  getArg,
  loadYamlFile,
  resolveArgPath,
  writeJsonReport,
} from './common.mjs';

function isDirectory(targetPath) {
  return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

function isFile(targetPath) {
  return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
}

function listVisibleEntries(folderPath) {
  return fs.readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function stripXmlDeclaration(text) {
  return text.replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>\s*/, '');
}

function extractXmlRoot(text) {
  const normalized = stripXmlDeclaration(text);
  const match = normalized.match(/^<\s*([A-Za-z0-9_.:-]+)([^>]*)>/);
  return {
    normalized,
    root: match ? match[1] : '',
  };
}

function defaultMessage(check) {
  switch (check.type) {
    case 'repository-name':
      return `El nombre del repositorio no coincide con '${check.pattern}'.`;
    case 'path':
      return `La ruta '${check.path}' no existe o no tiene el tipo esperado.`;
    case 'single-visible-file':
      return `La carpeta '${check.path}' no contiene exactamente el archivo '${check.name}'.`;
    case 'file-not-empty':
      return `El archivo '${check.path}' está vacío.`;
    case 'xml-root':
      return `El archivo '${check.path}' no tiene la raíz XML esperada '${check.root}'.`;
    case 'text-contains':
      return `El archivo '${check.path}' no contiene el texto esperado.`;
    default:
      return `Regla desconocida: '${check.type}'.`;
  }
}

function evaluateCheck(repoRoot, repoName, check) {
  const id = check.id || check.type;
  const message = check.message || defaultMessage(check);

  if (check.type === 'repository-name') {
    const pattern = new RegExp(check.pattern);
    const ok = pattern.test(repoName);
    return { id, status: ok ? 'PASS' : 'FAIL', detail: repoName, message: ok ? undefined : message };
  }

  const absolutePath = path.resolve(repoRoot, check.path);

  if (check.type === 'path') {
    const ok = check.kind === 'file' ? isFile(absolutePath) : isDirectory(absolutePath);
    return { id, status: ok ? 'PASS' : 'FAIL', detail: check.kind, message: ok ? undefined : message };
  }

  if (check.type === 'single-visible-file') {
    const ok = isDirectory(absolutePath)
      && (() => {
        const entries = listVisibleEntries(absolutePath);
        return entries.length === 1
          && entries[0].name === check.name
          && entries[0].isFile
          && !entries[0].isDirectory;
      })();
    return { id, status: ok ? 'PASS' : 'FAIL', detail: check.name, message: ok ? undefined : message };
  }

  if (check.type === 'file-not-empty') {
    const ok = isFile(absolutePath) && readText(absolutePath).trim().length > 0;
    return { id, status: ok ? 'PASS' : 'FAIL', detail: check.path, message: ok ? undefined : message };
  }

  if (check.type === 'xml-root') {
    if (!isFile(absolutePath)) {
      return { id, status: 'FAIL', detail: check.root, message };
    }
    const text = readText(absolutePath);
    const { root } = extractXmlRoot(text);
    const ok = root === check.root;
    return { id, status: ok ? 'PASS' : 'FAIL', detail: root, message: ok ? undefined : message };
  }

  if (check.type === 'text-contains') {
    const ok = isFile(absolutePath) && readText(absolutePath).includes(check.text);
    return { id, status: ok ? 'PASS' : 'FAIL', detail: check.text, message: ok ? undefined : message };
  }

  return { id, status: 'FAIL', detail: check.type, message: `Regla desconocida: '${check.type}'.` };
}

function evaluateRuleSet(repoRoot, ruleSet) {
  const state = createValidationState();
  const repoName = path.basename(repoRoot);

  if (ruleSet.repositoryNamePattern) {
    const result = evaluateCheck(repoRoot, repoName, {
      type: 'repository-name',
      pattern: ruleSet.repositoryNamePattern,
      message: ruleSet.repositoryNameMessage,
      id: 'repository_name',
    });
    addValidationCheck(state, result.id, result.status, result.detail, result.message);
    if (result.status === 'FAIL') {
      failValidation(state, result.message);
    }
  }

  for (const check of ruleSet.checks ?? []) {
    const result = evaluateCheck(repoRoot, repoName, check);
    addValidationCheck(state, result.id, result.status, result.detail, result.message);
    if (result.status === 'FAIL') {
      failValidation(state, result.message);
    }
  }

  return createValidationReport(
    {
      id: ruleSet.id,
      title: ruleSet.title ?? ruleSet.id,
      description: ruleSet.description,
    },
    state,
  );
}

function runManifest(repoRoot, manifestPath) {
  const manifest = loadYamlFile(manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const validators = [];

  for (const entry of manifest.validators ?? []) {
    const ruleSetPath = path.resolve(manifestDir, entry.ruleFile);
    const ruleSet = loadYamlFile(ruleSetPath);
    const mergedRuleSet = {
      id: entry.id ?? ruleSet.id,
      title: entry.title ?? ruleSet.title ?? entry.id ?? ruleSet.id,
      description: entry.description ?? ruleSet.description,
      repositoryNamePattern: ruleSet.repositoryNamePattern,
      repositoryNameMessage: ruleSet.repositoryNameMessage,
      checks: ruleSet.checks ?? [],
    };

    validators.push(evaluateRuleSet(repoRoot, mergedRuleSet));
  }

  const status = validators.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  return {
    manifest: manifestPath,
    status,
    summary: {
      pass: validators.filter((item) => item.status === 'PASS').length,
      fail: validators.filter((item) => item.status === 'FAIL').length,
    },
    validators,
  };
}

function main() {
  const repoRoot = resolveArgPath('--repo-root', process.cwd());
  const manifestPath = resolveArgPath('--manifest', path.join(process.cwd(), 'rules/validators.json'));
  const reportFile = resolveArgPath('--report-file', path.join(process.cwd(), 'validation-report.json'));

  const report = runManifest(repoRoot, manifestPath);
  writeJsonReport(reportFile, report);
  process.stdout.write(`${report.status}\n`);
}

main();
