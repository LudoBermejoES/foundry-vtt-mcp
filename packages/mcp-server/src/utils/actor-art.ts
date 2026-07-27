/**
 * Art-path helpers for read formatters.
 *
 * WHY THIS EXISTS. Every read formatter used to emit `hasImage: !!entity.img`
 * and nothing else. That boolean is `true` for Foundry's default placeholder
 * (`icons/svg/mystery-man.svg`), so it answers a question nobody asked and
 * cannot distinguish a real portrait from a missing one — the reason verifying an
 * import once required reading the world's LevelDB directly.
 *
 * The fix is ADDITIVE. `hasImage` keeps exactly the meaning and value it always
 * had (callers may already depend on its truthiness); the real `img` path is
 * emitted ALONGSIDE it, plus `isDefaultImg`, which is the *meaningful* version of
 * `hasImage` under a name that was never taken.
 */

/**
 * Foundry's built-in placeholders. `mystery-man.svg` is the Actor default;
 * `item-bag.svg` is the Item default. Anything under `icons/svg/` shipped by core
 * is a placeholder for our purposes, but we keep the list explicit rather than
 * prefix-matching, because a world CAN legitimately point an actor at a core icon
 * on purpose and we should not claim to know it was unintentional.
 */
const DEFAULT_IMAGE_PATHS = new Set<string>([
  'icons/svg/mystery-man.svg',
  'icons/svg/item-bag.svg',
]);

/** True when `img` is absent/empty or one of Foundry's built-in placeholders. */
export function isDefaultImg(img: unknown): boolean {
  if (typeof img !== 'string' || img.length === 0) return true;
  return DEFAULT_IMAGE_PATHS.has(img);
}

/**
 * The additive art fields for a read response: the real path (only when there is
 * one) plus the meaningful placeholder test (always). Spread this next to an
 * existing `hasImage` — never in place of it.
 */
export function artFields(img: unknown): { img?: string; isDefaultImg: boolean } {
  return {
    ...(typeof img === 'string' && img.length > 0 ? { img } : {}),
    isDefaultImg: isDefaultImg(img),
  };
}
