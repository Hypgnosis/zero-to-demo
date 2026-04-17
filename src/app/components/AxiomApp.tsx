'use client';

import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, Float, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import {
  Upload, MessageSquare, Globe, FileText,
  BrainCircuit, Shield, Zap, Send, Loader2, X, Mic, CheckCircle, AlertCircle
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import VoiceAgent from './VoiceAgent';

/* ═══════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════ */

interface ChatMsg {
  role: 'user' | 'model';
  content: string;
}

type AppPhase = 'upload' | 'processing' | 'agent';
type JobStatus = 'pending' | 'processing' | 'complete' | 'failed';

/* ═══════════════════════════════════════════════════════════════════
   TRANSLATIONS (Bilingual — No BYOK references)
   ═══════════════════════════════════════════════════════════════════ */

const translations = {
  en: {
    title0: 'AXIOM-0',
    titleG: 'AXIOM-G',
    subtitle0: 'Autonomous Intelligence | Ephemeral Memory',
    subtitleG: 'Enterprise Governance | Persistent Sovereignty',
    dragDrop: 'Drag & Drop Industrial PDF',
    uploadBtn: 'or click to vector-load',
    memory0: 'Session-Isolated',
    memoryG: 'Long-Term Context',
    encryption0: 'Server-Side Keys',
    encryptionG: 'BYOK Sovereign Keys',
    chatPlaceholder: 'Query the System...',
    steps: {
      0: 'Uploading to Staging...',
      1: 'Vectorizing Document...',
      2: 'System Online',
    } as Record<number, string>,
    noFile: 'Intake requires an industrial PDF.',
    processing: 'Processing your document...',
    complete: 'Vectorization complete!',
    failed: 'Processing failed.',
    voiceBtn: 'Voice Interface',
    face0: 'Face: 0',
    face0Desc: 'Ephemeral / Self-Destruct in 4h',
    faceG: 'Face: G',
    faceGDesc: 'Governed / Persistent Assets',
  },
  es: {
    title0: 'AXIOM-0',
    titleG: 'AXIOM-G',
    subtitle0: 'Inteligencia Autónoma | Memoria Efímera',
    subtitleG: 'Gobernanza Empresarial | Soberanía Persistente',
    dragDrop: 'Arrastra un PDF Industrial Aquí',
    uploadBtn: 'o haz clic para carga vectorial',
    memory0: 'Aislamiento por Sesión',
    memoryG: 'Contexto de Largo Plazo',
    encryption0: 'Claves del Servidor',
    encryptionG: 'Claves Soberanas BYOK',
    chatPlaceholder: 'Consulta al Sistema...',
    steps: {
      0: 'Subiendo al Staging...',
      1: 'Vectorizando Documento...',
      2: 'Sistema en Línea',
    } as Record<number, string>,
    noFile: 'La ingesta requiere un PDF industrial.',
    processing: 'Procesando su documento...',
    complete: '¡Vectorización completa!',
    failed: 'El procesamiento falló.',
    voiceBtn: 'Interfaz de Voz',
    face0: 'Cara: 0',
    face0Desc: 'Efímera / Autodestrucción en 4h',
    faceG: 'Cara: G',
    faceGDesc: 'Gobernada / Activos Persistentes',
  },
} as const;

type Lang = keyof typeof translations;

/* ═══════════════════════════════════════════════════════════════════
   LOGO COMPONENT (Unified)
   ═══════════════════════════════════════════════════════════════════ */

function AxiomLogo({ 
  className, 
  pulsing = false, 
  face = '0' 
}: { 
  className?: string; 
  pulsing?: boolean;
  face?: '0' | 'G';
}) {
  const logoSrc = face === '0' ? '/Axiom-0 Logo.png' : '/Axiom-G Logo.png';
  const glowColor = face === '0' ? 'rgba(188,19,254,1)' : 'rgba(255,215,0,1)';
  
  return (
    <div className={`relative flex items-center justify-center ${className ?? ''}`}>
      <motion.img
        key={face}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        src={logoSrc}
        alt={`Axiom-${face}`}
        className={`absolute inset-0 w-full h-full object-contain mix-blend-screen transition-all ${pulsing ? 'animate-pulse' : ''}`}
        style={{
          filter: `contrast(2.0) brightness(1.3) grayscale(0.2) ${pulsing ? `drop-shadow(0 0 20px ${glowColor})` : ''}`,
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   3D WEBGL CORE (REACT THREE FIBER)
   ═══════════════════════════════════════════════════════════════════ */

function SingularityCore() {
  const groupRef = useRef<THREE.Group>(null);
  const singularityRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.rotation.y = t * 0.15;
    }
    if (singularityRef.current) {
      const scale = 1 + Math.sin(t * 0.8) * 0.05;
      singularityRef.current.scale.set(scale, scale, scale);
    }
  });

  return (
    <Float speed={1.5} rotationIntensity={0.3} floatIntensity={0.5}>
      <group ref={groupRef}>
        {/* Core sphere */}
        <mesh ref={singularityRef}>
          <sphereGeometry args={[1.2, 64, 64]} />
          <meshPhysicalMaterial
            color="#1a0a2e"
            metalness={0.95}
            roughness={0.1}
            clearcoat={1}
            clearcoatRoughness={0.05}
            envMapIntensity={2}
          />
        </mesh>
        {/* Wire ring */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.0, 0.015, 16, 100]} />
          <meshPhysicalMaterial
            color="#BC13FE"
            emissive="#BC13FE"
            emissiveIntensity={0.8}
            metalness={1}
            roughness={0}
            transparent
            opacity={0.6}
          />
        </mesh>
        {/* Second tilted ring */}
        <mesh rotation={[1.2, 0.5, 0]}>
          <torusGeometry args={[1.7, 0.01, 16, 100]} />
          <meshPhysicalMaterial
            color="#FFD700"
            emissive="#FFD700"
            emissiveIntensity={0.6}
            metalness={1}
            roughness={0}
            transparent
            opacity={0.4}
          />
        </mesh>
      </group>
    </Float>
  );
}

function Background3D() {
  return (
    <div className="fixed inset-0 z-0 pointer-events-none" style={{ opacity: 0.4 }}>
      <Canvas camera={{ position: [0, 0, 6], fov: 50 }}>
        <Suspense fallback={null}>
          <Environment preset="city" />
          <SingularityCore />
          <ContactShadows position={[0, -2.5, 0]} opacity={0.3} scale={10} blur={2} />
        </Suspense>
      </Canvas>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   STATUS POLLING HOOK
   ═══════════════════════════════════════════════════════════════════ */

function useJobPoller(jobId: string | null, onComplete: () => void) {
  const [status, setStatus] = useState<JobStatus>('pending');
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!jobId) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/status?jobId=${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        setStatus(data.status);
        if (data.totalChunks) setTotalChunks(data.totalChunks);
        if (data.error) setError(data.error);

        if (data.status === 'complete') {
          if (intervalRef.current) clearInterval(intervalRef.current);
          onComplete();
        }
        if (data.status === 'failed') {
          if (intervalRef.current) clearInterval(intervalRef.current);
        }
      } catch {
        // Silent retry
      }
    };

    poll();
    intervalRef.current = setInterval(poll, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [jobId, onComplete]);

  return { status, totalChunks, error };
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN APPLICATION COMPONENT
   ═══════════════════════════════════════════════════════════════════ */

export default function AxiomApp() {
  /* ─── Session Management ────────────────────────────────────── */
  const [sessionId] = useState<string>(() => {
    if (typeof window === 'undefined') return uuidv4();
    const existing = sessionStorage.getItem('axiom-session-id');
    if (existing) return existing;
    const newId = uuidv4();
    sessionStorage.setItem('axiom-session-id', newId);
    return newId;
  });

  /* ─── Core State ────────────────────────────────────────────── */
  const [phase, setPhase] = useState<AppPhase>('upload');
  const [lang, setLang] = useState<Lang>('en');
  const [face, setFace] = useState<'0' | 'G'>('0');
  const [fileName, setFileName] = useState<string>('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [showVoice, setShowVoice] = useState(false);

  /* ─── Chat State ────────────────────────────────────────────── */
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  /* ─── Drag State ────────────────────────────────────────────── */
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const t = translations[lang];

  /* ─── Job Polling ───────────────────────────────────────────── */
  const handleJobComplete = useCallback(() => {
    setPhase('agent');
  }, []);

  const { status: jobStatus, totalChunks, error: jobError } = useJobPoller(
    phase === 'processing' ? jobId : null,
    handleJobComplete
  );

  /* ─── Auto-scroll Chat ──────────────────────────────────────── */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ─── Upload Handler ────────────────────────────────────────── */
  const handleUpload = async (file: File) => {
    if (!file.type.includes('pdf')) {
      return;
    }

    setFileName(file.name);
    setPhase('processing');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`/api/upload?sessionId=${sessionId}`, {
        method: 'POST',
        headers: {
          'X-Axiom-Mode': face === '0' ? 'ephemeral' : 'governed',
        },
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error?.message ?? `Upload failed: ${res.status}`);
      }

      const data = await res.json();
      setJobId(data.jobId);
    } catch (err) {
      console.error('Upload error:', err);
      setPhase('upload');
    }
  };

  /* ─── Chat Handler (SSE Stream) ─────────────────────────────── */
  const sendMessage = async () => {
    const query = inputValue.trim();
    if (!query || isStreaming) return;

    const userMsg: ChatMsg = { role: 'user', content: query };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInputValue('');
    setIsStreaming(true);

    // Add placeholder for model response
    const modelMsg: ChatMsg = { role: 'model', content: '' };
    setMessages([...updatedMessages, modelMsg]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messages: updatedMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error?.message ?? 'Chat request failed.');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream.');

      const decoder = new TextDecoder();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === 'text' && parsed.content) {
              fullResponse += parsed.content;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'model') {
                  last.content = fullResponse;
                }
                return [...updated];
              });
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      console.error('Chat error:', err);
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === 'model') {
          last.content = '⚠ An error occurred. Please try again.';
        }
        return [...updated];
      });
    } finally {
      setIsStreaming(false);
    }
  };

  /* ─── Drag & Drop Handlers ──────────────────────────────────── */
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  };
  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  };

  /* ═══════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════ */
  const themeColor = face === '0' ? 'var(--cyber-purple)' : 'var(--amber-gold)';
  const themeGlow = face === '0' ? 'glow-purple-text' : 'glow-gold-text';

  return (
    <div 
      className="relative min-h-screen w-full overflow-hidden bg-[var(--obsidian)]"
      style={{ '--theme-color': themeColor } as React.CSSProperties}
    >
      {/* 3D Background */}
      <Background3D />

      {/* Main Content */}
      <div className="relative z-10 flex flex-col items-center min-h-screen">
        {/* ── Header ──────────────────────────────────────────── */}
        <header className="w-full flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <AxiomLogo className="w-10 h-10" face={face} pulsing={phase === 'processing'} />
            <div>
              <h1 className={`text-lg font-bold tracking-wider text-[var(--text-primary)] ${themeGlow} transition-all duration-500`}>
                {face === '0' ? t.title0 : t.titleG}
              </h1>
              <p className="text-xs text-[var(--text-muted)] tracking-wide">
                {face === '0' ? t.subtitle0 : t.subtitleG}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Status Badges */}
            <div className="hidden md:flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)] tracking-widest uppercase">
                <Shield size={12} style={{ color: themeColor }} />
                {face === '0' ? t.encryption0 : t.encryptionG}
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)] tracking-widest uppercase">
                <Zap size={12} style={{ color: themeColor }} />
                {face === '0' ? t.memory0 : t.memoryG}
              </span>
            </div>

            {/* Language Toggle */}
            <button
              onClick={() => setLang((l) => (l === 'en' ? 'es' : 'en'))}
              className="glass-panel-sm px-3 py-1.5 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--cyber-purple)] transition-colors cursor-pointer"
            >
              <Globe size={14} />
              {lang.toUpperCase()}
            </button>
          </div>
        </header>

        {/* ── Main Content Area ────────────────────────────────── */}
        <div className="flex-1 w-full max-w-4xl mx-auto px-4 pb-8 flex flex-col">
          <AnimatePresence mode="wait">
            {/* ── UPLOAD PHASE ─────────────────────────────────── */}
            {phase === 'upload' && (
              <motion.div
                key="upload"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex items-center justify-center"
              >
                <div
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`glass-panel w-full max-w-lg p-12 flex flex-col items-center gap-6 cursor-pointer transition-all duration-500 ${
                    face === '0' ? 'glow-purple' : 'glow-gold'
                  } ${isDragging ? 'border-[var(--cyber-purple)] scale-[1.02]' : ''}`}
                >
                  {/* Mode Toggle (Face Switcher) */}
                  <div className="flex p-1 gap-1 glass-panel-sm rounded-xl mb-6 w-full max-w-xs relative overflow-hidden">
                    <button
                      onClick={(e) => { e.stopPropagation(); setFace('0'); }}
                      className={`flex-1 px-3 py-2 rounded-lg text-[10px] uppercase tracking-widest z-10 transition-all duration-300 ${
                        face === '0' 
                          ? 'bg-[var(--cyber-purple-dim)] text-[var(--text-primary)] border border-[var(--cyber-purple)]/30 shadow-[0_0_15px_rgba(188,19,254,0.3)]' 
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      {t.face0}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setFace('G'); }}
                      className={`flex-1 px-3 py-2 rounded-lg text-[10px] uppercase tracking-widest z-10 transition-all duration-300 ${
                        face === 'G' 
                          ? 'bg-[var(--amber-gold-dim)] text-[var(--text-primary)] border border-[var(--amber-gold)]/30 shadow-[0_0_15px_rgba(255,215,0,0.3)]' 
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      {t.faceG}
                    </button>
                  </div>

                  <div className={`w-20 h-20 rounded-2xl flex items-center justify-center relative overflow-hidden group transition-colors duration-500 ${
                    face === '0' ? 'bg-[var(--cyber-purple-dim)]' : 'bg-[var(--amber-gold-dim)]'
                  }`}>
                    <Upload size={36} className="transition-all duration-500" style={{ color: themeColor }} />
                    <motion.div 
                      key={face}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className={`absolute inset-0 pointer-events-none transition-opacity duration-1000 ${
                        face === '0' ? 'bg-gradient-to-tr from-[var(--cyber-purple-dim)] to-transparent' : 'bg-gradient-to-tr from-[var(--amber-gold-dim)] to-transparent'
                      }`}
                    />
                  </div>
                  
                  <div className="text-center">
                    <p className="text-lg font-semibold text-[var(--text-primary)]">
                      {t.dragDrop}
                    </p>
                    <p className="text-sm text-[var(--text-muted)] mt-1">{t.uploadBtn}</p>
                    <div className="flex flex-col gap-1 mt-4">
                      <p className="text-[10px] uppercase tracking-[0.2em] font-bold transition-colors duration-500" style={{ color: themeColor }}>
                        {face === '0' ? t.face0Desc : t.faceGDesc}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)] opacity-50 uppercase tracking-widest">
                        PDF · {face === '0' ? 'Ephemeral Memory' : 'Governed Sovereignty'}
                      </p>
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={onFileSelect}
                  />
                </div>
              </motion.div>
            )}

            {/* ── PROCESSING PHASE ─────────────────────────────── */}
            {phase === 'processing' && (
              <motion.div
                key="processing"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex-1 flex items-center justify-center"
              >
                <div className={`glass-panel w-full max-w-lg p-10 flex flex-col items-center gap-6 ${
                  face === '0' ? 'glow-purple' : 'glow-gold'
                }`}>
                  <AxiomLogo className="w-24 h-24" face={face} pulsing />

                  <div className="text-center">
                    <p className="text-sm font-mono text-[var(--text-secondary)] mb-2">
                      <FileText size={14} className="inline mr-1.5" />
                      {fileName}
                    </p>

                    {/* Status Steps */}
                    <div className="flex flex-col gap-2 mt-4">
                      {[0, 1, 2].map((step) => {
                        const isActive =
                          (step === 0 && (jobStatus === 'pending')) ||
                          (step === 1 && jobStatus === 'processing') ||
                          (step === 2 && jobStatus === 'complete');
                        const isComplete =
                          (step === 0 && jobStatus !== 'pending') ||
                          (step === 1 && jobStatus === 'complete') ||
                          (step === 2 && jobStatus === 'complete');

                        return (
                          <div
                            key={step}
                            className={`flex items-center gap-2 text-sm transition-all ${
                              isActive
                                ? 'transition-colors duration-500'
                                : isComplete
                                ? 'text-green-400'
                                : 'text-[var(--text-muted)]'
                            }`}
                            style={isActive ? { color: themeColor } : {}}
                          >
                            {isActive && <Loader2 size={14} className="animate-spin" />}
                            {isComplete && !isActive && <CheckCircle size={14} />}
                            {!isActive && !isComplete && (
                              <div className="w-3.5 h-3.5 rounded-full border border-[var(--text-muted)]" />
                            )}
                            <span className="font-mono text-xs tracking-wide">
                              {t.steps[step] ?? ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {totalChunks > 0 && (
                      <p className="text-xs mt-3 font-mono" style={{ color: themeColor }}>
                        {totalChunks} vectors embedded
                      </p>
                    )}

                    {jobError && (
                      <p className="text-xs text-red-400 mt-3 flex items-center gap-1">
                        <AlertCircle size={12} />
                        {jobError}
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ── AGENT PHASE (Chat) ───────────────────────────── */}
            {phase === 'agent' && !showVoice && (
              <motion.div
                key="agent"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col"
              >
                {/* Agent Header */}
                <div className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-2">
                    <BrainCircuit size={18} style={{ color: themeColor }} />
                    <span className="text-sm font-mono text-[var(--text-secondary)] tracking-wide uppercase">
                      AXIOM-{face} AGENT — {fileName}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 font-mono">
                      ONLINE
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowVoice(true)}
                      className="glass-panel-sm px-3 py-1.5 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--cyber-purple)] transition-colors cursor-pointer"
                    >
                      <Mic size={14} />
                      {t.voiceBtn}
                    </button>
                    <button
                      onClick={() => {
                        setPhase('upload');
                        setMessages([]);
                        setJobId(null);
                        setFileName('');
                      }}
                      className="glass-panel-sm px-3 py-1.5 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <X size={14} />
                      Reset
                    </button>
                  </div>
                </div>

                {/* Chat Messages */}
                <div className={`glass-panel flex-1 overflow-y-auto p-4 space-y-4 min-h-[400px] max-h-[60vh] scan-line relative ${
                  face === '0' ? 'glow-purple-sm' : 'glow-gold-sm'
                }`}>
                  {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-[var(--text-muted)] text-sm font-mono uppercase tracking-widest opacity-30">
                        {t.chatPlaceholder}
                      </p>
                    </div>
                  )}

                  {messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed transition-all duration-500 ${
                          msg.role === 'user'
                            ? `text-[var(--text-primary)] rounded-br-md`
                            : 'glass-panel-sm text-[var(--text-primary)] rounded-bl-md'
                        }`}
                        style={msg.role === 'user' ? { 
                          backgroundColor: face === '0' ? 'rgba(188,19,254,0.15)' : 'rgba(255,215,0,0.15)',
                          border: `1px solid ${face === '0' ? 'rgba(188,19,254,0.3)' : 'rgba(255,215,0,0.3)'}`
                        } : {}}
                      >
                        {msg.content || (
                          <span className="typing-cursor text-[var(--text-muted)]"> </span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>

                {/* Chat Input */}
                <div className="mt-3 glass-panel p-3 flex items-center gap-3">
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                    placeholder={t.chatPlaceholder}
                    disabled={isStreaming}
                    className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={isStreaming || !inputValue.trim()}
                    className="p-2 rounded-lg transition-all disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                    style={{ 
                      backgroundColor: face === '0' ? 'rgba(188,19,254,0.15)' : 'rgba(255,215,0,0.15)',
                      color: themeColor
                    }}
                  >
                    {isStreaming ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Send size={18} />
                    )}
                  </button>
                </div>
              </motion.div>
            )}

            {/* ── VOICE AGENT PHASE ────────────────────────────── */}
            {phase === 'agent' && showVoice && (
              <motion.div
                key="voice"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col"
              >
                <div className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-2">
                    <Mic size={18} style={{ color: themeColor }} />
                    <span className="text-sm font-mono text-[var(--text-secondary)] uppercase">
                      VOICE AGENT — {fileName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowVoice(false)}
                      className="glass-panel-sm px-3 py-1.5 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--cyber-purple)] transition-colors cursor-pointer"
                    >
                      <MessageSquare size={14} />
                      Text Chat
                    </button>
                  </div>
                </div>
                <VoiceAgent sessionId={sessionId} lang={lang} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Footer ──────────────────────────────────────────── */}
        <footer className="w-full text-center py-4 text-[10px] text-[var(--text-muted)] tracking-widest uppercase">
          High ArchyTech Solutions — AXIOM Unified Intelligence
        </footer>
      </div>
    </div>
  );
}
