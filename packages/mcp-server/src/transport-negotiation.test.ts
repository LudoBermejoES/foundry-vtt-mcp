/**
 * Negotiation is the whole safety story, so it is tested as a MATRIX over the four
 * states that can exist in the field — and with the real objects from both
 * packages wired together over a loopback data channel, not with stubs of
 * themselves:
 *
 *   server                module              expected
 *   ─────────────────────────────────────────────────────────────────────
 *   new (compresses)      new (advertises)    compressed both ways
 *   new (compresses)      OLD (silent)        plain both ways
 *   OLD (never compresses) new (advertises)   plain both ways
 *   reconnect                                 capability discarded, re-negotiated
 *
 * With compression as the wire FORMAT rather than an occasional mode, a server that
 * compresses to a peer that cannot decompress breaks EVERY message, not only large
 * ones. The plain path is therefore permanent and tested, not transitional.
 *
 * Real objects on both sides: `FoundryConnector` + `WebRTCPeer` (server) and
 * `SocketBridge` + `WebRTCConnection` (Foundry module), joined by a pair of fake
 * RTCDataChannels. Their private fields are injected because the genuine handshake
 * needs `RTCPeerConnection` and real sockets, and this repo's backend is a
 * singleton on a fixed port that must not be disturbed by a test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoundryConnector } from './foundry-connector.js';
import { WebRTCPeer } from './webrtc-peer.js';
import { COMPRESSED_MESSAGE_TYPE, COMPRESSION_CAPABILITY, compressMessage } from './wire-format.js';
import { SocketBridge } from '../../foundry-module/src/socket-bridge.js';
import { WebRTCConnection } from '../../foundry-module/src/webrtc-connection.js';

// ─── a loopback pair of data channels ────────────────────────────────────────

interface Frame {
  from: 'server' | 'module';
  raw: string;
  message: any;
}

function makeChannelPair(frames: Frame[]) {
  const server: any = { readyState: 'open', label: 'server', close: () => undefined };
  const module_: any = { readyState: 'open', label: 'module', close: () => undefined };

  server.send = (raw: string) => {
    frames.push({ from: 'server', raw, message: JSON.parse(raw) });
    queueMicrotask(() => module_.onmessage?.({ data: raw }));
  };
  module_.send = (raw: string) => {
    frames.push({ from: 'module', raw, message: JSON.parse(raw) });
    queueMicrotask(() => server.onmessage?.({ data: raw }));
  };
  return { server, module_ };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function quietLogger(): any {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  logger.child = () => logger;
  return logger;
}

// ─── the fake Foundry world the module half needs ────────────────────────────

function installModuleWorld(capabilities: string[], onImport?: (data: any) => any): void {
  const g = globalThis as any;
  g.CONFIG = {
    queries: {
      'foundry-mcp-bridge.ping': async () => ({
        status: 'ok',
        moduleVersion: '0.9.5',
        capabilities,
      }),
      'foundry-mcp-bridge.importActors': async (data: any) => ({
        results: (data?.actors ?? []).map((a: any) => ({ name: a.name, status: 'created' })),
        total: (data?.actors ?? []).length,
      }),
    },
  };
  if (onImport) {
    g.CONFIG.queries['foundry-mcp-bridge.importActors'] = async (data: any) => onImport(data);
  }
  g.ui = {
    notifications: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}

interface Harness {
  connector: FoundryConnector;
  peer: WebRTCPeer;
  bridge: SocketBridge;
  frames: Frame[];
  closeChannel: () => void;
  openChannel: () => void;
}

/**
 * Wire a real server connector to a real module bridge.
 *
 * `moduleCapabilities` is what the module's `ping` advertises — omit
 * `transport.compression.gzip` to model an OLD module.
 */
