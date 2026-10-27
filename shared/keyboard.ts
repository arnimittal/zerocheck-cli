/** One normalized key drives policy, applicability and the actual Playwright press. */
export function normalizeKey(value?: string): { value: string; key: string; activation: boolean; enter: boolean } {
  const parts = (value ?? 'Enter').split('+');
  const aliases: Record<string, string> = { enter: 'Enter', numpadenter: 'NumpadEnter', space: 'Space', spacebar: 'Space', ' ': 'Space', delete: 'Delete', backspace: 'Backspace', shift: 'Shift', control: 'Control', ctrl: 'Control', alt: 'Alt', meta: 'Meta', controlormeta: 'ControlOrMeta' };
  const normalized = parts.map(part => aliases[part.toLowerCase()] ?? part);
  const key = normalized.at(-1) ?? 'Enter';
  return { value: normalized.join('+'), key, activation: ['Enter', 'NumpadEnter', 'Space'].includes(key), enter: ['Enter', 'NumpadEnter'].includes(key) };
}

export function keyActivatesControl(value: string | undefined, role?: string | null, inputType?: string | null): boolean {
  const key = normalizeKey(value);
  if (!key.activation) return false;
  if (['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role ?? '')) return key.enter && Boolean(inputType && inputType !== 'textarea');
  return true;
}
