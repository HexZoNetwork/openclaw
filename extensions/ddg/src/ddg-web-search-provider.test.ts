import { describe, expect, it } from "vitest";
import { __testing, createDuckDuckGoWebSearchProvider } from "./ddg-web-search-provider.js";

describe("ddg web search provider", () => {
  it("normalizes supported region and freshness values", () => {
    expect(__testing.normalizeDuckDuckGoRegion("US-EN")).toBe("us-en");
    expect(__testing.normalizeDuckDuckGoRegion("bad-region")).toBeUndefined();
    expect(__testing.normalizeDuckDuckGoFreshness("week")).toBe("w");
    expect(__testing.normalizeDuckDuckGoFreshness("bad")).toBeUndefined();
  });

  it("decodes DuckDuckGo redirect URLs", () => {
    expect(
      __testing.resolveDuckDuckGoUrl(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenclaw.ai%2F&rut=test",
      ),
    ).toBe("https://openclaw.ai/");
  });

  it("parses search results from DuckDuckGo HTML", () => {
    const results = __testing.parseDuckDuckGoResults(
      `
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenclaw.ai%2F">OpenClaw</a>
          <a class="result__snippet">AI that actually does things</a>
          <a class="result__url">openclaw.ai</a>
        </div>
      `,
      5,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://openclaw.ai/");
    expect(results[0]?.title).toContain("OpenClaw");
    expect(results[0]?.description).toContain("AI that actually does things");
    expect(results[0]?.siteName).toContain("openclaw.ai");
  });

  it("creates a provider with no required API key", () => {
    const provider = createDuckDuckGoWebSearchProvider();
    expect(provider.id).toBe("ddg");
    expect(provider.envVars).toEqual([]);
    expect(provider.placeholder).toBe("No API key required");
    expect(provider.createTool({ config: {}, searchConfig: {} })).not.toBeNull();
  });
});
