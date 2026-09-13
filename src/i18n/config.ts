export const languages = {
  pt: 'Português',
  en: 'English',
} as const;

export const defaultLang = 'pt' as const;

export type Lang = keyof typeof languages;

export const localeMap: Record<Lang, string> = {
  pt: 'pt-BR',
  en: 'en-US',
};

export const ui = {
  pt: {
    'site.title': '~/the sisyphus',
    'site.description':
      'Notas sobre engenharia de software, arquitetura e as ferramentas do dia a dia.',
    'nav.home': 'Início',
    'nav.blog': 'Posts',
    'nav.about': 'Sobre',
    'home.hero.title': 'not all who wander are lost',
    'home.latest': 'Últimos posts',
    'home.all': 'Ver todos os posts',
    'blog.title': 'Todos os posts',
    'blog.empty': 'Nenhum post publicado ainda. Em breve!',
    'post.published': 'Publicado em',
    'post.updated': 'Atualizado em',
    'post.back': 'Voltar para os posts',
    'post.print': 'Salvar em PDF',
    'post.source': 'Publicado originalmente em',
    'post.readingTime': 'min de leitura',
    'tags.title': 'Posts com a tag',
    'tags.all': 'Tags',
    'about.title': 'Sobre',
    'footer.builtWith': 'Feito com Astro · hospedado no GitHub Pages',
    'lang.switch': 'Mudar idioma',
    'notfound.title': 'Página não encontrada',
    'notfound.text': 'O link pode estar quebrado ou a página foi movida.',
  },
  en: {
    'site.title': '~/the sisyphus',
    'site.description':
      'Notes on software engineering, architecture, and everyday tooling.',
    'nav.home': 'Home',
    'nav.blog': 'Posts',
    'nav.about': 'About',
    'home.hero.title': 'not all who wander are lost',
    'home.latest': 'Latest posts',
    'home.all': 'See all posts',
    'blog.title': 'All posts',
    'blog.empty': 'No posts published yet. Coming soon!',
    'post.published': 'Published on',
    'post.updated': 'Updated on',
    'post.back': 'Back to posts',
    'post.print': 'Save as PDF',
    'post.source': 'Originally published at',
    'post.readingTime': 'min read',
    'tags.title': 'Posts tagged',
    'tags.all': 'Tags',
    'about.title': 'About',
    'footer.builtWith': 'Built with Astro · hosted on GitHub Pages',
    'lang.switch': 'Switch language',
    'notfound.title': 'Page not found',
    'notfound.text': 'The link may be broken or the page was moved.',
  },
} as const;

export type UIKey = keyof (typeof ui)[typeof defaultLang];

export function useTranslations(lang: Lang) {
  return function t(key: UIKey): string {
    return (ui[lang] as Record<string, string>)[key] ?? ui[defaultLang][key];
  };
}

export function isLang(value: string): value is Lang {
  return value in languages;
}
