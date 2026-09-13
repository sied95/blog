#!/usr/bin/env node
// Cria um novo post: npm run new-post -- pt "Meu título aqui"
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const [lang, ...titleParts] = process.argv.slice(2);
const title = titleParts.join(' ').trim();

if (!lang || !title) {
  console.error('Uso: npm run new-post -- <pt|en> "Título do post"');
  process.exit(1);
}

if (!['pt', 'en'].includes(lang)) {
  console.error(`Idioma inválido: "${lang}". Use "pt" ou "en".`);
  process.exit(1);
}

const slug = title
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const dir = join('src', 'content', 'blog', lang);
const file = join(dir, `${slug}.md`);

try {
  await access(file);
  console.error(`Já existe: ${file}`);
  process.exit(1);
} catch {
  // não existe, seguimos
}

const today = new Date().toISOString().slice(0, 10);
const frontmatter = `---
title: ${JSON.stringify(title)}
description: ''
pubDate: ${today}
tags: []
draft: true
---

Escreva aqui.
`;

await mkdir(dir, { recursive: true });
await writeFile(file, frontmatter, 'utf8');

console.log(`✔ ${file}`);
console.log(`  → /${lang}/blog/${slug}`);
console.log('  Lembre de preencher "description" e trocar draft para false antes de publicar.');
