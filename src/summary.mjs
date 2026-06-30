import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYamlFile } from './infra/yaml.mjs';

const ARCHIMATE_TREE_SECTIONS = [
  'Strategy',
  'Business',
  'Application',
  'Technology & Physical',
  'Motivation',
  'Implementation & Migration',
  'Other',
  'Relations',
  'Views',
];

const ARCHIMATE_AUX_SECTIONS = ['Model Integrity', 'General'];

export async function renderDesignSummary(response) {
  if (response.systemStatus === 'ERROR') {
    return `${renderSystemErrorSummary(response).join('\n').trimEnd()}\n`;
  }

  const summary = buildSummaryModelFromReports({
    repoRoot: response.repoRoot,
    reports: response.reports ?? {},
    reportStatus: response.status,
  });
  return `${await renderSummaryMarkdownV03(summary)}\n`;
}

function buildSummaryModelFromReports({ repoRoot, reports, reportStatus } = {}) {
  const qualityScore = reports?.qualityScore ?? {};
  const quickchart = reports?.quickchart ?? {};
  const ruleResults = Array.isArray(reports?.ruleResults)
    ? reports.ruleResults
    : Array.isArray(reports?.rules)
      ? reports.rules
      : [];
  const catalog = loadSummaryCatalog(repoRoot);
  const catalogIndexes = buildCatalogIndexes(catalog);

  const ruleMap = new Map(ruleResults.map((rule) => [rule.ruleId, rule]));
  const businessRules = ruleResults.filter((rule) => rule.ruleId !== 'contract_consistency_check');
  const contractRule = ruleMap.get('contract_consistency_check') ?? null;
  const dimensions = Array.isArray(qualityScore.dimensions) ? qualityScore.dimensions : [];
  const evaluatedDimensions = dimensions.filter((dimension) => Number.isFinite(dimension.score));
  const omittedDimensions = dimensions.filter((dimension) => !Number.isFinite(dimension.score)).map((dimension) => dimension.label);
  const counts = countRuleStatuses(businessRules);
  const partial = Boolean(qualityScore.partial) || omittedDimensions.length > 0;
  const qualityStatus = mapQualityStatus(qualityScore.status, partial);
  const coverage = `${evaluatedDimensions.length}/${dimensions.length}`;
  const quickchartIssues = compareQuickchartToQualityScore(quickchart, qualityScore);
  const contractIssues = buildContractIssues(contractRule, quickchartIssues);
  const contractOk = contractIssues.length === 0;
  const generalState = partial ? 'Evaluación parcial' : (contractOk ? qualityStatus : 'Contrato inconsistente');
  const scoreLabel = qualityScore.overallScore === null || qualityScore.overallScore === undefined
    ? 'n/a'
    : `${qualityScore.overallScore}/100${partial ? ' (parcial)' : ''}`;

  return {
    repoRoot,
    qualityScore,
    quickchart,
    ruleResults: businessRules,
    contractRule,
    counts,
    partial,
    qualityStatus,
    coverage,
    contractOk,
    contractIssues,
    generalState,
    scoreLabel,
    omittedDimensions,
    radarTrusted: contractOk,
    catalog,
    catalogIndexes,
    sectionRules: buildRulesBySection(businessRules, catalogIndexes),
    treeSections: ARCHIMATE_TREE_SECTIONS,
    auxSections: ARCHIMATE_AUX_SECTIONS,
    quickchartConfig: quickchart?.type && quickchart?.data && quickchart?.options
      ? {
        type: quickchart.type,
        data: quickchart.data,
        options: quickchart.options,
      }
      : null,
  };
}

function countRuleStatuses(ruleResults) {
  return ruleResults.reduce((acc, rule) => {
    const key = String(rule.status ?? 'unknown').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(acc, key)) {
      acc[key] = 0;
    }
    acc[key] += 1;
    return acc;
  }, { pass: 0, warning: 0, fail: 0, notimplemented: 0 });
}

function mapQualityStatus(status, partial) {
  if (partial) {
    return 'Evaluación parcial';
  }

  const value = String(status ?? '').toLowerCase();
  if (value === 'pass') return 'Cumple';
  if (value === 'warning') return 'Cumple con advertencias';
  if (value === 'fail') return 'No cumple';
  return 'No evaluado';
}

function compareQuickchartToQualityScore(quickchart, qualityScore) {
  const included = (qualityScore?.dimensions ?? []).filter((dimension) => Number.isFinite(dimension.score));
  const radarLabels = quickchart?.data?.labels ?? [];
  const expectedLabels = included.map((dimension) => dimension.label);
  const evaluatedSeries = quickchart?.data?.datasets?.[0]?.data ?? [];
  const targetSeries = quickchart?.data?.datasets?.[1]?.data ?? [];
  const expectedScores = included.map((dimension) => dimension.score);
  const expectedTargets = included.map((dimension) => dimension.target);
  const issues = [];

  if (!arraysEqual(radarLabels, expectedLabels)) {
    issues.push('quickchart-radar.json no coincide con quality-score.json en el orden de dimensiones.');
  }

  if (!arraysEqual(evaluatedSeries, expectedScores)) {
    issues.push('quickchart-radar.json no coincide con quality-score.json en el dataset Evaluado.');
  }

  if (!arraysEqual(targetSeries, expectedTargets)) {
    issues.push('quickchart-radar.json no coincide con quality-score.json en el dataset Objetivo.');
  }

  if (Boolean(quickchart?.partial) !== Boolean(qualityScore?.partial)) {
    issues.push('quickchart-radar.json no coincide con el indicador partial.');
  }

  const omittedDimensions = (qualityScore?.dimensions ?? [])
    .filter((dimension) => !Number.isFinite(dimension.score))
    .map((dimension) => dimension.label);

  if (!arraysEqual(quickchart?.omittedDimensions ?? [], omittedDimensions)) {
    issues.push('quickchart-radar.json no coincide con las dimensiones omitidas.');
  }

  return issues;
}

