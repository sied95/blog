# ~/the sisyphus

Blog bilíngue (pt/en) feito com [Astro](https://astro.build), publicado no GitHub Pages.

- Zero JavaScript por padrão — só o toggle de tema
- Posts em Markdown/MDX com frontmatter validado por Zod
- Tema claro/escuro com detecção automática
- Sitemap, tags, Open Graph e `hreflang`
- Deploy automático a cada push na `main`

---

## 1. Configurar antes do primeiro deploy

Três arquivos precisam dos seus dados:

**`astro.config.mjs`** — a URL do site e o caminho base:

| Cenário | `SITE` | `BASE` |
|---|---|---|
| Repositório `SEU-USUARIO.github.io` | `https://SEU-USUARIO.github.io` | `/` |
| Repositório de projeto (ex.: `blog`) | `https://SEU-USUARIO.github.io` | `/blog` |
| Domínio próprio | `https://seudominio.com` | `/` |

> Errar o `BASE` é o motivo nº 1 de "meu site subiu mas o CSS não carrega". Se o repo não se chama `usuario.github.io`, o `BASE` **tem** que ser `/nome-do-repo`.

**`src/consts.ts`** — seu usuário do GitHub e links sociais.

**`src/i18n/config.ts`** — título e descrição do site, nos dois idiomas.

## 2. Rodar localmente

```bash
npm install
npm run dev        # http://localhost:4321
```

Outros comandos:

```bash
npm run build      # gera dist/
npm run preview    # serve o build local
npm run check      # type-check dos arquivos .astro e .ts
```

## 3. Publicar no GitHub

```bash
git init
git add .
git commit -m "primeiro commit"
git branch -M main
git remote add origin git@github.com:SEU-USUARIO/blog.git
git push -u origin main
```

Depois, no GitHub:

1. **Settings → Pages**
2. Em **Source**, escolha **GitHub Actions** (não "Deploy from a branch")
3. Volte na aba **Actions** — o workflow `Deploy to GitHub Pages` roda sozinho

O site fica no ar em ~1 minuto. Cada push na `main` republica.

### Domínio próprio (opcional)

1. Crie `public/CNAME` com uma linha: `seudominio.com`
2. Em **Settings → Pages → Custom domain**, informe o mesmo domínio
3. No seu DNS, aponte um `CNAME` para `SEU-USUARIO.github.io`
4. Ajuste `SITE` e `BASE = '/'` no `astro.config.mjs`

---

## Escrevendo posts

```bash
npm run new-post -- pt "Como eu debuguei um deadlock em produção"
```

Isso cria `src/content/blog/pt/como-eu-debuguei-um-deadlock-em-producao.md` já com `draft: true`.

Estrutura das pastas — **o nome da pasta é o idioma da URL**:

```
src/content/blog/
├── pt/meu-post.md   → /pt/blog/meu-post
└── en/my-post.md    → /en/blog/my-post
```

Frontmatter:

```yaml
---
title: 'Título do post'          # obrigatório
description: 'Resumo curto.'     # obrigatório — usado em SEO e nos cards
pubDate: 2026-08-06              # obrigatório
updatedDate: 2026-08-20          # opcional
tags: ['rust', 'performance']    # opcional
draft: false                     # true = não aparece no build de produção
---
```

Se faltar um campo obrigatório, o **build quebra** — de propósito. Melhor falhar no CI do que publicar uma página sem `description`.

### Detalhes úteis

- **Posts só em um idioma** são normais. Se `en/` não tem a tradução, o post simplesmente não aparece na listagem em inglês.
- **Rascunhos** aparecem no `npm run dev` e somem no build de produção.
- **MDX**: renomeie para `.mdx` e você pode importar componentes Astro/React dentro do post.
- **Imagens**: coloque em `public/img/` e referencie com `/img/foo.png` — o Astro cuida do `base` em assets do `public/`.

---

## Estrutura do projeto

```
├── .github/workflows/
│   ├── deploy.yml          # build + deploy no Pages (push na main)
│   └── check.yml           # type-check + build nos PRs
├── public/                 # servido como está (favicon, imagens, CNAME)
├── scripts/new-post.mjs    # gerador de post
├── src/
│   ├── components/         # Header, Footer, PostCard, ThemeToggle…
│   ├── content/blog/       # os posts, por idioma
│   ├── i18n/config.ts      # idiomas e todas as strings da interface
│   ├── layouts/            # BaseLayout (head/SEO) e PostLayout
│   ├── lib/
│   │   ├── posts.ts        # busca e ordena posts, tags, tempo de leitura
│   │   └── url.ts          # helper href() — respeita o `base`
│   ├── pages/
│   │   ├── index.astro         # redireciona para o idioma do navegador
│   │   ├── 404.astro
│   │   ├── [lang]/index.astro  # home
│   │   ├── [lang]/about.astro
│   │   ├── [lang]/blog/        # listagem e página do post
│   │   └── [lang]/tags/[tag]   # posts por tag
│   ├── content.config.ts   # schema Zod do frontmatter
│   ├── consts.ts           # autor e links sociais
│   └── styles/global.css   # tema claro/escuro via CSS variables
└── astro.config.mjs
```

### Regra da casa: links

Nunca escreva `href="/algo"` na mão. Use o helper:

```astro
---
import { href } from '../lib/url';
---
<a href={href('/pt/blog')}>Posts</a>
```

Sem isso, os links quebram quando o site roda em `/nome-do-repo/`.

### Adicionar um terceiro idioma

1. Adicione a chave em `languages` e as strings em `ui` (`src/i18n/config.ts`)
2. Adicione o locale em `localeMap`
3. Crie a pasta `src/content/blog/<lang>/`

As rotas e o sitemap se geram sozinhos. Só o seletor de idioma no `Header.astro` assume dois idiomas — vira um `<select>` se você passar disso.

---

## Ideias para depois

- Busca client-side com [Pagefind](https://pagefind.app)
- Imagens de Open Graph geradas no build (`satori`)
- Comentários via [giscus](https://giscus.app) (GitHub Discussions)
- View Transitions entre páginas
