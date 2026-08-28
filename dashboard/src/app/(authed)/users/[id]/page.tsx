/**
 * /users/[id] — the standalone edit page. Thin: the form lives in
 * ./_edit so the intercepted modal renders the identical component.
 */
import UserEdit from "./_edit";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; reset?: string }>;
}

export default async function EditUserPage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return (
    <UserEdit id={parseInt(id, 10)} error={sp.error} reset={sp.reset} variant="page" />
  );
}
