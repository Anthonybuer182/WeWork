import React from 'react';
import { useCommandStore } from '@/stores/command-store';

/**
 * Regex to match /command and @mention tokens.
 * Only matches at word boundaries (start of string or after whitespace).
 * The capturing group includes leading whitespace so split() preserves spacing.
 */
const TOKEN_PATTERN = /((?:^|\s)(?:\/[^\s]+|@[^\s]+))/g;

/** Known slash command names (registry: host + plugin commands) — read at call time. */
function getSlashCommandNames(): Set<string> {
  return new Set(useCommandStore.getState().commands.map((c) => c.name));
}

/**
 * Check whether a string segment looks like a token
 * (starts with optional whitespace followed by / or @).
 * Slash tokens must be a known command; @mentions are always recognized.
 */
function isToken(text: string): boolean {
  if (!/^(?:\s*)(?:\/[^\s]+|@[^\s]+)$/.test(text)) return false;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/') && !getSlashCommandNames().has(trimmed)) return false;
  return true;
}

/**
 * Render plain text with /command and @mention tokens highlighted as styled badges.
 * Leading whitespace is rendered outside the badge for clean visuals.
 * Returns an array of alternating text fragments and styled spans.
 */
export function renderTokenizedText(text: string): React.ReactNode[] {
  if (!text) return [];

  const parts = text.split(TOKEN_PATTERN);

  return parts
    .filter((part) => part !== '')
    .map((part, i) => {
      if (isToken(part)) {
        const trimmed = part.trimStart();
        const leadingSpace = part.slice(0, part.length - trimmed.length);
        const isSlash = trimmed.startsWith('/');
        const className = isSlash ? 'token-slash' : 'token-mention';
        return (
          <React.Fragment key={i}>
            {leadingSpace}
            <span className={className}>{trimmed}</span>
          </React.Fragment>
        );
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });
}
