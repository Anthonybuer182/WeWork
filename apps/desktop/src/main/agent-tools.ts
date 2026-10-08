/**
 * Agent tools the host contributes itself.
 *
 * Until now every agent tool came from a plugin, because plugins were the only
 * contributor. The context audit is different: it reports on the agent's own
 * kernel state, and routing it through the plugin trust boundary would mean
 * inventing a capability, a permission and a late-bound bridge so that
 * first-party code could read first-party state. The host may contribute tools
 * directly instead.
 *
 * `pluginId` is absent on these, which is deliberate: in the tool listing they
 * read as built-in, because that is what they are.
 */

import type { AgentContextConfig } from '@pi/types';
import { formatAuditText } from '@pi/sdk-wrapper';

/** Agent tool definition shape expected by createAgentSession({ customTools }). */
export interface AgentCustomTool {
  name: string;
  label: string;
  /** The plugin that contributed this tool. Absent for host-contributed tools. */
  pluginId?: string;
  description: string;
  parameters: unknown;
  /** From the manifest contribution — true = the tool only observes state. */
  readOnly?: boolean;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }>;
    details: unknown;
  }>;
}

/** The workspace the renderer is showing. Only the renderer knows this. */
let activeWorkspace: { id: string; path: string } | null = null;

export function setActiveWorkspace(workspace: { id: string; path: string } | null): void {
  activeWorkspace = workspace;
}

export function getActiveWorkspace(): { id: string; path: string } | null {
  return activeWorkspace;
}

export interface HostAgentToolDeps {
  readContextConfig: (workspacePath: string, workspaceId?: string) => Promise<AgentContextConfig>;
}

export function createHostAgentTools(deps: HostAgentToolDeps): AgentCustomTool[] {
  return [
    {
      name: 'context_audit',
      label: 'context_audit',
      description:
        "Report the agent's standing context — the instruction block sent on every request, before any conversation. " +
        'Returns each part (system prompt, prompt files, context files, plugin docs, skills, tool schemas) with its ' +
        "character cost and the total against the model's context window. Use it when the user asks why the context " +
        'is filling up, what is costing tokens, or which installed plugin is expensive.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_toolCallId, params) => {
        const explicit = typeof params.workspacePath === 'string' ? params.workspacePath.trim() : '';
        const target = explicit || activeWorkspace?.path;
        if (!target) {
          throw new Error(
            'context_audit: no active workspace — open a workspace in the app, or pass workspacePath',
          );
        }
        const config = await deps.readContextConfig(target, explicit ? undefined : activeWorkspace?.id);
        return {
          content: [{ type: 'text' as const, text: formatAuditText(config) }],
          details: {
            workspace: config.workspace.path,
            totals: config.totals,
            bySection: {
              base: config.sections.base.chars,
              appended: config.sections.appended.reduce((n, s) => n + s.chars, 0),
              contextFiles: config.sections.contextFiles.reduce((n, f) => n + f.chars, 0),
              skills: config.sections.skills.chars,
              tools: config.sections.tools.reduce((n, t) => n + t.schemaBytes, 0),
            },
            pluginDocs: config.pluginDocs,
          },
        };
      },
    },
  ];
}
