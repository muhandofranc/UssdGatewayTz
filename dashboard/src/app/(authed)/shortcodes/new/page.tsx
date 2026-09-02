/**
 * /shortcodes/new — the standalone create page.
 *
 * Thin on purpose: the form itself lives in ../_new so the intercepted
 * modal route renders exactly the same component. This page is what a
 * refresh, a pasted link, or a no-JS browser gets.
 */
import ShortcodeNew from "../_new";

interface Props { searchParams: Promise<{ error?: string }>; }

export default async function NewShortcodePage({ searchParams }: Props) {
  const sp = await searchParams;
  return <ShortcodeNew error={sp.error} variant="page" />;
}
