/**
 * Provider presets. Every major mailbox speaks IMAP/SMTP with a client
 * password (授权码/客户端专用密码) — adding a provider is one row here.
 *
 * `hint` is shown in the panel's account form: how to enable IMAP and get the
 * client password for that provider. The words differ per provider but the
 * dance is the same: admin enables IMAP (enterprise), user generates a
 * dedicated password — the account password itself never works for IMAP.
 */
import type { MailAccountInput, ResolvedAccount } from './types';

export interface PresetDef {
  label: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  hint: string;
}

export const PRESETS: Record<string, PresetDef> = {
  dingtalk: {
    label: '钉钉企业邮(阿里邮箱)',
    imap: { host: 'imap.qiye.aliyun.com', port: 993 },
    smtp: { host: 'smtp.qiye.aliyun.com', port: 465 },
    hint: '邮箱网页设置 → 开启 IMAP/SMTP 服务 → 生成客户端专用密码(管理员可能需先放开)',
  },
  feishu: {
    label: '飞书邮箱',
    imap: { host: 'imap.feishu.cn', port: 993 },
    smtp: { host: 'smtp.feishu.cn', port: 465 },
    hint: '管理员在管理后台开启 IMAP/SMTP 服务;邮箱 设置 → 安全设置 → 客户端专用密码',
  },
  qq: {
    label: 'QQ 邮箱',
    imap: { host: 'imap.qq.com', port: 993 },
    smtp: { host: 'smtp.qq.com', port: 465 },
    hint: '设置 → 账户 → 开启 IMAP/SMTP 服务 → 生成授权码',
  },
  '163': {
    label: '网易 163',
    imap: { host: 'imap.163.com', port: 993 },
    smtp: { host: 'smtp.163.com', port: 465 },
    hint: '设置 → POP3/IMAP/SMTP → 开启 IMAP → 新增授权密码',
  },
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 465 },
    hint: '需要两步验证:Google 账号 → 安全性 → 应用专用密码',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp.office365.com', port: 587 },
    hint: '个人版:账号安全 → 应用密码。企业 M365 需管理员放开 IMAP(企业版 OAuth 暂不支持)',
  },
  custom: {
    label: '其他邮箱(手填 IMAP/SMTP)',
    imap: { host: '', port: 993 },
    smtp: { host: '', port: 465 },
    hint: '在邮箱设置里开启 IMAP/SMTP,并生成客户端专用密码/授权码',
  },
};

/**
 * Validate an account form submission and resolve preset hosts into concrete
 * endpoints. Throws with panel-displayable (Chinese) messages — the account
 * form is the caller that shows them.
 */
export function resolveAccount(input: MailAccountInput): ResolvedAccount {
  const email = String(input?.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('请填写有效的邮箱地址');
  }

  const preset = String(input?.preset ?? '');
  if (!preset) throw new Error('请选择邮箱类型');
  const def = PRESETS[preset];
  if (!def) throw new Error(`未知的邮箱类型: ${preset}`);

  const user = String(input?.user ?? '').trim() || email;

  let imap = def.imap;
  let smtp = def.smtp;
  if (preset === 'custom') {
    imap = normalizeEndpoint(input.imap, 'IMAP');
    smtp = normalizeEndpoint(input.smtp, 'SMTP');
  }

  return { preset, email, user, imap, smtp };
}

function normalizeEndpoint(
  endpoint: { host?: unknown; port?: unknown } | undefined,
  name: string,
): { host: string; port: number } {
  const host = String(endpoint?.host ?? '').trim();
  if (!host) throw new Error(`请填写 ${name} 服务器地址`);
  const port = Number(endpoint?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 端口无效`);
  }
  return { host, port };
}
