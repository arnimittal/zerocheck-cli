import { isScalar } from 'yaml';

/** A YAML comment on a plain instruction may have silently removed intended text. */
export function hasYamlStepComment(node: unknown, source: string): boolean {
  return Boolean(isScalar(node) && node.type === 'PLAIN' && node.range
    && /^[ \t]+#/.test(source.slice(node.range[1], node.range[2])));
}
export const YAML_STEP_COMMENT_REMEDY = 'YAML truncated this step at a comment. Quote the whole step to preserve # and the complete instruction.';
