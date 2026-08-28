/**
 * /shortcodes/[id] — the standalone edit page.
 *
 * Thin on purpose: the form itself lives in ./_edit so the intercepted
 * modal route renders exactly the same component. This page is what a
 * refresh, a pasted link, or a no-JS browser gets.
 */
import ShortcodeEdit from "./_edit";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function EditShortcodePage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <ShortcodeEdit id={parseInt(id, 10)} error={sp.error} variant="page" />;
}
