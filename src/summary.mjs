export async function renderDesignSummary(response) {
  if (response.systemStatus === 'ERROR') {
    return `${renderSystemErrorSummary(response).join('\n').trimEnd()}\n`;
  }

  const validators = response.validators ?? [];
  const checks = flattenChecks(validators);
  const passChecks = checks.filter((check) => check.status === 'PASS');
  const warnChecks = checks.filter((check) => check.status === 'WARN');
  const failChecks = checks.filter((check) => check.status === 'FAIL');
  const rulesEvaluated = checks.length;
  const dslCount = validators.length;
  const statusCounts = countChecks(checks);
  const totalRules = statusCounts.PASS + statusCounts.WARN + statusCounts.FAIL;
  const complianceText = formatRatio(statusCounts.PASS, totalRules);
  const dashboard = await renderDashboardSectionFinal({
    validators,
    complianceText,
    passCount: statusCounts.PASS,
    warnCount: statusCounts.WARN,
    failCount: statusCounts.FAIL,
    totalRules,
    rulesEvaluated,
    dslCount,
    resultLabel: getResultLabel({ failCount: failChecks.length, warnCount: warnChecks.length, systemError: false }),
  });

  return `${[
    ...dashboard.lines,
    ...renderWarningPanelFinal(warnChecks),
    ...renderCautionPanelFinal(failChecks),
    ...renderTipPanelFinal(validators, passChecks),
    ...dashboard.systemIssueLines,
  ].join('\n').trimEnd()}\n`;
}

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

