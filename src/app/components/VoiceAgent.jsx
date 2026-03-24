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
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the voice agent modal is visible.
 * @param {Function} props.onClose - Callback to close the modal.
 * @param {string} props.lang - Current language ("en" or "es").
 */
export default function VoiceAgent({ isOpen, onClose, lang = "en" }) {
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | error
  const [isMuted, setIsMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);

  // Refs to avoid stale closures in WebSocket/audio callbacks
  const isMutedRef = useRef(false);
  const statusRef = useRef("idle");

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const playbackCtxRef = useRef(null);

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

  // ─── Cleanup on unmount or close ──────────────────────────────────
  useEffect(() => {
    return () => disconnect();
  }, []);

  useEffect(() => {
    if (!isOpen && statusRef.current !== "idle") {
      disconnect();
    }
  }, [isOpen]);

  // ─── PCM Audio Playback (NO decodeAudioData — raw 16-bit PCM) ────
  const playPcmAudio = useCallback((base64Audio) => {
    audioQueueRef.current.push(base64Audio);
    if (!isPlayingRef.current) {
      processAudioQueue();
    }
  }, []);

  const processAudioQueue = useCallback(async () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const base64 = audioQueueRef.current.shift();

    try {
      if (!playbackCtxRef.current) {
        playbackCtxRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
      }
      const ctx = playbackCtxRef.current;

      // Decode base64 to binary
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      // Convert raw 16-bit PCM to Float32 (CRITICAL: no decodeAudioData!)
      const dataView = new DataView(bytes.buffer);
      const numSamples = Math.floor(bytes.length / 2);
      const audioBuffer = ctx.createBuffer(1, numSamples, PLAYBACK_SAMPLE_RATE);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < numSamples; i++) {
        const int16 = dataView.getInt16(i * 2, true); // little-endian
        channelData[i] = int16 / 32768.0;
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
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Puck" },
                },
              },
            },
            systemInstruction: {
              parts: [
                {
                  text: `You are an expert technical sales engineer for Reshapex.
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

          // Handle audio response
          if (response.serverContent?.modelTurn?.parts) {
            for (const part of response.serverContent.modelTurn.parts) {
              if (part.inlineData?.data) {
                playPcmAudio(part.inlineData.data);
              }
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
      console.error("Connection error:", err);
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

      // Use ScriptProcessorNode to capture raw PCM
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

        // Convert Float32 to 16-bit PCM
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Base64 encode and send
        const uint8 = new Uint8Array(pcm16.buffer);
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
      console.error("Microphone error:", err);
      setErrorMsg("Microphone access denied");
      setStatus("error");
    }
  }, []);

  // ─── Disconnect ───────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }

    // Stop microphone
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

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-xl"
        onClick={(e) => e.target === e.currentTarget && handleClose()}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="relative w-full max-w-md mx-4"
        >
          {/* ─── Voice Agent Card ─────────────────────────────── */}
          <div className="voice-agent-card rounded-3xl p-8 text-center">
            {/* Header */}
            <div className="mb-8">
              <h2 className="text-xl font-bold text-[#F0F0F0] mb-1">
                {t.title}
              </h2>
              <p className="text-xs font-mono text-[#555]">{t.subtitle}</p>
            </div>

            {/* ─── Orb Visualizer ───────────────────────────── */}
            <div className="relative w-40 h-40 mx-auto mb-8">
              {/* Outer pulse rings */}
              {status === "connected" && (
                <>
                  <div
                    className="absolute inset-0 rounded-full border border-[#BC13FE]/20 animate-ping"
                    style={{ animationDuration: "2s" }}
                  />
                  <div
                    className="absolute inset-2 rounded-full border border-[#BC13FE]/15 animate-ping"
                    style={{ animationDuration: "2.5s", animationDelay: "0.5s" }}
                  />
                </>
              )}

              {/* Main orb */}
              <div
                className={`absolute inset-4 rounded-full flex items-center justify-center transition-all duration-500 ${
                  status === "connected"
                    ? "bg-gradient-to-br from-[#BC13FE] to-[#8B0FBF] shadow-[0_0_60px_rgba(188,19,254,0.5)]"
                    : status === "connecting"
                    ? "bg-gradient-to-br from-[#BC13FE]/60 to-[#8B0FBF]/60 animate-pulse"
                    : status === "error"
                    ? "bg-gradient-to-br from-red-500/40 to-red-700/40"
                    : "bg-[#1A1A1A] border border-[#BC13FE]/20"
                }`}
                style={{
                  transform:
                    status === "connected"
                      ? `scale(${1 + audioLevel * 0.15})`
                      : "scale(1)",
                  transition: "transform 100ms ease-out",
                }}
              >
                {status === "connecting" ? (
                  <Loader2 className="w-10 h-10 text-white/80 animate-spin" />
                ) : status === "connected" ? (
                  <div className="flex items-center gap-1">
                    {[...Array(5)].map((_, i) => (
                      <div
                        key={i}
                        className="w-1 bg-white/90 rounded-full voice-bar"
                        style={{
                          height: `${12 + audioLevel * 24 + Math.random() * 8}px`,
                          animationDelay: `${i * 0.1}s`,
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <Mic className="w-10 h-10 text-[#BC13FE]/60" />
                )}
              </div>
            </div>

            {/* ─── Status Text ──────────────────────────────── */}
            <div className="mb-8">
              <p
                className={`text-sm font-mono ${
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
            </div>

            {/* ─── Controls ────────────────────────────────── */}
            <div className="flex items-center justify-center gap-4">
              {status === "idle" || status === "error" ? (
                <button
                  onClick={connect}
                  className="flex items-center gap-2 px-8 py-3.5 rounded-2xl bg-gradient-to-r from-[#BC13FE] to-[#8B0FBF] text-white text-sm font-semibold
                    hover:from-[#a30de0] hover:to-[#7a0da8] transition-all duration-300
                    shadow-[0_0_30px_rgba(188,19,254,0.3)] hover:shadow-[0_0_40px_rgba(188,19,254,0.5)] cursor-pointer"
                >
                  <Mic className="w-4 h-4" />
                  {t.idle}
                </button>
              ) : (
                <>
                  {/* Mute/Unmute */}
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-300 cursor-pointer ${
                      isMuted
                        ? "bg-red-500/20 border border-red-500/30 text-red-400"
                        : "bg-[#1A1A1A] border border-[#BC13FE]/20 text-[#8A8A8A] hover:text-[#BC13FE] hover:border-[#BC13FE]/40"
                    }`}
                    title={isMuted ? t.unmute : t.mute}
                  >
                    {isMuted ? (
                      <MicOff className="w-5 h-5" />
                    ) : (
                      <Mic className="w-5 h-5" />
                    )}
                  </button>

                  {/* End Call */}
                  <button
                    onClick={handleClose}
                    className="w-14 h-14 rounded-2xl bg-red-500/20 border border-red-500/30 flex items-center justify-center
                      text-red-400 hover:bg-red-500/30 transition-all duration-300 cursor-pointer"
                    title={t.endCall}
                  >
                    <PhoneOff className="w-5 h-5" />
                  </button>
                </>
              )}
            </div>

            {/* ─── Close hint ───────────────────────────────── */}
            {status === "idle" && (
              <button
                onClick={handleClose}
                className="mt-6 text-xs font-mono text-[#333] hover:text-[#555] transition-colors cursor-pointer"
              >
                ESC to close
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
