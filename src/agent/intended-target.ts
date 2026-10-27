import { readDOM, selectAllDOM, sameDOMNode, bindDOMLocator, filterEntityCandidates, type NativeLocatorLease } from './dom-reader.js';
import { ExecutionError } from '../engine/execution-error.js';
import { TargetChangedError, SelectedTargetMismatchError } from './target-errors.js';
import { outsideQuotedText, scanQuotedText } from '../../shared/quoted-text.js';
import { locatorIncludesHandle, readAccessibleName } from './accessible-name.js';
import type { ElementHandle, Frame } from 'playwright';
import type { Step } from '../parser/types.js';
import type { TargetPolicy } from '../policy/target-policy.js';
import { readTargetIdentity, type TargetIdentity } from './target-identity.js';
import { anchoredDescriptionTarget, authoredOrdinal, hasAuthoredOrdinal, withoutAuthoredOrdinal, authoredQualifier, explicitRoleTarget, literalTargetName, normalizeTargetName, qualifiedRoleOnly, targetInstruction, targetRolesMatch } from './authored-target.js';
import { blockedFrameOrigins, frameOrigin, isFrameVisible, NativeFrameDetachedError } from './frame-policy.js';
import { targetReadiness } from './target-readiness.js';
import { hasOwnPointerSurface } from './pointer-receiver.js';

