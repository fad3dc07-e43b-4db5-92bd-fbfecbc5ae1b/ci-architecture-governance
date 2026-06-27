import fs from 'node:fs';
import path from 'node:path';

function getArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function resolveArgPath(name, fallback) {
  return path.resolve(getArg(name, fallback));
}

function loadYamlFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const state = { index: 0 };

  function isBlankOrComment(line) {
    const trimmed = line.trim();
    return trimmed === '' || trimmed.startsWith('#');
  }

  function countIndent(line) {
    return line.match(/^ */)?.[0].length ?? 0;
  }

  function parseScalar(value) {
    const trimmed = value.trim();
    if (trimmed === '') return '';
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null' || trimmed === '~') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  }

  function parseKeyValue(text) {
    const colonIndex = text.indexOf(':');
    if (colonIndex < 0) {
      throw new Error(`No se pudo interpretar la línea YAML: '${text}'.`);
    }
    const key = text.slice(0, colonIndex).trim();
    const value = text.slice(colonIndex + 1).trim();
    return { key, hasValue: value !== '', value };
  }

  function peekNextIndent(startIndex) {
    for (let index = startIndex; index < lines.length; index += 1) {
      if (isBlankOrComment(lines[index])) continue;
      return countIndent(lines[index]);
    }
    return null;
  }

  function parseYamlBlock(indent) {
    let mode = null;
    const objectValue = {};
    const arrayValue = [];

    while (state.index < lines.length) {
      const line = lines[state.index];
      if (isBlankOrComment(line)) {
        state.index += 1;
        continue;
      }

      const currentIndent = countIndent(line);
      if (currentIndent < indent || currentIndent > indent) {
        break;
      }

      const trimmed = line.slice(indent);
      if (trimmed.startsWith('- ')) {
        if (mode === null) mode = 'seq';
        if (mode !== 'seq') break;

        const itemText = trimmed.slice(2).trim();
        state.index += 1;

        if (itemText === '') {
          const nextIndent = peekNextIndent(state.index);
          arrayValue.push(parseYamlBlock(nextIndent ?? indent + 2));
          continue;
        }

        if (itemText.includes(':')) {
          const { key, hasValue, value } = parseKeyValue(itemText);
          const item = { [key]: hasValue ? parseScalar(value) : null };
          const nextIndent = peekNextIndent(state.index);
          if (nextIndent !== null && nextIndent > indent) {
            const nested = parseYamlBlock(nextIndent);
            if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
              Object.assign(item, nested);
            }
          }
          arrayValue.push(item);
          continue;
        }

        arrayValue.push(parseScalar(itemText));
        continue;
      }

      if (mode === null) mode = 'map';
      if (mode !== 'map') break;

      const { key, hasValue, value } = parseKeyValue(trimmed);
      state.index += 1;

      if (hasValue) {
        objectValue[key] = parseScalar(value);
        continue;
      }

      const nextIndent = peekNextIndent(state.index);
      objectValue[key] = nextIndent !== null && nextIndent > indent ? parseYamlBlock(nextIndent) : null;
    }

    return mode === 'seq' ? arrayValue : objectValue;
  }

  return parseYamlBlock(0);
}

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
  return { root: match ? match[1] : '' };
}

function defaultMessage(check) {
  switch (check.type) {
    case 'repository-name': return `El nombre del repositorio no coincide con '${check.pattern}'.`;
    case 'path': return `La ruta '${check.path}' no existe o no tiene el tipo esperado.`;
    case 'single-visible-file': return `La carpeta '${check.path}' no contiene exactamente el archivo '${check.name}'.`;
    case 'file-not-empty': return `El archivo '${check.path}' está vacío.`;
    case 'xml-root': return `El archivo '${check.path}' no tiene la raíz XML esperada '${check.root}'.`;
    case 'text-contains': return `El archivo '${check.path}' no contiene el texto esperado.`;
    default: return `Regla desconocida: '${check.type}'.`;
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
        return entries.length === 1 && entries[0].name === check.name && entries[0].isFile && !entries[0].isDirectory;
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
    const { root } = extractXmlRoot(readText(absolutePath));
    const ok = root === check.root;
    return { id, status: ok ? 'PASS' : 'FAIL', detail: root, message: ok ? undefined : message };
  }

  if (check.type === 'text-contains') {
    const ok = isFile(absolutePath) && readText(absolutePath).includes(check.text);
    return { id, status: ok ? 'PASS' : 'FAIL', detail: check.text, message: ok ? undefined : message };
  }

  return { id, status: 'FAIL', detail: check.type, message: `Regla desconocida: '${check.type}'.` };
}

function createValidationState() {
  return { status: 'PASS', observations: [], checks: [] };
}

function failValidation(state, message) {
  state.status = 'FAIL';
  state.observations.push(message);
}

function addValidationCheck(state, id, status, detail = undefined, message = undefined) {
  state.checks.push({ id, status, detail, message });
}

function createValidationReport(base, state) {
  return {
    ...base,
    status: state.status === 'PASS' && state.checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    checks: state.checks,
    observations: state.observations,
  };
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
    if (result.status === 'FAIL') failValidation(state, result.message);
  }

  for (const check of ruleSet.checks ?? []) {
    const result = evaluateCheck(repoRoot, repoName, check);
    addValidationCheck(state, result.id, result.status, result.detail, result.message);
    if (result.status === 'FAIL') failValidation(state, result.message);
  }

  return createValidationReport({ id: ruleSet.id, title: ruleSet.title ?? ruleSet.id, description: ruleSet.description }, state);
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

  return {
    manifest: manifestPath,
    status: validators.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    summary: { pass: validators.filter((item) => item.status === 'PASS').length, fail: validators.filter((item) => item.status === 'FAIL').length },
    validators,
  };
}

function main() {
  const repoRoot = resolveArgPath('--repo-root', process.cwd());
  const manifestPath = resolveArgPath('--manifest', path.join(process.cwd(), 'rules/manifest.yaml'));
  const reportFile = resolveArgPath('--report-file', path.join(process.cwd(), 'validation-report.json'));

  const report = runManifest(repoRoot, manifestPath);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${report.status}\n`);
}

main();
