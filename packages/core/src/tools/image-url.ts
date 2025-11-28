/**
 * @license
 * Copyright 2025 Kolosal
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PartUnion } from '@google/genai';

const IMAGE_FETCH_TIMEOUT_MS = 15000;
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB max

/**
 * Fetch with timeout and custom options
 */
async function fetchImageWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Combine external abort signal with our timeout
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'image/*',
      },
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Supported image MIME types
 */
const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

/**
 * Detect MIME type from URL extension
 */
function getMimeTypeFromUrl(url: string): string | null {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) return 'image/jpeg';
  if (urlLower.includes('.png')) return 'image/png';
  if (urlLower.includes('.gif')) return 'image/gif';
  if (urlLower.includes('.webp')) return 'image/webp';
  if (urlLower.includes('.svg')) return 'image/svg+xml';
  if (urlLower.includes('.bmp')) return 'image/bmp';
  return null;
}

/**
 * Parameters for the ReadImageUrl tool
 */
export interface ReadImageUrlToolParams {
  /**
   * The URL of the image to fetch
   */
  url: string;
  /**
   * Optional description/context about why this image is being fetched
   */
  description?: string;
}

/**
 * Result includes the image as inline data for vision models
 */
export interface ReadImageUrlToolResult extends ToolResult {
  /** The image data as a Part for the LLM */
  imagePart?: PartUnion;
}

/**
 * Implementation of the ReadImageUrl tool invocation logic
 */
class ReadImageUrlToolInvocation extends BaseToolInvocation<
  ReadImageUrlToolParams,
  ReadImageUrlToolResult
> {
  constructor(
    private readonly config: Config,
    params: ReadImageUrlToolParams,
  ) {
    super(params);
  }

  override getDescription(): string {
    const desc = this.params.description 
      ? ` (${this.params.description})` 
      : '';
    return `Fetching image from ${this.params.url}${desc}`;
  }

  override async shouldConfirmExecute(): Promise<
    ToolCallConfirmationDetails | false
  > {
    // Allow in PLAN mode since image fetch is read-only (just retrieves information)
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT ||
        this.config.getApprovalMode() === ApprovalMode.YOLO ||
        this.config.getApprovalMode() === ApprovalMode.PLAN) {
      return false;
    }

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Confirm Image Fetch',
      prompt: `Fetch image from: ${this.params.url}`,
      urls: [this.params.url],
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(signal: AbortSignal): Promise<ReadImageUrlToolResult> {
    let url = this.params.url;

    // Handle common URL patterns
    // Convert GitHub blob URL to raw URL
    if (url.includes('github.com') && url.includes('/blob/')) {
      url = url
        .replace('github.com', 'raw.githubusercontent.com')
        .replace('/blob/', '/');
      console.debug(`[ReadImageUrl] Converted GitHub blob URL to raw URL: ${url}`);
    }

    try {
      console.debug(`[ReadImageUrl] Fetching image from: ${url}`);
      
      const response = await fetchImageWithTimeout(url, IMAGE_FETCH_TIMEOUT_MS, signal);

      if (!response.ok) {
        const errorMessage = `Failed to fetch image: ${response.status} ${response.statusText}`;
        console.error(`[ReadImageUrl] ${errorMessage}`);
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: errorMessage,
          error: {
            message: errorMessage,
            type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
          },
        };
      }

      // Check content type
      const contentType = response.headers.get('content-type')?.split(';')[0] || '';
      let mimeType = contentType;
      
      // If content type is not an image, try to detect from URL
      if (!SUPPORTED_IMAGE_TYPES[contentType]) {
        const urlMimeType = getMimeTypeFromUrl(url);
        if (urlMimeType) {
          mimeType = urlMimeType;
        } else {
          const errorMessage = `URL does not appear to be an image. Content-Type: ${contentType}`;
          console.error(`[ReadImageUrl] ${errorMessage}`);
          return {
            llmContent: `Error: ${errorMessage}. Supported types: ${Object.keys(SUPPORTED_IMAGE_TYPES).join(', ')}`,
            returnDisplay: errorMessage,
            error: {
              message: errorMessage,
              type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
            },
          };
        }
      }

      // Check content length if available
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE_BYTES) {
        const errorMessage = `Image too large: ${contentLength} bytes (max: ${MAX_IMAGE_SIZE_BYTES} bytes)`;
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: errorMessage,
          error: {
            message: errorMessage,
            type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
          },
        };
      }

      // Fetch the image data
      const arrayBuffer = await response.arrayBuffer();
      
      // Double-check size after download
      if (arrayBuffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        const errorMessage = `Image too large: ${arrayBuffer.byteLength} bytes (max: ${MAX_IMAGE_SIZE_BYTES} bytes)`;
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: errorMessage,
          error: {
            message: errorMessage,
            type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
          },
        };
      }

      // Convert to base64
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const sizeKb = (arrayBuffer.byteLength / 1024).toFixed(1);

      console.debug(`[ReadImageUrl] Successfully fetched image (${sizeKb}KB, ${mimeType})`);

      // Create the image part for the LLM
      const imagePart: PartUnion = {
        inlineData: {
          mimeType,
          data: base64Data,
        },
      };

      // For SVG, also include the text content for analysis
      if (mimeType === 'image/svg+xml') {
        const svgText = new TextDecoder().decode(arrayBuffer);
        return {
          llmContent: [
            { text: `Image fetched from ${this.params.url} (SVG, ${sizeKb}KB):\n\n${svgText.substring(0, 5000)}${svgText.length > 5000 ? '\n... (truncated)' : ''}` },
            imagePart,
          ],
          returnDisplay: `Fetched SVG image: ${sizeKb}KB`,
          imagePart,
        };
      }

      // Return the image inline with descriptive text
      return {
        llmContent: [
          { text: `Image fetched from ${this.params.url} (${mimeType}, ${sizeKb}KB):` },
          imagePart,
        ],
        returnDisplay: `Fetched image: ${sizeKb}KB (${mimeType})`,
        imagePart,
      };
    } catch (error: unknown) {
      const err = error as Error;
      const errorMessage = `Error fetching image from ${url}: ${err.message}`;
      console.error(`[ReadImageUrl] ${errorMessage}`, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }
  }
}

