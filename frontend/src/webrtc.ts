import { io, Socket } from "socket.io-client";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface FileTransfer {
  id: string;
  file: File;
  metadata: FileMetadata;
  progress: number;
  status: "queued" | "transferring" | "completed" | "failed";
}

const CHUNK_SIZE = 16384;

export class PeerManager {
  private socket: Socket;
  private peer: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private roomId: string = "";
  private onStateChange: (state: ConnectionState) => void;
  private onFileReceived: (file: Blob, metadata: FileMetadata) => void;
  private onTransferUpdate: (transfer: FileTransfer) => void;

  private pendingFiles: Map<
    string,
    { chunks: ArrayBuffer[]; metadata: FileMetadata; bytesReceived: number }
  > = new Map();
  private fileQueue: FileTransfer[] = [];
  private isProcessing = false;

  constructor(
    onStateChange: (state: ConnectionState) => void,
    onFileReceived: (file: Blob, metadata: FileMetadata) => void,
    onTransferUpdate: (transfer: FileTransfer) => void,
  ) {
    this.socket = io("http://localhost:3001");
    this.onStateChange = onStateChange;
    this.onFileReceived = onFileReceived;
    this.onTransferUpdate = onTransferUpdate;

    this.socket.on("user-joined", () => {
      console.log("Peer joined, initiating connection...");
      this.initiateConnection();
    });

    this.socket.on("signal", async ({ data }) => {
      if (!this.peer) this.createPeer();

      if (data.sdp) {
        await this.peer!.setRemoteDescription(
          new RTCSessionDescription(data.sdp),
        );
        if (data.sdp.type === "offer") {
          const answer = await this.peer!.createAnswer();
          await this.peer!.setLocalDescription(answer);
          this.socket.emit("signal", {
            roomId: this.roomId,
            data: { sdp: this.peer!.localDescription },
          });
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
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("signal", {
          roomId: this.roomId,
          data: { candidate: event.candidate },
        });
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
    this.socket.emit("signal", {
      roomId: this.roomId,
      data: { sdp: this.peer!.localDescription },
    });
  }

  private setupDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = "arraybuffer";

    this.dataChannel.onopen = () => {
      this.onStateChange("connected");
      this.processQueue();
    };
    this.dataChannel.onclose = () => this.onStateChange("disconnected");

    this.dataChannel.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const data = JSON.parse(event.data);
          if (data.fileId) {
            const metadata: FileMetadata = {
              id: data.fileId,
              name: data.name,
              size: data.size,
              type: data.type,
            };
            this.pendingFiles.set(data.fileId, {
              chunks: [],
              metadata,
              bytesReceived: 0,
            });

            const transfer: FileTransfer = {
              id: data.fileId,
              file: new File([], data.name),
              metadata,
              progress: 0,
              status: "transferring",
            };
            this.onTransferUpdate(transfer);
          }
        } catch {
          // Legacy format without fileId
        }
      } else {
        const chunk = event.data as ArrayBuffer;
        const view = new DataView(chunk);
        const fileIdLength = view.getUint8(0);
        const fileId = new TextDecoder().decode(
          chunk.slice(1, 1 + fileIdLength),
        );
        const actualChunk = chunk.slice(1 + fileIdLength);

        const fileData = this.pendingFiles.get(fileId);
        if (!fileData) return;

        fileData.chunks.push(actualChunk);
        fileData.bytesReceived += actualChunk.byteLength;

        const progress =
          (fileData.bytesReceived / fileData.metadata.size) * 100;

        const transfer: FileTransfer = {
          id: fileId,
          file: new File([], fileData.metadata.name),
          metadata: fileData.metadata,
          progress,
          status: "transferring",
        };
        this.onTransferUpdate(transfer);

        if (fileData.bytesReceived >= fileData.metadata.size) {
          const blob = new Blob(fileData.chunks, {
            type: fileData.metadata.type,
          });
          this.onFileReceived(blob, fileData.metadata);

          const completedTransfer: FileTransfer = {
            id: fileId,
            file: new File([], fileData.metadata.name),
            metadata: fileData.metadata,
            progress: 100,
            status: "completed",
          };
          this.onTransferUpdate(completedTransfer);

          this.pendingFiles.delete(fileId);
        }
      }
    };
  }

  sendFile(file: File) {
    this.queueFiles([file]);
  }

  queueFiles(files: FileList | File[]) {
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      const id = Math.random().toString(36).substring(2, 11);
      const transfer: FileTransfer = {
        id,
        file,
        metadata: {
          id,
          name: file.name,
          size: file.size,
          type: file.type,
        },
        progress: 0,
        status: "queued",
      };

      this.fileQueue.push(transfer);
      this.onTransferUpdate(transfer);
    }

    if (this.dataChannel?.readyState === "open" && !this.isProcessing) {
      this.processQueue();
    }
  }

  private async processQueue() {
    if (this.isProcessing || this.fileQueue.length === 0) return;

    this.isProcessing = true;

    while (this.fileQueue.length > 0) {
      const transfer = this.fileQueue.shift();
      if (!transfer) continue;

      await this.sendFileInternal(transfer);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.isProcessing = false;
  }

  private async sendFileInternal(transfer: FileTransfer) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") return;

    const updatingTransfer: FileTransfer = {
      ...transfer,
      status: "transferring",
    };
    this.onTransferUpdate(updatingTransfer);

    this.dataChannel.send(
      JSON.stringify({
        fileId: transfer.metadata.id,
        name: transfer.metadata.name,
        size: transfer.metadata.size,
        type: transfer.metadata.type,
      }),
    );

    const file = transfer.file;
    const reader = new FileReader();
    let offset = 0;

    const readNextChunk = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      const chunk = e.target?.result as ArrayBuffer;
      if (chunk && chunk.byteLength > 0) {
        const fileIdBytes = new TextEncoder().encode(transfer.metadata.id);
        const combined = new Uint8Array(
          1 + fileIdBytes.length + chunk.byteLength,
        );
        combined[0] = fileIdBytes.length;
        combined.set(fileIdBytes, 1);
        combined.set(new Uint8Array(chunk), 1 + fileIdBytes.length);

        this.dataChannel!.send(combined);
        offset += chunk.byteLength;

        const progress = (offset / file.size) * 100;

        const updatingTransfer: FileTransfer = {
          ...transfer,
          progress,
          status: "transferring",
        };
        this.onTransferUpdate(updatingTransfer);

        if (offset < file.size) {
          if (this.dataChannel!.bufferedAmount > 16 * 1024 * 1024) {
            setTimeout(readNextChunk, 100);
          } else {
            readNextChunk();
          }
        } else {
          const completedTransfer: FileTransfer = {
            ...transfer,
            progress: 100,
            status: "completed",
          };
          this.onTransferUpdate(completedTransfer);
          this.processQueue();
        }
      }
    };

    readNextChunk();
  }

  cancelTransfer(transferId: string) {
    const index = this.fileQueue.findIndex((t) => t.id === transferId);
    if (index !== -1) {
      this.fileQueue.splice(index, 1);
    }
  }

  clearCompletedTransfers() {
    this.fileQueue = this.fileQueue.filter((t) => t.status !== "completed");
  }
}