function buildContractIssues(contractRule, quickchartIssues) {
  const issues = [...quickchartIssues];

  if (!contractRule) {
    issues.push('Falta el resultado interno contract_consistency_check en rule-results.json.');
    return issues;
  }

  for (const finding of contractRule.findings ?? []) {
    if (finding?.message) {
      issues.push(finding.message);
    }
  }

  if (contractRule.includeInQualityScore !== false) {
    issues.push('contract_consistency_check debe tener includeInQualityScore: false.');
  }

  if (contractRule.includeInRadar !== false) {
    issues.push('contract_consistency_check debe tener includeInRadar: false.');
  }

  if (String(contractRule.status ?? '') !== 'pass') {
    issues.push('contract_consistency_check falló.');
  }

  return issues;
}

function loadSummaryCatalog(repoRoot) {
  if (!repoRoot) {
    return null;
  }

  const catalogPath = path.join(repoRoot, 'reports', 'catalog.json');
  return readJsonFileIfExists(catalogPath);
}

function buildCatalogIndexes(catalog) {
  const folders = new Map((catalog?.folders ?? []).map((folder) => [folder.id, folder]));
  const elements = new Map((catalog?.elements ?? []).map((element) => [element.id, element]));
  const views = new Map((catalog?.views ?? []).map((view) => [view.id, view]));
  const relationships = new Map((catalog?.relationships ?? []).map((relationship) => [relationship.id, relationship]));

  return {
    folders,
    elements,
    views,
    relationships,
  };
}

function buildRulesBySection(rules, catalogIndexes) {
  const sections = new Map([...ARCHIMATE_TREE_SECTIONS, ...ARCHIMATE_AUX_SECTIONS].map((section) => [section, []]));

  for (const rule of rules) {
    const section = resolveRuleSection(rule, catalogIndexes);
    if (!sections.has(section)) {
      sections.set(section, []);
    }

    sections.get(section).push(rule);
  }

  for (const rulesInSection of sections.values()) {
    rulesInSection.sort(sortVisibleRulesForReport);
  }

  return sections;
}

function resolveRuleSection(rule, catalogIndexes) {
  const ruleId = String(rule?.ruleId ?? '');
  if (ruleId === 'abuso_association_regla') {
    return 'Relations';
  }

  if (ruleId === 'contract_consistency_check') {
    return 'Errores del sistema';
  }

  const collectedSections = collectRuleSections(rule, catalogIndexes);

  if (['Estructura', 'Integridad', 'Trazabilidad', 'Gobierno'].includes(String(rule.dimension ?? ''))) {
    return 'Model Integrity';
  }

  if (ruleId.startsWith('vistas_')) {
    return 'Views';
  }

  if (rule.dimension === 'Relaciones' || collectedSections.has('Relations')) {
    return 'Relations';
  }

  if (collectedSections.has('Views')) {
    return 'Views';
  }

  if (rule.dimension === 'Nomenclatura') {
    return collectedSections.size === 1 ? [...collectedSections][0] : 'General';
  }

  if (collectedSections.size === 1) {
    return [...collectedSections][0];
  }

  if (collectedSections.size > 1) {
    return 'General';
  }

  return 'General';
}

function collectRuleSections(rule, catalogIndexes) {
  const sections = new Set();
  const addSectionForRecord = (collection, recordId) => {
    const section = resolveRecordSection(collection, recordId, catalogIndexes);
    if (section) {
      sections.add(section);
    }
  };

  for (const finding of rule?.findings ?? []) {
    addSectionForRecord(finding?.collection, finding?.recordId);
  }

  for (const evidence of rule?.evidence ?? []) {
    for (const recordId of evidence?.recordIds ?? []) {
      addSectionForRecord(evidence?.collection, recordId);
    }
  }

  return sections;
}

function resolveRecordSection(collection, recordId, catalogIndexes) {
  if (!collection || !recordId) {
    return null;
  }

  if (collection === 'views') {
    return 'Views';
  }

  if (collection === 'relationships') {
    return 'Relations';
  }

  if (collection === 'folders') {
    const folder = catalogIndexes?.folders?.get(recordId);
    return folder ? resolveFolderSection(folder, catalogIndexes) : null;
  }

  if (collection === 'elements') {
    const element = catalogIndexes?.elements?.get(recordId);
    if (!element) {
      return null;
    }

    const folder = catalogIndexes?.folders?.get(element.folderId);
    return folder ? resolveFolderSection(folder, catalogIndexes) : element.folderName ?? null;
  }

  return null;
}

