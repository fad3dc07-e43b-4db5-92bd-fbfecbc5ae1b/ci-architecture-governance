import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const markdownPath = process.argv[2];
const htmlPath = process.argv[3] ?? path.join(path.dirname(markdownPath ?? ''), 'summary.html');

if (!markdownPath) {
  throw new Error('Usage: node test/render-markdown.mjs <markdown-file> [html-file]');
}

const markdown = fs.readFileSync(markdownPath, 'utf8');
const html = markdownToHtml(markdown);

fs.writeFileSync(htmlPath, html, 'utf8');

if (process.env.CI !== 'true') {
  openInBrowser(htmlPath);
}

process.stdout.write(`${htmlPath}\n`);

function markdownToHtml(input) {
  const lines = String(input ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeBuffer = [];
  let inList = false;
  let inQuote = false;

  const flushCode = () => {
    if (!inCode) return;
    out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
    codeBuffer = [];
    inCode = false;
  };

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith('```')) {
      if (inCode) {
        flushCode();
      } else {
        closeList();
        closeQuote();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (!line.trim()) {
      closeList();
      closeQuote();
      out.push('<div class="spacer"></div>');
      continue;
    }

    if (line.startsWith('# ')) {
      closeList();
      closeQuote();
      out.push(`<h1>${renderInline(line.slice(2))}</h1>`);
      continue;
    }

    if (line.startsWith('## ')) {
      closeList();
      closeQuote();
      out.push(`<h2>${renderInline(line.slice(3))}</h2>`);
      continue;
    }

    if (line.startsWith('### ')) {
      closeList();
      closeQuote();
      out.push(`<h3>${renderInline(line.slice(4))}</h3>`);
      continue;
    }

    if (line.startsWith('> ')) {
      closeList();
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      out.push(`<p>${renderInline(line.slice(2))}</p>`);
      continue;
    }

    if (line.startsWith('- ')) {
      closeQuote();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${renderInline(line.slice(2))}</li>`);
      continue;
    }

    if (line.trimStart().startsWith('<')) {
      closeList();
      closeQuote();
      out.push(line);
      continue;
    }

    closeList();
    closeQuote();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  flushCode();
  closeList();
  closeQuote();

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CALinter Test Report</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; background: #f6f7fb; color: #111827; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 24px 64px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.05); padding: 24px; }
    h1, h2, h3 { margin: 1.25em 0 .5em; line-height: 1.2; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.35rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .35rem; }
    h3 { font-size: 1.05rem; }
    p, li { line-height: 1.55; }
    blockquote { margin: 1rem 0; padding: .75rem 1rem; border-left: 4px solid #f59e0b; background: #fffbeb; color: #92400e; }
    pre { margin: 1rem 0; padding: 1rem; background: #0f172a; color: #e2e8f0; overflow: auto; border-radius: 12px; }
    code { font-family: Consolas, monospace; font-size: .95em; }
    ul { padding-left: 1.5rem; }
    .spacer { height: .25rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #e5e7eb; padding: .5rem .75rem; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
  </style>
</head>
<body>
  <div class="wrap"><div class="card">
${out.join('\n')}
  </div></div>
</body>
</html>`;
}

function renderInline(value) {
  return escapeHtml(String(value ?? ''))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openInBrowser(filePath) {
  const normalized = path.resolve(filePath);
  const url = `file://${normalized.replace(/\\/g, '/')}`;

  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
