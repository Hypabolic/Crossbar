/** Crossbar core contract — public surface for adapters, registry, discovery, and the Pi shim. */

export {
  Capability,
  CLOUD_KINDS,
  type AuthMode,
  type BackendKind,
} from "./capability.ts";

export {
  CONTRACT_VERSION,
  canIntrospect,
  canLoadUnload,
  canSwitch,
  supports,
  type BackendAdapter,
  type PiApiType,
} from "./backend-adapter.ts";

export type {
  CrossbarConfigFile,
  CrossbarSettings,
  DiscoveredServer,
  HealthState,
  HealthStatus,
  LoadAction,
  LoadedModelInfo,
  LoadedState,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ProbeInit,
  ProbeResult,
  ServerCredential,
  ServerRecord,
} from "./types.ts";
