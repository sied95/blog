---
title: 'Começando o blog: por que Astro e GitHub Pages'
description: 'As razões por trás da stack deste blog e como o setup funciona por dentro.'
pubDate: 2026-08-06
tags: ['astro', 'meta', 'devops']
draft: false
---

Todo blog tech começa com um post sobre como o blog foi feito. Este não vai ser diferente — mas prometo que os próximos são sobre outra coisa.

## Por que Astro

A escolha era entre Astro, Hugo, Jekyll e Next.js. Astro ganhou por três motivos:

- **Zero JavaScript por padrão.** Uma página de post é HTML e CSS. O JS só aparece onde eu explicitamente pedir.
- **Content collections com validação.** O frontmatter dos posts passa por um schema Zod. Se eu esquecer a `description`, o build quebra — e não a página em produção.
- **Markdown e MDX no mesmo projeto.** Escrevo em `.md` no dia a dia e uso `.mdx` quando preciso de um componente interativo.

## Como o i18n funciona aqui

Não usei nenhuma biblioteca. O roteamento é uma rota dinâmica `[lang]` e os posts ficam organizados por pasta:

```
src/content/blog/
├── pt/
│   └── comecando-o-blog.md
└── en/
    └── starting-the-blog.md
```

O `id` de cada entrada vira `pt/comecando-o-blog`, então basta separar no `/` para saber o idioma:

```ts
export function splitId(id: string) {
  const [lang, ...rest] = id.split('/');
  return { lang, slug: rest.join('/') };
}
```

Se um post existe só em um idioma, ele simplesmente não aparece na listagem do outro. Sem fallback, sem tradução automática, sem página vazia.

## Deploy

Um workflow do GitHub Actions roda `astro build` e publica em GitHub Pages a cada push na `main`. Não há servidor, não há banco, não há conta para gerenciar.

```yaml
- uses: withastro/action@v5
- uses: actions/deploy-pages@v4
```

## A pegadinha do `base`

Se o repositório não se chama `usuario.github.io`, o site é servido em `/nome-do-repo/` e todo link absoluto quebra. A solução foi centralizar em um helper:

```ts
export function href(path = '/'): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`.replace(/\/{2,}/g, '/') || '/';
}
```

Regra da casa: nenhum `href="/algo"` escrito na mão. Sempre `href('/algo')`.

## Próximos passos

Adicionar busca client-side, imagens de Open Graph geradas no build e talvez comentários via GitHub Discussions. Mas isso fica para outro post.
