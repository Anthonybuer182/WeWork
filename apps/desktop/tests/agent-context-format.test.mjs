/**
 * The numbers the context panel and the `context_audit` tool put in front of a
 * reader.
 *
 * These are strings a person — or an agent relaying to a person — acts on, so a
 * formatting regression here is silent and looks like data. The assertions that
 * matter most are the ones guarding *decisions*: that a shadowed prompt file is
 * never reported as in effect, and that the plugin index is not counted twice
 * against the budget.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  budgetRows,
  budgetTotal,
  formatAuditText,
  formatChars,
  formatCount,
  formatTokens,
  promptFileGroups,
  promptFileStatus,
  promptStatusLabel,
  reloadNote,
  scopeLabel,
} from '@pi/sdk-wrapper';

test('formatCount separates thousands without a locale', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1,000');
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCount(-1234), '-1,234');
  assert.equal(formatCount(1234.6), '1,235');
});

test('formatChars compacts and marks token estimates', () => {
  assert.equal(formatChars(834), '834');
  assert.equal(formatChars(1234), '1.2k');
  assert.equal(formatChars(12345), '12k');
  assert.equal(formatChars(1500000), '1.5M');
  assert.equal(formatTokens(3100), '≈3.1k');
});

test('scope labels cover all three discovery sources', () => {
  assert.equal(scopeLabel('global'), '全局');
  assert.equal(scopeLabel('workspace'), '工作区');
  assert.equal(scopeLabel('ancestor'), '上级目录');
});

test('reload wording never promises more than happened', () => {
  assert.match(reloadNote({ applied: true }), /下一条消息/);
  assert.match(reloadNote({ applied: false, reason: 'busy' }), /新会话/);
  assert.match(reloadNote({ applied: false, reason: 'no-session' }), /新会话/);
});

test('a rebuild failure is reported as a save that did not take effect, not a failed save', () => {
  // The file is already on disk by the time a reload runs. Saying "保存失败"
  // would send the user hunting for a problem that does not exist — and likely
  // re-editing a file that is already correct.
  const note = reloadNote({ applied: false, reason: 'error', message: 'boom' });
  assert.match(note, /文件已保存/);
  assert.match(note, /生效时出错/);
  assert.match(note, /boom/);
  assert.doesNotMatch(note, /保存失败/);
});

// ── prompt files ──

test('a file that exists but loses to the other scope is "shadowed", not "active"', () => {
  // The state worth being loud about: on disk, readable, and doing nothing.
  assert.equal(promptFileStatus({ exists: true, active: true }), 'active');
  assert.equal(promptFileStatus({ exists: true, active: false }), 'shadowed');
  assert.equal(promptFileStatus({ exists: false, active: false }), 'missing');
  assert.equal(promptStatusLabel('shadowed'), '被遮住');
});

test('prompt files group by kind, project before global, regardless of input order', () => {
  const file = (kind, scope, active = false, exists = true) => ({
    kind,
    scope,
    path: `/${scope}/${kind}.md`,
    exists,
    active,
    content: exists ? 'x' : null,
    bytes: 1,
    chars: 1,
    mtimeMs: 1,
  });
  const input = [
    file('append', 'global'),
    file('system', 'global', true),
    file('system', 'project'),
    file('append', 'project'),
  ];
  const groups = promptFileGroups(input);
  assert.deepEqual(groups.map((g) => g.kind), ['system', 'append']);
  assert.equal(groups[0].files[0].scope, 'project');
  assert.equal(groups[0].files[1].scope, 'global');
  // Reversing the input must not change the output.
  assert.deepEqual(promptFileGroups([...input].reverse()), groups);
});

// ── budget ──

test('budget rows drop zero-cost sections and sort largest first', () => {
  const config = makeConfig({ base: 100, appended: 500, context: 300, skills: 0, tools: 200 });
  const rows = budgetRows(config);
  assert.deepEqual(rows.map((r) => r.label), ['追加段', '上下文文件', '工具定义', '基础系统提示词']);
  assert.equal(budgetTotal(config), 1100);
});

test('an unreadable base prompt counts as zero rather than throwing', () => {
  assert.equal(budgetTotal(makeConfig({ base: null, appended: 10, context: 0, skills: 0, tools: 0 })), 10);
});

// ── the agent-facing report ──

test('the audit report marks estimates as estimates', () => {
  const text = formatAuditText(makeConfig({ base: 100, appended: 900, context: 90, skills: 16, tools: 460 }));
  assert.match(text, /tokens \(estimated\)/);
  assert.match(text, /Sent on every request/);
});

test('the plugin index is not counted twice against the budget', () => {
  // It is one of the appended segments. If it also appeared as a budget row the
  // same characters would be counted twice and the reported total would exceed
  // what the model actually receives.
  const text = formatAuditText(makeConfig({ base: 100, appended: 900, context: 0, skills: 0, tools: 0 }));
  const bySection = text.slice(text.indexOf('By section'), text.indexOf('Base system prompt'));
  assert.equal(
    bySection.split('\n').filter((line) => line.includes('插件索引')).length,
    0,
  );
});

test('a replaced base prompt says so, and a missing one is not reported as zero', () => {
  const replaced = formatAuditText(
    makeConfig({ base: 18, appended: 0, context: 0, skills: 0, tools: 0, overridden: true }),
  );
  assert.match(replaced, /REPLACED by a SYSTEM\.md/);
  assert.match(replaced, /built-in prompt is not in effect/);

  const missing = formatAuditText(
    makeConfig({ base: null, appended: 10, context: 0, skills: 0, tools: 0 }),
  );
  assert.match(missing, /text unavailable/);
  assert.doesNotMatch(missing, /Base system prompt: 0 chars/);
});

test('a shadowed prompt file is reported as having no effect', () => {
  const config = makeConfig({ base: 100, appended: 0, context: 0, skills: 0, tools: 0 });
  config.promptFiles = [
    {
      kind: 'append',
      scope: 'global',
      path: '/agent/APPEND_SYSTEM.md',
      exists: true,
      active: false,
      content: 'x',
      bytes: 1,
      chars: 1,
      mtimeMs: 1,
    },
  ];
  const text = formatAuditText(config);
  assert.match(text, /present but shadowed by the other scope/);
});

// ── the host-contributed tool ──
//
// The tool used to be a plugin's, which meant it could be invoked directly over
// the plugin IPC. Now it is the host's, so the only way to pin its behaviour
// without spending a real model turn is to drive it here. Cheap, and it guards
// the "no active workspace" message a user would otherwise meet as a raw throw.

test('context_audit reports the active workspace and refuses cleanly without one', async () => {
  const { createHostAgentTools, setActiveWorkspace } = await import(
    '../src/main/agent-tools.ts'
  );
  const config = makeConfig({ base: 100, appended: 0, context: 0, skills: 0, tools: 0 });
  const calls = [];
  const [tool] = createHostAgentTools({
    readContextConfig: async (path, id) => {
      calls.push([path, id]);
      return { ...config, workspace: { ...config.workspace, path } };
    },
  });
  assert.equal(tool.name, 'context_audit');
  // Host tools carry no pluginId — in the tool listing they read as built-in,
  // which is what they are.
  assert.equal(tool.pluginId, undefined);

  setActiveWorkspace({ id: 'w1', path: '/w' });
  const result = await tool.execute('call-1', {});
  assert.deepEqual(calls, [['/w', 'w1']]);
  assert.match(result.content[0].text, /Standing context for workspace \/w/);
  assert.equal(result.details.workspace, '/w');

  // An explicit path wins and carries no id — it is not the active workspace.
  await tool.execute('call-2', { workspacePath: '/other' });
  assert.deepEqual(calls[1], ['/other', undefined]);

  setActiveWorkspace(null);
  await assert.rejects(() => tool.execute('call-3', {}), /no active workspace/);
});

function makeConfig(sizes) {
  return {
    workspace: { path: '/w' },
    agentDir: '/agent',
    assembled: null,
    promptFiles: [],
    sections: {
      base: {
        text: sizes.base === null ? null : 'x',
        chars: sizes.base,
        note: 'n',
        overridden: sizes.overridden ?? false,
      },
      appended: sizes.appended
        ? [{ label: '插件索引', source: 'plugin-docs', text: 'x', chars: sizes.appended }]
        : [],
      contextFiles: sizes.context
        ? [
            {
              path: '/w/AGENTS.md',
              scope: 'workspace',
              bytes: 1,
              chars: sizes.context,
              content: 'x',
              mtimeMs: 1,
            },
          ]
        : [],
      skills: { items: [], rendered: 'x', chars: sizes.skills },
      tools: sizes.tools ? [{ name: 't', source: 'builtin', schemaBytes: sizes.tools }] : [],
    },
    pluginDocs: [],
    totals: { chars: 0, tokensEst: 0 },
  };
}
