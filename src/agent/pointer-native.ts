import { selectors, type ElementHandle, type Frame } from 'playwright';

type Control = ElementHandle<SVGElement | HTMLElement>;
type NativeHandle = Awaited<ReturnType<Frame['frameElement']>>;
const engine = 'zerocheck_pointer_facts_v1';
const key = Symbol.for(engine);
const registry = selectors as typeof selectors & { [key]?: Promise<void> };
// Geometry, hit testing and ownership must use native APIs in the isolated world.
const registered = registry[key] ??= selectors.register(engine, { content: String.raw`({
 queryAll(root, body) {
  const input = JSON.parse(body), doc = root.ownerDocument || root, win = doc.defaultView;
  const el = root;
  if (input.mode === 'control') return [el];
  const metadata = value => { const node = doc.createElement('meta'); node.setAttribute('content', JSON.stringify(value)); return [el, node]; };
  if (input.mode === 'scroll') { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return metadata(true); }
  const parent = node => node.parentElement || node.getRootNode()?.host;
  const rect = el.getBoundingClientRect();
  if (input.mode === 'frame') {
   for (let node = el; node; node = parent(node)) {
    const style = win.getComputedStyle(node);
    if (style.transform !== 'none' || ['translate','rotate','scale'].some(key => style[key] && style[key] !== 'none')
      || style.zoom && style.zoom !== '1' && style.zoom !== 'normal') return metadata(false);
   }
   return metadata(doc.elementFromPoint(rect.left + input.x, rect.top + input.y) === el);
  }
  if (input.mode === 'own') {
   if (!el.isConnected || !el.matches('button,[role="button"]')) return metadata(null);
   for (let node = el; node; node = parent(node)) if (win.getComputedStyle(node).display === 'none') return metadata(null);
   const style = win.getComputedStyle(el);
   if (rect.width > 0 && rect.height > 0 || style.visibility !== 'visible' || style.display === 'none') return metadata(null);
   const surfaces = ['::before','::after'].map(pseudo => win.getComputedStyle(el, pseudo)).filter(surface =>
    surface.content !== 'none' && surface.content !== 'normal' && surface.display !== 'none' && surface.visibility === 'visible'
    && surface.pointerEvents !== 'none' && parseFloat(surface.width) > 0 && parseFloat(surface.height) > 0);
   if (!surfaces.length) return metadata(null);
   for (let container = el.parentElement; container && !['BODY','HTML','FORM'].includes(container.tagName); container = container.parentElement) {
    const bounds = container.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    const result = (x,y) => metadata({ x,y,originX:rect.left,originY:rect.top });
    if (!input.hitTest) return result(bounds.left + bounds.width/2, bounds.top + bounds.height/2);
    const left = Math.max(0,bounds.left), right = Math.min(win.innerWidth,bounds.right), top = Math.max(0,bounds.top), bottom = Math.min(win.innerHeight,bounds.bottom);
    if (right <= left || bottom <= top) return metadata(null);
    const centerX = (left+right)/2, centerY = (top+bottom)/2;
    if (doc.elementFromPoint(centerX,centerY) === el) return result(centerX,centerY);
    // Bound the search, adjusting density to the actual own surface. Every accepted
    // point is proven against the exact button; the container grants no authority.
    const spacing = Math.max(4, Math.min(24, ...surfaces.map(surface => Math.min(parseFloat(surface.width),parseFloat(surface.height))/2)));
    let columns = Math.max(1,Math.ceil((right-left)/spacing)), rows = Math.max(1,Math.ceil((bottom-top)/spacing));
    if (columns*rows > 4096) { const scale = Math.sqrt(columns*rows/4096); columns = Math.max(1,Math.floor(columns/scale)); rows = Math.max(1,Math.floor(rows/scale)); }
    for (let row=0; row<rows; row++) for (let column=0; column<columns; column++) {
     const x=left+(column+0.5)*(right-left)/columns, y=top+(row+0.5)*(bottom-top)/rows;
     if (doc.elementFromPoint(x,y) === el) return result(x,y);
    }
    return metadata(null);
   }
   return metadata(null);
  }
  if (input.mode !== 'receiver' || !rect.width || !rect.height || el.matches(':disabled,[aria-disabled="true"]')) return [];
  const hit = doc.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
  if (!hit || hit === el || el.contains(hit) || !hit.matches('button,[role="button"]') || hit.matches(':disabled,[aria-disabled="true"]')) return [];
  const name = node => {
   const ids = String(node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
   return String(node.getAttribute('aria-label') || ids.map(id=>doc.getElementById(id)?.textContent || '').join(' ') || Array.from(node.labels || []).map(label=>label.textContent).join(' ') || node.innerText || node.textContent || '').replace(/\s+/g,' ').trim().toLowerCase();
  };
  if (!name(el) || name(el) !== name(hit)) return [];
  const controls = node => Array.from(node.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="radio"],[role="checkbox"],[role="switch"]'));
  if (el.id && String(hit.getAttribute('aria-controls') || '').split(/\s+/).includes(el.id)
    && Array.from(doc.querySelectorAll('[id]')).filter(node=>node.id===el.id).length===1) {
   return Array.from(doc.querySelectorAll('button,[role="button"]')).filter(node=>String(node.getAttribute('aria-controls') || '').split(/\s+/).includes(el.id)).length===1 ? [el, hit] : [];
  }
  for (let group=el.parentElement; group && !['BODY','HTML','FORM'].includes(group.tagName); group=group.parentElement) {
   if (!group.contains(hit)) continue;
   const candidates=controls(group);
   return candidates.length===2 && candidates.includes(el) && candidates.includes(hit) ? [el, hit] : [];
  }
  return [];
 }
})` }, { contentScript: true });

/** Scope the fixed isolated selector directly to the existing native handle.
 * No DOM marker or page-installed setter participates in pointer authority. */
async function inspect(control: NativeHandle, input: Record<string, unknown>): Promise<Control | undefined> {
  await registered;
  const results = await control.$$(`${engine}=${JSON.stringify(input)}`) as Control[];
  const [native, result] = results;
  try {
    if (results.length === 2 && native && await native.evaluate((el, original) => el === original, control)) return result;
    await result?.dispose();
    return undefined;
  } finally { await native?.dispose(); }
}

export async function initializePointerInspection(): Promise<void> { await registered; }

export async function nativePointerFacts<T>(control: NativeHandle, input: Record<string, unknown>): Promise<T | undefined> {
  const result = await inspect(control, input);
  try { const value = await result?.getAttribute('content'); return value == null ? undefined : JSON.parse(value) as T; }
  finally { await result?.dispose(); }
}
export async function nativePointerReceiver(control: Control): Promise<Control | undefined> { return inspect(control, { mode: 'receiver' }); }

/** Intentional scroll preparation, isolated from page-installed method wrappers. */
export async function scrollOwnControl(control: Control): Promise<void> {
  const result = await inspect(control, { mode: 'scroll' });
  try { if (!result || await result.getAttribute('content') !== 'true') throw new Error('Native control scroll is unavailable.'); }
  finally { await result?.dispose(); }
}
