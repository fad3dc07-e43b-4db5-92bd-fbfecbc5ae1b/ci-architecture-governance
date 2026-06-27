import fs from 'node:fs';
import path from 'node:path';

function readJsonEnv(name, fallback = '{}') {
  return JSON.parse(process.env[name] ?? fallback);
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function main() {
  const report = readJsonEnv('VALIDATION_REPORT');
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;

  const lines = [];
  lines.push('| Validador | Estado |');
  lines.push('|---|---|');

  for (const validator of report.validators ?? []) {
    lines.push(`| ${validator.title ?? validator.id ?? 'Sin título'} | \`${validator.status ?? 'UNKNOWN'}\` |`);
  }

  lines.push('');
  lines.push(`- Estado global: \`${report.status ?? 'UNKNOWN'}\``);
  lines.push(`- Validadores OK: \`${report.summary?.pass ?? 0}\``);
  lines.push(`- Validadores con fallo: \`${report.summary?.fail ?? 0}\``);

  for (const validator of report.validators ?? []) {
    lines.push('');
    lines.push(`### ${validator.title ?? validator.id ?? 'Validador'}`);
    lines.push(`- Estado: \`${validator.status ?? 'UNKNOWN'}\``);
    for (const check of validator.checks ?? []) {
      const detail = check.detail === undefined ? '' : ` (${check.detail})`;
      lines.push(`- ${check.id}: \`${check.status}\`${detail}`);
    }
    for (const item of validator.observations ?? []) {
      lines.push(`- ${item}`);
    }
  }

  if (summaryFile) {
    writeTextFile(summaryFile, `${lines.join('\n')}\n`);
  }

  process.stdout.write(`${report.status ?? 'FAIL'}\n`);
}

main();
