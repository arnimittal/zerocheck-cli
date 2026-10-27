import { randomUUID } from 'node:crypto';
import { boundedRead } from './read-deadline.js';
import { selectors, type ElementHandle, type Frame, type Locator } from 'playwright';
import { facts, elements, snapshots } from './dom-operations.js';

type Handle = ElementHandle<SVGElement | HTMLElement>;
type Root = ElementHandle<any> | Frame;
type Fact = keyof typeof facts;
type Selection = keyof typeof elements;
type Snapshot = keyof typeof snapshots;
type Args<F extends (...args: any[]) => unknown> = Parameters<F> extends [any, infer A] ? [input: A] : [];
const engine = 'zerocheck_dom_read_v1';
const registrationKey = Symbol.for(engine);
const registry = selectors as typeof selectors & { [registrationKey]?: Promise<void> };
const source = (operations: object) => `{${Object.entries(operations).map(([name, operation]) => `${JSON.stringify(name)}:(${String(operation)})`).join(',')}}`;
// This is a closed table of checked-in functions, not an evaluator for authored,
// model or page-provided source. The exact native handle is the selector root.
const registered = registry[registrationKey] ??= selectors.register(engine, { content: `(() => {
  const facts = ${source(facts)}, elements = ${source(elements)}, snapshots = ${source(snapshots)};
  const bindings = new Map();
  return { queryAll(root, encoded) {
    const request = JSON.parse(encoded);
    const doc = root.ownerDocument || root;
    if (['bind','lookup','release'].includes(request.kind)) {
      if (!/^[0-9a-f-]{36}$/.test(request.token)) throw new Error('Invalid native locator token.');
      if (request.kind === 'release') { bindings.delete(request.token); return []; }
      if (request.kind === 'bind') {
        if (bindings.has(request.token) || root.nodeType !== 1 || !root.isConnected) throw new Error('Native locator binding is unavailable.');
        bindings.set(request.token, { node: root, document: doc }); return [root];
      }
      const binding = bindings.get(request.token);
      if (!binding || binding.document !== doc || binding.node.ownerDocument !== doc || !binding.node.isConnected) throw new Error('Native locator binding is stale or unavailable.');
      return [binding.node];
    }

    // Necessary entity filter only. Visibility, name and final identity remain
    // controller checks; selected conflicts are retained by the locator union.
    if (request.kind === 'entity-filter') return facts.entityMatch(root, { ...request.input, ownSurface: true }) === true ? [root] : [];

    const table = request.kind === 'fact' ? facts : request.kind === 'element' ? elements : request.kind === 'snapshot' ? snapshots : null;
    if (!table || !Object.prototype.hasOwnProperty.call(table, request.operation)) throw new Error('Unknown native DOM read operation.');
    const value = table[request.operation](root, request.input, facts);
    if (request.kind === 'element') return value == null ? [] : Array.isArray(value) ? value : [value];
    const metadata = doc.createElement('meta');
    metadata.setAttribute('content', JSON.stringify({ value: request.kind === 'snapshot' ? value.facts : value }));
    return request.kind === 'snapshot' ? [metadata, ...value.nodes] : [metadata];
  }};
})()` }, { contentScript: true });

async function query(root: Root, kind: 'fact' | 'element', operation: Fact | Selection, input: unknown): Promise<Handle | null> {
  await registered;
  return await root.$(`${engine}=${JSON.stringify({ kind, operation, input })}`) as Handle | null;
}

/** DOM failures remain failures. Never retry in the page world or infer absence. */
export async function readDOM<K extends Fact>(root: Root, operation: K, ...args: Args<(typeof facts)[K]>): Promise<ReturnType<(typeof facts)[K]>> {
  const metadata = await query(root, 'fact', operation, args[0]);
  if (!metadata) throw new Error('Native DOM observation is unavailable.');
  try {
    const encoded = await metadata.getAttribute('content');
    if (encoded === null) throw new Error('Native DOM observation is unavailable.');
    const result = JSON.parse(encoded);
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'value')) throw new Error('Native DOM observation is malformed.');
    return result.value;
  } finally { await metadata.dispose(); }
}

