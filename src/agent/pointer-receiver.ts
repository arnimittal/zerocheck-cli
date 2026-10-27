import type { ElementHandle } from 'playwright';
import { nativePointerFacts, nativePointerReceiver, scrollOwnControl } from './pointer-native.js';
import { TargetChangedError } from './target-errors.js';

export interface PointerReceiver { handle: ElementHandle<SVGElement | HTMLElement>; point: { x: number; y: number } }

/** Visibility for uniqueness includes offscreen and covered own surfaces. */
export async function hasOwnPointerSurface(control: ElementHandle<SVGElement | HTMLElement>): Promise<boolean> {
  return Boolean(await inspectOwnPointerSurface(control, false));
}

/** A zero-box button may own an expanded CSS pseudo-element. Probe only its
 * nearest local container, and accept a point only when the hit is that button. */
export async function ownPointerSurface(control: ElementHandle<SVGElement | HTMLElement>): Promise<{ x: number; y: number } | undefined> {
  const observed = await inspectOwnPointerSurface(control, true);
  if (!observed) return undefined;
  const box = await control.boundingBox();
  if (!box) return undefined;
  const point = { x: box.x + observed.x - observed.originX, y: box.y + observed.y - observed.originY };
  return await framePointerPath(control, point) ? point : undefined;
}

async function inspectOwnPointerSurface(control: ElementHandle<SVGElement | HTMLElement>, hitTest: boolean) {
  return nativePointerFacts<{ x: number; y: number; originX: number; originY: number } | null>(control, { mode: 'own', hitTest });
}

/** A covered control is not clicked through. Only an independently associated,
 * hit-tested activation control can receive its pointer, including a CSS pseudo overlay. */
export async function associatedPointerReceiver(control: ElementHandle<SVGElement | HTMLElement>, options: { scrollOwnSurface?: boolean } = {}): Promise<PointerReceiver | undefined> {
  if (options.scrollOwnSurface && await hasOwnPointerSurface(control)) {
    // Scroll the already bound control itself. Never activate its container or
    // infer ownership from the separate radio that happens to sit underneath.
    await scrollOwnControl(control);
  }
  const own = await ownPointerSurface(control);
  if (own) {
    const duplicate = await control.evaluateHandle(element => element);
    const handle = duplicate.asElement() as ElementHandle<SVGElement | HTMLElement> | null;
    if (handle) return { handle, point: own };
    await duplicate.dispose(); return undefined;
  }
  const handle = await nativePointerReceiver(control);
  if (!handle) return undefined;
  const box = await control.boundingBox();
  if (!box) { await handle.dispose(); return undefined; }
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (!await framePointerPath(control, point)) { await handle.dispose(); return undefined; }
  return { handle, point };
}

async function framePointerPath(control: ElementHandle<SVGElement | HTMLElement>, point: { x: number; y: number }): Promise<boolean> {
  let frame = await control.ownerFrame();
  while (frame?.parentFrame()) {
    const owner = await frame.frameElement();
    try {
      const globalBox = await owner.boundingBox();
      if (!globalBox || !await nativePointerFacts<boolean>(owner, { mode: 'frame', x: point.x - globalBox.x, y: point.y - globalBox.y })) return false;
    } finally { await owner.dispose(); }
    frame = frame.parentFrame();
  }
  return true;
}

export async function revalidatePointerReceiver(control: ElementHandle<SVGElement | HTMLElement>, expected: PointerReceiver): Promise<void> {
  const current = await associatedPointerReceiver(control);
  try {
    if (!current || !await current.handle.evaluate((element, previous) => element === previous, expected.handle)
      || Math.abs(current.point.x - expected.point.x) > 0.5 || Math.abs(current.point.y - expected.point.y) > 0.5) throw new TargetChangedError('Pointer receiver association changed before dispatch.');
  } finally { await current?.handle.dispose(); }
}
