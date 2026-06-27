import fs from 'node:fs';
import path from 'node:path';

export function getArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function resolveArgPath(name, fallback) {
  return path.resolve(getArg(name, fallback));
}

export function loadYamlFile(filePath) {
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

export function isDirectory(targetPath) {
  return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

export function isFile(targetPath) {
  return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
}

export function listVisibleEntries(folderPath) {
  return fs.readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

export function extractXmlRoot(text) {
  const normalized = text.replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>\s*/, '');
  const match = normalized.match(/^<\s*([A-Za-z0-9_.:-]+)([^>]*)>/);
  return { root: match ? match[1] : '' };
}