function resolveFolderSection(folder, catalogIndexes) {
  if (!folder) {
    return null;
  }

  if (!folder.parentId) {
    return folder.name ?? null;
  }

  const parent = catalogIndexes?.folders?.get(folder.parentId);
  return parent ? resolveFolderSection(parent, catalogIndexes) : folder.parentName ?? folder.name ?? null;
}

function sortVisibleRulesForReport(left, right) {
  const order = new Map([
    ['fail', 0],
    ['warning', 1],
    ['pass', 2],
    ['notimplemented', 3],
    ['incomplete', 3],
  ]);

  const leftOrder = order.get(String(left.status ?? '').toLowerCase()) ?? 99;
  const rightOrder = order.get(String(right.status ?? '').toLowerCase()) ?? 99;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return String(left.ruleId ?? '').localeCompare(String(right.ruleId ?? ''));
}

function getVisibleRuleStatus(rule) {
  const value = String(rule?.status ?? '').toLowerCase();
  if (value === 'pass') return 'PASS';
  if (value === 'warning') return 'WARN';
  if (value === 'fail') return 'FAIL';
  if (value === 'notimplemented' || value === 'incomplete') return 'FAIL';
  return 'FAIL';
}

function getVisibleAlertKind(status) {
  if (status === 'PASS') return 'TIP';
  if (status === 'WARN') return 'WARNING';
  return 'CAUTION';
}

function getRuleSummaryMessage(rule) {
  if (String(rule?.status ?? '').toLowerCase() === 'pass') {
    return 'Cumple.';
  }

  return getFailureMessage(rule) !== 'n/a'
    ? getFailureMessage(rule)
    : (rule?.message ?? rule?.reason ?? 'Revisar el hallazgo reportado.');
}

function getRuleActionMessage(rule) {
  const status = String(rule?.status ?? '').toLowerCase();
  if (status === 'pass') {
    return 'Sin acción.';
  }

  if (status === 'notimplemented' || status === 'incomplete') {
    return 'Revisar el soporte del motor para esta regla.';
  }

  if (status === 'warning') {
    if (/may[uú]scula/i.test(String(rule?.message ?? ''))) {
      return 'Renombrar el elemento para que inicie con mayúscula.';
    }

    return 'Revisar la convención y ajustar el elemento.';
  }

  return 'Corregir el hallazgo para que la regla cumpla.';
}

function renderRuleAlert(rule, catalogIndexes) {
  const status = getVisibleRuleStatus(rule);
  const kind = getVisibleAlertKind(status);
  const lines = [
    `> [!${kind}]`,
    `> **${status} · \`${escapeInlineCode(rule.ruleId)}\`**`,
    `> **Dimensión:** ${normalizeInlineText(rule.dimension ?? 'General')}`,
    '>',
    `> ${normalizeInlineText(getRuleSummaryMessage(rule))}`,
    '>',
    `> **Acción:** ${normalizeInlineText(getRuleActionMessage(rule))}`,
  ];

  if (status === 'PASS') {
    return lines;
  }

  const findings = Array.isArray(rule.findings) ? rule.findings : [];
  lines.push('>', '> <details>', '> <summary>Cómo se resuelve</summary>', '>');

  if (findings.length === 0) {
    lines.push('> Sin hallazgos detallados.');
  } else {
    for (const finding of findings) {
      const label = getFindingLabel(finding, catalogIndexes);
      const message = normalizeInlineText(finding?.message ?? 'Revisar el hallazgo reportado.');
      lines.push(`> - ${label ? `${label}: ` : ''}${message}`);
    }
  }

  lines.push('>', '> </details>');
  return lines;
}

function getFindingLabel(finding, catalogIndexes) {
  if (!finding) {
    return '';
  }

  if (finding.collection === 'views') {
    return catalogIndexes?.views?.get(finding.recordId)?.name ?? 'Vista';
  }

  if (finding.collection === 'relationships') {
    return catalogIndexes?.relationships?.get(finding.recordId)?.name ?? 'Relación';
  }

  if (finding.collection === 'folders') {
    return catalogIndexes?.folders?.get(finding.recordId)?.name ?? 'Carpeta';
  }

  if (finding.collection === 'elements') {
    return catalogIndexes?.elements?.get(finding.recordId)?.name ?? 'Elemento';
  }

  return '';
}

function renderSystemErrorPanel(message, details) {
  const lines = [
    '## Errores del sistema',
    '',
    '> [!CAUTION]',
    '> **ERROR · `contract_consistency_check`**',
    '> **Dimensión:** Gobierno',
    '>',
    `> ${normalizeInlineText(message)}`,
    '>',
    '> **Acción:** Revisar la consistencia del contrato del reporte.',
  ];

  if (Array.isArray(details) && details.length > 0) {
    lines.push('>', '> <details>', '> <summary>Cómo se resuelve</summary>', '>');
    for (const detail of details) {
      lines.push(`> - ${normalizeInlineText(detail)}`);
    }
    lines.push('>', '> </details>');
  }

  return lines;
}

