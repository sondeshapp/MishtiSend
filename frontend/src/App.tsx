import React, { useState, useRef } from 'react';
import { PeerManager } from './webrtc';
import type { ConnectionState, FileMetadata, FileTransfer } from './webrtc';
import './index.css';

interface ReceivedFile {
  blob: Blob;
  metadata: FileMetadata;
  id: string;
}

const App: React.FC = () => {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [showJoinInput, setShowJoinInput] = useState(false);
  const [status, setStatus] = useState<ConnectionState>('disconnected');
  const [progress, setProgress] = useState(0);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const peerManagerRef = useRef<PeerManager | null>(null);

  const generateAndCreate = () => {
    const newId = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(newId);
    handleJoin(newId);
  };

  const handleJoin = (idToJoin?: string) => {
    const finalId = idToJoin || roomId;
    if (!finalId) return;
    
    const pm = new PeerManager(
      (state) => setStatus(state),
      (blob, metadata) => {
        setReceivedFiles(prev => [
          ...prev, 
          { blob, metadata, id: Math.random().toString(36).slice(2, 11) }
        ]);
      },
      (transfer: FileTransfer) => setProgress(transfer.progress)
    );
    
    pm.joinRoom(finalId);
    peerManagerRef.current = pm;
    setJoined(true);
  };

  const downloadFile = (file: ReceivedFile) => {
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.metadata.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <h1>FlashSend</h1>
      <p>Direct P2P file transfer. Secure, fast, and simple.</p>

      {!joined ? (
        <div className="join-container">
          {!showJoinInput ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <button onClick={generateAndCreate}>Create New Room</button>
              <button 
                style={{ background: 'transparent', border: '1px solid var(--primary)', color: 'var(--primary)' }}
                onClick={() => setShowJoinInput(true)}
              >
                Join Existing Room
              </button>
            </div>
          ) : (
            <div className="input-group">
              <input 
                type="text" 
                placeholder="Enter 6-digit Room ID" 
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                autoFocus
              />
              <button style={{ marginTop: '1rem' }} onClick={() => handleJoin()}>Join Room</button>
              <button 
                style={{ marginTop: '0.5rem', background: 'transparent', color: 'var(--text-muted)', fontSize: '0.875rem' }}
                onClick={() => setShowJoinInput(false)}
              >
                ← Back
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="room-container">
          <div className="status-banner" style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '0.75rem', textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>Share this ID with your friend:</p>
            <h2 style={{ fontSize: '1.5rem', letterSpacing: '2px', color: 'white', margin: '0.5rem 0' }}>{roomId}</h2>
            <div className="status" style={{ justifyContent: 'center' }}>
              <div className={`status-dot ${status === 'connected' ? 'online' : ''}`}></div>
              <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
            </div>
          </div>

          <div 
            className="drop-zone"
            onClick={() => document.getElementById('fileInput')?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file && peerManagerRef.current) {
                peerManagerRef.current.sendFile(file);
              }
            }}
          >
            <p>Click or drag file to send</p>
            <input 
              type="file" 
              id="fileInput" 
              style={{ display: 'none' }} 
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && peerManagerRef.current) {
                  peerManagerRef.current.sendFile(file);
                }
              }}
            />
          </div>

          {progress > 0 && (
            <div className="progress-container">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }}></div>
              </div>
              <p style={{ marginTop: '0.5rem', textAlign: 'center' }}>
                {progress < 100 ? `Transferring: ${Math.round(progress)}%` : 'Processing...'}
              </p>
            </div>
          )}

          {receivedFiles.length > 0 && (
            <div className="received-files">
              <h3>Received Files</h3>
              {receivedFiles.map(file => (
                <div key={file.id} className="file-item">
                  <span style={{ fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.metadata.name}
                  </span>
                  <a 
                    href="#" 
                    className="download-link" 
                    onClick={(e) => { e.preventDefault(); downloadFile(file); }}
                  >
                    Download
                  </a>
                </div>
              ))}
            </div>
          )}
          
          <button 
            style={{ marginTop: '2rem', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
            onClick={() => window.location.reload()}
          >
            Leave Room
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
