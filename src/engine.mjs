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

  async main() {
    const mode = getArg('--mode', 'validate');
    const repoRoot = resolveArgPath('--repo-root', process.cwd());
    const manifestPath = resolveArgPath('--manifest', path.join(process.cwd(), this.defaultManifestPath));

    if (mode === 'summary') {
      try {
        const response = this.runManifest(repoRoot, manifestPath);
        const summaryFile = process.env.GITHUB_STEP_SUMMARY;

        if (summaryFile) {
          fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
          fs.writeFileSync(summaryFile, await this.renderSummary(response), 'utf8');
        }

        process.stdout.write(`${response.systemStatus === 'ERROR' ? 'ERROR' : 'PASS'}\n`);
        return;
      } catch (error) {
        const response = this.buildErrorResponse(manifestPath, error);
        const summaryFile = process.env.GITHUB_STEP_SUMMARY;

        if (summaryFile) {
          fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
          fs.writeFileSync(summaryFile, await this.renderSummary(response), 'utf8');
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

    return buildResponse(repoRoot, manifestPath, manifest, artifact, validators);
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

  async renderSummary(response) {
    if (response.systemStatus === 'ERROR') {
      return `${renderSystemErrorSummary(response).join('\n').trimEnd()}\n`;
    }

    const validators = response.validators ?? [];
    const checks = flattenChecks(validators);
    const passChecks = checks.filter((check) => check.status === 'PASS');
    const warnChecks = checks.filter((check) => check.status === 'WARN');
    const failChecks = checks.filter((check) => check.status === 'FAIL');
    const score = calculateComplianceScore(checks);
    const rulesEvaluated = checks.length;
    const dslCount = validators.length;
    const statusCounts = countChecks(checks);
    const dashboard = await renderDashboardSectionFinal({
      validators,
      score,
      passCount: statusCounts.PASS,
      warnCount: statusCounts.WARN,
      failCount: statusCounts.FAIL,
      rulesEvaluated,
      dslCount,
      resultLabel: getResultLabel({ failCount: failChecks.length, warnCount: warnChecks.length, systemError: false }),
    });

    return `${[
      '# Calidad del diseño',
      '',
      ...dashboard.lines,
      ...renderWarningPanelFinal(warnChecks),
      ...renderCautionPanelFinal(failChecks),
      ...renderTipPanelFinal(validators, passChecks),
      ...dashboard.systemIssueLines,
    ].join('\n').trimEnd()}\n`;
  },
};

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

function formatArtifactType(value) {
  return String(value ?? 'ArchiMate').toLowerCase() === 'archimate' ? 'ArchiMate' : String(value ?? 'ArchiMate');
}

function formatToolName(value) {
  return String(value ?? 'Archi').toLowerCase() === 'archi' ? 'Archi' : String(value ?? 'Archi');
}

function flattenChecks(validators) {
  return validators.flatMap((validator) => (validator.checks ?? []).map((check) => ({
    ...check,
    validatorId: validator.id,
    validatorTitle: validator.title,
  })));
}

function getDecision({ failCount, warnCount, systemError }) {
  if (systemError) return 'No evaluable';
  if (failCount > 0) return 'No cumple';
  if (warnCount > 0) return 'Cumple con advertencias';
  return 'Cumple';
}

function isMergeAllowedSummary({ failCount, systemError }) {
  return !systemError && failCount === 0;
}

async function renderDashboardSectionFinal({ validators, score, passCount, warnCount, failCount, rulesEvaluated, dslCount, resultLabel }) {
  try {
    const dimensions = buildDimensionSummaries(validators);
    const worstDimension = [...dimensions].sort((left, right) => left.score - right.score)[0] ?? { label: 'N/A', score: 0 };
    const [complianceUrl, distributionUrl, dimensionsUrl] = await Promise.all([
      createQuickChartUrl(buildComplianceChartConfig({ score, failCount, warnCount }), { width: 220, height: 160 }),
      createQuickChartUrl(buildDistributionChartConfig({ passCount, warnCount, failCount }), { width: 260, height: 160 }),
      createQuickChartUrl(buildDimensionsChartConfig(dimensions), { width: 300, height: 160 }),
    ]);

    return {
      lines: [
        `| **Cumplimiento** [${formatScore(score)}](${complianceUrl}) | **Reglas** [PASS ${formatCount(passCount)} · WARN ${formatCount(warnCount)} · FAIL ${formatCount(failCount)}](${distributionUrl}) | **Dimensiones** [${worstDimension.label} ${formatScore(worstDimension.score)}](${dimensionsUrl}) |`,
        '',
      ],
      systemIssueLines: [],
    };
  } catch (error) {
    return {
      lines: [
        '```text',
        `Cumplimiento: ${formatScore(score)}`,
        `Resultado: ${resultLabel}`,
        `PASS: ${formatCount(passCount)} · WARN: ${formatCount(warnCount)} · FAIL: ${formatCount(failCount)}`,
        `Reglas evaluadas: ${formatCount(rulesEvaluated)} · DSLs: ${formatCount(dslCount)}`,
        '```',
        '',
      ],
      systemIssueLines: [
        '## Estado del sistema',
        '',
        '> [!CAUTION]',
        '> **ERROR — No se pudieron generar los gráficos del dashboard**',
        '>',
        `> **Detalle:** ${normalizeInlineText(error?.message ?? 'QuickChart no respondió.')}`,
        '> **Acción:** revisar conectividad hacia QuickChart o usar fallback textual.',
        '',
      ],
    };
  }
}

function buildComplianceChartConfig({ score, failCount, warnCount }) {
  const safeScore = Math.max(0, Math.min(10, Number(score) || 0));
  const remaining = Math.max(0, 10 - safeScore);
  const scoreColorHex = getScoreColor(safeScore, failCount, warnCount);

  return {
    type: 'doughnut',
    data: {
      labels: ['Cumplimiento', 'Pendiente'],
      datasets: [
        {
          data: [safeScore, remaining],
          backgroundColor: [scoreColorHex, '#e5e7eb'],
          borderWidth: 0,
        },
      ],
    },
    options: {
      layout: { padding: 4 },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Cumplimiento ${formatScore(safeScore)}`,
          font: { size: 13 },
        },
      },
      cutout: '70%',
    },
  };
}

function buildDistributionChartConfig({ passCount, warnCount, failCount }) {
  return {
    type: 'bar',
    data: {
      labels: ['PASS', 'WARN', 'FAIL'],
      datasets: [
        {
          label: 'Reglas',
          data: [passCount, warnCount, failCount],
          backgroundColor: ['#22c55e', '#f59e0b', '#ef4444'],
        },
      ],
    },
    options: {
      layout: { padding: 4 },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: 'Reglas',
          font: { size: 13 },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 10 } },
        },
        x: { ticks: { font: { size: 10 } } },
      },
    },
  };
}

function buildDimensionsChartConfig(dimensions) {
  return {
    type: 'bar',
    data: {
      labels: dimensions.map((dimension) => dimension.label),
      datasets: [
        {
          label: 'Score',
          data: dimensions.map((dimension) => dimension.score),
          backgroundColor: dimensions.map((dimension) => dimension.color),
        },
      ],
    },
    options: {
      indexAxis: 'y',
      layout: { padding: 4 },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: 'Dimensiones',
          font: { size: 13 },
        },
      },
      scales: {
        x: {
          min: 0,
          max: 10,
          ticks: { stepSize: 2, precision: 0, font: { size: 10 } },
        },
        y: {
          ticks: { font: { size: 10 } },
        },
      },
    },
  };
}

function buildDimensionSummaries(validators) {
  const dimensions = [
    {
      label: 'XML',
      matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'document',
    },
    {
      label: 'Identidad',
      matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'archiIdentity',
    },
    {
      label: 'Estructura',
      matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'archiStructure',
    },
    {
      label: 'Integridad',
      matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'internalIntegrity',
    },
    {
      label: 'Estilo',
      matches: ({ validator, check }) => validator.dslType === 'archi-style' && check.group !== 'Views',
    },
    {
      label: 'Vistas',
      matches: ({ validator, check }) => validator.dslType === 'archi-style' && check.group === 'Views',
    },
  ];

  return dimensions.map((dimension) => {
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;

    for (const validator of validators) {
      for (const check of validator.checks ?? []) {
        if (!dimension.matches({ validator, check })) {
          continue;
        }

        if (check.status === 'PASS') {
          passCount += 1;
        } else if (check.status === 'WARN') {
          warnCount += 1;
        } else if (check.status === 'FAIL') {
          failCount += 1;
        }
      }
    }

    const score = Math.max(0, 10 - warnCount - (failCount * 4));

    return {
      label: dimension.label,
      score,
      passCount,
      warnCount,
      failCount,
      color: getScoreColor(score, failCount, warnCount),
    };
  });
}

function getScoreColor(score, failCount, warnCount) {
  if (failCount > 0) {
    return '#ef4444';
  }

  if (warnCount > 0 || Number(score) < 10) {
    return '#f59e0b';
  }

  return '#22c55e';
}

async function createQuickChartUrl(chartConfig, { width = 500, height = 300 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://quickchart.io/chart/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '4',
        backgroundColor: 'white',
        width,
        height,
        format: 'png',
        devicePixelRatio: 2,
        chart: chartConfig,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`QuickChart request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const url = data.shortUrl ?? data.url;

    if (!url) {
      throw new Error('QuickChart response did not include url.');
    }

    return url;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('QuickChart request timed out after 15 seconds.');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getResultLabel({ failCount, warnCount, systemError }) {
  if (systemError) {
    return '⚫ NO EVALUABLE';
  }

  if (failCount > 0) {
    return '🔴 NO CUMPLE';
  }

  if (warnCount > 0) {
    return '🟡 ACEPTABLE CON OBSERVACIONES';
  }

  return '✅ APROBADO';
}

function renderEvaluationState(failCount, warnCount) {
  if (failCount > 0) {
    return '🔴 NO ACEPTABLE';
  }

  if (warnCount > 0) {
    return '🟡 ACEPTABLE CON OBSERVACIONES';
  }

  return '🟢 ACEPTABLE';
}

function formatCount(value) {
  if (Number(value) > 99) {
    return '99+';
  }

  return String(Math.max(0, Number(value) || 0)).padStart(2, '0');
}

function formatScore(value) {
  const safeValue = Math.max(0, Math.min(10, Number(value) || 0));
  return `${String(safeValue).padStart(2, '0')}/10`;
}

function renderScoreBar(score) {
  const safeScore = Math.max(0, Math.min(10, Number(score) || 0));
  return `${'█'.repeat(safeScore)}${'░'.repeat(10 - safeScore)}`;
}

function renderCompliancePanelFinal({ artifactPath, score, decision, mergeAllowed, failCount, warnCount, rulesEvaluated, rulesPassed }) {
  return [
    `> ## Cumplimiento: **${score === null ? 'No evaluable' : `${score}/10`}** — ${decision}`,
    '>',
    '> | Indicador | Valor |',
    '> |---|---|',
    `> | **Archivo evaluado** | \`${escapeInlineCode(artifactPath)}\` |`,
    `> | **Resultado** | ${decision} |`,
    `> | **Merge permitido** | ${mergeAllowed ? 'Sí' : 'No'} |`,
    `> | **Errores bloqueantes** | ${failCount} |`,
    `> | **Advertencias** | ${warnCount} |`,
    `> | **Reglas evaluadas** | ${rulesEvaluated} |`,
    `> | **Reglas cumplidas** | ${rulesPassed} |`,
    '',
  ];
}

function renderWarningPanelFinal(warnChecks) {
  if (warnChecks.length === 0) {
    return [];
  }

  return renderHtmlAlertPanel({
    accent: '#b7791f',
    title: `${warnChecks.length} ${pluralize(warnChecks.length, 'observación', 'observaciones')} ${warnChecks.length === 1 ? 'requiere' : 'requieren'} revisión`,
    body: warnChecks.map((check) => renderHtmlIssue(check, 'Elemento', 'Problema', 'Recomendación')).join('<br><br>'),
  });
}

function renderCautionPanelFinal(failChecks) {
  if (failChecks.length === 0) {
    return [];
  }

  return renderHtmlAlertPanel({
    accent: '#d1242f',
    title: `${failChecks.length} ${pluralize(failChecks.length, 'regla bloqueante incumplida', 'reglas bloqueantes incumplidas')}`,
    body: failChecks.map((check) => renderHtmlIssue(check, 'Elemento', 'Problema', 'Recomendación')).join('<br><br>'),
  });
}

function renderTipPanelFinal(validators, passChecks) {
  if (passChecks.length === 0) {
    return [];
  }

  const sections = [];

  for (const validator of validators) {
    const validatorPasses = (validator.checks ?? []).filter((check) => check.status === 'PASS');
    if (validatorPasses.length === 0) {
      continue;
    }

    sections.push(`<strong>${escapeHtml(validator.title ?? validator.id ?? 'Reglas')}</strong><br>`);
    for (const check of validatorPasses) {
      sections.push(`- <code>${escapeHtml(check.id)}</code> — ${escapeHtml(formatPassDescription(check.description ?? check.detail ?? 'Cumple.'))}<br>`);
    }
    sections.push('<br>');
  }

  return renderHtmlAlertPanel({
    accent: '#1f883d',
    title: `${passChecks.length} ${pluralize(passChecks.length, 'regla cumplida', 'reglas cumplidas')}`,
    body: [`<details><summary>Ver reglas cumplidas</summary><br>${sections.join('')}</details>`].join(''),
  });
}

function renderIssuePanelEntryFinal(check, elementLabel, problemLabel, recommendationLabel) {
  const lines = [`> **Regla:** \`${escapeInlineCode(check.id)}\``];
  lines.push(`> **Ubicación:** \`${escapeInlineCode(check.group ?? 'General')}\``);

  const element = getMeaningfulDetail(check.detail);
  if (element) {
    lines.push(`> **${elementLabel}:** \`${escapeInlineCode(element)}\``);
  }

  lines.push(`> **${problemLabel}:** ${normalizeInlineText(check.message ?? 'Revisar el hallazgo reportado.')}`);
  lines.push(`> **${recommendationLabel}:** ${normalizeInlineText(suggestAction(check))}`);

  return lines;
}

function renderHtmlAlertPanel({ accent, title, body }) {
  return [
    '<table>',
    '  <tr>',
    `    <td style="width:6px; background:${accent};">&nbsp;</td>`,
    '    <td>',
    `      <strong>${escapeHtml(title)}</strong><br><br>`,
    `      ${body}`,
    '    </td>',
    '  </tr>',
    '</table>',
    '',
  ];
}

function renderHtmlIssue(check, elementLabel, problemLabel, recommendationLabel) {
  const lines = [
    `<strong>Regla:</strong> <code>${escapeHtml(check.id)}</code>`,
    `<strong>Ubicación:</strong> <code>${escapeHtml(check.group ?? 'General')}</code>`,
  ];

  const element = getMeaningfulDetail(check.detail);
  if (element) {
    lines.push(`<strong>${escapeHtml(elementLabel)}:</strong> <code>${escapeHtml(element)}</code>`);
  }

  lines.push(`<strong>${escapeHtml(problemLabel)}:</strong> ${escapeHtml(normalizeInlineText(check.message ?? 'Revisar el hallazgo reportado.'))}`);
  lines.push(`<strong>${escapeHtml(recommendationLabel)}:</strong> ${escapeHtml(normalizeInlineText(suggestAction(check)))}`);

  return lines.join('<br>');
}

function groupChecksByValidator(validators) {
  return validators.map((validator) => ({
    title: validator.title ?? validator.id ?? 'Reglas',
    checks: validator.checks ?? [],
  }));
}

function labelForStatus(status) {
  if (status === 'PASS') return 'Cumple';
  if (status === 'WARN') return 'Cumple con advertencias';
  if (status === 'FAIL') return 'No cumple';
  if (status === 'ERROR') return 'Error técnico';
  return 'Desconocido';
}

function renderExceptionSummary(failChecks, warnChecks) {
  const lines = [];

  if (failChecks.length > 0) {
    lines.push(
      '## Errores bloqueantes',
      '',
      `**${failChecks.length} regla${failChecks.length === 1 ? '' : 's'} bloqueante${failChecks.length === 1 ? '' : 's'} requiere${failChecks.length === 1 ? '' : 'n'} revisión**`,
      '',
      ...renderIssueBlock(failChecks, 'Regla', 'Ubicación', 'Elemento o recurso', 'Motivo', 'Recomendación')
    );
  }

  if (warnChecks.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      '## Advertencias',
      '',
      `**${warnChecks.length} observación${warnChecks.length === 1 ? '' : 'es'} requiere${warnChecks.length === 1 ? '' : 'n'} revisión**`,
      '',
      ...renderIssueBlock(warnChecks, 'Regla', 'Ubicación', 'Elemento', 'Problema', 'Recomendación')
    );
  }

  return lines;
}

function renderIssueBlock(checks, ruleLabel, locationLabel, elementLabel, problemLabel, recommendationLabel) {
  const lines = [];

  for (const check of checks) {
    lines.push(`> **${ruleLabel}:** \`${escapeInlineCode(check.id)}\``);
    lines.push(`> **${locationLabel}:** \`${escapeInlineCode(check.group ?? 'General')}\``);

    const element = getMeaningfulDetail(check.detail);
    if (element) {
      lines.push(`> **${elementLabel}:** \`${escapeInlineCode(element)}\``);
    }

    lines.push(`> **${problemLabel}:** ${normalizeInlineText(check.message ?? 'Revisar el hallazgo reportado.')}`);
    lines.push(`> **${recommendationLabel}:** ${normalizeInlineText(suggestAction(check))}`);
    lines.push('>');
  }

  if (lines.length > 0) {
    lines.pop();
  }

  return lines;
}

function renderPassDetails(checksByValidator) {
  const passCount = checksByValidator.reduce((acc, validator) => acc + (validator.checks ?? []).filter((check) => check.status === 'PASS').length, 0);
  if (passCount === 0) {
    return [];
  }

  const lines = [
    '<details>',
    `<summary>Ver ${passCount} ${pluralize(passCount, 'regla cumplida', 'reglas cumplidas')}</summary>`,
    '',
  ];

  for (const validator of checksByValidator) {
    const passChecks = (validator.checks ?? []).filter((check) => check.status === 'PASS');
    if (passChecks.length === 0) {
      continue;
    }

    lines.push(`### ${validator.title}`);
    lines.push('');

    for (const check of passChecks) {
      lines.push(`- \`${escapeInlineCode(check.id)}\` — ${escapeMarkdownText(stripTrailingPeriod(check.description ?? check.detail ?? 'Cumple.'))}`);
    }

    lines.push('');
  }

  lines.push('</details>');
  return lines;
}

function renderScorecard({ artifactPath, artifactType, sourceTool, score, status, summary, rulesEvaluated, dslsExecuted }) {
  const mergeAllowed = isMergeAllowed(status);
  const complianceText = score === null ? 'No evaluable' : `${score}/10`;
  const complianceColor = score === null ? 'lightgrey' : scoreColor(score);
  const resultColor = statusColor(status);
  const failColor = summary.fail > 0 ? 'red' : 'brightgreen';
  const warnColor = summary.warn > 0 ? 'yellow' : 'brightgreen';

  return [
    '> [!NOTE]',
    '> **Resumen del artefacto evaluado**',
    '>',
    ...renderQuotedTable([
    ['Archivo', `\`${escapeInlineCode(artifactPath)}\``],
    ['Tipo de artefacto', artifactType],
    ['Herramienta origen', sourceTool],
    ['Cumplimiento', badge('cumplimiento', complianceText, complianceColor)],
    ['Resultado', badge('resultado', statusLabel(status), resultColor)],
    ['Merge permitido', badge('merge', mergeAllowed ? 'permitido' : 'bloqueado', mergeAllowed ? 'brightgreen' : 'red')],
    ['Errores bloqueantes', badge('fail', `${summary.fail} ${pluralize(summary.fail, 'bloqueante', 'bloqueantes')}`, failColor)],
    ['Advertencias', badge('warn', `${summary.warn} ${pluralize(summary.warn, 'observación', 'observaciones')}`, warnColor)],
    ['Reglas evaluadas', `\`${rulesEvaluated}\``],
    ['DSLs ejecutados', `\`${dslsExecuted}\``],
  ]),
  ];
}

function renderPassPanel(passChecks) {
  const count = passChecks.length;
  const lines = [
    '> [!TIP]',
    `> ${badge('PASS', `${count} ${pluralize(count, 'regla', 'reglas')}`, 'brightgreen')}`,
    '>',
  ];

  if (count === 0) {
    lines.push('> No existen reglas cumplidas.');
    return lines;
  }

  for (const check of passChecks) {
    const description = stripTrailingPeriod(check.description ?? check.detail ?? 'Cumple');
    lines.push(`> - \`${escapeInlineCode(check.id)}\` — ${escapeMarkdownText(description)}`);
  }

  return lines;
}

function renderWarnPanel(warnChecks) {
  const count = warnChecks.length;
  const lines = [
    '> [!WARNING]',
    `> ${badge('WARN', `${count} ${pluralize(count, 'observación', 'observaciones')}`, count === 0 ? 'brightgreen' : 'yellow')}`,
    '>',
  ];

  if (count === 0) {
    lines.push('> No existen reglas con observación.');
    return lines;
  }

  for (const check of warnChecks) {
    lines.push(...renderIssueEntry(check, 'Elemento', 'Observación'));
  }

  return lines;
}

function renderFailPanel(failChecks) {
  const count = failChecks.length;
  const lines = [
    '> [!CAUTION]',
    `> ${badge('FAIL', `${count} ${pluralize(count, 'bloqueante', 'bloqueantes')}`, count === 0 ? 'brightgreen' : 'red')}`,
    '>',
  ];

  if (count === 0) {
    lines.push('> No existen reglas bloqueantes incumplidas.');
    return lines;
  }

  for (const check of failChecks) {
    lines.push(...renderIssueEntry(check, 'Elemento o recurso', 'Motivo del fallo'));
  }

  return lines;
}

function renderIssueEntry(check, elementLabel, observationLabel) {
  const lines = [`> - \`${escapeInlineCode(check.id)}\``];
  const location = check.group ?? 'General';
  const element = getMeaningfulDetail(check.detail);
  const observation = normalizeInlineText(check.message ?? check.detail ?? 'Revisar el hallazgo reportado.');
  const recommendation = normalizeInlineText(suggestAction(check));

  lines.push(`>   - **Ubicación:** \`${escapeInlineCode(location)}\``);
  if (element) {
    lines.push(`>   - **${elementLabel}:** \`${escapeInlineCode(element)}\``);
  }
  lines.push(`>   - **${observationLabel}:** ${observation}`);
  lines.push(`>   - **Recomendación:** ${recommendation}`);

  return lines;
}

function renderSystemErrorSummary(response) {
  return [
    '# Calidad del diseño',
    '',
    '## Estado del sistema',
    '',
    '> [!CAUTION]',
    '> **ERROR — No se pudo completar la validación**',
    '>',
    '> El motor no pudo completar la validación.',
    `> **Detalle:** ${normalizeInlineText(response.error ?? 'Error desconocido.')}`,
    '> **Acción:** Revisar el manifiesto, el artefacto de entrada y la configuración del workflow.',
  ];
}

function badge(label, message, color) {
  const safeLabel = encodeURIComponent(String(label));
  const safeMessage = encodeURIComponent(String(message));
  return `![${safeLabel}](https://img.shields.io/badge/${safeLabel}-${safeMessage}-${color})`;
}

function statusColor(status) {
  if (status === 'PASS') return 'brightgreen';
  if (status === 'WARN') return 'yellow';
  if (status === 'FAIL') return 'red';
  if (status === 'ERROR') return 'critical';
  return 'lightgrey';
}

function scoreColor(score) {
  if (score === null || score === undefined) return 'lightgrey';
  if (score >= 10) return 'brightgreen';
  if (score >= 7) return 'yellow';
  return 'red';
}

function statusLabel(status) {
  if (status === 'PASS' || status === 'WARN' || status === 'FAIL' || status === 'ERROR') {
    return status;
  }

  return 'UNKNOWN';
}

function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural;
}

function renderQuotedTable(rows) {
  const lines = ['> | Indicador | Valor |', '> |---|---|'];
  for (const [indicator, value] of rows) {
    lines.push(`> | ${indicator} | ${value} |`);
  }
  return lines;
}

function escapeInlineCode(value) {
  return String(value ?? '').replace(/`/g, '\\`').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMarkdownText(value) {
  return String(value ?? '').replace(/\r?\n+/g, ' ').trim();
}

function normalizeInlineText(value) {
  return escapeMarkdownText(value);
}

function getMeaningfulDetail(value) {
  const text = normalizeInlineText(value);
  if (!text) {
    return '';
  }

  const normalized = text.toLowerCase();
  const genericValues = new Set([
    'binary',
    'missing-context',
    'missing-rule',
    'n/a',
    'na',
    'pass',
    'sin coincidencias',
    'unsupported',
    'xml',
    'utf-8',
    'utf-8-bom',
  ]);

  if (genericValues.has(normalized)) {
    return '';
  }

  if (/^no se (encontró|encontro|definió|definio)/i.test(text)) {
    return '';
  }

  return text;
}

function stripTrailingPeriod(value) {
  return String(value ?? '').replace(/\.+$/, '');
}

function formatPassDescription(value) {
  const text = stripTrailingPeriod(value)
    .replace(/^Verifica que\s+/i, '')
    .replace(/^Valida que\s+/i, '')
    .replace(/\bpueda\b/gi, 'puede')
    .replace(/\bcorresponda\b/gi, 'corresponde')
    .replace(/\besté\b/gi, 'está')
    .replace(/\bexistan\b/gi, 'Existen')
    .replace(/\bexista\b/gi, 'existe')
    .replace(/\bcontenga\b/gi, 'contiene')
    .replace(/\bapunten\b/gi, 'apuntan')
    .replace(/\btenga\b/gi, 'tiene')
    .replace(/\bsea\b/gi, 'es')
    .replace(/\bsean\b/gi, 'son')
    .replace(/\bcomiencen\b/gi, 'comienzan');

  if (text.length === 0) {
    return text;
  }

  return `${text[0].toUpperCase()}${text.slice(1)}`;
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

function buildResponse(repoRoot, manifestPath, manifest, artifact, validators) {
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
  await Engine.main();
}
