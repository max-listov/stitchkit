/**
 * Whether a menu, a popover or a panel was opened with the keyboard.
 *
 * A script's `focus()` shows a focus ring when the element that had focus
 * before it was showing one, whatever opened the thing: a menu opened by a right
 * click, with focus on `body`, would still draw its ring on the first item, and
 * nobody pressed a key. The cure is to decide at the moment of opening: move
 * focus to the first item only when this answers `true`, and otherwise leave it
 * on the menu's container.
 */

/**
 * `true` when the element that has focus right now shows a focus ring — the
 * browser's own guess that the person is using the keyboard. Call it in the
 * event handler that opens the menu, before anything moves focus: after the
 * menu has taken focus the answer is about the menu.
 *
 * `false` on a server, with nothing focused, or in a browser without
 * `:focus-visible`.
 */
export function openedByKeyboard(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return document.activeElement?.matches(':focus-visible') === true;
  } catch {
    // A browser that does not know `:focus-visible` throws on the selector.
    return false;
  }
}
