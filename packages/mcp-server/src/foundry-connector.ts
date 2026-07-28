import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { Logger } from './logger.js';
import { Config, WEBRTC_CONSTANTS } from './config.js';
import { WebRTCPeer } from './webrtc-peer.js';
import {
  COMPRESSION_CAPABILITY,
  compressMessage,
  decompressEnvelope,
  isCompressedEnvelope,
  mustSendPlain,
  PING_QUERY_METHOD,
  wireBytesOf,
  WireDecodeError,
} from './wire-format.js';

export interface FoundryConnectorOptions {
  config: Config['foundry'];
  logger: Logger;
}

interface PendingQuery {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class FoundryConnector {
  private wss: WebSocketServer | null = null;
  private httpServer: any;
  private webrtcSignalingServer: any; // Separate HTTP server for WebRTC signaling
  private logger: Logger;
  private config: Config['foundry'];
  private isStarted = false;
  private foundrySocket: WebSocket | null = null;
  private webrtcPeer: WebRTCPeer | null = null;
  private activeConnectionType: 'websocket' | 'webrtc' | null = null;
  private pendingQueries = new Map<string, PendingQuery>();
  private queryIdCounter = 0;
  /**
   * Capabilities advertised by the module on the CURRENT connection, or `null`
   * when the handshake has not completed (or has been invalidated).
   *
   * PER CONNECTION, AND DISCARDED ON DISCONNECT. The peer behind a reconnect may
   * be a different module version — after a world reload it usually is — so a
   * cached "yes" that survived a reconnect would have the server compressing into
   * a module that cannot decompress, which with compression as the FORMAT breaks
   * every message rather than only large ones.
   */
  private peerCapabilities: string[] | null = null;
  private negotiationTimer: NodeJS.Timeout | null = null;

  constructor({ config, logger }: FoundryConnectorOptions) {
    this.config = config;
    this.logger = logger.child({ component: 'FoundryConnector' });
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.debug('Foundry connector already started');
      return;
    }

    this.logger.info('Starting Foundry connector WebSocket server', {
      port: this.config.port,
      protocol: this.config.protocol || 'ws',
      remoteMode: this.config.remoteMode || false,
    });

