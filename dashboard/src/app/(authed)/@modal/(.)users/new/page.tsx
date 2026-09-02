/**
 * Intercepts /users/new — see (.)shortcodes/new for why this route is
 * mandatory rather than a nicety.
 */
import Modal from "../../../_modal";
import UserNew, { userNewTitle } from "../../../users/_new";

interface Props { searchParams: Promise<{ error?: string }>; }

export default async function UserNewModal({ searchParams }: Props) {
  const sp = await searchParams;
  return (
    <Modal title={userNewTitle}>
      <UserNew error={sp.error} variant="modal" />
    </Modal>
  );
}
