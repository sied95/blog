/**
 * Monta uma URL respeitando o `base` configurado em astro.config.mjs.
 * Sempre use este helper em vez de escrever href="/algo" na mão —
 * caso contrário os links quebram quando o site roda em /nome-do-repo/.
 */
export function href(path = '/'): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const full = `${base}${suffix}`.replace(/\/{2,}/g, '/');
  return full === '' ? '/' : full;
}
