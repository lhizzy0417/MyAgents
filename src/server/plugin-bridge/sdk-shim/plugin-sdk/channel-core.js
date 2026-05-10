// Hand-written shim for openclaw/plugin-sdk/channel-core.
//
// Upstream (openclaw/src/plugin-sdk/channel-core.ts) is a barrel that re-exports
// working factory functions from ./core.js — including `createChatChannelPlugin`,
// `defineChannelPluginEntry`, etc.
//
// The auto-generated stub returned `undefined` for everything, so plugins that
// import from `openclaw/plugin-sdk/channel-core` (e.g. yuanbao 2.13.x — issue
// #180: yuanbaoPlugin = createChatChannelPlugin({...})) collapsed to undefined
// at module-load time. We mirror upstream's barrel here. The implementations
// already live in core.js (which other plugins like Feishu use directly), so
// this shim is just re-routing — no new logic.
//
// Names upstream exports that no shipped plugin currently consumes are left as
// `undefined` so destructure-imports don't throw at parse/load time. Add a real
// implementation when a plugin actually needs one.

export {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from './core.js';

export const buildChannelConfigSchema = undefined;
export const buildThreadAwareOutboundSessionRoute = undefined;
export const clearAccountEntryFields = undefined;
export const defineSetupPluginEntry = undefined;
export const parseOptionalDelimitedEntries = undefined;
export const recoverCurrentThreadSessionId = undefined;
export const tryReadSecretFileSync = undefined;
