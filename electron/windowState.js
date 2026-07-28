export const DEFAULT_WINDOW_BOUNDS = { width: 1280, height: 832 }

export function resolveWindowBounds(saved, displays) {
  const bounds = {
    x: Number(saved?.x),
    y: Number(saved?.y),
    width: Number(saved?.width) || DEFAULT_WINDOW_BOUNDS.width,
    height: Number(saved?.height) || DEFAULT_WINDOW_BOUNDS.height
  }
  const visible = displays.some(({ bounds: display }) => (
    bounds.x < display.x + display.width &&
    bounds.x + bounds.width > display.x &&
    bounds.y < display.y + display.height &&
    bounds.y + bounds.height > display.y
  ))
  return visible ? bounds : { ...DEFAULT_WINDOW_BOUNDS }
}
