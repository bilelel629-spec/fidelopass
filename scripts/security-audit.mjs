#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();

const SECRET_PATTERNS = [
  { name: 'Stripe secret key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'Stripe webhook secret', regex: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { name: 'Supabase service secret', regex: /\bsb_secret_[A-Za-z0-9._-]{12,}\b/g },
  { name: 'Brevo API key', regex: /\bxkeysib-[A-Za-z0-9-]{40,}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: 'Private key PEM', regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----/g },
];

const IGNORE_FILES = new Set([
  '.env.example',
  'README.md',
  'docs/runbook-ops-fidelopass.md',
]);

function listTrackedFiles() {
  const output = execSync('git ls-files', { cwd, encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isBinaryLikely(content) {
  return content.includes('\u0000');
}

function shouldIgnore(file) {
  if (IGNORE_FILES.has(file)) return true;
  if (file.startsWith('dist/')) return true;
  if (file.startsWith('node_modules/')) return true;
  if (file.startsWith('.astro/')) return true;
  if (file.startsWith('playwright-report/')) return true;
  if (file.startsWith('test-results')) return true;
  return false;
}

function findLineNumber(content, matchIndex) {
  let line = 1;
  for (let i = 0; i < matchIndex; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

const findings = [];
const files = listTrackedFiles();

for (const file of files) {
  if (shouldIgnore(file)) continue;
  const absolutePath = resolve(cwd, file);
  let content = '';
  try {
    content = readFileSync(absolutePath, 'utf8');
  } catch {
    continue;
  }
  if (!content || isBinaryLikely(content)) continue;

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      const value = String(match[0]);
      if (value.includes('...')) continue;
      findings.push({
        file,
        line: findLineNumber(content, match.index),
        type: pattern.name,
      });
    }
  }
}

if (!findings.length) {
  console.log('✅ Security audit: aucun secret détecté dans les fichiers trackés.');
  process.exit(0);
}

console.error('❌ Security audit: secrets potentiels détectés.');
for (const finding of findings) {
  console.error(`- ${finding.file}:${finding.line} [${finding.type}]`);
}
console.error('\nAction: retirez le secret du code, régénérez-le, puis stockez-le uniquement en variables Railway/Supabase.');
process.exit(1);

