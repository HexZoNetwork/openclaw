import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("ddg plugin", () => {
  it("exports a valid plugin entry with correct id and name", () => {
    expect(plugin.id).toBe("ddg");
    expect(plugin.name).toBe("DuckDuckGo Plugin");
    expect(typeof plugin.register).toBe("function");
  });

  it("registers a DuckDuckGo web search provider", () => {
    const registrations: { webSearchProviders: unknown[] } = { webSearchProviders: [] };

    const mockApi = {
      registerWebSearchProvider(provider: unknown) {
        registrations.webSearchProviders.push(provider);
      },
      config: {},
    };

    plugin.register(mockApi as never);

    expect(registrations.webSearchProviders).toHaveLength(1);
    const provider = registrations.webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("ddg");
    expect(provider.autoDetectOrder).toBe(15);
    expect(provider.envVars).toEqual([]);
  });
});
