import type { RunRecord } from '../../../shared/contracts.js';

export function printRun(run: RunRecord): void {
  console.log(`${run.environment} / ${run.runner}: ${run.status} (${run.id})`);
  for (const test of run.result?.tests ?? []) {
    const label = test.status === 'pass' ? test.flaky ? 'FLAKY / passed after recovery' : 'PASS' : test.failureKind === 'cancelled' ? 'CANCELLED' : ['infrastructure', 'configuration', 'policy'].includes(test.failureKind ?? '') ? `ERROR / ${test.failureKind}` : 'FAIL';
    console.log(`  ${label}  ${test.name}${test.healed ? ' [healed]' : ''}${test.blocksMerge === false ? ' [non-blocking]' : ''}`);
    for (const attempt of test.attempts ?? [{ attempt: 1, steps: test.steps }]) {
      for (const step of attempt.steps.filter(step => step.status === 'fail')) console.log(`    Attempt ${attempt.attempt}: ${step.raw}: ${step.error ?? 'Failed'}`);
      for (const step of attempt.steps.filter(step => step.observation)) console.log(`    ${step.raw}: ${step.observation!.kind === 'nonappearance' ? 'nonappearance throughout' : 'stable absence at the end of'} ${step.observation!.windowMs / 1000}s.${step.observation!.match ? ` Matching: ${step.observation!.match} text.` : ''}`);
    }
  }
  if (run.error) console.log(`  ${run.error}`);
  if (run.webUrl) console.log(`Results: ${run.webUrl}`);
}