function renderRulesBySection(summary) {
  const lines = [];
  const sections = [...summary.treeSections, ...summary.auxSections];
  const grouped = {
    warning: collectSectionRulesByStatus(summary.sectionRules, sections, 'WARN'),
    pass: collectSectionRulesByStatus(summary.sectionRules, sections, 'PASS'),
    fail: collectSectionRulesByStatus(summary.sectionRules, sections, 'FAIL'),
  };

  lines.push(...renderConsolidatedStatusAlert('warning', 'WARN', grouped.warning));
  lines.push('');
  lines.push(...renderConsolidatedStatusAlert('pass', 'PASS', grouped.pass));
  lines.push('');
  lines.push(...renderConsolidatedStatusAlert('fail', 'FAIL', grouped.fail, summary.contractIssues));

  return lines;
}

function collectSectionRulesByStatus(sectionRules, sections, status) {
  return sections
    .map((section) => {
      const rules = (sectionRules.get(section) ?? []).filter((rule) => getVisibleRuleStatus(rule) === status);
      return rules.length > 0 ? { section, rules } : null;
    })
    .filter(Boolean);
}

function renderConsolidatedStatusAlert(kind, statusLabel, sectionGroups, extraMessages = []) {
  const lines = [];
  const count = sectionGroups.reduce((sum, group) => sum + group.rules.length, 0) + extraMessages.length;
  const alertKind = kind === 'warning' ? 'WARNING' : (kind === 'pass' ? 'TIP' : 'CAUTION');

  lines.push(`> [!${alertKind}]`);
  if (count > 0) {
    lines.push('>');
  }

  if (sectionGroups.length === 0 && extraMessages.length === 0) {
    lines.push('> Sin reglas aplicadas.');
    return lines;
  }

  for (const group of sectionGroups) {
    lines.push(`> **${group.section}**`);
    for (const rule of group.rules) {
      const summary = normalizeInlineText(getRuleSummaryMessage(rule));
      const action = normalizeInlineText(getRuleActionMessage(rule));
      lines.push(`> - \`${escapeInlineCode(rule.ruleId)}\` · ${summary}`);
      if (kind !== 'pass') {
        lines.push(`>   - **Acción:** ${action}`);
      }
    }
    lines.push('>');
  }

  if (extraMessages.length > 0) {
    lines.push('> **Errores del engine**');
    for (const message of extraMessages) {
      lines.push(`> - ${normalizeInlineText(message)}`);
    }
  }

  return lines;
}

function readJsonFileIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJsonFile(filePath);
  } catch {
    return null;
  }
}

async function renderSummaryMarkdownV03(summary) {
  const lines = ['# Calidad del diseño', ''];

  lines.push('## Dashboard');
  lines.push('');

  const resultChart = await createQuickChartUrl(buildResultChartConfig(summary), { width: 260, height: 180 });
  const coverageChart = await createQuickChartUrl(buildCoverageChartConfig(summary), { width: 260, height: 180 });
  const dimensionsChart = await createQuickChartUrl(summary.quickchartConfig, { width: 300, height: 180 });

  lines.push('<table>');
  lines.push('<tr>');
  lines.push('<td width="33%" align="center">');
  lines.push('');
  lines.push(`<img src="${resultChart}" width="260" />`);
  lines.push('');
  lines.push('</td>');
  lines.push('<td width="33%" align="center">');
  lines.push('');
  lines.push(`<img src="${coverageChart}" width="260" />`);
  lines.push('');
  lines.push(`<strong>Cobertura</strong><br/>${summary.coverage} dimensiones evaluadas · ${summary.counts.notimplemented} pendientes`);
  lines.push('');
  lines.push('</td>');
  lines.push('<td width="33%" align="center">');
  lines.push('');
  lines.push(`<img src="${dimensionsChart}" width="260" />`);
  lines.push('');
  lines.push(`<strong>Dimensiones</strong><br/>${summary.partial ? `Radar parcial · omite ${summary.omittedDimensions.join(' y ')}` : 'Radar completo'}${summary.omittedDimensions.length > 0 ? `<br/>Dimensiones pendientes: ${summary.omittedDimensions.join(', ')}` : ''}`);
  lines.push('');
  lines.push('</td>');
  lines.push('</tr>');
  lines.push('</table>');
  lines.push('');

  if (summary.contractIssues.length > 0) {
    lines.push(...renderSystemErrorPanel('Contrato inconsistente', summary.contractIssues));
    lines.push('');
  }

  lines.push('## Reporte de reglas');
  lines.push('');
  lines.push(...renderRulesBySection(summary));

  return lines.join('\n').trimEnd();
}

function groupRulesByStatus(rules) {
  return rules.reduce((groups, rule) => {
    const status = String(rule.status ?? 'unknown').toLowerCase();
    if (!groups.has(status)) {
      groups.set(status, []);
    }

    groups.get(status).push(rule);
    return groups;
  }, new Map());
}

