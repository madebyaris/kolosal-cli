/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { convert } from 'html-to-text';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { fetchWithTimeout, isPrivateIp } from '../utils/fetch.js';
import { getResponseText } from '../utils/partUtils.js';
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
import { webContentCache, SearchCache } from '../utils/searchCache.js';

const URL_FETCH_TIMEOUT_MS = 8000; // Reduced from 10s for faster response
const MAX_CONTENT_LENGTH = 100000;

/**
 * Parameters for the WebFetch tool
 */
export interface WebFetchToolParams {
  /**
   * The URL to fetch content from
   */
  url: string;
  /**
   * The prompt to run on the fetched content
   */
  prompt: string;
}

/**
 * Implementation of the WebFetch tool invocation logic
 */
class WebFetchToolInvocation extends BaseToolInvocation<
  WebFetchToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: WebFetchToolParams,
  ) {
    super(params);
  }

  private async executeDirectFetch(signal: AbortSignal): Promise<ToolResult> {
    let url = this.params.url;

    // Convert GitHub blob URL to raw URL
    if (url.includes('github.com') && url.includes('/blob/')) {
      url = url
        .replace('github.com', 'raw.githubusercontent.com')
        .replace('/blob/', '/');
      console.debug(
        `[WebFetchTool] Converted GitHub blob URL to raw URL: ${url}`,
      );
    }

    try {
      // Check cache for the raw content
      const cacheKey = SearchCache.generateKey(url);
      let textContent = webContentCache.get(cacheKey);
      let cached = false;

      if (textContent) {
        console.debug(`[WebFetchTool] Cache hit for URL: ${url}`);
        cached = true;
      } else {
        const startTime = Date.now();
        console.debug(`[WebFetchTool] Fetching content from: ${url}`);
        const response = await fetchWithTimeout(url, URL_FETCH_TIMEOUT_MS);

        if (!response.ok) {
          const errorMessage = `Request failed with status code ${response.status} ${response.statusText}`;
          console.error(`[WebFetchTool] ${errorMessage}`);
          throw new Error(errorMessage);
        }

        console.debug(`[WebFetchTool] Successfully fetched content from ${url}`);
        const html = await response.text();
        textContent = convert(html, {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' },
          ],
        }).substring(0, MAX_CONTENT_LENGTH);

        // Cache the converted text content
        webContentCache.set(cacheKey, textContent);
        
        const elapsed = Date.now() - startTime;
        console.debug(
          `[WebFetchTool] Converted HTML to text (${textContent.length} chars) in ${elapsed}ms`,
        );
      }

      const geminiClient = this.config.getGeminiClient();
      const fallbackPrompt = `The user requested the following: "${this.params.prompt}".

I have fetched the content from ${this.params.url}. Please use the following content to answer the user's request.

---
${textContent}
---`;

      console.debug(
        `[WebFetchTool] Processing content with prompt: "${this.params.prompt}"`,
      );

      const result = await geminiClient.generateContent(
        [{ role: 'user', parts: [{ text: fallbackPrompt }] }],
        {},
        signal,
      );
      const resultText = getResponseText(result) || '';

      console.debug(
        `[WebFetchTool] Successfully processed content from ${this.params.url}`,
      );

      const cacheIndicator = cached ? ' (cached content)' : '';
      return {
        llmContent: resultText,
        returnDisplay: `Content from ${this.params.url} processed successfully${cacheIndicator}.`,
      };
    } catch (e) {
      const error = e as Error;
      const errorMsg = error.message || 'Unknown error';
      // Check for cause property (ES2022+)
      const errorCause = (error as Error & { cause?: unknown }).cause;
      const causeMsg = errorCause instanceof Error ? `: ${errorCause.message}` : '';
      
      const errorMessage = `Error during fetch for ${url}: ${errorMsg}${causeMsg}`;
      console.error(`[WebFetchTool] ${errorMessage}`, error);
      
      // Provide more helpful error hints based on error type
      let errorHint = '';
      const fullErrorMsg = `${errorMsg}${causeMsg}`.toLowerCase();
      
      if (fullErrorMsg.includes('timeout') || fullErrorMsg.includes('etimedout')) {
        errorHint = ' Try again or check if the URL is accessible.';
      } else if (fullErrorMsg.includes('econnrefused')) {
        errorHint = ' The server refused the connection.';
      } else if (fullErrorMsg.includes('enotfound') || fullErrorMsg.includes('getaddrinfo')) {
        errorHint = ' Could not resolve the hostname. Check the URL.';
      } else if (fullErrorMsg.includes('certificate') || fullErrorMsg.includes('ssl') || fullErrorMsg.includes('cert')) {
        errorHint = ' SSL/TLS certificate issue. The site may have an invalid certificate.';
      } else if (fullErrorMsg.includes('fetch failed')) {
        errorHint = ' Network request failed. This could be due to SSL issues, network problems, or the site blocking automated requests.';
      } else if (fullErrorMsg.includes('econnreset')) {
        errorHint = ' Connection was reset by the server.';
      }
      
      return {
        llmContent: `Error: ${errorMessage}${errorHint}`,
        returnDisplay: `Error: ${errorMsg}${errorHint}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }
  }

  override getDescription(): string {
    const displayPrompt =
      this.params.prompt.length > 100
        ? this.params.prompt.substring(0, 97) + '...'
        : this.params.prompt;
    return `Fetching content from ${this.params.url} and processing with prompt: "${displayPrompt}"`;
  }

  override async shouldConfirmExecute(): Promise<
    ToolCallConfirmationDetails | false
  > {
    // Allow in PLAN mode since web fetch is read-only (just retrieves information)
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT ||
        this.config.getApprovalMode() === ApprovalMode.YOLO ||
        this.config.getApprovalMode() === ApprovalMode.PLAN) {
      return false;
    }

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Confirm Web Fetch`,
      prompt: `Fetch content from ${this.params.url} and process with: ${this.params.prompt}`,
      urls: [this.params.url],
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    // Check if URL is private/localhost
    const isPrivate = isPrivateIp(this.params.url);

    if (isPrivate) {
      console.debug(
        `[WebFetchTool] Private IP detected for ${this.params.url}, using direct fetch`,
      );
    } else {
      console.debug(
        `[WebFetchTool] Public URL detected for ${this.params.url}, using direct fetch`,
      );
    }

    return this.executeDirectFetch(signal);
  }
}