/** Prove uniqueness of the instruction, never merely of the model's CSS selector. */
export async function bindIntendedTarget(handle: ElementHandle<SVGElement | HTMLElement>, step: Step, identity: TargetIdentity, policy?: TargetPolicy): Promise<TargetIdentity> {
  const frame = await handle.ownerFrame();
  if (!frame) throw new TargetChangedError('Target detached before authored binding.');
  const authored = targetInstruction(step);
  const explicitSelector = explicitRoleTarget(authored.replace(/^(["'])(.*)\1$/, '$2'));
  let instruction = explicitSelector ? JSON.stringify(explicitSelector.name) : authored;
  let tiers: [Frame[], Frame[]] | undefined;
  if (hasAuthoredOrdinal(instruction) && literalTargetName(instruction) === undefined) {
    tiers = await bindingFrames(frame, policy);
    // A whole observed label wins over ordinal grammar, regardless of the model pick.
    const whole = normalizeTargetName(instruction);
    if (await observedLiteralName(tiers, whole, step)) instruction = JSON.stringify(whole);
  }
  const fullName = normalizeTargetName(instruction);
  const localName = !identity.name && identity.textEntry ? await readDOM(handle, 'localLabel') : '';
  const name = (identity.name || localName).trim().replace(/\s+/g, ' ').toLowerCase();
  const wholeName = instruction.trim().replace(/\s+/g, ' ').toLowerCase() === name;
  const qualifier = step.keyword === 'act' || wholeName || fullName === name ? undefined : authoredQualifier(step);
  const anchored = anchoredDescriptionTarget(step, identity.name);
  const roleOnly = qualifiedRoleOnly(qualifier);
  const completeName = wholeName || fullName === name && literalTargetName(instruction) === undefined;
  const ordinal = completeName ? undefined : authoredOrdinal(qualifier?.rawControl ?? instruction);
  const landmarks: Record<string, 'banner'|'contentinfo'|'navigation'|'main'|'complementary'> = { header: 'banner', footer: 'contentinfo', navigation: 'navigation', nav: 'navigation', main: 'main', sidebar: 'complementary' };
  const landmark = qualifier && ['in','within'].includes(qualifier.relation) ? landmarks[qualifier.entity] : undefined;
  const control = wholeName ? name : ordinal ? normalizeTargetName(withoutAuthoredOrdinal(qualifier?.rawControl ?? instruction)) : qualifier?.control ?? fullName;
  if (!completeName && hasAuthoredOrdinal(qualifier?.rawControl ?? instruction) && !ordinal) throw new SelectedTargetMismatchError('The authored ordinal needs a numeric position, for example 101st.');
  const unquoted = outsideQuotedText(qualifier?.rawControl ?? instruction);
  const authoredRole = explicitSelector?.role ?? (anchored ? anchored.role : step.keyword === 'act' || wholeName ? undefined : unquoted.match(/\b(button|link|field|input|box|dropdown|checkbox|radio)\b/i)?.[1].toLowerCase());
  const role = ['field','input','box'].includes(authoredRole ?? '') ? 'textbox' : authoredRole === 'dropdown' ? 'combobox' : authoredRole ?? (step.keyword === 'enter' ? 'textbox' : step.keyword === 'select' ? 'combobox' : undefined);
  const clickFamily = !explicitSelector && step.keyword === 'click' && ['button','link'].includes(role ?? '');
  if (!targetRolesMatch(role, identity, clickFamily)) throw new SelectedTargetMismatchError('Ambiguous target: the authored control role does not match.');
  let authoredName = anchored?.name ?? literalTargetName(qualifier?.rawControl ?? instruction);
  if (ordinal && authoredName === undefined) {
    tiers ??= await bindingFrames(frame, policy);
    if (await observedLiteralName(tiers, control, step, role)) authoredName = control;
  }
  const literal = authoredName !== undefined || control === name;
  if (ordinal && !literal) await assertDescriptiveOrder(handle, ordinal, identity.role, control);
  const controlName = roleOnly ? undefined : authoredName;
  if (!literal && !roleOnly && step.keyword !== 'act' && scanQuotedText(instruction).spans.length > 0) throw new SelectedTargetMismatchError('Ambiguous target: the authored control name does not match.');
  if (!literal && !roleOnly && !qualifier) { const unbound = { ...identity }; delete unbound.binding; return unbound; }
  // Descriptive intent remains usable through AI, but is never persisted as proven.
  // Raw names are used only for local DOM lookup, never persisted or sent to AI.
  // For literal names, the browser's accessible-name match is authoritative.
  // Raw DOM identity can contain aria-hidden status text; it remains unchanged
  // for staleness/policy checks. CSS uniqueness never substitutes for membership.
  const observedName = authoredName ?? (identity.name.includes('[redacted]') ? (await readTargetIdentity(handle, [], Number.MAX_SAFE_INTEGER)).name : identity.name || localName);
  const escapedName = observedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const queryName = new RegExp(`^[\\s\uE000-\uF8FF\u2190-\u21FF\u27F0-\u27FF\u2900-\u297F]*${escapedName}[\\s\uE000-\uF8FF\u2190-\u21FF\u27F0-\u27FF\u2900-\u297F]*$`, 'i');
  const entityPattern = `^${(qualifier?.entity ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  if (authoredName !== undefined && !roleOnly && !await nativeNameMatches(handle, observedName, identity.role, Boolean(identity.textEntry))) throw new SelectedTargetMismatchError('Ambiguous target: the authored control name does not match the selected control.');
  let matches = 0; let selected = false; let rejected = false; let ordered = 0;
  const [primary, embedded] = tiers ?? await bindingFrames(frame, policy, Boolean(anchored));
  // The live top-level application gets first claim. A model-supplied framePath
  // cannot hide its matching control behind a same-name chat/analytics control.
  for (const tier of [primary, embedded]) {
  for (const candidateFrame of tier) {
    const nativeRole = ['button','link','textbox','combobox','checkbox','radio','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','searchbox','spinbutton','img'].includes(identity.role);
    const includeHidden = authoredName === undefined;
    let locator = nativeRole ? candidateFrame.getByRole(identity.role as 'button', { ...(roleOnly ? {} : { name: queryName }), includeHidden }) : candidateFrame.getByText(queryName);
    if (clickFamily) locator = locator.or(candidateFrame.getByRole('button', {name: queryName, includeHidden})).or(candidateFrame.getByRole('link', {name: queryName, includeHidden}));
    if (step.keyword === 'click' && (!role || clickFamily)) locator = locator.or(candidateFrame.locator('[tabindex],[onclick],[role="button"],[role="link"]'));
    if (nativeRole && !role) for (const kind of ['button','link','textbox','combobox','checkbox','radio','switch','tab','menuitem','option'] as const) locator = locator.or(candidateFrame.getByRole(kind, { name: queryName, includeHidden }));
    if (['radio', 'checkbox'].includes(identity.role)) locator = locator.or(candidateFrame.getByLabel(queryName).and(candidateFrame.locator(`input[type="${identity.role}"]`)));
    if (identity.textEntry) {
      // Label aliases include decorative aria-labelled images. Retain text-entry
      // controls (including password inputs without an ARIA textbox role), not
      // every element sharing the label. Readonly/disabled fields still count.
      const textEntry = candidateFrame.locator('input:not([type="button" i],[type="submit" i],[type="reset" i],[type="checkbox" i],[type="radio" i],[type="file" i],[type="image" i],[type="color" i],[type="range" i],[type="hidden" i]),textarea,[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i],[role="textbox"],[role="searchbox"],[role="spinbutton"]');
      locator = locator.or(candidateFrame.getByPlaceholder(queryName).or(candidateFrame.getByLabel(queryName)).and(textEntry));
      if (authoredName !== undefined || localName) locator = locator.or(textEntry); // Native name/local label proof below remains mandatory.
    }
    if (landmark) locator = locator.and(candidateFrame.getByRole(landmark).locator('*'));
    const candidates: ElementHandle<SVGElement | HTMLElement>[] = [];
    let selectedLease: NativeLocatorLease | undefined;
    try {
      if (qualifier?.entity && !landmark) {
        if (candidateFrame === frame) selectedLease = await bindDOMLocator(handle);
        locator = await filterEntityCandidates(locator, { entity: qualifier.entity, relation: qualifier.relation, entityPattern, controlName }, selectedLease?.locator);
      }
      candidates.push(...await locator.elementHandles() as ElementHandle<SVGElement | HTMLElement>[]);
      for (const candidate of candidates) {
        if (!(await targetReadiness(candidate)).active) continue;
        if (step.keyword === 'click' && (!role || clickFamily)) {
          const currentIdentity = await readTargetIdentity(candidate);
          if (!currentIdentity.interactive || !targetRolesMatch(role,currentIdentity,clickFamily)) continue;
        }
        const ownSurface = step.keyword === 'click' && !await candidate.isVisible() && await hasOwnPointerSurface(candidate);
        const match = await readDOM(candidate, 'entityMatch', { entity: landmark ? undefined : qualifier?.entity, relation: qualifier?.relation, entityPattern, ownSurface, controlName });
        if (!match) continue;
        const isSelected = candidateFrame === frame && await candidate.evaluate((element, original) => element === original, handle);
        if (match === 'conflict' && !isSelected) continue;
        // Entity/visibility is a cheap prefilter, never name authority. Read the
        // native accessible name only for candidates that could own the action.
        if (literal && !roleOnly && !await nativeNameMatches(candidate, observedName, identity.role, Boolean(identity.textEntry))) continue;
        if (literal && step.keyword === 'click' && await isDuplicateFocusWrapper(candidate, observedName)) continue;
        if (match === 'conflict') { rejected = true; continue; }
        if (ordinal && ++ordered !== ordinal) continue;
        matches++;
        if (isSelected) selected = true;
      }
    } finally { try { await Promise.all(candidates.map(candidate => candidate.dispose())); } finally { await selectedLease?.release(); } }
  }
  if (matches && !anchored) break;
  }
  if (rejected) throw new SelectedTargetMismatchError('Ambiguous target: the selected control belongs to a different authored entity or record.');
  if (matches === 0) throw new TargetChangedError('Target not found: no current control satisfies the authored name and entity.');
  if (matches !== 1) throw new ExecutionError('configuration', 'Ambiguous target: the instruction does not identify exactly one matching control and entity.');
  if (!selected) throw new SelectedTargetMismatchError('Ambiguous target: the selected control is not the independently matched authored target.');
  // Exact name/uniqueness constrains this dispatch; the descriptive tail remains model-interpreted.
  if (anchored || ordinal) { const unbound = { ...identity }; delete unbound.binding; return unbound; }
  return literal || roleOnly ? { ...identity, name: authoredName ?? identity.name, entity: qualifier?.entity, binding: { version: 2, control, ...(qualifier ? { entity: qualifier.entity, relation: qualifier.relation } : {}) } } : identity;
}

async function nativeNameMatches(handle: ElementHandle<SVGElement | HTMLElement>, expected: string, role: string, textEntry: boolean): Promise<boolean> {
  const observed = await readTargetIdentity(handle, [], Number.MAX_SAFE_INTEGER);
  const nativeRoles = ['button','link','textbox','combobox','checkbox','radio','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','searchbox','spinbutton','img'];
  if (!nativeRoles.includes(observed.role)) return observed.name.trim().replace(/\s+/g, ' ').toLowerCase() === expected.trim().replace(/\s+/g, ' ').toLowerCase();
  const native = await readAccessibleName(handle, observed.role, observed.name);
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalize(native) === normalize(expected)) return true;
  if (textEntry && normalize(await handle.getAttribute('placeholder') ?? '') === normalize(expected)) return true;
  if (textEntry) {
    const frame = await handle.ownerFrame();
    if (frame && await locatorIncludesHandle(frame.getByLabel(new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')), handle)) return true;
    if (!normalize(native) && normalize(await readDOM(handle, 'localLabel')) === normalize(expected)) return true;
  }
  const decorations = await readDOM(handle, 'decorations');
  let name = native.trim();
  for (const raw of decorations) {
    let text: string; try { text = JSON.parse(raw); } catch { continue; }
    if (!text.trim() || !/^[\s\uE000-\uF8FF\u2190-\u21FF\u27F0-\u27FF\u2900-\u297F]+$/.test(text)) continue;
    const decoration = text.trim();
    if (name.startsWith(decoration)) name = name.slice(decoration.length).trim();
    if (name.endsWith(decoration)) name = name.slice(0, -decoration.length).trim();
  }
  return normalize(name) === normalize(expected);
}

/** Independent name discovery prevents a wrong model pick from turning a name into a description. */
async function observedLiteralName(tiers: [Frame[], Frame[]], name: string, step: Step, role?: string): Promise<boolean> {
  if (!name) return false;
  for (const tier of tiers) for (const frame of tier) {
    const candidates = await frame.locator('button,a[href],input,select,textarea,summary,[contenteditable],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="spinbutton"],[tabindex],[onclick]').elementHandles() as ElementHandle<SVGElement | HTMLElement>[];
    try {
      for (const candidate of candidates) {
        if (!(await targetReadiness(candidate)).active) continue;
        const identity = await readTargetIdentity(candidate);
        if (step.keyword === 'click' && !identity.interactive || step.keyword === 'enter' && !identity.textEntry || step.keyword === 'select' && identity.role !== 'combobox') continue;
        if (!targetRolesMatch(role, identity, step.keyword === 'click' && ['button','link'].includes(role ?? ''))) continue;
        if (await nativeNameMatches(candidate, name, identity.role, Boolean(identity.textEntry)) && !await isDuplicateFocusWrapper(candidate, name)) return true;
      }
    } finally { await Promise.all(candidates.map(candidate => candidate.dispose())); }
  }
  return false;
}

async function focusWrapperWithoutDeclaredActivation(handle: ElementHandle<SVGElement | HTMLElement>): Promise<boolean> {
  // DOM0 handlers are application-world state. Like readTargetIdentity, they are
  // only a compatibility hint; native DOM/name observations remain authoritative.
  // This does not establish absence of registered or delegated event listeners.
  return await readDOM(handle, 'focusWrapper') && !await handle.evaluate(element => typeof (element as any).onclick === 'function');
}

/** Focus management around a named action does not manufacture a second action. */
async function isDuplicateFocusWrapper(handle: ElementHandle<SVGElement | HTMLElement>, name: string): Promise<boolean> {
  if (!await focusWrapperWithoutDeclaredActivation(handle)) return false;
  const descendants = await selectAllDOM(handle, 'actionDescendants');
  let matches = 0;
  try {
    for (const child of descendants) {
      if (!(await targetReadiness(child)).active || await focusWrapperWithoutDeclaredActivation(child)) continue;
      const identity = await readTargetIdentity(child);
      if (identity.interactive && await nativeNameMatches(child, name, identity.role, Boolean(identity.textEntry))) matches++;
    }
    return matches === 1;
  } finally { await Promise.all(descendants.map(child => child.dispose())); }
}

/** A matching collection label establishes the candidate set; list order alone does not. */
async function assertDescriptiveOrder(handle: ElementHandle<SVGElement | HTMLElement>, ordinal: number, role: string, description: string): Promise<void> {
  const label = await readDOM(handle, 'ordinalCollectionLabel');
  if (!label || label.trim().replace(/\s+/g, ' ').toLowerCase() !== description) return;
  const items = await selectAllDOM(handle, 'ordinalItems');
  let count = 0; let selected = 0;
  try {
    for (const item of items) {
      if (!(await targetReadiness(item)).active) continue;
      const descendants = await selectAllDOM(item, 'actionDescendants');
      const matches: ElementHandle<SVGElement | HTMLElement>[] = [];
      try {
        for (const candidate of [item, ...descendants]) {
          if (!(await targetReadiness(candidate)).active || await focusWrapperWithoutDeclaredActivation(candidate)) continue;
          const identity = await readTargetIdentity(candidate);
          if (identity.role === role && identity.interactive) matches.push(candidate);
        }
        if (matches.length !== 1) return; // Unknown collection membership remains descriptive, not cached.
        count++;
        if (await sameDOMNode(matches[0], handle)) selected = count;
      } finally { await Promise.all(descendants.map(candidate => candidate.dispose())); }
    }
    if (selected && selected !== ordinal) throw new SelectedTargetMismatchError('Ambiguous target: the selected control contradicts the authored ordinal in its collection.');
  } finally { await Promise.all(items.map(item => item.dispose())); }
}

async function bindingFrames(frame: Frame, policy?: TargetPolicy, acrossFrames = false): Promise<[Frame[], Frame[]]> {
  const primary: Frame[] = [], embedded: Frame[] = [];
  const requiredFrames: Frame[] = [];
  for (let current: Frame | null = frame; current; current = current.parentFrame()) requiredFrames.push(current);
  const topOrigin = policy ? await frameOrigin(frame.page().mainFrame()) : undefined;
  for (const candidateFrame of policy || acrossFrames ? frame.page().frames() : [frame]) {
    try { if (!await isFrameVisible(candidateFrame)) continue; }
    catch (error) {
      if (!(error instanceof NativeFrameDetachedError)) throw error;
      if (requiredFrames.some(required => required.isDetached())) throw new TargetChangedError('The selected target frame detached before authored binding.');
      continue; // A positively retired unrelated frame cannot own a current target.
    }
    if (policy && (await blockedFrameOrigins(candidateFrame, policy)).length) continue;
    let sameChain = true;
    if (policy) for (let ancestor: Frame | null = candidateFrame; ancestor; ancestor = ancestor.parentFrame()) if (await frameOrigin(ancestor) !== topOrigin) { sameChain = false; break; }
    (sameChain ? primary : embedded).push(candidateFrame);
  }
  return [primary, embedded];
}
