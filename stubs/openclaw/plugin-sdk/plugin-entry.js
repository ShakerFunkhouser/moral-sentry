// Stub for openclaw/plugin-sdk/plugin-entry.
// definePluginEntry is a passthrough - OpenClaw's real runtime uses it for
// registration metadata, but the register() function is what does the work.
export function definePluginEntry(entry) {
  return entry;
}

// Empty config schema sentinel used when a plugin has no config.
export const emptyPluginConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
