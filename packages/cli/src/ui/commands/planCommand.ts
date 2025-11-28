/**
 * @license
 * Copyright 2025 Kolosal
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, CommandContext, MessageActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { ApprovalMode } from '@kolosal-ai/kolosal-ai-core';

/**
 * Quick toggle for Plan mode (session-only).
 * Plan mode prevents file edits and commands - only analysis and planning.
 */
export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'Toggle Plan mode (read-only analysis) for this session',
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, _args: string): Promise<MessageActionReturn> => {
    const { config } = context.services;
    
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      };
    }

    try {
      const currentMode = config.getApprovalMode();
      
      if (currentMode === ApprovalMode.PLAN) {
        // Toggle off - return to DEFAULT mode
        config.setApprovalMode(ApprovalMode.DEFAULT);
        return {
          type: 'message',
          messageType: 'info',
          content: '✏️ Plan mode disabled. Returning to default approval mode.',
        };
      } else {
        // Toggle on - enable PLAN mode
        config.setApprovalMode(ApprovalMode.PLAN);
        return {
          type: 'message',
          messageType: 'info',
          content: '📋 Plan mode enabled! Analysis only - no file edits or commands will run.\n' +
                   '   The AI will present a plan and wait for your confirmation.\n' +
                   '   Use /plan again to disable, or /approval-mode default to return to normal.',
        };
      }
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to toggle Plan mode: ${(error as Error).message}`,
      };
    }
  },
};
