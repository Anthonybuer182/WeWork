/**
 * Account persistence on the host's per-plugin storage.
 *
 * The password lives under its own storage key, never inside the account
 * record — so code that logs or renders the account never sees the secret.
 * (Upgrade path, deliberately non-breaking: when the host grows a
 * `secret.set/get` capability backed by Electron safeStorage, only the two
 * functions below change.)
 */
import type { PluginContext } from '@pi/plugin-sdk';
import { resolveAccount } from './presets';
import type { MailAccountInput, ResolvedAccount } from './types';

const ACCOUNT_KEY = 'mail:account';
const PASS_KEY = 'mail:pass';

type Ctx = Pick<PluginContext, 'call'>;

export async function loadAccount(ctx: Ctx): Promise<MailAccountInput | null> {
  const saved = (await ctx
    .call('storage.get', { key: ACCOUNT_KEY })
    .catch(() => undefined)) as MailAccountInput | undefined;
  if (!saved || typeof saved !== 'object' || !saved.preset || !saved.email) return null;
  // Records written before the strip-on-save fix may still carry a pass —
  // never hand it back out.
  const { pass: _leaked, ...clean } = saved as unknown as Record<string, unknown>;
  return clean as unknown as MailAccountInput;
}

export async function loadPass(ctx: Ctx): Promise<string> {
  const saved = (await ctx
    .call('storage.get', { key: PASS_KEY })
    .catch(() => undefined)) as string | undefined;
  return typeof saved === 'string' ? saved : '';
}

/**
 * Validate + persist. Returns the resolved account so the caller can hand it
 * straight to the engine. `pass` empty means "keep the stored one" (the form
 * re-submits on every field change; re-typing a password to change the label
 * would be hostile).
 */
export async function saveAccount(
  ctx: Ctx,
  input: MailAccountInput,
  pass: string,
): Promise<ResolvedAccount> {
  const resolved = resolveAccount(input);
  const trimmed = String(pass ?? '').trim();

  if (trimmed) {
    await ctx.call('storage.set', { key: PASS_KEY, value: trimmed });
  } else {
    const existing = await loadPass(ctx);
    if (!existing) throw new Error('请填写客户端专用密码(授权码)');
  }

  // Store the account WITHOUT the password field — the form submits it, but
  // the account record is what account.get hands back and must never carry
  // the secret (it already leaked into a stored record once).
  const { pass: _secret, ...record } = input as unknown as Record<string, unknown>;
  await ctx.call('storage.set', { key: ACCOUNT_KEY, value: record });
  return resolved;
}

export async function clearAccount(ctx: Ctx): Promise<void> {
  await ctx.call('storage.set', { key: ACCOUNT_KEY, value: null }).catch(() => {});
  await ctx.call('storage.set', { key: PASS_KEY, value: '' }).catch(() => {});
}
