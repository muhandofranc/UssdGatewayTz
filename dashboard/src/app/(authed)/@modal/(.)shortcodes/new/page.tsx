/**
 * Intercepts /shortcodes/new when navigated to from within the app,
 * rendering the create form as a dialog over the list. A refresh or a
 * pasted link skips interception and gets the standalone page.
 *
 * This route must exist: without it the sibling `(.)shortcodes/[id]`
 * interceptor matches /shortcodes/new with id="new".
 */
import Modal from "../../../_modal";
import ShortcodeNew, { shortcodeNewTitle } from "../../../shortcodes/_new";

interface Props { searchParams: Promise<{ error?: string }>; }

export default async function ShortcodeNewModal({ searchParams }: Props) {
  const sp = await searchParams;
  return (
    <Modal title={shortcodeNewTitle}>
      <ShortcodeNew error={sp.error} variant="modal" />
    </Modal>
  );
}
