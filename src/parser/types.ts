export type Keyword = 'navigate_to' | 'click' | 'enter' | 'verify' | 'wait_for' | 'press' | 'select' | 'hover_over' | 'scroll_to' | 'act';
export interface Step { keyword: Keyword; argument: string; lineNumber: number; raw: string }
export interface TestBlock {
  name: string;
  description?: string;
  blocksMerge?: boolean;
  steps: Step[];
}
export const KEYWORD_MAP: [string, Keyword][] = [
  ['Navigate to', 'navigate_to'], ['Hover over', 'hover_over'], ['Scroll to', 'scroll_to'],
  ['Wait for', 'wait_for'], ['Click', 'click'], ['Enter', 'enter'], ['Verify', 'verify'], ['Select', 'select'],
];
