/**
 * /users/new — the standalone create page.
 *
 * Thin on purpose: the form itself lives in ../_new so the intercepted
 * modal route renders exactly the same component.
 */
import UserNew from "../_new";

interface Props { searchParams: Promise<{ error?: string }>; }

export default async function NewUserPage({ searchParams }: Props) {
  const sp = await searchParams;
  return <UserNew error={sp.error} variant="page" />;
}