function makeHarness(moduleCapabilities: string[], onImport?: (data: any) => any): Harness {
  installModuleWorld(moduleCapabilities, onImport);
  const frames: Frame[] = [];
  const { server: serverChannel, module_: moduleChannel } = makeChannelPair(frames);
  const logger = quietLogger();

  const connector = new FoundryConnector({
    config: {
      host: 'localhost',
      port: 0,
      namespace: '/foundry-mcp',
      reconnectAttempts: 1,
      reconnectDelay: 1,
      connectionTimeout: 1000,
      queryTimeout: 2000,
      connectionType: 'webrtc',
      protocol: 'ws',
      remoteMode: false,
      rejectUnauthorized: true,
      webrtc: { stunServers: [] },
    } as any,
    logger,
  });

  const peer = new WebRTCPeer({
    config: { stunServers: [] } as any,
    logger,
    onMessage: (message: any) => (connector as any).handleMessage(message),
    onOpen: () => (connector as any).scheduleCapabilityHandshake(10),
    onClose: () => (connector as any).invalidatePeerCapabilities('data channel closed'),
  });
  (peer as any).dataChannel = serverChannel;
  (peer as any).setupDataChannelHandlers();
  (peer as any).isConnected = true;

  (connector as any).isStarted = true;
  (connector as any).activeConnectionType = 'webrtc';
  (connector as any).webrtcPeer = peer;

  // Module half: the real bridge, the real WebRTC receive path (compressed branch
  // and fragment framing included).
  const bridge = new SocketBridge({
    enabled: true,
    serverHost: 'localhost',
    serverPort: 31415,
    namespace: '/foundry-mcp',
    reconnectAttempts: 1,
    reconnectDelay: 1,
    connectionTimeout: 1,
    debugLogging: false,
    connectionType: 'webrtc',
  });
  const connection = new WebRTCConnection({
    serverHost: 'localhost',
    serverPort: 31415,
    namespace: '/foundry-mcp',
    stunServers: [],
    connectionTimeout: 1,
    debugLogging: false,
  });
  (connection as any).messageHandler = (message: any, meta: any) =>
    (bridge as any).handleMessage(message, meta);
  (connection as any).connectionState = 'connected';
  (connection as any).dataChannel = moduleChannel;
  (connection as any).setupDataChannelHandlers();
  (bridge as any).webrtc = connection;
  (bridge as any).activeConnectionType = 'webrtc';
  (bridge as any).connectionState = 'connected';

  return {
    connector,
    peer,
    bridge,
    frames,
    closeChannel: () => serverChannel.onclose?.(),
    openChannel: () => serverChannel.onopen?.(),
  };
}

const requests = (frames: Frame[]) => frames.filter(f => f.from === 'server');
const responses = (frames: Frame[]) => frames.filter(f => f.from === 'module');
const isCompressed = (f: Frame) => f.message.type === COMPRESSED_MESSAGE_TYPE;

