import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export function getArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function resolveArgPath(name, fallback) {
  return path.resolve(getArg(name, fallback));
}

export function loadYamlFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');

  try {
    return parseYaml(text) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo interpretar el archivo YAML '${filePath}': ${message}`);
  }
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
