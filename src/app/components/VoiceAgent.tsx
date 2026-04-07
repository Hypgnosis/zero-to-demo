'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Mic, MicOff, Loader2, AlertCircle } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════ */

interface VoiceAgentProps {
  sessionId: string;
  lang: string;
}

interface ChatBubble {
  role: 'user' | 'model';
  content: string;
}

type VoiceStatus = 'idle' | 'connecting' | 'active' | 'error';

/* ═══════════════════════════════════════════════════════════════════
   PCM AUDIO PLAYBACK (Gemini Live API sends raw 16-bit PCM @ 24kHz)
   ═══════════════════════════════════════════════════════════════════ */

function playPcmAudio(
  audioContext: AudioContext,
  base64Data: string
): void {
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const dataView = new DataView(bytes.buffer);
  const numSamples = bytes.length / 2;
  const audioBuffer = audioContext.createBuffer(1, numSamples, 24000);
  const channelData = audioBuffer.getChannelData(0);

  for (let i = 0; i < numSamples; i++) {
    const int16 = dataView.getInt16(i * 2, true); // Little-endian
    channelData[i] = int16 / 32768.0;
  }

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();
}

/* ═══════════════════════════════════════════════════════════════════
   VOICE AGENT COMPONENT
   ═══════════════════════════════════════════════════════════════════ */

export default function VoiceAgent({ sessionId, lang }: VoiceAgentProps) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<ChatBubble[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  /* ─── Connect ───────────────────────────────────────────────── */
  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);

    try {
      // 1. Get proxy URL from our secure handshake endpoint
      const handshakeRes = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, lang }),
      });

      if (!handshakeRes.ok) {
        const errData = await handshakeRes.json().catch(() => ({}));
        throw new Error(errData?.error?.message ?? 'Voice handshake failed.');
      }

      const { wsUrl } = await handshakeRes.json();

      // 2. Initialize audio context
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });

      // 3. Get microphone access
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // 4. Connect to WebSocket proxy (NOT directly to Google)
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[VoiceAgent] Connected to proxy');
        setStatus('active');
        startAudioCapture();
      };

      ws.onmessage = async (event) => {
        try {
          let rawText: string;
          if (event.data instanceof Blob) {
            rawText = await event.data.text();
          } else {
            rawText = String(event.data);
          }

          const msg = JSON.parse(rawText);

          // Handle setup complete
          if (msg.setupComplete) {
            console.log('[VoiceAgent] Setup confirmed by Gemini');
            return;
          }

          // Handle server content (audio/text)
          const serverContent = msg.serverContent;
          if (!serverContent) return;

          if (serverContent.modelTurn?.parts) {
            for (const part of serverContent.modelTurn.parts) {
              if (part.text) {
                setTranscript((prev) => {
                  const last = prev[prev.length - 1];
                  if (last && last.role === 'model') {
                    return [
                      ...prev.slice(0, -1),
                      { ...last, content: last.content + part.text },
                    ];
                  }
                  return [...prev, { role: 'model', content: part.text }];
                });
              }
              if (part.inlineData?.data && audioContextRef.current) {
                playPcmAudio(audioContextRef.current, part.inlineData.data);
              }
            }
          }

          // Turn complete
          if (serverContent.turnComplete) {
            // Ready for next user input
          }
        } catch (err) {
          console.error('[VoiceAgent] Message parse error:', err);
        }
      };

      ws.onerror = () => {
        setStatus('error');
        setError('Voice connection error.');
      };

      ws.onclose = (event) => {
        console.log(`[VoiceAgent] WS closed: code=${event.code}`);
        setStatus('idle');
      };
    } catch (err) {
      console.error('[VoiceAgent] Connect error:', err);
      setError(err instanceof Error ? err.message : 'Connection failed.');
      setStatus('error');
    }
  }, [sessionId, lang]);

  /* ─── Start Audio Capture (AudioWorklet — off main thread) ─── */
  const startAudioCapture = useCallback(async () => {
    if (!audioContextRef.current || !mediaStreamRef.current || !wsRef.current) return;

    const ctx = audioContextRef.current;

    // Inline the AudioWorklet processor as a Blob URL to avoid a separate file
    const workletCode = `
      class PcmCaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const float32 = input[0];
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          this.port.postMessage(int16.buffer, [int16.buffer]);
          return true;
        }
      }
      registerProcessor('pcm-capture', PcmCaptureProcessor);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);

    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } catch (err) {
      console.error('[VoiceAgent] AudioWorklet registration failed:', err);
      URL.revokeObjectURL(workletUrl);
      return;
    }
    URL.revokeObjectURL(workletUrl);

    const source = ctx.createMediaStreamSource(mediaStreamRef.current);
    const workletNode = new AudioWorkletNode(ctx, 'pcm-capture');

    workletNode.port.onmessage = (e: MessageEvent) => {
      if (wsRef.current?.readyState !== 1) return;

      const pcmBuffer = e.data as ArrayBuffer;
      const bytes = new Uint8Array(pcmBuffer);

      // Base64 encode
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const b64 = btoa(binary);

      wsRef.current.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: 'audio/pcm;rate=16000',
                data: b64,
              },
            ],
          },
        })
      );
    };

    source.connect(workletNode);
    workletNode.connect(ctx.destination);
  }, []);

  /* ─── Disconnect ────────────────────────────────────────────── */
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnect');
      wsRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setStatus('idle');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  /* ═══════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════ */
  return (
    <div className="glass-panel flex-1 flex flex-col min-h-[400px] max-h-[60vh]">
      {/* Transcript Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {transcript.length === 0 && status === 'idle' && (
          <div className="flex items-center justify-center h-full">
            <p className="text-[var(--text-muted)] text-sm font-mono">
              Press the microphone to start a voice session
            </p>
          </div>
        )}

        {transcript.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-[var(--cyber-purple-dim)] text-[var(--text-primary)] rounded-br-md'
                  : 'glass-panel-sm text-[var(--text-primary)] rounded-bl-md'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Error Display */}
      {error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-center gap-2">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Controls */}
      <div className="p-4 flex items-center justify-center">
        <motion.button
          onClick={status === 'idle' || status === 'error' ? connect : disconnect}
          disabled={status === 'connecting'}
          whileTap={{ scale: 0.9 }}
          className={`w-16 h-16 rounded-full flex items-center justify-center transition-all cursor-pointer disabled:cursor-not-allowed ${
            status === 'active'
              ? 'bg-red-500/20 border-2 border-red-500 text-red-400 hover:bg-red-500/30'
              : status === 'connecting'
              ? 'bg-[var(--cyber-purple-dim)] border-2 border-[var(--cyber-purple)] text-[var(--cyber-purple)]'
              : 'bg-[var(--cyber-purple-dim)] border-2 border-[var(--cyber-purple)] text-[var(--cyber-purple)] hover:bg-[var(--cyber-purple)] hover:text-white'
          }`}
        >
          {status === 'connecting' ? (
            <Loader2 size={28} className="animate-spin" />
          ) : status === 'active' ? (
            <MicOff size={28} />
          ) : (
            <Mic size={28} />
          )}
        </motion.button>

        {status === 'active' && (
          <div className="ml-4 flex items-center gap-1">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="voice-bar w-1 bg-[var(--cyber-purple)] rounded-full"
                style={{
                  height: `${12 + Math.random() * 20}px`,
                  animationDelay: `${i * 0.1}s`,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