function sortRulesForReport(rules) {
  const order = new Map([
    ['fail', 0],
    ['warning', 1],
    ['notimplemented', 2],
    ['pass', 3],
  ]);

  return [...rules].sort((left, right) => {
    const leftOrder = order.get(String(left.status ?? '').toLowerCase()) ?? 99;
    const rightOrder = order.get(String(right.status ?? '').toLowerCase()) ?? 99;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return String(left.dimension ?? '').localeCompare(String(right.dimension ?? '')) || String(left.ruleId ?? '').localeCompare(String(right.ruleId ?? ''));
  });
}

function formatRuleState(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'fail') return 'FAIL';
  if (value === 'warning') return 'WARNING';
  if (value === 'notimplemented') return 'NOT IMPLEMENTED';
  if (value === 'pass') return 'PASS';
  return value || 'n/a';
}

function formatRuleGroupHeading(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'fail') return 'ERROR';
  if (value === 'warning') return 'WARNING';
  if (value === 'notimplemented') return 'CAUTION';
  if (value === 'pass') return 'TIP';
  return value.toUpperCase();
}

function buildRuleGroupNarrative(status, rules) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'fail') {
    return [`Estas reglas bloquean el avance y deben corregirse primero. (${rules.length})`];
  }
  if (value === 'warning') {
    return [`Estas reglas requieren revisión antes de considerar el artefacto como estable. (${rules.length})`];
  }
  if (value === 'notimplemented') {
    return ['Reglas declaradas, pero el motor aún no soporta su scope u operador.'];
  }
  if (value === 'pass') {
    return ['Reglas validadas correctamente.'];
  }
  return ['Reglas agrupadas por estado.'];
}

function buildRuleGroupAlert(status, count) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'fail') {
    return ['> [!CAUTION]', `> **${count} ${count === 1 ? 'regla fallida' : 'reglas fallidas'}**`];
  }
  if (value === 'warning') {
    return ['> [!WARNING]', `> **${count} ${count === 1 ? 'regla con advertencia' : 'reglas con advertencia'}**`];
  }
  if (value === 'notimplemented') {
    return ['> [!CAUTION]', `> **${count} ${count === 1 ? 'regla no implementada' : 'reglas no implementadas'}**`];
  }
  if (value === 'pass') {
    return ['> [!TIP]', `> **${count} ${count === 1 ? 'regla cumplida' : 'reglas cumplidas'}**`];
  }

  return ['> [!NOTE]', `> **${count} reglas**`];
}

function formatDimensionScore(value) {
  if (value === null || value === undefined) {
    return 'n/a';
  }

  return String(value);
}

function formatDimensionState(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'pass') return 'Aprobada';
  if (value === 'warning') return 'Advertencia';
  if (value === 'fail') return 'Bloqueante';
  if (value === 'incomplete') return 'Parcial';
  if (value === 'notimplemented') return 'No implementada';
  return value || 'n/a';
}

function getFailureMessage(rule) {
  const firstFinding = (rule.findings ?? [])[0];
  if (firstFinding?.message) {
    return firstFinding.message;
  }

  if (rule.reason) {
    return rule.reason;
  }

  if (rule.message) {
    return rule.message;
  }

  return 'n/a';
}

function getRuleMessage(rule) {
  const failureMessage = getFailureMessage(rule);
  if (failureMessage !== 'n/a') {
    return failureMessage;
  }

  if (String(rule.status ?? '').toLowerCase() === 'pass') {
    return 'Cumple.';
  }

  if (String(rule.status ?? '').toLowerCase() === 'notimplemented') {
    return 'Regla declarada, pero el motor aún no soporta su scope u operador.';
  }

  return rule.reason ?? rule.message ?? 'n/a';
}

function formatRuleFindingsInline(rule) {
  const findings = rule.findings ?? [];
  if (findings.length === 0) {
    return '';
  }

  const preview = findings.slice(0, 2).map((finding) => `${truncateInline(finding.recordId ?? 'n/a', 12)} ${truncateInline(formatFindingValue(finding.value), 40)}`);
  const remaining = findings.length - preview.length;
  return `<br><small>${normalizeInlineText(preview.join(' · '))}${remaining > 0 ? ` · +${remaining}` : ''}</small>`;
}

