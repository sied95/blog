// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { asciiDiagram } from './src/lib/ascii-lang.mjs';

// ─────────────────────────────────────────────────────────────
// ⚠️  AJUSTE ESTES DOIS VALORES ANTES DO PRIMEIRO DEPLOY
//
// Caso A — repositório chamado `SEU-USUARIO.github.io`:
//   SITE = 'https://SEU-USUARIO.github.io'
//   BASE = '/'
//
// Caso B — repositório de projeto (ex.: `blog`):
//   SITE = 'https://SEU-USUARIO.github.io'
//   BASE = '/blog'
//
// Caso C — domínio próprio:
//   SITE = 'https://seudominio.com'
//   BASE = '/'
// ─────────────────────────────────────────────────────────────
const SITE = 'https://thesisyphus.dev';
const BASE = '/';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      // Linguagem própria para os diagramas: use a cerca ```ascii
      langs: [asciiDiagram],
      wrap: true,
    },
  },
});
