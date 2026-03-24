"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, MicOff, PhoneOff, Loader2 } from "lucide-react";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════
/** Gemini Live API WebSocket endpoint (v1beta — required). */
const GEMINI_WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Native audio model for real-time voice. */
const VOICE_MODEL = "models/gemini-2.5-flash-native-audio-latest";

/** Audio sample rate for playback (Gemini streams 24kHz PCM). */
const PLAYBACK_SAMPLE_RATE = 24000;

/** Audio sample rate for microphone capture. */
const CAPTURE_SAMPLE_RATE = 16000;

/** ScriptProcessor buffer size. */
const BUFFER_SIZE = 4096;

// ═══════════════════════════════════════════════════════════════════════
// VOICE AGENT COMPONENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * VoiceAgent — Real-time multimodal voice interface using Gemini Live API.
 * Streams raw PCM audio over WebSocket (BidiGenerateContent).
 * Pipes text transcriptions into the main chat via onTranscript callback.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the voice agent is active.
 * @param {Function} props.onClose - Callback to close/deactivate the agent.
 * @param {Function} props.onTranscript - Callback to pipe transcripts to chat: (role, text) => void
 * @param {string} props.lang - Current language ("en" or "es").
 */
export default function VoiceAgent({ isOpen, onClose, onTranscript, lang = "en" }) {
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | error
  const [isMuted, setIsMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);

  // Refs to avoid stale closures in WebSocket/audio callbacks
  const isMutedRef = useRef(false);
  const statusRef = useRef("idle");
  const onTranscriptRef = useRef(onTranscript);

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const playbackCtxRef = useRef(null);

  // Track the current AI message ID so streaming text appends to the same bubble
  const currentAiMsgIdRef = useRef(null);

  const i18n = {
    en: {
      title: "Voice Demo Agent",
      subtitle: "Reshapex Multimodal Live",
      connecting: "Initializing voice link...",
      connected: "Live — Speak naturally",
      idle: "Start Voice Demo",
      error: "Connection failed",
      mute: "Mute",
      unmute: "Unmute",
      endCall: "End Demo",
      listening: "Listening...",
      speaking: "Agent speaking...",
    },
    es: {
      title: "Agente de Voz en Vivo",
      subtitle: "Reshapex Multimodal en Vivo",
      connecting: "Inicializando enlace de voz...",
      connected: "En vivo — Habla naturalmente",
      idle: "Iniciar Demo de Voz",
      error: "Conexión fallida",
      mute: "Silenciar",
      unmute: "Activar",
      endCall: "Terminar Demo",
      listening: "Escuchando...",
      speaking: "Agente hablando...",
    },
  };

  const t = i18n[lang] || i18n.en;

  // ─── Sync refs with state to avoid stale closures ────────────────
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);

  // ─── Cleanup on unmount or close ──────────────────────────────────
  useEffect(() => {
    return () => disconnect();
  }, []);

  useEffect(() => {
    if (!isOpen && statusRef.current !== "idle") {
      disconnect();
    }
  }, [isOpen]);

  // ─── PCM Audio Playback ───────────────────────────────────────────
  const processAudioQueue = useCallback(() => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const base64Chunk = audioQueueRef.current.shift();

    try {
      if (!playbackCtxRef.current || playbackCtxRef.current.state === "closed") {
        playbackCtxRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
      }

      const ctx = playbackCtxRef.current;
      const binaryStr = atob(base64Chunk);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const view = new DataView(bytes.buffer);
      const numSamples = bytes.length / 2;
      const audioBuffer = ctx.createBuffer(1, numSamples, PLAYBACK_SAMPLE_RATE);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < numSamples; i++) {
        channelData[i] = view.getInt16(i * 2, true) / 32768.0;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => processAudioQueue();
      source.start();
    } catch (err) {
      console.error("PCM playback error:", err);
      processAudioQueue();
    }
  }, []);

  const playPcmAudio = useCallback(
    (base64Data) => {
      audioQueueRef.current.push(base64Data);
      if (!isPlayingRef.current) {
        processAudioQueue();
      }
    },
    [processAudioQueue]
  );

  // ─── Connect to Gemini Live API ───────────────────────────────────
  const connect = useCallback(async () => {
    setStatus("connecting");
    setErrorMsg(null);

    try {
      // 1. Fetch catalog context + API key from server
      const res = await fetch("/api/context");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load catalog context");
      }
      const { context, apiKey } = data;

      // 2. Open WebSocket to Gemini Live API (v1beta)
      const wsUrl = `${GEMINI_WS_BASE}?key=${apiKey}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // 3. Send setup message with context injection
        const setupMsg = {
          setup: {
            model: VOICE_MODEL,
            generationConfig: {
              responseModalities: ["AUDIO", "TEXT"],
            },
            systemInstruction: {
              parts: [
                {
                  text: `You are the Reshapex Industrial Sales Engineer voice assistant.
Answer the prospect's questions professionally, concisely, and conversationally over audio.
Use ONLY the following prospect catalog data to answer questions.
If it's not in the data, say you don't have that specification handy.

CATALOG DATA:
${context}`,
                },
              ],
            },
          },
        };
        ws.send(JSON.stringify(setupMsg));
      };

      ws.onmessage = async (event) => {
        try {
          // CRITICAL: Gemini may send Blob or ArrayBuffer, not raw string
          let text;
          if (event.data instanceof Blob) {
            text = await event.data.text();
          } else if (event.data instanceof ArrayBuffer) {
            text = new TextDecoder().decode(event.data);
          } else {
            text = event.data;
          }

          const response = JSON.parse(text);

          // Handle setup completion
          if (response.setupComplete) {
            setStatus("connected");
            startMicrophone();
            return;
          }

          // Handle model turn (AI response — audio + text)
          if (response.serverContent?.modelTurn?.parts) {
            for (const part of response.serverContent.modelTurn.parts) {
              // Play audio
              if (part.inlineData?.data) {
                playPcmAudio(part.inlineData.data);
              }
              // Pipe text transcript to chat
              if (part.text && onTranscriptRef.current) {
                onTranscriptRef.current("ai", part.text, currentAiMsgIdRef.current);
              }
            }
          }

          // When the model turn is complete, reset the AI message ID
          // so the next response creates a new bubble
          if (response.serverContent?.turnComplete) {
            currentAiMsgIdRef.current = null;
          }

          // Handle user input transcript (Gemini echoes what the user said)
          if (response.serverContent?.inputTranscript) {
            if (onTranscriptRef.current) {
              onTranscriptRef.current("user", response.serverContent.inputTranscript);
            }
          }
        } catch (err) {
          console.error("WebSocket message parse error:", err);
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setErrorMsg("WebSocket connection error");
        setStatus("error");
      };

      ws.onclose = (event) => {
        if (statusRef.current !== "idle") {
          console.log("WebSocket closed:", event.code, event.reason);
          if (event.code !== 1000) {
            setErrorMsg(`Connection closed: ${event.reason || `Code ${event.code}`}`);
            setStatus("error");
          } else {
            setStatus("idle");
          }
        }
      };
    } catch (err) {
      console.error("Voice agent connect error:", err);
      setErrorMsg(err.message);
      setStatus("error");
    }
  }, [playPcmAudio]);

  // ─── Microphone Capture ───────────────────────────────────────────
  const startMicrophone = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: CAPTURE_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMutedRef.current) return;
        const inputData = e.inputBuffer.getChannelData(0);

        // Calculate audio level for visualization
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        setAudioLevel(Math.min(rms * 5, 1));

        // Convert Float32 to Int16 PCM
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Base64 encode and send
        const uint8 = new Uint8Array(pcmData.buffer);
        let binary = "";
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        const base64 = btoa(binary);

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              realtimeInput: {
                mediaChunks: [
                  {
                    mimeType: `audio/pcm;rate=${CAPTURE_SAMPLE_RATE}`,
                    data: base64,
                  },
                ],
              },
            })
          );
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
    } catch (err) {
      console.error("Microphone access error:", err);
      setErrorMsg("Microphone access denied");
      setStatus("error");
    }
  }, []);

  // ─── Disconnect ───────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close(1000, "User disconnected");
      wsRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close();
      playbackCtxRef.current = null;
    }

    // Clear audio queue
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    currentAiMsgIdRef.current = null;

    setStatus("idle");
    setAudioLevel(0);
    setIsMuted(false);
    setErrorMsg(null);
  }, []);

  // ─── Handle close ─────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    disconnect();
    onClose();
  }, [disconnect, onClose]);

  if (!isOpen) return null;

  // ═══════════════════════════════════════════════════════════════════
  // INLINE CARD UI (replaces the old fullscreen modal)
  // ═══════════════════════════════════════════════════════════════════
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="voice-agent-card rounded-2xl p-5"
    >
      {/* ─── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-[#F0F0F0]">{t.title}</h3>
          <p className="text-[10px] font-mono text-[#555]">{t.subtitle}</p>
        </div>
        {/* Compact orb indicator */}
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-500 ${
            status === "connected"
              ? "bg-gradient-to-br from-[#BC13FE] to-[#8B0FBF] shadow-[0_0_20px_rgba(188,19,254,0.4)]"
              : status === "connecting"
              ? "bg-gradient-to-br from-[#BC13FE]/60 to-[#8B0FBF]/60 animate-pulse"
              : status === "error"
              ? "bg-gradient-to-br from-red-500/40 to-red-700/40"
              : "bg-[#1A1A1A] border border-[#BC13FE]/20"
          }`}
          style={{
            transform:
              status === "connected"
                ? `scale(${1 + audioLevel * 0.2})`
                : "scale(1)",
            transition: "transform 100ms ease-out",
          }}
        >
          {status === "connecting" ? (
            <Loader2 className="w-3.5 h-3.5 text-white/80 animate-spin" />
          ) : status === "connected" ? (
            <div className="flex items-center gap-[2px]">
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
                  className="w-[2px] bg-white/90 rounded-full voice-bar"
                  style={{
                    height: `${6 + audioLevel * 10}px`,
                    animationDelay: `${i * 0.1}s`,
                  }}
                />
              ))}
            </div>
          ) : (
            <Mic className="w-3.5 h-3.5 text-[#BC13FE]/60" />
          )}
        </div>
      </div>

      {/* ─── Status ──────────────────────────────────────────── */}
      <p
        className={`text-xs font-mono mb-4 ${
          status === "connected"
            ? "text-[#BC13FE]"
            : status === "error"
            ? "text-red-400"
            : "text-[#555]"
        }`}
      >
        {status === "connected"
          ? t.connected
          : status === "connecting"
          ? t.connecting
          : status === "error"
          ? errorMsg || t.error
          : t.idle}
      </p>

      {/* ─── Controls ────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {status === "idle" || status === "error" ? (
          <button
            onClick={connect}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#BC13FE] to-[#8B0FBF] text-white text-xs font-semibold
              hover:from-[#a30de0] hover:to-[#7a0da8] transition-all duration-300
              shadow-[0_0_20px_rgba(188,19,254,0.3)] hover:shadow-[0_0_30px_rgba(188,19,254,0.4)] cursor-pointer"
          >
            <Mic className="w-3.5 h-3.5" />
            {t.idle}
          </button>
        ) : (
          <>
            {/* Mute/Unmute */}
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 cursor-pointer ${
                isMuted
                  ? "bg-red-500/20 border border-red-500/30 text-red-400"
                  : "bg-[#1A1A1A] border border-[#BC13FE]/20 text-[#8A8A8A] hover:text-[#BC13FE] hover:border-[#BC13FE]/40"
              }`}
              title={isMuted ? t.unmute : t.mute}
            >
              {isMuted ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>

            {/* End Call */}
            <button
              onClick={handleClose}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-red-500/20 border border-red-500/30
                text-red-400 text-xs font-semibold hover:bg-red-500/30 transition-all duration-300 cursor-pointer"
              title={t.endCall}
            >
              <PhoneOff className="w-3.5 h-3.5" />
              {t.endCall}
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}
