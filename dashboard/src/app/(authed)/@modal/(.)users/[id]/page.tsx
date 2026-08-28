/** Intercepts /users/[id] — see the shortcodes one for the pattern. */
import Modal from "../../../_modal";
import UserEdit, { userEditTitle } from "../../../users/[id]/_edit";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; reset?: string }>;
}

export default async function UserEditModal({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const numId = parseInt(id, 10);
  return (
    <Modal title={await userEditTitle(numId)}>
      <UserEdit id={numId} error={sp.error} reset={sp.reset} variant="modal" />
    </Modal>
  );
}
