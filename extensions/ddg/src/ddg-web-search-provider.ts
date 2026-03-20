import { Type } from "@sinclair/typebox";
import { parseHTML } from "linkedom";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readNumberParam,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setScopedCredentialValue,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";

const DDG_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_SEARCH_REGION_CODES = new Set([
  "ar-es",
  "at-de",
  "au-en",
  "be-fr",
  "be-nl",
  "bg-bg",
  "br-pt",
  "ca-en",
  "ca-fr",
  "ch-de",
  "ch-fr",
  "cl-es",
  "cn-zh",
  "co-es",
  "ct-ca",
  "cz-cs",
  "de-de",
  "dk-da",
  "ee-et",
  "es-ca",
  "es-es",
  "fi-fi",
  "fr-fr",
  "gr-el",
  "hk-tzh",
  "hu-hu",
  "id-en",
  "ie-en",
  "il-en",
  "in-en",
  "is-is",
  "it-it",
  "jp-jp",
  "kr-kr",
  "lt-lt",
  "lv-lv",
  "mx-es",
  "my-en",
  "nl-nl",
  "no-no",
  "nz-en",
  "pe-es",
  "ph-en",
  "pk-en",
  "pl-pl",
  "pt-pt",
  "ro-ro",
  "ru-ru",
  "se-sv",
  "sg-en",
  "sk-sk",
  "sl-sl",
  "th-en",
  "tr-tr",
  "tw-tzh",
  "ua-uk",
  "uk-en",
  "us-en",
  "us-es",
  "vn-en",
  "wt-wt",
  "xa-ar",
  "za-en",
]);
const DDG_FRESHNESS_CODES = new Set(["d", "w", "m", "y"]);

const GenericDuckDuckGoSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-20).",
        minimum: 1,
        maximum: 20,
      }),
    ),
    region: Type.Optional(
      Type.String({
        description: "DuckDuckGo region code like us-en, id-en, uk-en, or wt-wt for all regions.",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Time filter: day, week, month, or year.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DuckDuckGoSearchResult = {
  title: string;
  url: string;
  description?: string;
  siteName?: string;
};

function normalizeDuckDuckGoRegion(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return DDG_SEARCH_REGION_CODES.has(normalized) ? normalized : undefined;
}

function normalizeDuckDuckGoFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const mapped =
    normalized === "d" || normalized === "day" || normalized === "pd"
      ? "d"
      : normalized === "w" || normalized === "week" || normalized === "pw"
        ? "w"
        : normalized === "m" || normalized === "month" || normalized === "pm"
          ? "m"
          : normalized === "y" || normalized === "year" || normalized === "py"
            ? "y"
            : undefined;
  return mapped && DDG_FRESHNESS_CODES.has(mapped) ? mapped : undefined;
}

function resolveDuckDuckGoUrl(rawHref: string): string {
  const resolved = new URL(rawHref, "https://duckduckgo.com");
  const redirected = resolved.searchParams.get("uddg");
  if (redirected) {
    return redirected;
  }
  return resolved.toString();
}

function extractResultText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? wrapWebContent(normalized, "web_search") : undefined;
}

function parseDuckDuckGoResults(html: string, count: number): DuckDuckGoSearchResult[] {
  const { document } = parseHTML(html);
  const nodes = Array.from(document.querySelectorAll(".result"));
  const seenUrls = new Set<string>();
  const results: DuckDuckGoSearchResult[] = [];

  for (const node of nodes) {
    const anchor = node.querySelector(".result__a");
    const href = anchor?.getAttribute("href")?.trim();
    if (!anchor || !href) {
      continue;
    }

    const url = resolveDuckDuckGoUrl(href);
    if (!url || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);

    const title = extractResultText(anchor.textContent) ?? "";
    if (!title) {
      continue;
    }

    const snippet =
      extractResultText(node.querySelector(".result__snippet")?.textContent) ?? undefined;
    const siteName =
      extractResultText(node.querySelector(".result__url")?.textContent) ??
      resolveSiteName(url) ??
      undefined;

    results.push({
      title,
      url,
      ...(snippet ? { description: snippet } : {}),
      ...(siteName ? { siteName } : {}),
    });

    if (results.length >= count) {
      break;
    }
  }

  return results;
}

async function runDuckDuckGoSearch(params: {
  query: string;
  count: number;
  region?: string;
  freshness?: string;
  timeoutSeconds: number;
}): Promise<DuckDuckGoSearchResult[]> {
  const form = new URLSearchParams();
  form.set("q", params.query);
  if (params.region) {
    form.set("kl", params.region);
  }
  if (params.freshness) {
    form.set("df", params.freshness);
  }

  return await withTrustedWebSearchEndpoint(
    {
      url: DDG_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; OpenClaw/1.0; +https://openclaw.ai)",
        },
        body: form.toString(),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`DuckDuckGo Search error (${res.status}): ${detail || res.statusText}`);
      }
      return parseDuckDuckGoResults(await res.text(), params.count);
    },
  );
}

