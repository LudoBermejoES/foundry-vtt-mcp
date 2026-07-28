import { MODULE_ID, CONNECTION_STATES, WEBRTC_CONSTANTS } from './constants.js';
import {
  decodeFailureResponse,
  decompressEnvelope,
  isCompressedEnvelope,
  WireDecodeError,
  type WireMeta,
} from './wire-format.js';

/** UTF-8 byte length of one code point. */
function utf8LengthOfCodePoint(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** UTF-8 byte length of a string, i.e. what the transport actually counts. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Split `text` into pieces of at most `maxBytes` UTF-8 bytes, cutting only on
 * code-point boundaries so each piece is a well-formed string and
 * `pieces.join('')` reproduces the input exactly.
 *
 * Exported for the test that pins the defect this replaces: a string whose
 * UTF-16 length is under the fragment threshold while its UTF-8 encoding is over
 * the frame.
 */
export function splitByUtf8Bytes(text: string, maxBytes: number): string[] {
  const limit = Math.max(4, maxBytes);
  const parts: string[] = [];
  let start = 0;
  let bytes = 0;

  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i) as number;
    const units = codePoint > 0xffff ? 2 : 1;
    const width = utf8LengthOfCodePoint(codePoint);

    if (bytes + width > limit && i > start) {
      parts.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }

    bytes += width;
    i += units;
  }

  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

export interface WebRTCConfig {
  serverHost: string;
  serverPort: number;
  namespace: string;
  stunServers: string[];
  connectionTimeout: number;
  debugLogging: boolean;
}

/**
 * WebRTC peer connection for browser-to-server communication
 * Uses HTTP POST for signaling (localhost exception allows HTTP from HTTPS)
 * Then establishes encrypted WebRTC DataChannel for P2P connection without SSL certificates
 */
export class WebRTCConnection {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private connectionState: string = CONNECTION_STATES.DISCONNECTED;
  private messageHandler: ((message: any, meta: WireMeta) => Promise<void>) | null = null;

  constructor(private config: WebRTCConfig) {}

  async connect(onMessage: (message: any, meta: WireMeta) => Promise<void>): Promise<void> {
    if (
      this.connectionState === CONNECTION_STATES.CONNECTED ||
      this.connectionState === CONNECTION_STATES.CONNECTING
    ) {
      return;
    }

    this.connectionState = CONNECTION_STATES.CONNECTING;
    this.messageHandler = onMessage;
    this.log('Starting WebRTC connection...');

    try {
      // Step 1: Create WebRTC peer connection
      this.peerConnection = new RTCPeerConnection({
        iceServers: this.config.stunServers.map(url => ({ urls: url })),
      });

      // Step 2: Create data channel
      this.dataChannel = this.peerConnection.createDataChannel('foundry-mcp', {
        ordered: true,
        maxRetransmits: 10,
      });

      this.setupDataChannelHandlers();
      this.setupPeerConnectionHandlers();

      // Step 3: Create offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      // Step 4: Wait for ICE gathering
      await this.waitForIceGathering();

      // Step 5: Send offer to server via signaling WebSocket
      await this.sendSignalingOffer(this.peerConnection.localDescription!);

      this.log('WebRTC connection initiated');
    } catch (error) {
      this.log(`WebRTC connection failed: ${error}`);
      this.connectionState = CONNECTION_STATES.DISCONNECTED;
      throw error;
    }
  }

  private setupDataChannelHandlers(): void {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      this.log('WebRTC data channel opened');
      this.connectionState = CONNECTION_STATES.CONNECTED;
    };

    this.dataChannel.onclose = () => {
      this.log('WebRTC data channel closed');
      this.connectionState = CONNECTION_STATES.DISCONNECTED;
    };

    this.dataChannel.onerror = error => {
      this.log(`WebRTC data channel error: ${error}`);
    };

