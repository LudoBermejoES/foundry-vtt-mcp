// Constants for Foundry MCP Bridge Module

/**
 * Module constants
 */
export const MODULE_ID = 'foundry-mcp-bridge';
export const MODULE_TITLE = 'Foundry MCP Bridge';

/**
 * Socket event names
 */
export const SOCKET_EVENTS = {
  MCP_QUERY: 'mcp-query',
  MCP_RESPONSE: 'mcp-response',
  BRIDGE_STATUS: 'bridge-status',
  PING: 'ping',
  PONG: 'pong',
} as const;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  MCP_HOST: 'localhost',
  MCP_PORT: 31415,
  CONNECTION_TIMEOUT: 10,
  RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY: 1000,
  LOG_LEVEL: 'info',
} as const;

/**
 * Connection states
 */
export const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
} as const;

/**
 * Token dispositions
 */
export const TOKEN_DISPOSITIONS = {
  HOSTILE: -1,
  NEUTRAL: 0,
  FRIENDLY: 1,
} as const;

/**
 * WebRTC / SCTP transport sizes.
 *
 * MIRROR of `packages/mcp-server/src/config.ts` `WEBRTC_CONSTANTS`, field for
 * field, and asserted equal by `packages/mcp-server/src/wire-format.test.ts` —
 * a comment saying "keep in sync" is not a mechanism, a failing test is. These
 * used to be declared inline in a method body in `webrtc-connection.ts`; they
 * live here because this change adds a third consumer (the decompression
 * bound).
 *
 * NOT imported from `@foundry-mcp/shared`, which does exist: this package is
 * loaded by the browser as ESM (`module.json` `"esmodules": ["dist/main.js"]`)
 * and built by plain `tsc` with no bundler, so a bare specifier would not
 * resolve at runtime, and the package declares only `socket.io-client`.
 */
export const WEBRTC_CONSTANTS = {
  /** SCTP maxMessageSize — hard limit from the WebRTC specification. */
  MAX_MESSAGE_SIZE: 65536,
  /** Threshold above which an outbound message is fragmented. */
  CHUNK_SIZE: 50 * 1024,
  /** Decompression-bomb bound; see the server-side comment for the rationale. */
  MAX_DECOMPRESSED_BYTES: 8 * 1024 * 1024,
} as const;

/**
 * Error messages
 */
export const ERROR_MESSAGES = {
  NOT_INITIALIZED: 'Data provider not initialized',
  NOT_CONNECTED: 'Not connected to Foundry VTT',
  CHARACTER_NOT_FOUND: 'Character not found',
  SCENE_NOT_FOUND: 'Scene not found',
  ACCESS_DENIED: 'Access denied - feature is disabled',
  QUERY_TIMEOUT: 'Query timeout',
  UNKNOWN_METHOD: 'Unknown method',
  BRIDGE_NOT_RUNNING: 'MCP Bridge is not running',
} as const;