    // Create HTTP server for WebSocket connections
    this.httpServer = createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });

    // Create SEPARATE HTTP server for WebRTC signaling (port 31416)
    const WEBRTC_PORT = 31416;
    this.webrtcSignalingServer = createServer(async (req, res) => {
      // Set CORS headers for all requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle OPTIONS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Only handle POST to /webrtc-offer
      if (req.method === 'POST' && req.url === '/webrtc-offer') {
        try {
          await this.handleWebRTCOfferHTTP(req, res);
        } catch (error) {
          this.logger.error('WebRTC offer handling failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    // Start WebRTC signaling server
    await new Promise<void>((resolve, reject) => {
      this.webrtcSignalingServer.listen(WEBRTC_PORT, '0.0.0.0', () => {
        this.logger.info(`WebRTC signaling server listening on port ${WEBRTC_PORT}`);
        console.error(`[WebRTC] Server started on 0.0.0.0:${WEBRTC_PORT}`);
        resolve();
      });
      this.webrtcSignalingServer.on('error', (error: Error) => {
        this.logger.error('Failed to start WebRTC signaling server', error);
        console.error(`[WebRTC] Server error:`, error);
        reject(error);
      });
    });

    // Create WebSocket server in noServer mode to avoid request consumption
    this.wss = new WebSocketServer({ noServer: true });

    // Manually handle upgrade for WebSocket connections
    this.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      const pathname = req.url || '/';

      // Only upgrade if path matches WebSocket namespace
      if (pathname === (this.config.namespace || '/')) {
        this.wss?.handleUpgrade(req, socket, head, ws => {
          this.wss?.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    // Handle WebSocket connections (both signaling and direct WebSocket)
    this.wss.on('connection', ws => {
      this.logger.info('Client connected via WebSocket');

      // Register the connection immediately on connect, not on first message
      // This fixes Issue #19: WebSocket handshake deadlock where both sides
      // waited for the other to send a message first
      if (!this.foundrySocket) {
        this.foundrySocket = ws;
        this.activeConnectionType = 'websocket';
        this.logger.info('Foundry module registered via WebSocket');
        this.scheduleCapabilityHandshake();
      }

      ws.on('close', () => {
        this.logger.info('Client disconnected');
        if (this.activeConnectionType === 'websocket' && this.foundrySocket === ws) {
          this.foundrySocket = null;
          this.activeConnectionType = null;
          this.invalidatePeerCapabilities('websocket disconnect');
          // Reject all pending queries
          this.pendingQueries.forEach(({ reject, timeout }) => {
            clearTimeout(timeout);
            reject(new Error('Connection closed'));
          });
          this.pendingQueries.clear();
        }
      });

      ws.on('message', async data => {
        try {
          const message = JSON.parse(data.toString());

          // Check if this is WebRTC signaling
          if (message.type === 'webrtc-offer') {
            await this.handleWebRTCOffer(message.offer, ws);
          } else if (isCompressedEnvelope(message)) {
            // A receiver accepts BOTH encodings at all times, on every transport,
            // regardless of what it sends: it does not control its peer's version.
            await this.handleCompressedMessage(message);
          } else {
            // Regular WebSocket message - process it directly
            await this.handleMessage(message);
          }
        } catch (error) {
          this.logger.error('Failed to parse message', error);
        }
      });

      ws.on('error', error => {
        this.logger.error('WebSocket error', error);
      });
    });

    // Start the HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(this.config.port, () => {
        this.isStarted = true;
        this.logger.info('Foundry connector listening', { port: this.config.port });
        resolve();
      });

      this.httpServer.on('error', (error: Error) => {
        this.logger.error('Failed to start Foundry connector', error);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    this.logger.info('Stopping Foundry connector...');

    this.invalidatePeerCapabilities('connector stopping');

    // Reject all pending queries
    this.pendingQueries.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Server shutting down'));
    });
    this.pendingQueries.clear();

    if (this.foundrySocket) {
      this.foundrySocket.close();
      this.foundrySocket = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>(resolve => {
        this.httpServer.close(() => {
          resolve();
        });
      });
      this.httpServer = null;
    }

    this.isStarted = false;
    this.logger.info('Foundry connector stopped');
  }

  private async handleMessage(message: any): Promise<void> {
    if (message.type === 'mcp-response' && message.id) {
      const pending = this.pendingQueries.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingQueries.delete(message.id);

        if (message.data.success) {
          this.logger.debug('Query response received', {
            id: message.id,
            hasData: !!message.data.data,
          });
          pending.resolve(message.data.data);
        } else {
          this.logger.error('Query failed', { id: message.id, error: message.data.error });
          pending.reject(new Error(message.data.error || 'Query failed'));
        }
      }
      return;
    }

    if (message.type === 'pong') {
      const pending = this.pendingQueries.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingQueries.delete(message.id);
        pending.resolve(message.data);
      }
      return;
    }

    const comfyHandlers = (globalThis as any).backendComfyUIHandlers;
    if (comfyHandlers?.handleMessage) {
      this.logger.debug('Routing message to backend ComfyUI handlers', { type: message.type });
      try {
        await comfyHandlers.handleMessage(message);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Failed to forward message to backendComfyUIHandlers', {
          type: message.type,
          error: errorMessage,
        });
      }
      return;
    }

    this.logger.debug('Received unknown message type', { type: message.type });
  }

  /**
   * Unwrap a `compressed-message` and route it, or answer the request it belonged
   * to. Dropping a decode failure costs the caller its whole deadline and is then
   * reported as a timeout, which points at the wrong subsystem.
   */
  private async handleCompressedMessage(envelope: any): Promise<void> {
    try {
      const inner = decompressEnvelope(envelope, WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES);
      await this.handleMessage(inner);
    } catch (error) {
      const decodeError =
        error instanceof WireDecodeError
          ? error
          : new WireDecodeError(
              error instanceof Error ? error.message : String(error),
              envelope?.originalId,
              envelope?.originalType
            );
      this.logger.error('Failed to decode compressed message', { error: decodeError.message });
      if (decodeError.originalId) {
        await this.handleMessage({
          type: 'mcp-response',
          id: decodeError.originalId,
          data: { success: false, error: decodeError.message },
        });
      }
    }
  }

  // ── Capability negotiation ────────────────────────────────────────────────
  //
  // NOTHING PINGED ON CONNECT BEFORE THIS CHANGE. `FoundryClient.ping()` existed
  // with no caller at connection establishment, and the import tool's dry-run gate
  // pinged ad hoc per call. Compression as the wire FORMAT needs the answer before
  // the first real query, so the handshake now runs once per connection.
  //
  // Failure is not an error condition: an unanswered or refused ping simply leaves
  // `peerCapabilities` null, and the server sends plain JSON — today's behaviour,
  // which is the permanent path for an older module or a runtime without the
  // primitive, not a transitional one.

  /**
   * Run the handshake shortly after the connection is usable.
   *
   * The small delay is deliberate: on the WebSocket path the module attaches its
   * `onmessage` handler inside its own `onopen`, so a ping sent in the same tick as
   * the server's `connection` event can be dispatched before anything is listening
   * and simply vanish. Worst case we stay plain.
   */
  private scheduleCapabilityHandshake(delayMs = 250): void {
    if (this.negotiationTimer) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = setTimeout(() => {
      this.negotiationTimer = null;
      void this.negotiateCapabilities();
    }, delayMs);
    // Do not hold the process open for a handshake.
    this.negotiationTimer.unref?.();
  }

  private async negotiateCapabilities(): Promise<void> {
    if (!this.isConnected()) return;
    try {
      // Sent PLAIN — `mustSendPlain` forces it, because this exchange is how the
      // encoding is discovered and so cannot ride inside it.
      const pong = await this.query(PING_QUERY_METHOD, undefined, 10000);
      const caps: unknown = pong?.capabilities;
      this.peerCapabilities = Array.isArray(caps) ? caps.filter(c => typeof c === 'string') : [];
      this.logger.info('Negotiated bridge capabilities', {
        connectionType: this.activeConnectionType,
        moduleVersion: pong?.moduleVersion ?? null,
        compression: this.isCompressionNegotiated(),
        capabilities: this.peerCapabilities.length,
      });
    } catch (error) {
      // Stay plain. Not a failure mode — just no capability observed.
      this.logger.warn('Bridge capability handshake did not complete; staying on plain JSON', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private invalidatePeerCapabilities(reason: string): void {
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer);
      this.negotiationTimer = null;
    }
    if (this.peerCapabilities !== null) {
      this.logger.info('Discarding negotiated bridge capabilities', { reason });
    }
    this.peerCapabilities = null;
  }

  /** Capabilities observed on the current connection, or `null` if none yet. */
  getPeerCapabilities(): readonly string[] | null {
    return this.peerCapabilities;
  }

  /** True only once the peer has advertised compression on THIS connection. */
  isCompressionNegotiated(): boolean {
    return this.peerCapabilities !== null && this.peerCapabilities.includes(COMPRESSION_CAPABILITY);
  }

  /**
   * Serialized size, in bytes, of the message this connector would actually put on
   * the wire for `method`/`data` — compressed when compression has been negotiated
   * on this connection, plain otherwise.
   *
   * The single sanctioned way to answer "will this fit in a frame". It MEASURES;
   * callers must never predict a compressed size from an assumed ratio, because
   * the ratio is a property of the content: ordinary WoD actor documents compress
   * 6.9x-12x, one carrying an embedded 118 KB image compresses 1.5x.
   */
  measureQueryWireBytes(method: string, data?: any): number {
    const message = {
      type: 'mcp-query',
      id: `query-${this.queryIdCounter + 1}`,
      data: { method, data },
    };
    return wireBytesOf(message, this.isCompressionNegotiated());
  }

  private async handleWebRTCOffer(offer: any, signalingWs: WebSocket): Promise<void> {
    try {
      this.logger.info('Handling WebRTC offer for signaling');

      // A new peer means a possibly different module build: start from "no
      // capability observed" and re-negotiate once its data channel opens.
      this.invalidatePeerCapabilities('new WebRTC peer');

      // Create WebRTC peer
      this.webrtcPeer = new WebRTCPeer({
        config: this.config.webrtc,
        logger: this.logger,
        onMessage: this.handleMessage.bind(this),
        onOpen: () => this.scheduleCapabilityHandshake(),
        onClose: () => this.invalidatePeerCapabilities('WebRTC data channel closed'),
      });

      // Handle offer and get answer
      const answer = await this.webrtcPeer.handleOffer(offer);

      // Send answer back via signaling WebSocket
      signalingWs.send(
        JSON.stringify({
          type: 'webrtc-answer',
          answer: answer,
        })
      );

      this.activeConnectionType = 'webrtc';
      this.logger.info('WebRTC connection established');

      // Close signaling WebSocket after handshake
      setTimeout(() => {
        signalingWs.close();
      }, 1000);
    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer', error);
      signalingWs.send(
        JSON.stringify({
          type: 'webrtc-error',
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }
  }

  private async handleWebRTCOfferHTTP(req: any, res: any): Promise<void> {
    // CRITICAL: Call resume() to enable stream data flow
    req.resume();

    try {
      // Read body using promise wrapper around classic events
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        req.on('end', () => {
          resolve(Buffer.concat(chunks).toString());
        });

        req.on('error', reject);
      });

      const { offer } = JSON.parse(body);

      if (!offer) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing offer in request body' }));
        return;
      }

      // A new peer means a possibly different module build: start from "no
      // capability observed" and re-negotiate once its data channel opens.
      this.invalidatePeerCapabilities('new WebRTC peer');

      // Create WebRTC peer
      this.webrtcPeer = new WebRTCPeer({
        config: this.config.webrtc,
        logger: this.logger,
        onMessage: this.handleMessage.bind(this),
        onOpen: () => this.scheduleCapabilityHandshake(),
        onClose: () => this.invalidatePeerCapabilities('WebRTC data channel closed'),
      });

      // Handle offer and get answer
      const answer = await this.webrtcPeer.handleOffer(offer);

      this.activeConnectionType = 'webrtc';
      this.logger.info('WebRTC connection established via HTTP signaling');

      // Send answer back via HTTP response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer }));
    } catch (error) {
      this.logger.error('Failed to handle WebRTC offer via HTTP', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }
  }

  /**
   * Issue one `mcp-query` to the Foundry module and await its `mcp-response`.
   *
   * `timeoutMs` is an OPTIONAL PER-CALL override, defaulting to
   * `config.foundry.queryTimeout` (itself defaulting to the historical 10 000 ms).
   * Per-call rather than global on purpose: a blanket raise would also relax the
   * deadline for every fast query, so only callers that knowingly issue
   * long-running Foundry work (e.g. actor import) pass one.
   *
   * A timed-out query is NOT cancelled Foundry-side — there is no abort hook in
   * Foundry's CONFIG.queries contract. We drop the pendingQueries entry and
   * reject; the module keeps running and its late `mcp-response` is discarded by
   * handleMessage (`pending` is undefined). Any write already in flight therefore
   * completes and persists unreported. Callers that write must be idempotent and
   * reconcilable — see importActors' flags.wodchar.sourceId stamping.
   */
  async query(method: string, data?: any, timeoutMs?: number): Promise<any> {
    // Check connection based on active connection type
    const isConnected =
      this.activeConnectionType === 'webrtc'
        ? this.webrtcPeer && this.webrtcPeer.getIsConnected()
        : this.foundrySocket && this.foundrySocket.readyState === WebSocket.OPEN;

    if (!isConnected) {
      throw new Error('Not connected to Foundry VTT module');
    }

    const effectiveTimeout = timeoutMs ?? this.config.queryTimeout ?? 10000;

    const queryId = `query-${++this.queryIdCounter}`;
    this.logger.debug('Sending query to Foundry', {
      method,
      data,
      queryId,
      connectionType: this.activeConnectionType,
      timeoutMs: effectiveTimeout,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQueries.delete(queryId);
        reject(new Error(`Query timeout: ${method}`));
      }, effectiveTimeout);

      this.pendingQueries.set(queryId, { resolve, reject, timeout });

      const message = {
        type: 'mcp-query',
        id: queryId,
        data: { method, data },
      };

      // Use sendToFoundry to support both WebSocket and WebRTC.
      //
      // A SEND THAT FAILS REJECTS THIS QUERY AT ONCE. It used to be swallowed by a
      // `logger.error` inside the WebRTC sender, so an undeliverable message
      // surfaced a full deadline later as `Query timeout: <method>` — pointing at
      // the wrong subsystem for a message that never left the process. Now that no
      // application-level size check precedes the send, this is the ONLY mechanism
      // that distinguishes "could not send" from "sent and never answered".
      try {
        this.sendToFoundry(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingQueries.delete(queryId);
        const reason = error instanceof Error ? error.message : String(error);
        reject(
          new Error(
            `Send failed on the ${this.activeConnectionType ?? 'unknown'} transport for ${method} ` +
              `(${this.wireBytesOfMessage(message)} bytes on the wire): ${reason}`
          )
        );
      }
    });
  }

  /**
   * The ONE outbound encoder. Every server->Foundry send funnels through here —
   * `query` (above), `sendMessage`, and `FoundryClient.sendMessage` — so there is
   * exactly one place that decides a message's encoding, on either transport.
   *
   * Compression is applied only when the peer has advertised it on the CURRENT
   * connection and the message is not in the forced-plain set (`mustSendPlain`).
   * Until then, plain JSON: identical to the behaviour before this change, and the
   * permanent path for an un-upgraded module.
   */
  sendToFoundry(message: any): void {
    const payload = this.encodeOutbound(message);

    if (this.activeConnectionType === 'webrtc' && this.webrtcPeer) {
      this.webrtcPeer.sendMessage(payload);
    } else if (
      this.activeConnectionType === 'websocket' &&
      this.foundrySocket &&
      this.foundrySocket.readyState === WebSocket.OPEN
    ) {
      this.foundrySocket.send(JSON.stringify(payload));
    } else {
      throw new Error('Not connected to Foundry VTT module');
    }
  }

  private encodeOutbound(message: any): any {
    if (!this.isCompressionNegotiated() || mustSendPlain(message)) return message;
    try {
      return compressMessage(message);
    } catch (error) {
      // Never let an encoder fault take out a send that would have worked plain.
      this.logger.error('Compression failed; falling back to plain JSON for this message', {
        type: message?.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return message;
    }
  }

  private wireBytesOfMessage(message: any): number {
    try {
      return wireBytesOf(message, this.isCompressionNegotiated());
    } catch {
      return -1;
    }
  }

  isConnected(): boolean {
    if (!this.isStarted) return false;

    if (this.activeConnectionType === 'webrtc') {
      return this.webrtcPeer !== null && this.webrtcPeer.getIsConnected();
    } else if (this.activeConnectionType === 'websocket') {
      return this.foundrySocket !== null && this.foundrySocket.readyState === WebSocket.OPEN;
    }

    return false;
  }

  getConnectionInfo(): any {
    return {
      started: this.isStarted,
      connected: this.isConnected(),
      connectionType: this.activeConnectionType,
      readyState: this.foundrySocket?.readyState || 'CLOSED',
      config: {
        port: this.config.port,
        namespace: this.config.namespace,
      },
    };
  }

  getConnectionType(): 'websocket' | 'webrtc' | null {
    return this.activeConnectionType;
  }

  /**
   * Send a message to the connected Foundry module
   */
  sendMessage(message: any): void {
    if (!this.isConnected()) {
      throw new Error('Not connected to Foundry VTT module');
    }

    try {
      this.sendToFoundry(message);
      this.logger.debug('Sent message to Foundry module', {
        type: message.type,
        connectionType: this.activeConnectionType,
      });
    } catch (error) {
      this.logger.error('Failed to send message to Foundry module', error);
      throw error;
    }
  }

  /**
   * Broadcast a message to all connected Foundry clients (alias for sendMessage for single connection)
   */
  broadcastMessage(message: any): void {
    this.sendMessage(message);
  }
}
