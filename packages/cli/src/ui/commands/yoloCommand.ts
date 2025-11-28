/**
 * @license
 * Copyright 2025 Kolosal
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, CommandContext, MessageActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { ApprovalMode } from '@kolosal-ai/kolosal-ai-core';

/**
 * Quick toggle for YOLO mode (session-only).
 * YOLO mode auto-approves all tool calls without confirmation.
 */
export const yoloCommand: SlashCommand = {
  name: 'yolo',
  description: 'Toggle YOLO mode (auto-approve all tools) for this session',
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
      
      if (currentMode === ApprovalMode.YOLO) {
        // Toggle off - return to DEFAULT mode
        config.setApprovalMode(ApprovalMode.DEFAULT);
        return {
          type: 'message',
          messageType: 'info',
          content: '🛡️ YOLO mode disabled. Returning to default approval mode.',
        };
      } else {
        // Toggle on - enable YOLO mode
        config.setApprovalMode(ApprovalMode.YOLO);
        return {
          type: 'message',
          messageType: 'info',
          content: '⚡ YOLO mode enabled! All tool calls will be auto-approved.\n' +
                   '   Use /yolo again to disable, or /approval-mode default to return to normal.',
        };
      }
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to toggle YOLO mode: ${(error as Error).message}\n` +
                 'Note: YOLO mode requires the folder to be trusted. Run /trust first if needed.',
      };
    }
  },
};
