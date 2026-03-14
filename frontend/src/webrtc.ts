import { io, Socket } from "socket.io-client";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
}

const CHUNK_SIZE = 16384; // 16KB

export class PeerManager {
  private socket: Socket;
  private peer: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private roomId: string = "";
  private onStateChange: (state: ConnectionState) => void;
  private onFileReceived: (file: Blob, metadata: FileMetadata) => void;
  private onProgress: (progress: number) => void;

  private receivedChunks: ArrayBuffer[] = [];
  private currentFileMetadata: FileMetadata | null = null;
  private bytesReceived = 0;

  constructor(
    onStateChange: (state: ConnectionState) => void,
    onFileReceived: (file: Blob, metadata: FileMetadata) => void,
    onProgress: (progress: number) => void
  ) {
    this.socket = io("https://poems-complement-casey-mission.trycloudflare.com");
    this.onStateChange = onStateChange;
    this.onFileReceived = onFileReceived;
    this.onProgress = onProgress;

    this.socket.on("user-joined", () => {
      console.log("Peer joined, initiating connection...");
      this.initiateConnection();
    });

    this.socket.on("signal", async ({ data }) => {
      if (!this.peer) this.createPeer();
      
      if (data.sdp) {
        await this.peer!.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === "offer") {
          const answer = await this.peer!.createAnswer();
          await this.peer!.setLocalDescription(answer);
          this.socket.emit("signal", { roomId: this.roomId, data: { sdp: this.peer!.localDescription } });
        }
      } else if (data.candidate) {
        await this.peer!.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });
  }

  joinRoom(roomId: string) {
    this.roomId = roomId;
    this.socket.emit("join-room", roomId);
    this.onStateChange("connecting");
  }

  private createPeer() {
    this.peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    this.peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("signal", { roomId: this.roomId, data: { candidate: event.candidate } });
      }
    };

    this.peer.onconnectionstatechange = () => {
      if (this.peer?.connectionState === "connected") {
        this.onStateChange("connected");
      } else if (this.peer?.connectionState === "disconnected") {
        this.onStateChange("disconnected");
      }
    };

    this.peer.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };
  }

  private async initiateConnection() {
    this.createPeer();
    this.dataChannel = this.peer!.createDataChannel("file-transfer");
    this.setupDataChannel(this.dataChannel);

    const offer = await this.peer!.createOffer();
    await this.peer!.setLocalDescription(offer);
    this.socket.emit("signal", { roomId: this.roomId, data: { sdp: this.peer!.localDescription } });
  }

  private setupDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = "arraybuffer";

    this.dataChannel.onopen = () => this.onStateChange("connected");
    this.dataChannel.onclose = () => this.onStateChange("disconnected");

    this.dataChannel.onmessage = (event) => {
      if (typeof event.data === "string") {
        const metadata = JSON.parse(event.data) as FileMetadata;
        this.currentFileMetadata = metadata;
        this.receivedChunks = [];
        this.bytesReceived = 0;
      } else {
        this.receivedChunks.push(event.data);
        this.bytesReceived += event.data.byteLength;
        if (this.currentFileMetadata) {
          const progress = (this.bytesReceived / this.currentFileMetadata.size) * 100;
          this.onProgress(progress);

          if (this.bytesReceived >= this.currentFileMetadata.size) {
            const blob = new Blob(this.receivedChunks, { type: this.currentFileMetadata.type });
            this.onFileReceived(blob, this.currentFileMetadata);
            this.currentFileMetadata = null;
            this.onProgress(0);
          }
        }
      }
    };
  }

  async sendFile(file: File) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") return;

    // Send metadata first
    this.dataChannel.send(JSON.stringify({
      name: file.name,
      size: file.size,
      type: file.type
    }));

    const reader = new FileReader();
    let offset = 0;

    const readNextChunk = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      const chunk = e.target?.result as ArrayBuffer;
      this.dataChannel!.send(chunk);
      offset += chunk.byteLength;

      const progress = (offset / file.size) * 100;
      this.onProgress(progress);

      if (offset < file.size) {
        // Use a small delay or check bufferedAmount to avoid overwhelming the channel
        if (this.dataChannel!.bufferedAmount > 16 * 1024 * 1024) { // 16MB buffer limit
          setTimeout(readNextChunk, 100);
        } else {
          readNextChunk();
        }
      } else {
        this.onProgress(0);
      }
    };

    readNextChunk();
  }
}
