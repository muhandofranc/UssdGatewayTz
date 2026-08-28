/**
 * /operators/[id] — the standalone edit page. Thin: the form lives in
 * ./_edit so the intercepted modal renders the identical component.
 */
import OperatorEdit from "./_edit";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function EditOperatorPage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <OperatorEdit id={parseInt(id, 10)} error={sp.error} variant="page" />;
}