function truncateInline(value, maxLength = 40) {
  const text = String(value ?? '');
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function formatFindingValue(value) {
  if (value === null || value === undefined) {
    return 'n/a';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
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

function validateDesignContracts() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rulesPath = path.join(root, '.calinter', 'archi-rules.yml');
  const qualityPath = path.join(root, '.calinter', 'archi-quality.yml');
  const catalogPath = path.join(root, 'reports', 'catalog.json');
  const ruleResultsPath = path.join(root, 'reports', 'rule-results.json');
  const qualityScorePath = path.join(root, 'reports', 'quality-score.json');
  const quickchartPath = path.join(root, 'reports', 'quickchart-radar.json');

  const rulesConfig = loadYamlFile(rulesPath);
  const qualityConfig = loadYamlFile(qualityPath);
  const catalog = readJsonFile(catalogPath);
  const ruleResults = readJsonFile(ruleResultsPath);
  const qualityScore = readJsonFile(qualityScorePath);
  const quickchart = readJsonFile(quickchartPath);

  const rulesById = new Map(Object.entries(rulesConfig.rules ?? {}));
  const qualityDimensions = Object.entries(qualityConfig.qualityModel?.dimensions ?? {});
  const ruleResultsById = new Map((ruleResults.rules ?? []).map((rule) => [rule.ruleId, rule]));

  const contractCheck = ruleResultsById.get('contract_consistency_check');
  if (!contractCheck) {
    throw new Error('Contrato inconsistente: falta el resultado interno contract_consistency_check en rule-results.json.');
  }

  if (contractCheck.includeInQualityScore !== false) {
    throw new Error('Contrato inconsistente: contract_consistency_check debe tener includeInQualityScore: false.');
  }

  if (contractCheck.includeInRadar !== false) {
    throw new Error('Contrato inconsistente: contract_consistency_check debe tener includeInRadar: false.');
  }

  if (String(contractCheck.status ?? '') !== 'pass') {
    throw new Error('Contrato inconsistente: contract_consistency_check falló.');
  }

  for (const [, dimension] of qualityDimensions) {
    for (const ruleRef of dimension.rules ?? []) {
      if (!rulesById.has(ruleRef.id)) {
        throw new Error(`Contrato inválido: quality.yml referencia la regla inexistente '${ruleRef.id}'.`);
      }
    }
  }

  for (const dimension of qualityScore.dimensions ?? []) {
    for (const ruleRef of dimension.rules ?? []) {
      if (!ruleResultsById.has(ruleRef.ruleId)) {
        throw new Error(`Contrato inválido: quality-score.json usa la regla '${ruleRef.ruleId}' sin resultado en rule-results.json.`);
      }
    }
  }

  const expectedQualityScore = buildExpectedQualityScore({ qualityConfig, qualityDimensions, ruleResultsById, rulesById });
  assertQualityScoreMatches(qualityScore, expectedQualityScore);
  assertQuickchartMatchesQualityScore(quickchart, qualityScore);

  if (ruleResultsById.get('referencias_rotas_regla')?.status === 'pass') {
    validateCatalogReferences(catalog);
  }
}

function buildExpectedQualityScore({ qualityConfig, qualityDimensions, ruleResultsById, rulesById }) {
  const dimensions = qualityDimensions.map(([dimensionId, dimension]) => {
    const rules = (dimension.rules ?? []).map((ruleRef) => {
      const result = ruleResultsById.get(ruleRef.id);
      if (!result) {
        throw new Error(`Contrato inválido: falta el resultado de la regla '${ruleRef.id}' para recalcular quality-score.json.`);
      }

      return {
        ruleId: ruleRef.id,
        weight: Number(ruleRef.weight) || 0,
        score: result.includeInQualityScore === false || result.status === 'notImplemented' ? null : Number(result.score),
        status: result.status,
      };
    });

    const dimensionPartial = rules.some((rule) => rule.score === null || String(rule.status ?? '').toLowerCase() === 'notimplemented');

    const scoredRules = rules.filter((rule) => rule.score !== null && Number.isFinite(rule.score));
    const weightTotal = scoredRules.reduce((sum, rule) => sum + rule.weight, 0);
    const weightedScore = scoredRules.reduce((sum, rule) => sum + (rule.score * rule.weight), 0);
    const score = weightTotal > 0 ? Math.round(weightedScore / weightTotal) : null;
    const hasCriticalFailure = scoredRules.some((rule) => (ruleResultsById.get(rule.ruleId)?.status === 'fail') && String(rulesById.get(rule.ruleId)?.severity ?? '').toLowerCase() === 'error');
    const target = Number(dimension.target) || 0;
    const status = hasCriticalFailure ? 'fail' : (dimensionPartial ? 'incomplete' : (score === null ? 'incomplete' : (score >= target ? 'pass' : 'warning')));

    return {
      id: dimensionId,
      label: dimension.label,
      target,
      score,
      status,
      weightTotal,
      rules,
    };
  });

  const scoredDimensions = dimensions.filter((dimension) => Number.isFinite(dimension.score));
  const overallScore = scoredDimensions.length > 0
    ? Math.round(scoredDimensions.reduce((sum, dimension) => sum + dimension.score, 0) / scoredDimensions.length)
    : null;
  const status = dimensions.some((dimension) => dimension.status === 'fail')
    ? 'fail'
    : (dimensions.some((dimension) => dimension.status === 'incomplete') ? 'incomplete' : (dimensions.some((dimension) => dimension.status === 'warning') ? 'warning' : 'pass'));

  return {
    overallScore,
    status,
    partial: dimensions.some((dimension) => dimension.status === 'incomplete'),
    radarOrder: dimensions.map((dimension) => dimension.label),
    dimensions,
  };
}

function assertQualityScoreMatches(actual, expected) {
  if (expected.overallScore === null) {
    if (actual?.overallScore !== null) {
      throw new Error('Contrato inválido: quality-score.json no debe inventar overallScore.');
    }
  } else if (Number(actual?.overallScore) !== expected.overallScore) {
    throw new Error(`Contrato inválido: quality-score.json no recalcula el score global esperado (${expected.overallScore}).`);
  }

  if (String(actual?.status ?? '') !== expected.status) {
    throw new Error(`Contrato inválido: quality-score.json no coincide con el estado esperado '${expected.status}'.`);
  }

  if (Boolean(actual?.partial) !== Boolean(expected.partial)) {
    throw new Error('Contrato inválido: quality-score.json no coincide con el indicador partial.');
  }

  if (!arraysEqual(actual?.radarOrder ?? [], expected.radarOrder)) {
    throw new Error('Contrato inválido: quality-score.json no coincide con el orden esperado de dimensiones.');
  }

  const actualDimensions = actual?.dimensions ?? [];
  if (actualDimensions.length !== expected.dimensions.length) {
    throw new Error('Contrato inválido: quality-score.json tiene un número de dimensiones distinto al esperado.');
  }

  for (let index = 0; index < expected.dimensions.length; index += 1) {
    const actualDimension = actualDimensions[index] ?? {};
    const expectedDimension = expected.dimensions[index];

    if (String(actualDimension.id ?? '') !== expectedDimension.id) {
      throw new Error(`Contrato inválido: quality-score.json tiene la dimensión '${actualDimension.id ?? 'desconocida'}' fuera de orden o con id distinto.`);
    }

    if (String(actualDimension.label ?? '') !== expectedDimension.label) {
      throw new Error(`Contrato inválido: quality-score.json no coincide con la etiqueta esperada de '${expectedDimension.label}'.`);
    }

    if (Number(actualDimension.target) !== expectedDimension.target) {
      throw new Error(`Contrato inválido: quality-score.json no coincide con el target de '${expectedDimension.label}'.`);
    }

    if (expectedDimension.score === null) {
      if (actualDimension.score !== null) {
        throw new Error(`Contrato inválido: quality-score.json debe dejar sin score a '${expectedDimension.label}'.`);
      }
    } else if (Number(actualDimension.score) !== expectedDimension.score) {
      throw new Error(`Contrato inválido: quality-score.json no recalcula el score de '${expectedDimension.label}'.`);
    }

    if (String(actualDimension.status ?? '') !== expectedDimension.status) {
      throw new Error(`Contrato inválido: quality-score.json no coincide con el estado de '${expectedDimension.label}'.`);
    }

    if (Number(actualDimension.weightTotal) !== expectedDimension.weightTotal) {
      throw new Error(`Contrato inválido: quality-score.json no coincide con el peso total de '${expectedDimension.label}'.`);
    }

    const actualRules = actualDimension.rules ?? [];
    if (actualRules.length !== expectedDimension.rules.length) {
      throw new Error(`Contrato inválido: quality-score.json no coincide con el número de reglas de '${expectedDimension.label}'.`);
    }

    for (let ruleIndex = 0; ruleIndex < expectedDimension.rules.length; ruleIndex += 1) {
      const actualRule = actualRules[ruleIndex] ?? {};
      const expectedRule = expectedDimension.rules[ruleIndex];

      if (String(actualRule.ruleId ?? '') !== expectedRule.ruleId) {
        throw new Error(`Contrato inválido: quality-score.json no coincide con la regla '${expectedRule.ruleId}' de '${expectedDimension.label}'.`);
      }

      if (Number(actualRule.weight) !== expectedRule.weight) {
        throw new Error(`Contrato inválido: quality-score.json no coincide con el peso de '${expectedRule.ruleId}'.`);
      }

      if (expectedRule.score === null) {
        if (actualRule.score !== null) {
          throw new Error(`Contrato inválido: quality-score.json no debe inventar score para '${expectedRule.ruleId}'.`);
        }
      } else if (Number(actualRule.score) !== expectedRule.score) {
        throw new Error(`Contrato inválido: quality-score.json no coincide con el score de '${expectedRule.ruleId}'.`);
      }

      if (String(actualRule.status ?? '') !== String(expectedRule.status ?? '')) {
        throw new Error(`Contrato inválido: quality-score.json no coincide con el estado de '${expectedRule.ruleId}'.`);
      }
    }
  }
}

function assertQuickchartMatchesQualityScore(quickchart, qualityScore) {
  const included = (qualityScore.dimensions ?? []).filter((dimension) => Number.isFinite(dimension.score));
  const radarLabels = quickchart?.data?.labels ?? [];
  const expectedLabels = included.map((dimension) => dimension.label);
  const evaluatedSeries = quickchart?.data?.datasets?.[0]?.data ?? [];
  const targetSeries = quickchart?.data?.datasets?.[1]?.data ?? [];
  const expectedScores = included.map((dimension) => dimension.score);
  const expectedTargets = included.map((dimension) => dimension.target);

  if (!arraysEqual(radarLabels, expectedLabels)) {
    throw new Error('Contrato inválido: quickchart-radar.json no coincide con quality-score.json en el orden de dimensiones.');
  }

  if (!arraysEqual(evaluatedSeries, expectedScores)) {
    throw new Error('Contrato inválido: quickchart-radar.json no coincide con quality-score.json en el dataset Evaluado.');
  }

  if (!arraysEqual(targetSeries, expectedTargets)) {
    throw new Error('Contrato inválido: quickchart-radar.json no coincide con quality-score.json en el dataset Objetivo.');
  }

  if (Boolean(quickchart?.partial) !== Boolean(qualityScore.partial)) {
    throw new Error('Contrato inválido: quickchart-radar.json no coincide con el indicador partial.');
  }

  if (!arraysEqual(quickchart?.omittedDimensions ?? [], (qualityScore.dimensions ?? []).filter((dimension) => !Number.isFinite(dimension.score)).map((dimension) => dimension.label))) {
    throw new Error('Contrato inválido: quickchart-radar.json no coincide con las dimensiones omitidas.');
  }
}

function validateCatalogReferences(catalog) {
  const elementIds = new Set((catalog.elements ?? []).map((element) => element.id));
  const relationshipIds = new Set((catalog.relationships ?? []).map((relationship) => relationship.id));
  const brokenReferences = [];

  for (const object of catalog.diagramObjects ?? []) {
    if (!elementIds.has(object.elementRef)) {
      brokenReferences.push(`diagramObject:${object.id}->${object.elementRef}`);
    }
  }

  for (const connection of catalog.diagramConnections ?? []) {
    if (!relationshipIds.has(connection.relationshipRef)) {
      brokenReferences.push(`diagramConnection:${connection.id}->${connection.relationshipRef}`);
    }
  }

  for (const relationship of catalog.relationships ?? []) {
    if (!elementIds.has(relationship.source)) {
      brokenReferences.push(`relationship:${relationship.id}.source->${relationship.source}`);
    }

    if (!elementIds.has(relationship.target)) {
      brokenReferences.push(`relationship:${relationship.id}.target->${relationship.target}`);
    }
  }

  if (brokenReferences.length > 0) {
    throw new Error(`Contrato inválido: catalog.json contiene referencias rotas (${brokenReferences.join(', ')}).`);
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function flattenChecks(validators) {
  return validators.flatMap((validator) => (validator.checks ?? []).map((check) => ({
    ...check,
    validatorId: validator.id,
    validatorTitle: validator.title,
  })));
}

function getResultLabel({ failCount, warnCount, systemError, incomplete }) {
  if (systemError) {
    return '⚫ NO EVALUABLE';
  }

  if (incomplete) {
    return '🟠 EVALUACIÓN PARCIAL';
  }

  if (failCount > 0) {
    return '🔴 NO CUMPLE';
  }

  if (warnCount > 0) {
    return '🟡 ACEPTABLE CON OBSERVACIONES';
  }

  return '✅ APROBADO';
}

function renderIncompletePanel(isIncomplete) {
  if (!isIncomplete) {
    return [];
  }

  return [
    '> [!CAUTION]',
    '> **EVALUACIÓN PARCIAL**',
    '>',
    '> Hay dimensiones no implementadas y el radar se publica de forma parcial.',
    '',
  ];
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

function buildResultChartConfig(summary) {
  const score = Number(summary?.qualityScore?.overallScore);
  const hasScore = Number.isFinite(score);
  const completionPercent = hasScore ? Math.max(0, Math.min(100, Math.round(score))) : 0;
  const pendingPercent = 100 - completionPercent;
  const title = hasScore ? `Cumplimiento ${completionPercent}%` : 'Cumplimiento n/a';

  return {
    type: 'doughnut',
    data: {
      labels: ['Score', 'Pendiente'],
      datasets: [
        {
          data: [completionPercent, pendingPercent],
          backgroundColor: ['#22c55e', '#e5e7eb'],
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
          text: title,
          font: { size: 13 },
        },
      },
      cutout: '70%',
    },
  };
}

function buildCoverageChartConfig(summary) {
  const evaluated = Number(summary?.coverage?.split('/')[0]) || 0;
  const total = Number(summary?.coverage?.split('/')[1]) || 0;
  const notImplemented = Math.max(0, total - evaluated);

  return {
    type: 'doughnut',
    data: {
      labels: ['Evaluadas', 'No implementadas'],
      datasets: [
        {
          data: [evaluated, notImplemented],
          backgroundColor: ['#3b82f6', '#9ca3af'],
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
          text: 'Cobertura',
          font: { size: 13 },
        },
      },
      cutout: '70%',
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
  const contractInconsistency = /Contrato inconsistente/i.test(String(response.error ?? ''));
  const ruleId = contractInconsistency ? 'contract_consistency_check' : 'system_error';
  return [
    '# Calidad del diseño',
    '',
    '## Errores del sistema',
    '',
    '> [!CAUTION]',
    `> **ERROR · \`${ruleId}\`**`,
    '> **Dimensión:** Gobierno',
    '>',
    `> ${contractInconsistency ? 'La validación encontró una inconsistencia contractual.' : 'El motor no pudo completar la validación.'}`,
    '>',
    `> **Acción:** ${contractInconsistency ? 'Revisar el contrato del reporte y volver a ejecutar la validación.' : 'Revisar el manifiesto, el artefacto de entrada y la configuración del workflow.'}`,
    '',
    '> <details>',
    '> <summary>Cómo se resuelve</summary>',
    '>',
    `> - ${normalizeInlineText(response.error ?? 'Error desconocido.')}`,
    '>',
    '> </details>',
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