describe('Requirement: compression is gated on a per-connection negotiated capability', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(() => {
    harness?.peer.disconnect();
    harness = null;
  });

  it('new server + new module: query and response both travel compressed', async () => {
    harness = makeHarness(['importActors.dryRun', COMPRESSION_CAPABILITY]);
    const h = harness;

    // Nothing pinged on connect before this change; the data channel opening is
    // now what triggers the handshake.
    h.openChannel();
    await settle();
    await settle();

    expect(h.connector.isCompressionNegotiated()).toBe(true);
    expect(h.connector.getPeerCapabilities()).toContain(COMPRESSION_CAPABILITY);

    // The handshake itself was PLAIN both ways — it cannot ride inside the
    // encoding it negotiates.
    expect(requests(h.frames).every(f => !isCompressed(f))).toBe(true);
    expect(responses(h.frames).every(f => !isCompressed(f))).toBe(true);

    h.frames.length = 0;
    const result = await h.connector.query('foundry-mcp-bridge.importActors', {
      actors: [{ name: 'Salvador Pacheco-König' }],
    });

    expect(result.total).toBe(1);
    expect(requests(h.frames)).toHaveLength(1);
    expect(isCompressed(requests(h.frames)[0])).toBe(true);
    expect(requests(h.frames)[0].message.originalType).toBe('mcp-query');
    // Answered in kind — the request is itself proof the peer speaks compression,
    // so the reverse direction needs no negotiation of its own.
    expect(responses(h.frames)).toHaveLength(1);
    expect(isCompressed(responses(h.frames)[0])).toBe(true);
  });

  it('new server + OLD module: no capability observed, so plain both ways', async () => {
    harness = makeHarness(['importActors.dryRun']); // no compression entry
    const h = harness;

    h.openChannel();
    await settle();
    await settle();

    // The handshake completed — the module answered — it just advertised nothing.
    expect(h.connector.getPeerCapabilities()).toEqual(['importActors.dryRun']);
    expect(h.connector.isCompressionNegotiated()).toBe(false);

    h.frames.length = 0;
    const result = await h.connector.query('foundry-mcp-bridge.importActors', {
      actors: [{ name: 'Berlin Student' }],
    });

    expect(result.total).toBe(1); // today's behaviour, unchanged
    expect(requests(h.frames).every(f => !isCompressed(f))).toBe(true);
    expect(responses(h.frames).every(f => !isCompressed(f))).toBe(true);
  });

  it('OLD server + new module: the module answers plain because the request was plain', async () => {
    // "Old server" = one that never compresses. Modelled by never negotiating, so
    // `peerCapabilities` stays null and the encoder is never engaged.
    harness = makeHarness(['importActors.dryRun', COMPRESSION_CAPABILITY]);
    const h = harness;

    expect(h.connector.getPeerCapabilities()).toBeNull();
    expect(h.connector.isCompressionNegotiated()).toBe(false);

    const result = await h.connector.query('foundry-mcp-bridge.importActors', {
      actors: [{ name: 'Ludo' }],
    });

    expect(result.total).toBe(1);
    expect(requests(h.frames).every(f => !isCompressed(f))).toBe(true);
    // Safe by construction — but asserted rather than reasoned.
    expect(responses(h.frames).every(f => !isCompressed(f))).toBe(true);
  });

  it('a receiver accepts compressed traffic even while it is sending plain', async () => {
    // "A receiver SHALL accept both encodings at all times, regardless of what it
    // sends, since it does not control its peer's version." Wired without the
    // module half so the only answer is the compressed one injected below.
    const logger = quietLogger();
    const connector = new FoundryConnector({
      config: {
        host: 'localhost',
        port: 0,
        namespace: '/foundry-mcp',
        reconnectAttempts: 1,
        reconnectDelay: 1,
        connectionTimeout: 1000,
        queryTimeout: 5000,
        connectionType: 'webrtc',
        protocol: 'ws',
        remoteMode: false,
        rejectUnauthorized: true,
        webrtc: { stunServers: [] },
      } as any,
      logger,
    });
    const sent: any[] = [];
    const peer = new WebRTCPeer({
      config: { stunServers: [] } as any,
      logger,
      onMessage: (message: any) => (connector as any).handleMessage(message),
    });
    (peer as any).dataChannel = {
      readyState: 'open',
      close: () => undefined,
      send: (raw: string) => sent.push(JSON.parse(raw)),
    };
    (peer as any).setupDataChannelHandlers();
    (peer as any).isConnected = true;
    (connector as any).isStarted = true;
    (connector as any).activeConnectionType = 'webrtc';
    (connector as any).webrtcPeer = peer;

    // The server has negotiated nothing, so it sends plain...
    expect(connector.isCompressionNegotiated()).toBe(false);
    const pending = connector.query('foundry-mcp-bridge.importActors', { actors: [] });
    await settle();
    expect(sent[0].type).toBe('mcp-query');

    // ...but a COMPRESSED inbound response still resolves that query.
    (peer as any).dataChannel.onmessage({
      data: JSON.stringify(
        compressMessage({
          type: 'mcp-response',
          id: sent[0].id,
          data: { success: true, data: { total: 42 } },
        })
      ),
    });
    await expect(pending).resolves.toEqual({ total: 42 });
    peer.disconnect();
  });

  it('the capability is NOT carried across a reconnect', async () => {
    harness = makeHarness(['importActors.dryRun', COMPRESSION_CAPABILITY]);
    const h = harness;

    h.openChannel();
    await settle();
    await settle();
    expect(h.connector.isCompressionNegotiated()).toBe(true);

    // A world reload closes the channel. The module behind the next connection may
    // be a different version, so the cached "yes" must not survive.
    h.closeChannel();
    expect(h.connector.getPeerCapabilities()).toBeNull();
    expect(h.connector.isCompressionNegotiated()).toBe(false);

    // Re-establish: negotiated again on the new connection, from scratch.
    (h.peer as any).isConnected = true;
    h.openChannel();
    await settle();
    await settle();
    expect(h.connector.isCompressionNegotiated()).toBe(true);
  });

  it('a handshake that cannot complete leaves the server on plain JSON, not broken', async () => {
    // A ping that fails or times out is not a failure mode — it is "no capability
    // observed", and the server keeps sending plain JSON, which is exactly the
    // behaviour before this change.
    harness = makeHarness(['importActors.dryRun', COMPRESSION_CAPABILITY]);
    const h = harness;
    (h.connector as any).webrtcPeer = {
      getIsConnected: () => true,
      sendMessage: () => {
        throw new Error('OperationError: Failure to send data');
      },
    };

    await (h.connector as any).negotiateCapabilities();
    expect(h.connector.isCompressionNegotiated()).toBe(false);
    expect(h.connector.getPeerCapabilities()).toBeNull();

    // And a subsequent send is still attempted, plain.
    (h.connector as any).webrtcPeer = h.peer;
    const result = await h.connector.query('foundry-mcp-bridge.importActors', { actors: [] });
    expect(result.total).toBe(0);
    expect(requests(h.frames).every(f => !isCompressed(f))).toBe(true);
  });
});

