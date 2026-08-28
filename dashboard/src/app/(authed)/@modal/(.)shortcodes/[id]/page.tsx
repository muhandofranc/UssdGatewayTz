/**
 * Intercepts /shortcodes/[id] when navigated to from within the app,
 * rendering the edit form as a dialog over the list. A refresh or a
 * pasted link skips interception and gets the standalone page.
 */
import Modal from "../../../_modal";
import ShortcodeEdit, { shortcodeEditTitle } from "../../../shortcodes/[id]/_edit";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function ShortcodeEditModal({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const numId = parseInt(id, 10);
  return (
    <Modal title={await shortcodeEditTitle(numId)}>
      <ShortcodeEdit id={numId} error={sp.error} variant="modal" />
    </Modal>
  );
}
