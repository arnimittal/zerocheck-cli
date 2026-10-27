import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import YAML, { isSeq } from 'yaml';
import type { CheckDefinition, EnvironmentName, ExecutionConfig } from '../../../shared/contracts.js';
import { validateAllowedOrigins, validateSecretOrigins } from '../../../shared/origins.js';
import { hasYamlStepComment, YAML_STEP_COMMENT_REMEDY } from '../../../src/parser/yaml-step-comments.js';
import { assertNoSecretLiterals } from '../../../src/security/check-secrets.js';
import { containsSecretValue } from '../../../src/security/redaction.js';

const ENVIRONMENTS: EnvironmentName[] = ['dev', 'staging', 'production'];

/** One run as this machine sees it. Only `config` and `checks` go to the instance; the secret values and their grants
 * stay here. */
export interface LocalRun {
  projectId: string; environment: EnvironmentName;
  config: ExecutionConfig;
  secrets: Record<string, string>;
  /** Which environment variable holds each secret. */
  variables: Record<string, string>;
  grants: Record<string, string[]>;
  checks: CheckDefinition[];
}

/** Reads zerocheck.yaml, the selected checks and the environment's secrets. The instance validates the checks and the
 * configuration again; this side checks only what it enforces itself. */
export async function readLocalRun(projectDir: string, paths: string[], environment?: string, variables: NodeJS.ProcessEnv = process.env): Promise<LocalRun> {
  let text: string;
  try { text = await fs.readFile(resolve(projectDir, 'zerocheck.yaml'), 'utf8'); }
  catch { throw new Error('No readable zerocheck.yaml. Run this in your project folder.'); }
  const document = YAML.parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`zerocheck.yaml: ${document.errors[0].message}`);
  const project = document.toJS({ maxAliasCount: 50 }) as Record<string, any>;
  if (typeof project?.project !== 'string' || !project.project) throw new Error('zerocheck.yaml must name its project.');
  const chosen = (environment ?? project.default_environment) as EnvironmentName;
  if (!ENVIRONMENTS.includes(chosen)) throw new Error('Choose the dev, staging or production environment.');
  const selected = project.environments?.[chosen];
  if (!selected || typeof selected.url !== 'string') throw new Error(`Environment ${chosen} is not configured in zerocheck.yaml.`);
  const steps = document.getIn(['environments', chosen, 'login_steps'], true);
  if (isSeq(steps)) for (const [index, node] of steps.items.entries()) if (hasYamlStepComment(node, text)) throw new Error(`${chosen}.login_steps[${index + 1}]: ${YAML_STEP_COMMENT_REMEDY}`);

  const secrets: Record<string, string> = {}, names: Record<string, string> = {}, missing: string[] = [];
  if (selected.secrets !== undefined && (!selected.secrets || typeof selected.secrets !== 'object' || Array.isArray(selected.secrets))) throw new Error(`${chosen}.secrets must map names to environment variables.`);
  for (const [name, reference] of Object.entries(selected.secrets ?? {})) {
    const variable = typeof reference === 'string' ? reference.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] : undefined;
    if (!variable) throw new Error(`Secret ${name} must be an environment variable reference such as \${${name}}.`);
    names[name] = variable;
    const value = variables[variable];
    if (value) secrets[name] = value; else missing.push(variable);
  }
  if (missing.length) throw new Error(`Missing test secrets for ${chosen}: ${missing.join(', ')}. Set these environment variables before running.`);
  // The same rules as a hosted run's: this machine enforces the grants itself.
  const allowedOrigins = validateAllowedOrigins(selected.allowed_origins, `${chosen}.allowed_origins`);
  const grants = validateSecretOrigins(selected.secret_origins, secrets, selected.url, allowedOrigins, `${chosen}.secret_origins`);

  const execution = project.execution ?? {};
  const config: ExecutionConfig = {
    url: selected.url, loginSteps: selected.login_steps ?? [], allowedOrigins, secretNames: Object.keys(secrets),
    ...['retries', 'testTimeoutMs', 'stepTimeoutMs', 'viewport'].reduce((out, key) => execution[key] === undefined ? out : { ...out, [key]: execution[key] }, {}),
  };
  const directory = typeof project.test_directory === 'string' ? project.test_directory : 'zerocheck/tests';
  const checks = await readChecks(projectDir, paths.length ? paths : [directory]);
  // The instance gets secret names only, so it cannot see a value written out in the steps it is sent: refuse that here,
  // as the CLI always has for checks, and for the login steps it now sends too, before anything is recorded or sent. The
  // YAML is never rewritten.
  assertNoSecretLiterals(checks, Object.values(secrets));
  if (containsSecretValue(config.loginSteps, Object.values(secrets))) throw new Error(`${chosen}.login_steps in zerocheck.yaml contains a configured secret value. Replace the literal with a \${NAME} reference before running.`);
  return { projectId: project.project, environment: chosen, config, secrets, variables: names, grants, checks };
}

/** The selected YAML files, as the instance names them: a path id and a content revision. */
async function readChecks(projectDir: string, selected: string[]): Promise<CheckDefinition[]> {
  const root = await fs.realpath(projectDir), files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(`${root}${sep}`)) throw new Error(`${path} is outside the project.`);
    const info = await fs.lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported for checks: ${path}`);
    if (info.isDirectory()) for (const item of (await fs.readdir(full)).sort()) await visit(relative(root, resolve(full, item)));
    else if (info.isFile() && ['.yaml', '.yml'].includes(extname(full))) files.push(full);
  };
  for (const path of selected) await visit(path);
  if (!files.length) throw new Error('No checks selected. Name YAML files or a folder of them.');
  return Promise.all(files.map(async full => {
    const path = relative(root, full).split(sep).join('/'), yaml = await fs.readFile(full, 'utf8');
    return { id: createHash('sha256').update(path).digest('hex').slice(0, 24), path, yaml, revision: createHash('sha256').update(yaml).digest('hex') };
  }));
}
