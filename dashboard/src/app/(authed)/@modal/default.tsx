/**
 * The @modal slot renders nothing unless an intercepting route filled
 * it. Next requires a `default` for a parallel slot so that a hard
 * navigation to a route the slot doesn't match — or a refresh while a
 * modal is open — renders the page alone instead of 404ing the slot.
 */
export default function ModalDefault() {
  return null;
}
