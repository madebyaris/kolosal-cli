/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { tokenLimit } from '@kolosal-ai/kolosal-ai-core';
import { theme } from '../semantic-colors.js';

/**
 * Format token count for display (e.g., 1234 -> "1.2k", 1234567 -> "1.2M")
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return count.toString();
}

/**
 * Get color based on usage percentage
 */
function getUsageColor(usagePercent: number): string {
  if (usagePercent >= 90) return theme.status.error; // Red - critical
  if (usagePercent >= 75) return theme.status.warning; // Yellow - warning
  if (usagePercent >= 50) return theme.text.secondary; // Gray - moderate
  return theme.status.success; // Green - healthy
}

/**
 * Generate a simple progress bar using Unicode characters
 */
function generateProgressBar(usagePercent: number, width: number = 10): string {
  const filled = Math.round((usagePercent / 100) * width);
  const empty = width - filled;
  const filledChar = '█';
  const emptyChar = '░';
  return filledChar.repeat(filled) + emptyChar.repeat(empty);
}

export interface ContextUsageDisplayProps {
  promptTokenCount: number;
  model: string;
  /** Show compact version (just percentage) */
  compact?: boolean;
  /** Show progress bar */
  showProgressBar?: boolean;
}

export const ContextUsageDisplay = ({
  promptTokenCount,
  model,
  compact = false,
  showProgressBar = false,
}: ContextUsageDisplayProps) => {
  const maxTokens = tokenLimit(model);
  const usagePercent = (promptTokenCount / maxTokens) * 100;
  const remainingPercent = 100 - usagePercent;
  const color = getUsageColor(usagePercent);

  if (compact) {
    return (
      <Text color={color}>
        {remainingPercent.toFixed(0)}% left
      </Text>
    );
  }

  const usedFormatted = formatTokenCount(promptTokenCount);
  const maxFormatted = formatTokenCount(maxTokens);

  if (showProgressBar) {
    const progressBar = generateProgressBar(usagePercent, 8);
    return (
      <Box>
        <Text color={color}>{progressBar}</Text>
        <Text color={theme.text.secondary}> </Text>
        <Text color={color}>{usedFormatted}</Text>
        <Text color={theme.text.secondary}>/</Text>
        <Text color={theme.text.secondary}>{maxFormatted}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={color}>{usedFormatted}</Text>
      <Text color={theme.text.secondary}>/</Text>
      <Text color={theme.text.secondary}>{maxFormatted}</Text>
      <Text color={theme.text.secondary}> (</Text>
      <Text color={color}>{remainingPercent.toFixed(0)}%</Text>
      <Text color={theme.text.secondary}> left)</Text>
    </Box>
  );
};
