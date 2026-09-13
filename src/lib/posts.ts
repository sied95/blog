import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../i18n/config';

export type Post = CollectionEntry<'blog'>;

/** O id vem como "pt/ola-mundo" — separa idioma e slug. */
export function splitId(id: string): { lang: string; slug: string } {
  const [lang, ...rest] = id.split('/');
  return { lang, slug: rest.join('/') };
}

export function slugOf(post: Post): string {
  return splitId(post.id).slug;
}

/** Posts de um idioma, sem rascunhos, do mais novo para o mais antigo. */
export async function getPosts(lang: Lang): Promise<Post[]> {
  const posts = await getCollection('blog', ({ id, data }) => {
    const isDraft = data.draft && import.meta.env.PROD;
    return splitId(id).lang === lang && !isDraft;
  });
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export async function getTags(lang: Lang): Promise<{ tag: string; count: number }[]> {
  const posts = await getPosts(lang);
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function readingTime(body = ''): number {
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 220));
}
