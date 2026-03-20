import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createDuckDuckGoWebSearchProvider } from "./src/ddg-web-search-provider.js";

export default definePluginEntry({
  id: "ddg",
  name: "DuckDuckGo Plugin",
  description: "Bundled DuckDuckGo web search plugin",
  register(api) {
    api.registerWebSearchProvider(createDuckDuckGoWebSearchProvider());
  },
});
