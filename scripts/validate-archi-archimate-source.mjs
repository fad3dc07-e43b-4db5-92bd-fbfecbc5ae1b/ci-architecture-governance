import fs from 'node:fs';
import path from 'node:path';

// Valida un archivo fuente compatible con Archi y ArchiMate dentro de `artifact/source`.
// El script exige un único archivo `design.archimate` y comprueba marcadores típicos
// de un export de Archi antes de escribir el reporte.
function getArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const config = {
  sourcePath: path.resolve(getArg('--source-path', path.join(process.cwd(), 'artifact/source'))),
  expectedFileName: getArg('--expected-file', 'design.archimate'),
  expectedRootTag: getArg('--expected-root-tag', 'archimate:model'),
  reportFile: path.resolve(getArg('--report-file', path.join(process.cwd(), 'archimate-source-report.json'))),
};

const state = {
  status: 'PASS',
  observations: [],
  checks: [],
};

function fail(message) {
  state.status = 'FAIL';
  state.observations.push(message);
}

function addCheck(name, status, detail) {
  state.checks.push(detail === undefined ? { name, status } : { name, status, detail });
}

function isDirectory(targetPath) {
  return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

function listVisibleEntries(folderPath) {
  return fs.readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function inspectSourceFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const normalized = text.replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>\s*/, '');
  const openTagMatch = normalized.match(/^<\s*([A-Za-z0-9_.:-]+)([^>]*)>/);
  const openTag = openTagMatch ? openTagMatch[1] : '';
  const hasClosingTag = normalized.includes(`</${config.expectedRootTag}>`);
  const hasArchimateNamespace = /xmlns:archimate\s*=\s*['"][^'"]+['"]/i.test(text);

  return {
    text,
    openTag,
    hasClosingTag,
    hasArchimateNamespace,
  };
}

function validateSourceFolder() {
  if (!isDirectory(config.sourcePath)) {
    fail(`La carpeta fuente '${config.sourcePath}' no existe o no es un directorio.`);
    return;
  }

  // La carpeta fuente debe contener un único archivo visible con el nombre esperado.
  const visibleEntries = listVisibleEntries(config.sourcePath);
  const expectedFilePath = path.resolve(config.sourcePath, config.expectedFileName);
  const exactMatch = visibleEntries.length === 1
    && visibleEntries[0].name === config.expectedFileName
    && visibleEntries[0].isFile
    && !visibleEntries[0].isDirectory;

  if (!exactMatch) {
    fail(`Se esperaba solo '${expectedFilePath}' dentro de '${config.sourcePath}', pero se encontró: ${JSON.stringify(visibleEntries.map((entry) => entry.name))}.`);
    return;
  }

  const sourceFile = inspectSourceFile(expectedFilePath);
  if (!sourceFile.text.trim()) {
    fail(`'${expectedFilePath}' está vacío.`);
    return;
  }

  if (sourceFile.openTag !== config.expectedRootTag) {
    fail(`'${expectedFilePath}' no tiene un elemento raíz de modelo ArchiMate.`);
    return;
  }

  if (!sourceFile.hasArchimateNamespace || !/\bmodel\b/i.test(sourceFile.openTag)) {
    fail(`'${expectedFilePath}' no tiene el namespace de ArchiMate o los atributos base del modelo.`);
    return;
  }

  if (!sourceFile.hasClosingTag) {
    fail(`'${expectedFilePath}' no tiene la etiqueta de cierre del modelo ArchiMate.`);
    return;
  }

  addCheck('archimate_model_root', 'PASS', sourceFile.openTag);
  addCheck('archimate_namespace', 'PASS', sourceFile.hasArchimateNamespace ? 'presente' : 'ausente');
}

// Si ninguna verificación específica corrió, deja una marca única para el reporte.
function finalizeChecks() {
  if (state.checks.length === 0) {
    addCheck('design_archimate', state.status);
  }
}

function writeReport() {
  const report = {
    path: config.sourcePath,
    status: state.status,
    checks: state.checks,
    observations: state.observations,
  };

  // Escribe el reporte en disco; el workflow lo lee y lo publica como salida.
  fs.mkdirSync(path.dirname(config.reportFile), { recursive: true });
  fs.writeFileSync(config.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${state.status}\n`);
}

validateSourceFolder();
finalizeChecks();
writeReport();
