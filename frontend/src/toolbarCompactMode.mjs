export function getToolbarMode({ isPC, keyboardVisible }) {
  return !isPC && keyboardVisible ? 'keyboard-compact' : 'normal'
}