/**
 * A tool to fetch images from URLs and provide them to vision-capable models.
 * Supports common image formats: JPEG, PNG, GIF, WebP, SVG, BMP.
 */
export class ReadImageUrlTool extends BaseDeclarativeTool<
  ReadImageUrlToolParams,
  ReadImageUrlToolResult
> {
  static readonly Name: string = 'read_image_url';

  constructor(private readonly config: Config) {
    super(
      ReadImageUrlTool.Name,
      'ReadImageUrl',
      `Fetches an image from a URL and provides it for visual analysis.

Use this tool when you need to:
- Analyze an image from the web (screenshots, diagrams, charts, etc.)
- Read text from an image (OCR-like functionality)
- Understand visual content referenced in a discussion
- Compare visual designs or UI screenshots

Supported image formats: JPEG, PNG, GIF, WebP, SVG, BMP
Maximum size: 20MB

The image will be included in the conversation for visual analysis by vision-capable models.
If the current model doesn't support vision, the tool will return an error message.

Usage notes:
- Provide the direct URL to the image file
- For GitHub images, both blob and raw URLs are supported (blob URLs are auto-converted)
- SVG files will also include the raw SVG code for text analysis`,
      Kind.Fetch,
      {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL of the image to fetch and analyze',
          },
          description: {
            type: 'string',
            description: 'Optional: Brief description of what to look for in the image',
          },
        },
        required: ['url'],
      },
    );
  }

  protected override validateToolParamValues(
    params: ReadImageUrlToolParams,
  ): string | null {
    if (!params.url || params.url.trim() === '') {
      return "The 'url' parameter cannot be empty.";
    }
    if (
      !params.url.startsWith('http://') &&
      !params.url.startsWith('https://')
    ) {
      return "The 'url' must be a valid URL starting with http:// or https://.";
    }
    return null;
  }

  protected createInvocation(
    params: ReadImageUrlToolParams,
  ): ToolInvocation<ReadImageUrlToolParams, ReadImageUrlToolResult> {
    return new ReadImageUrlToolInvocation(this.config, params);
  }
}