/** Returns the actual node, retaining existing attachment/identity checks. */
export async function selectDOM<K extends Selection>(root: Root, operation: K, ...args: Args<(typeof elements)[K]>): Promise<Handle | null> {
  return query(root, 'element', operation, args[0]);
}

export async function initializeDOMInspection(): Promise<void> { await registered; }

export async function selectAllDOM<K extends Selection>(root: Root, operation: K, ...args: Args<(typeof elements)[K]>): Promise<Handle[]> {
  await registered;
  return root.$$(`${engine}=${JSON.stringify({ kind: 'element', operation, input: args[0] })}`) as Promise<Handle[]>;
}

/** Facts and node references are captured in one native observation. The caller
 * owns/disposes nodes, and correlates them with previously held native handles. */
export async function readDOMSnapshot<K extends Snapshot>(root: Root, operation: K): Promise<{ facts: ReturnType<(typeof snapshots)[K]>['facts']; nodes: Handle[] }> {
  await registered;
  const [metadata, ...nodes] = await root.$$(`${engine}=${JSON.stringify({ kind: 'snapshot', operation })}`) as Handle[];
  try {
    const encoded = await metadata?.getAttribute('content');
    if (encoded == null) throw new Error('Native DOM snapshot is unavailable.');
    const result = JSON.parse(encoded);
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'value')) throw new Error('Native DOM snapshot is malformed.');
    return { facts: result.value, nodes };
  } catch (error) { await Promise.all(nodes.map(node => node.dispose())); throw error; }
  finally { await metadata?.dispose(); }
}

/** Reference equality has no DOM getter/method or page-provided authority. */
export function sameDOMNode(first: Handle, second: Handle): Promise<boolean> {
  return first.evaluate((element, other) => element === other, second);
}

export interface NativeLocatorLease { locator: Locator; assertCurrent(): Promise<void>; release(): Promise<void> }
/** Ephemeral exact-handle bridge for APIs which require a Locator. This private
 * utility-world association cannot be reordered or overwritten by the page; it
 * confers no cached identity/permission and never writes an application attribute. */
export async function bindDOMLocator(handle: ElementHandle<any>): Promise<NativeLocatorLease> {
  await registered;
  const frame = await handle.ownerFrame();
  if (!frame) throw new Error('Native locator target frame is unavailable.');
  const token = randomUUID();
  const locator = frame.locator(`${engine}=${JSON.stringify({ kind: 'lookup', token })}`);
  let released = false;
  const release = async () => {
    if (released) return; released = true;
    // A dead/stalled document must not hold cleanup open. The token is never
    // reused; any late release only drops this association, not another lease.
    await boundedRead(async () => { const result = await frame.$(`${engine}=${JSON.stringify({ kind: 'release', token })}`); await result?.dispose(); }, { deadline: Date.now() + 250, label: 'Native locator cleanup', check: () => {} }).catch(() => {});
  };
  const assertCurrent = async () => {
    if (released || !await locator.evaluate((current, original) => current === original, handle, { timeout: 1000 })) throw new Error('Native locator no longer identifies the original target.');
  };
  try {
    const bound = await handle.$(`${engine}=${JSON.stringify({ kind: 'bind', token })}`);
    try { if (!bound || !await bound.evaluate((current, original) => current === original, handle)) throw new Error('Native locator binding changed target.'); }
    finally { await bound?.dispose(); }
    await assertCurrent();
    return { locator, assertCurrent, release };
  } catch (error) { await release(); throw error; }
}

/** Exclude only nonmatching entities in one native selector query. Keep the
 * selected native node within the original candidate set for conflict rejection. */
export async function filterEntityCandidates(original: Locator, input: Omit<Parameters<typeof facts.entityMatch>[1], 'ownSurface'>, selected?: Locator): Promise<Locator> {
  await registered;
  const filtered = original.locator(`${engine}=${JSON.stringify({ kind: 'entity-filter', input })}`);
  return selected ? filtered.or(selected.and(original)) : filtered;
}
