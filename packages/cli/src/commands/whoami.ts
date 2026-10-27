import { apiRequest } from '../api-client.js';
import { apiBase, requireToken } from '../config.js';
import type { ProjectRecord } from '../../../../shared/contracts.js';
export async function whoamiCommand(): Promise<void> {
  requireToken();
  const { projects } = await apiRequest<{ projects: ProjectRecord[] }>('/v1/cli/projects', { method: 'GET' });
  console.log(`Signed in to ${apiBase()}`);
  for (const project of projects) console.log(`Project: ${project.id} (${project.name})`);
}