/**
 * Implementation of the WebFetch tool logic
 */
export class WebFetchTool extends BaseDeclarativeTool<
  WebFetchToolParams,
  ToolResult
> {
  static readonly Name: string = 'web_fetch';

  constructor(private readonly config: Config) {
    super(
      WebFetchTool.Name,
      'WebFetch',
      'Fetches content from a specified URL and processes it using an AI model\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Processes the content with the prompt using a small, fast model\n- Returns the model\'s response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".\n  - The URL must be a fully-formed valid URL\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n  - Supports both public and private/localhost URLs using direct fetch',
      Kind.Fetch,
      {
        properties: {
          url: {
            description: 'The URL to fetch content from',
            type: 'string',
          },
          prompt: {
            description: 'The prompt to run on the fetched content',
            type: 'string',
          },
        },
        required: ['url', 'prompt'],
        type: 'object',
      },
    );
    const proxy = config.getProxy();
    if (proxy) {
      setGlobalDispatcher(new ProxyAgent(proxy as string));
    }
  }

  protected override validateToolParamValues(
    params: WebFetchToolParams,
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
    if (!params.prompt || params.prompt.trim() === '') {
      return "The 'prompt' parameter cannot be empty.";
    }
    return null;
  }

  protected createInvocation(
    params: WebFetchToolParams,
  ): ToolInvocation<WebFetchToolParams, ToolResult> {
    return new WebFetchToolInvocation(this.config, params);
  }
}