function flattenChecks(validators) {
  return validators.flatMap((validator) => (validator.checks ?? []).map((check) => ({
    ...check,
    validatorId: validator.id,
    validatorTitle: validator.title,
  })));
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

async function renderDashboardSectionFinal({ validators, complianceText, passCount, warnCount, failCount, totalRules, rulesEvaluated, dslCount, resultLabel }) {
  try {
    const dimensions = buildDimensionSummaries(validators);
    const [complianceUrl, distributionUrl, dimensionsUrl] = await Promise.all([
      createQuickChartUrl(buildComplianceChartConfig({ passCount, warnCount, failCount, totalRules }), { width: 220, height: 160 }),
      createQuickChartUrl(buildDistributionChartConfig({ passCount, warnCount, failCount }), { width: 260, height: 160 }),
      createQuickChartUrl(buildDimensionsChartConfig(dimensions), { width: 300, height: 160 }),
    ]);

    return {
      lines: [
        '<table>',
        '  <thead>',
        '    <tr>',
        '      <th colspan="3" align="left">Calidad del diseño</th>',
        '    </tr>',
        '  </thead>',
        '  <tbody>',
        '    <tr>',
        `      <td><img src="${complianceUrl}" width="220" height="160" alt="Cumplimiento general"></td>`,
        `      <td><img src="${distributionUrl}" width="260" height="160" alt="Distribución de resultados"></td>`,
        `      <td><img src="${dimensionsUrl}" width="300" height="160" alt="Calidad por dimensión"></td>`,
        '    </tr>',
        '  </tbody>',
        '</table>',
        '',
      ],
      systemIssueLines: [],
    };
  } catch (error) {
    return {
      lines: [
        '<table>',
        '  <thead>',
        '    <tr>',
        '      <th colspan="3" align="left">Calidad del diseño</th>',
        '    </tr>',
        '  </thead>',
        '  <tbody>',
        '    <tr>',
        '      <td colspan="3">',
        '```text',
        `Cumplimiento: ${complianceText}`,
        `Resultado: ${resultLabel}`,
        `PASS: ${formatCount(passCount)} · WARN: ${formatCount(warnCount)} · FAIL: ${formatCount(failCount)}`,
        `Reglas evaluadas: ${formatCount(rulesEvaluated)} · DSLs: ${formatCount(dslCount)}`,
        '```',
        '      </td>',
        '    </tr>',
        '  </tbody>',
        '</table>',
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

function buildComplianceChartConfig({ passCount, warnCount, failCount, totalRules }) {
  const safeTotal = Math.max(0, Number(totalRules) || 0);
  const safePass = Math.max(0, Math.min(safeTotal, Number(passCount) || 0));
  const remaining = Math.max(0, safeTotal - safePass);
  const remainingColor = getScoreColor({ failCount, warnCount, totalRules: safeTotal });

  return {
    type: 'doughnut',
    data: {
      labels: ['Cumplimiento', 'Pendiente'],
      datasets: [
        {
          data: [safePass, remaining],
          backgroundColor: ['#22c55e', remaining > 0 ? remainingColor : '#e5e7eb'],
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
          text: `Cumplimiento ${formatRatio(safePass, safeTotal)}`,
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
    { label: 'XML', matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'document' },
    { label: 'Identidad', matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'archiIdentity' },
    { label: 'Estructura', matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'archiStructure' },
    { label: 'Integridad', matches: ({ validator, check }) => validator.dslType === 'archi-consistency' && check.group === 'internalIntegrity' },
    { label: 'Estilo', matches: ({ validator, check }) => validator.dslType === 'archi-style' && check.group !== 'Views' },
    { label: 'Vistas', matches: ({ validator, check }) => validator.dslType === 'archi-style' && check.group === 'Views' },
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
      color: getDimensionColor(score, failCount, warnCount),
    };
  });
}

function getScoreColor({ failCount, warnCount, totalRules }) {
  if (totalRules === 0) {
    return '#9ca3af';
  }

  if (failCount > 0) {
    return '#ef4444';
  }

  if (warnCount > 0) {
    return '#f59e0b';
  }

  return '#22c55e';
}

function getDimensionColor(score, failCount, warnCount) {
  if (failCount > 0) {
    return '#ef4444';
  }

  if (warnCount > 0 || Number(score) < 10) {
    return '#f59e0b';
  }

  return '#22c55e';
}

function formatRatio(value, total) {
  const safeValue = Math.max(0, Number(value) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  return `${String(safeValue).padStart(2, '0')}/${String(safeTotal).padStart(2, '0')}`;
}

async function createQuickChartUrl(chartConfig, { width = 500, height = 300 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://quickchart.io/chart/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

function renderWarningPanelFinal(warnChecks) {
  if (warnChecks.length === 0) {
    return [];
  }

  const lines = [
    '> [!WARNING]',
    `> **${warnChecks.length} ${pluralize(warnChecks.length, 'observación', 'observaciones')} ${warnChecks.length === 1 ? 'requiere' : 'requieren'} revisión**`,
    '>',
  ];

  warnChecks.forEach((check, index) => {
    lines.push(...renderIssuePanelEntryFinal(check, 'Elemento', 'Problema', 'Recomendación'));
    if (index < warnChecks.length - 1) {
      lines.push('>');
    }
  });

  lines.push('');
  return lines;
}

function renderCautionPanelFinal(failChecks) {
  if (failChecks.length === 0) {
    return [];
  }

  const lines = [
    '> [!CAUTION]',
    `> **${failChecks.length} ${pluralize(failChecks.length, 'regla bloqueante incumplida', 'reglas bloqueantes incumplidas')}**`,
    '>',
  ];

  failChecks.forEach((check, index) => {
    lines.push(...renderIssuePanelEntryFinal(check, 'Elemento', 'Problema', 'Recomendación'));
    if (index < failChecks.length - 1) {
      lines.push('>');
    }
  });

  lines.push('');
  return lines;
}

function renderTipPanelFinal(validators, passChecks) {
  if (passChecks.length === 0) {
    return [];
  }

  const lines = [
    '> [!TIP]',
    `> **${passChecks.length} ${pluralize(passChecks.length, 'regla cumplida', 'reglas cumplidas')}**`,
    '>',
    '> <details>',
    '> <summary>Ver reglas cumplidas</summary>',
    '>',
  ];

  for (const validator of validators) {
    const validatorPasses = (validator.checks ?? []).filter((check) => check.status === 'PASS');
    if (validatorPasses.length === 0) {
      continue;
    }

    lines.push(`> ### ${validator.title ?? validator.id ?? 'Reglas'}`);
    lines.push('>');

    for (const check of validatorPasses) {
      lines.push(`> - \`${escapeInlineCode(check.id)}\` — ${formatPassDescription(check.description ?? check.detail ?? 'Cumple.')}`);
    }

    lines.push('>');
  }

  lines.push('> </details>', '');
  return lines;
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

function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural;
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

function escapeInlineCode(value) {
  return String(value ?? '').replace(/`/g, '\\`').trim();
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
