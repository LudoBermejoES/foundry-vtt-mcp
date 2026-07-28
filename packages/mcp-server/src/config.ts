import { z } from 'zod';
import dotenv from 'dotenv';
import { getFoundryDataDir, getDefaultComfyUIDir } from './utils/platform.js';

dotenv.config();

const ConfigSchema = z.object({
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  logFormat: z.enum(['json', 'simple']).default('simple'),
  enableFileLogging: z.boolean().default(false),
  logFilePath: z.string().optional(),
  foundry: z.object({
    host: z.string().default('localhost'),
    port: z.number().min(1024).max(65535).default(31415),
    namespace: z.string().default('/foundry-mcp'),
    reconnectAttempts: z.number().min(1).max(20).default(5),
    reconnectDelay: z.number().min(100).max(30000).default(1000),
    connectionTimeout: z.number().min(1000).max(60000).default(10000),
    /**
     * Default deadline for a single `mcp-query` round-trip to the Foundry module.
     *
     * This is the DEFAULT, not a global override: `FoundryConnector.query()` takes
     * an optional per-call `timeoutMs`, and only callers that know they are issuing
     * long-running Foundry work (e.g. a full-document actor import, where cost
     * scales with the actor's embedded-item count and cannot be known in advance)
     * pass one. Raising this value globally would weaken the guard for the ~90
     * genuinely fast queries, so the default stays at the historical 10 000 ms and
     * behaviour is bit-identical until someone sets FOUNDRY_QUERY_TIMEOUT.
     *
     * NOTE: distinct from the (currently unread) `connectionTimeout` above — that
     * env var may already be set by users, so it is left alone rather than
     * silently given a new meaning.
     */
    queryTimeout: z.number().min(1000).max(600000).default(10000),
    connectionType: z.enum(['websocket', 'webrtc', 'auto']).default('auto'),
    protocol: z.enum(['ws', 'wss']).default('ws'), // Legacy, used only for WebSocket mode
    remoteMode: z.boolean().default(false),
    dataPath: z.string().optional(), // Custom path for generated maps (remote mode)
    rejectUnauthorized: z.boolean().default(true), // TLS certificate validation
    // WebRTC configuration
    webrtc: z
      .object({
        stunServers: z
          .array(z.string())
          .default(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),
        // Future: TURN servers support
        // turnServers: z.array(z.object({
        //   urls: z.string(),
        //   username: z.string().optional(),
        //   credential: z.string().optional()
        // })).optional()
      })
      .default({
        stunServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
      }),
  }),
  comfyui: z.object({
    // ComfyUI always runs locally on the same machine as the MCP server
    port: z.number().min(1024).max(65535).default(31411),
    installPath: z.string(), // No default here - set in rawConfig
    host: z.string().default('127.0.0.1'),
    pythonCommand: z.string().default('python/python.exe'), // Will be platform-specific
  }),
  toolResponseMaxChars: z.number().min(256).max(500000).default(20000),
  /**
   * World-of-Darkness-specific settings.
   *
   * `importDir` gates the OPT-IN path-intake surface of
   * `worldofdarkness-import-actor`. It is intentionally unset by default: with it
   * unset the tool refuses `actorPath`/`actorPaths` outright, so no deployment
   * (least of all a `foundry.remoteMode` one, where paths resolve on the SERVER's
   * disk, not the caller's) grows a file-read surface unless an operator asks for
   * one. See tools/worldofdarkness/import-path.ts for the resolution rules.
   */
  wod: z.object({
    importDir: z.string().optional(),
    importMaxBytes: z.number().min(1024).max(33554432).default(2097152),
  }),
  server: z.object({
    name: z.string().default('foundry-mcp-server'),
    version: z.string().default('0.4.17'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const rawConfig = {
  logLevel: process.env.LOG_LEVEL || 'warn',
  logFormat: process.env.LOG_FORMAT || 'simple',
  enableFileLogging: process.env.ENABLE_FILE_LOGGING === 'true',
  logFilePath: process.env.LOG_FILE_PATH,
  foundry: {
    host: process.env.FOUNDRY_HOST || 'localhost',
    port: parseInt(process.env.FOUNDRY_PORT || '31415', 10),
    namespace: process.env.FOUNDRY_NAMESPACE || '/foundry-mcp',
    reconnectAttempts: parseInt(process.env.FOUNDRY_RECONNECT_ATTEMPTS || '5', 10),
    reconnectDelay: parseInt(process.env.FOUNDRY_RECONNECT_DELAY || '1000', 10),
    connectionTimeout: parseInt(process.env.FOUNDRY_CONNECTION_TIMEOUT || '10000', 10),
    queryTimeout: parseInt(process.env.FOUNDRY_QUERY_TIMEOUT || '10000', 10),
    connectionType: (process.env.FOUNDRY_CONNECTION_TYPE || 'auto') as
      | 'websocket'
      | 'webrtc'
      | 'auto',
    protocol: (process.env.FOUNDRY_PROTOCOL || 'ws') as 'ws' | 'wss',
    remoteMode: process.env.FOUNDRY_REMOTE_MODE === 'true',
    dataPath: process.env.FOUNDRY_DATA_PATH,
    rejectUnauthorized: process.env.FOUNDRY_REJECT_UNAUTHORIZED !== 'false',
    webrtc: {
      stunServers: process.env.FOUNDRY_STUN_SERVERS
        ? process.env.FOUNDRY_STUN_SERVERS.split(',')
        : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    },
  },
  comfyui: {
    // ComfyUI always runs locally on the same machine as the MCP server (localhost:31411)
    port: parseInt(process.env.COMFYUI_PORT || '31411', 10),
    installPath: process.env.COMFYUI_INSTALL_PATH || getDefaultComfyUIDir(),
    host: process.env.COMFYUI_HOST || '127.0.0.1',
    pythonCommand: process.env.COMFYUI_PYTHON_COMMAND || 'python/python.exe',
  },
  toolResponseMaxChars: parseInt(process.env.TOOL_RESPONSE_MAX_CHARS || '20000', 10),
  wod: {
    importDir: process.env.WOD_IMPORT_DIR,
    importMaxBytes: parseInt(process.env.WOD_IMPORT_MAX_BYTES || '2097152', 10),
  },
  server: {
    name: process.env.SERVER_NAME || 'foundry-mcp-server',
    version: process.env.SERVER_VERSION || '1.0.0',
  },
};

export const config = ConfigSchema.parse(rawConfig);

/**
 * WebRTC Protocol Constants
 *
 * SCTP (Stream Control Transmission Protocol) limits for WebRTC data channels
 */
export const WEBRTC_CONSTANTS = {
  /**
   * SCTP maxMessageSize limit - hard limit imposed by WebRTC specification
   * Messages exceeding this size will fail with "OperationError: Failure to send data"
   */
  MAX_MESSAGE_SIZE: 65536, // 64KB in bytes

  /**
   * Safe chunk size threshold for splitting large messages
   * Set below MAX_MESSAGE_SIZE to account for:
   * - JSON stringification overhead (~1-2KB for chunk metadata)
   * - String escaping (quotes, backslashes, unicode) can increase size 5-20%
   * - Safety buffer to prevent edge cases
   *
   * Testing showed 50KB provides reliable chunking with ~14KB headroom
   */
  CHUNK_SIZE: 50 * 1024, // 50KB in bytes

  /**
   * Timeout for incomplete chunked messages (milliseconds)
   * After this time, pending chunks are cleaned up to prevent memory leaks
   *
   * Network issues or client disconnects can leave incomplete messages
   * Set to 30 seconds - longer than typical query timeout (10s) but prevents indefinite storage
   */
  CHUNK_TIMEOUT_MS: 30000, // 30 seconds

  /**
   * Maximum chunks allowed per message
   * Security limit to prevent "chunk bomb" attacks where malicious clients
   * send huge totalChunks values to trigger memory allocation attacks
   *
   * 1000 chunks * 50KB = 50MB maximum message size
   * This is far larger than any legitimate Foundry VTT data
   */
  MAX_CHUNKS_PER_MESSAGE: 1000,

  /**
   * Interval for cleanup of timed-out chunks (milliseconds)
   * Background task runs periodically to remove incomplete messages
   */
  CHUNK_CLEANUP_INTERVAL_MS: 10000, // 10 seconds

  /**
   * Maximum size a compressed message may decompress to, in bytes.
   *
   * SECURITY. Same class of hazard as MAX_CHUNKS_PER_MESSAGE above: a small
   * payload that costs an attacker nothing can expand without bound on the
   * receiver ("decompression bomb"). gzip's theoretical ceiling is ~1032:1, so
   * one 64 KiB frame could otherwise demand ~64 MB. `DecompressionStream` and
   * `zlib` impose no limit of their own, so this one is enforced by the
   * receivers (see wire-format.ts and foundry-module/src/wire-format.ts) while
   * output is being read, never after materialising it.
   *
   * Why 8 MiB:
   *   - 4x the DEFAULT staged-document gate (`wod.importMaxBytes`, 2 MiB), so
   *     every legitimate import fits with headroom. An operator who raises
   *     WOD_IMPORT_MAX_BYTES beyond 8 MiB must raise this too.
   *   - 128x one frame (65,536 B), i.e. it accepts any expansion ratio up to
   *     128x, an order of magnitude above the 6.9x-12.5x measured on real
   *     WoD actor documents.
   *   - 6x TIGHTER than the memory a chunk-bombed message may already claim
   *     (MAX_CHUNKS_PER_MESSAGE * CHUNK_SIZE = 50 MB), so it does not loosen the
   *     transport's existing exposure.
   *
   * Keep in sync with packages/foundry-module/src/constants.ts (asserted equal
   * by wire-format.test.ts).
   */
  MAX_DECOMPRESSED_BYTES: 8 * 1024 * 1024, // 8 MiB
} as const;
