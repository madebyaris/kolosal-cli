/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolInfoConfirmationDetails,
  ToolConfirmationOutcome,
} from './tools.js';

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';
import { webSearchCache, SearchCache } from '../utils/searchCache.js';

// Search timeout in milliseconds (reduced from default for faster response)
const SEARCH_TIMEOUT_MS = 8000;
// Retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

interface TavilyResultItem {
  title: string;
  url: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilyResultItem[];
}

/**
 * Cached search result type
 */
interface CachedSearchResult {
  answer?: string;
  results: Array<{ title: string; url: string; content?: string }>;
}

/**
 * Parameters for the WebSearchTool.
 */
export interface WebSearchToolParams {
  /**
   * The search query.
   */
  query: string;
}

/**
 * Extends ToolResult to include sources for web search.
 */
export interface WebSearchToolResult extends ToolResult {
  sources?: Array<{ title: string; url: string }>;
  /** Whether result came from cache */
  cached?: boolean;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  // Combine the provided signal with our timeout signal
  const originalSignal = options.signal;
  
  if (originalSignal) {
    originalSignal.addEventListener('abort', () => controller.abort());
  }
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

class WebSearchToolInvocation extends BaseToolInvocation<
  WebSearchToolParams,
  WebSearchToolResult
> {
  constructor(
    private readonly config: Config,
    params: WebSearchToolParams,
  ) {
    super(params);
  }

  override getDescription(): string {
    return `Searching the web for: "${this.params.query}"`;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // Allow in PLAN mode since web search is read-only (just retrieves information)
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT ||
        this.config.getApprovalMode() === ApprovalMode.YOLO ||
        this.config.getApprovalMode() === ApprovalMode.PLAN) {
      return false;
    }

    const confirmationDetails: ToolInfoConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Search',
      prompt: `Search the web for: "${this.params.query}"`,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  /**
   * Execute the Tavily API search with retry logic
   */
  private async executeSearch(
    apiKey: string,
    query: string,
    signal: AbortSignal,
  ): Promise<TavilySearchResponse> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (signal.aborted) {
          throw new Error('Search aborted');
        }

        const response = await fetchWithTimeout(
          'https://api.tavily.com/search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              api_key: apiKey,
              query: query,
              search_depth: 'basic', // Use 'basic' for faster results
              max_results: 5,
              include_answer: true,
            }),
            signal,
          },
          SEARCH_TIMEOUT_MS,
        );

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(
            `Tavily API error: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
          );
        }

        return (await response.json()) as TavilySearchResponse;
      } catch (error: unknown) {
        lastError = error as Error;
        
        // Don't retry on abort or if we've exhausted retries
        if (signal.aborted || attempt >= MAX_RETRIES) {
          throw error;
        }
        
        // Only retry on timeout or network errors
        const errorMsg = (error as Error).message || '';
        if (errorMsg.includes('abort') && !errorMsg.includes('timeout')) {
          throw error;
        }
        
        console.debug(`[WebSearch] Retry ${attempt + 1}/${MAX_RETRIES} after error: ${errorMsg}`);
        await sleep(RETRY_DELAY_MS * (attempt + 1)); // Exponential backoff
      }
    }
    
    throw lastError || new Error('Search failed after retries');
  }

  async execute(signal: AbortSignal): Promise<WebSearchToolResult> {
    const apiKey =
      this.config.getTavilyApiKey() || process.env['TAVILY_API_KEY'];
    if (!apiKey) {
      return {
        llmContent:
          'Web search is disabled because TAVILY_API_KEY is not configured. Please set it in your settings.json, .env file, or via --tavily-api-key command line argument to enable web search.',
        returnDisplay:
          'Web search disabled. Configure TAVILY_API_KEY to enable Tavily search.',
      };
    }

    // Check cache first
    const cacheKey = SearchCache.generateKey(this.params.query);
    const cachedResult = webSearchCache.get(cacheKey);
    
    if (cachedResult) {
      console.debug(`[WebSearch] Cache hit for query: "${this.params.query}"`);
      return this.formatResult(cachedResult, true);
    }

    try {
      const startTime = Date.now();
      const data = await this.executeSearch(apiKey, this.params.query, signal);
      const elapsed = Date.now() - startTime;
      console.debug(`[WebSearch] Search completed in ${elapsed}ms`);

      // Cache the result
      const cacheEntry: CachedSearchResult = {
        answer: data.answer,
        results: (data.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
        })),
      };
      webSearchCache.set(cacheKey, cacheEntry);

      return this.formatResult(cacheEntry, false);
    } catch (error: unknown) {
      const errorMessage = `Error during web search for query "${this.params.query}": ${getErrorMessage(
        error,
      )}`;
      console.error(errorMessage, error);
      
      // Return a more helpful error message
      const errorHint = (error as Error).message?.includes('timeout')
        ? ' (The search timed out. Try a simpler query or check your network connection.)'
        : (error as Error).message?.includes('abort')
          ? ' (Search was cancelled.)'
          : '';
      
      return {
        llmContent: `Error: ${errorMessage}${errorHint}`,
        returnDisplay: `Error performing web search.${errorHint}`,
      };
    }
  }

  /**
   * Format the search result for LLM consumption
   */
  private formatResult(
    data: CachedSearchResult,
    cached: boolean,
  ): WebSearchToolResult {
    const sources = data.results.map((r) => ({
      title: r.title,
      url: r.url,
    }));

    const sourceListFormatted = sources.map(
      (s, i) => `[${i + 1}] ${s.title || 'Untitled'} (${s.url})`,
    );

    let content = data.answer?.trim() || '';
    if (!content) {
      // Fallback: build a concise summary from top results
      content = sources
        .slice(0, 3)
        .map((s, i) => `${i + 1}. ${s.title} - ${s.url}`)
        .join('\n');
    }

    if (sourceListFormatted.length > 0) {
      content += `\n\nSources:\n${sourceListFormatted.join('\n')}`;
    }

    if (!content.trim()) {
      return {
        llmContent: `No search results or information found for query: "${this.params.query}"`,
        returnDisplay: 'No information found.',
        cached,
      };
    }

    const cacheIndicator = cached ? ' (cached)' : '';
    return {
      llmContent: `Web search results for "${this.params.query}":\n\n${content}`,
      returnDisplay: `Search results for "${this.params.query}" returned${cacheIndicator}.`,
      sources,
      cached,
    };
  }
}

/**
 * A tool to perform web searches using Google Search via the Gemini API.
 */
export class WebSearchTool extends BaseDeclarativeTool<
  WebSearchToolParams,
  WebSearchToolResult
> {
  static readonly Name: string = 'web_search';

  constructor(private readonly config: Config) {
    super(
      WebSearchTool.Name,
      'WebSearch',
      'Performs a web search using the Tavily API and returns a concise answer with sources. Requires the TAVILY_API_KEY environment variable.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find information on the web.',
          },
        },
        required: ['query'],
      },
    );
  }

  /**
   * Validates the parameters for the WebSearchTool.
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  protected override validateToolParamValues(
    params: WebSearchToolParams,
  ): string | null {
    if (!params.query || params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }
    return null;
  }

  protected createInvocation(
    params: WebSearchToolParams,
  ): ToolInvocation<WebSearchToolParams, WebSearchToolResult> {
    return new WebSearchToolInvocation(this.config, params);
  }
}