    this.dataChannel.onmessage = async event => {
      try {
        // Routed by `message.type` ONLY — never by sniffing the payload bytes and
        // never by testing `typeof event.data`. The wire stays textual precisely
        // so this stays a single discrimination axis.
        const message = JSON.parse(event.data);
        await this.dispatch(message);
      } catch (error) {
        this.log(`Failed to parse WebRTC message: ${error}`);
      }
    };
  }

  /**
   * Unwrap a `compressed-message` envelope if that is what arrived, then hand the
   * message to the application with a note of how it arrived — so the reply can
   * be encoded in kind (see socket-bridge's `handleMessage`).
   *
   * A decode failure ANSWERS the originating request rather than being dropped:
   * dropping it costs the caller its full query deadline and points at the wrong
   * subsystem.
   */
  private async dispatch(message: any): Promise<void> {
    if (!isCompressedEnvelope(message)) {
      if (this.messageHandler) await this.messageHandler(message, { compressed: false });
      return;
    }

    let inner: any;
    try {
      inner = await decompressEnvelope(message, WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES);
    } catch (error) {
      const decodeError =
        error instanceof WireDecodeError
          ? error
          : new WireDecodeError(
              error instanceof Error ? error.message : String(error),
              message.originalId,
              message.originalType
            );
      this.log(`Failed to decode compressed message: ${decodeError.message}`);
      try {
        this.sendMessage(decodeFailureResponse(decodeError));
      } catch (sendError) {
        this.log(`Could not report the decode failure: ${sendError}`);
      }
      return;
    }

    this.log(
      `Decoded compressed message: ${message.originalType} (${message.payload.length} b64 chars)`
    );
    if (this.messageHandler) await this.messageHandler(inner, { compressed: true });
  }

  private setupPeerConnectionHandlers(): void {
    if (!this.peerConnection) return;

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      this.log(`ICE connection state: ${state}`);

      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.connectionState = CONNECTION_STATES.DISCONNECTED;
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      this.log(`Peer connection state: ${state}`);
    };
  }

  private async waitForIceGathering(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ICE gathering timeout'));
      }, this.config.connectionTimeout * 1000);

      if (this.peerConnection?.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
        return;
      }

      this.peerConnection!.onicegatheringstatechange = () => {
        if (this.peerConnection?.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
  }

  private async sendSignalingOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    // Use HTTP POST for signaling to dedicated WebRTC signaling port (31416)
    // For HTTPS pages, browsers allow HTTP POST to localhost (security exception)
    // The MCP server must be running on the same machine as the browser
    const isHttps = window.location.protocol === 'https:';
    const signalingHost = isHttps ? 'localhost' : this.config.serverHost;
    const protocol = 'http'; // Always http:// - localhost exception allows this from HTTPS
    const WEBRTC_SIGNALING_PORT = 31416; // Dedicated port for WebRTC signaling
    const httpUrl = `${protocol}://${signalingHost}:${WEBRTC_SIGNALING_PORT}/webrtc-offer`;

    this.log(`Sending WebRTC offer via HTTP POST: ${httpUrl} (HTTPS page: ${isHttps})`);

    try {
      const response = await fetch(httpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ offer }),
        signal: AbortSignal.timeout(this.config.connectionTimeout * 1000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const { answer } = await response.json();

      if (!answer) {
        throw new Error('No answer received from server');
      }

      this.log('Received WebRTC answer from server via HTTP');
      await this.peerConnection?.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`Signaling via HTTP failed: ${errorMsg}`);
      throw error; // Re-throw original error instead of wrapping
    }
  }

  disconnect(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.log('WebRTC connection closed');
  }

  sendMessage(message: any): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      this.log('Cannot send message - data channel not open');
      return;
    }

    try {
      const json = JSON.stringify(message);
      // BYTES, not UTF-16 code units. SCTP's limit is a byte limit; `json.length`
      // counts code units, so every non-ASCII character (this corpus is Spanish,
      // and one accented character is 2 bytes, an emoji 4) made the old
      // measurement under-count — a check that could not detect what it existed
      // to detect. Compression dissolves this on the compressed path, because
      // gzip consumes an encoded byte buffer and there is no `.length` left to
      // get wrong; it does NOT dissolve here, because this framing layer still
      // splits a text envelope.
      const size = utf8Length(json);

      const { MAX_MESSAGE_SIZE, CHUNK_SIZE } = WEBRTC_CONSTANTS;

      if (size > CHUNK_SIZE) {
        // Split large message into chunks. The cut points are byte-budgeted but
        // land on CODE-POINT boundaries: each fragment travels as a string and the
        // far side reassembles by string concatenation, so slicing mid-sequence
        // would corrupt the character that straddles the cut.
        const parts = splitByUtf8Bytes(json, CHUNK_SIZE);
        const totalChunks = parts.length;
        const chunkId = `chunk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        this.log(
          `Chunking large message: ${size} bytes → ${totalChunks} chunks (type: ${message.type})`
        );

        for (let i = 0; i < totalChunks; i++) {
          const chunk = parts[i];

          const chunkMessage = {
            type: 'chunked-message',
            chunkId: chunkId,
            chunkIndex: i,
            totalChunks: totalChunks,
            chunk: chunk,
            originalType: message.type,
            originalId: message.id,
          };

          const chunkJson = JSON.stringify(chunkMessage);
          const chunkBytes = utf8Length(chunkJson);

          // Verify chunk doesn't exceed SCTP maxMessageSize (safety check)
          if (chunkBytes > MAX_MESSAGE_SIZE) {
            throw new Error(
              `Chunk ${i + 1}/${totalChunks} size ${chunkBytes} bytes exceeds ` +
                `SCTP maxMessageSize of ${MAX_MESSAGE_SIZE} bytes. ` +
                `Original message may be too large to chunk safely.`
            );
          }

          this.dataChannel.send(chunkJson);
          this.log(`Sent chunk ${i + 1}/${totalChunks} (${chunkBytes} bytes)`);
        }

        this.log(`Successfully sent all ${totalChunks} chunks for ${message.type}`);
      } else {
        // Send as single message
        this.dataChannel.send(json);
        this.log(`Sent WebRTC message: ${message.type} (${size} bytes)`);
      }
    } catch (error) {
      this.log(`Failed to send WebRTC message: ${error}`);
      throw error; // Re-throw so caller knows send failed
    }
  }

  isConnected(): boolean {
    return this.connectionState === CONNECTION_STATES.CONNECTED;
  }

  getConnectionState(): string {
    return this.connectionState;
  }

  private log(message: string): void {
    if (this.config.debugLogging) {
      console.log(`[${MODULE_ID}] WebRTC: ${message}`);
    }
  }
}
