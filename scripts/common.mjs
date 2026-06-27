import fs from 'node:fs';
import path from 'node:path';

// Componentes compartidos para los scripts de gobernanza.
// Mantiene fuera del engine la lectura de argumentos, el estado común y el I/O.
export function getArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

export function resolveArgPath(name, fallback) {
  return path.resolve(getArg(name, fallback));
}

function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function countIndent(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === '') {
    return '';
  }
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

function peekNextIndent(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (isBlankOrComment(lines[index])) {
      continue;
    }
    return countIndent(lines[index]);
  }
  return null;
}

function parseYamlBlock(lines, state, indent) {
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
    if (currentIndent < indent) {
      break;
    }
    if (currentIndent > indent) {
      break;
    }

    const trimmed = line.slice(indent);

    if (trimmed.startsWith('- ')) {
      if (mode === null) {
        mode = 'seq';
      } else if (mode !== 'seq') {
        break;
      }

      const itemText = trimmed.slice(2).trim();
      state.index += 1;

      if (itemText === '') {
        const nextIndent = peekNextIndent(lines, state.index);
        arrayValue.push(parseYamlBlock(lines, state, nextIndent ?? indent + 2));
        continue;
      }

      if (itemText.includes(':')) {
        const { key, hasValue, value } = parseKeyValue(itemText);
        const item = { [key]: hasValue ? parseScalar(value) : null };
        const nextIndent = peekNextIndent(lines, state.index);
        if (nextIndent !== null && nextIndent > indent) {
          const nested = parseYamlBlock(lines, state, nextIndent);
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

    if (mode === null) {
      mode = 'map';
    } else if (mode !== 'map') {
      break;
    }

    const { key, hasValue, value } = parseKeyValue(trimmed);
    state.index += 1;

    if (hasValue) {
      objectValue[key] = parseScalar(value);
      continue;
    }

    const nextIndent = peekNextIndent(lines, state.index);
    objectValue[key] = nextIndent !== null && nextIndent > indent
      ? parseYamlBlock(lines, state, nextIndent)
      : null;
  }

  return mode === 'seq' ? arrayValue : objectValue;
}

export function loadYamlFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const state = { index: 0 };
  return parseYamlBlock(lines, state, 0);
}

export function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function createValidationState() {
  return {
    status: 'PASS',
    observations: [],
    checks: [],
  };
}

export function failValidation(state, message) {
  state.status = 'FAIL';
  state.observations.push(message);
}

export function addValidationCheck(state, id, status, detail = undefined, message = undefined) {
  state.checks.push({ id, status, detail, message });
}

export function computeValidationStatus(state) {
  return state.status === 'PASS' && state.checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
}

export function createValidationReport(base, state) {
  return {
    ...base,
    status: computeValidationStatus(state),
    checks: state.checks,
    observations: state.observations,
  };
}

export function writeJsonReport(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

export function readJsonEnv(name, fallback = '{}') {
  return JSON.parse(process.env[name] ?? fallback);
}