describe('Requirement: a message the transport could not deliver fails its query immediately', () => {
  it('rejects at once, naming the transport, without waiting for the deadline', async () => {
    installModuleWorld([COMPRESSION_CAPABILITY]);
    const logger = quietLogger();
    const connector = new FoundryConnector({
      config: {
        host: 'localhost',
        port: 0,
        namespace: '/foundry-mcp',
        reconnectAttempts: 1,
        reconnectDelay: 1,
        connectionTimeout: 1000,
        // A deadline long enough that waiting for it would be obvious.
        queryTimeout: 30_000,
        connectionType: 'webrtc',
        protocol: 'ws',
        remoteMode: false,
        rejectUnauthorized: true,
        webrtc: { stunServers: [] },
      } as any,
      logger,
    });

    const peer = new WebRTCPeer({
      config: { stunServers: [] } as any,
      logger,
      onMessage: async () => undefined,
    });
    // A channel that refuses the send, exactly as SCTP does for an over-size
    // message: "OperationError: Failure to send data".
    (peer as any).dataChannel = {
      readyState: 'open',
      close: () => undefined,
      send: () => {
        throw new Error('OperationError: Failure to send data');
      },
    };
    (peer as any).isConnected = true;
    (connector as any).isStarted = true;
    (connector as any).activeConnectionType = 'webrtc';
    (connector as any).webrtcPeer = peer;

    const started = Date.now();
    const attempt = connector.query('foundry-mcp-bridge.importActors', { actors: [] });

    await expect(attempt).rejects.toThrow(/Send failed on the webrtc transport/);
    // NOT the generic timeout, which is what this used to surface 30 s later.
    await expect(attempt).rejects.not.toThrow(/Query timeout/);
    await expect(attempt).rejects.toThrow(/Failure to send data/);
    expect(Date.now() - started).toBeLessThan(1000);
    // And the pending entry is gone, so a late response cannot resolve it.
    expect((connector as any).pendingQueries.size).toBe(0);

    peer.disconnect();
  });

  it('a closed data channel is a send failure, not a silent drop', async () => {
    const logger = quietLogger();
    const peer = new WebRTCPeer({
      config: { stunServers: [] } as any,
      logger,
      onMessage: async () => undefined,
    });
    expect(() => peer.sendMessage({ type: 'mcp-query', id: 'q', data: {} })).toThrow(
      /data channel is not open/
    );
    peer.disconnect();
  });
});