export function createDuckDuckGoWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "ddg",
    label: "DuckDuckGo Search",
    hint: "Keyless DuckDuckGo web results with region and time filters",
    envVars: [],
    placeholder: "No API key required",
    signupUrl: "https://duckduckgo.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 15,
    credentialPath: "tools.web.search.ddg.apiKey",
    inactiveSecretPaths: ["tools.web.search.ddg.apiKey"],
    getCredentialValue: (searchConfig) => {
      const ddg = searchConfig?.ddg;
      return ddg && typeof ddg === "object" && !Array.isArray(ddg)
        ? (ddg as { apiKey?: unknown }).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      setScopedCredentialValue(searchConfigTarget, "ddg", value);
    },
    createTool: (ctx) => ({
      description:
        "Search the web using DuckDuckGo without an API key. Returns organic web results with snippets and optional region/time filters.",
      parameters: GenericDuckDuckGoSearchSchema,
      execute: async (args) => {
        const params = args as Record<string, unknown>;
        const query = readStringParam(params, "query", { required: true });
        const count = resolveSearchCount(
          readNumberParam(params, "count", { integer: true }),
          DEFAULT_SEARCH_COUNT,
        );
        const region = readStringParam(params, "region");
        const freshness = readStringParam(params, "freshness");
        const normalizedRegion = normalizeDuckDuckGoRegion(region);
        if (region && !normalizedRegion) {
          return {
            error: "invalid_region",
            message: "region must be a DuckDuckGo locale code like us-en, id-en, uk-en, or wt-wt.",
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }
        const normalizedFreshness = normalizeDuckDuckGoFreshness(freshness);
        if (freshness && !normalizedFreshness) {
          return {
            error: "invalid_freshness",
            message: "freshness must be day, week, month, or year.",
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }

        const cacheKey = buildSearchCacheKey([
          "ddg",
          query,
          count,
          normalizedRegion,
          normalizedFreshness,
        ]);
        const cached = readCachedSearchPayload(cacheKey);
        if (cached) {
          return cached;
        }

        const timeoutSeconds = resolveSearchTimeoutSeconds(
          ctx.searchConfig as Record<string, unknown> | undefined,
        );
        const cacheTtlMs = resolveSearchCacheTtlMs(
          ctx.searchConfig as Record<string, unknown> | undefined,
        );
        const startedAt = Date.now();
        const results = await runDuckDuckGoSearch({
          query,
          count: Math.min(count, MAX_SEARCH_COUNT),
          region: normalizedRegion,
          freshness: normalizedFreshness,
          timeoutSeconds,
        });
        const payload = {
          query,
          provider: "ddg",
          count: results.length,
          tookMs: Date.now() - startedAt,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: "ddg",
            wrapped: true,
          },
          results,
        };
        writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
        return payload;
      },
    }),
  };
}

export const __testing = {
  normalizeDuckDuckGoFreshness,
  normalizeDuckDuckGoRegion,
  parseDuckDuckGoResults,
  resolveDuckDuckGoUrl,
} as const;
