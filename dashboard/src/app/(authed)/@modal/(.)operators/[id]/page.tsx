/** Intercepts /operators/[id] — see the shortcodes one for the pattern. */
import Modal from "../../../_modal";
import OperatorEdit, { operatorEditTitle } from "../../../operators/[id]/_edit";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function OperatorEditModal({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const numId = parseInt(id, 10);
  return (
    <Modal title={await operatorEditTitle(numId)}>
      <OperatorEdit id={numId} error={sp.error} variant="modal" />
    </Modal>
  );
}
