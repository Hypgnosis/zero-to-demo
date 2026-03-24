"use client";

import React, { useState, useRef, useEffect, useCallback, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  UploadCloud,
  FileText,
  CheckCircle,
  MessageSquare,
  Play,
  Zap,
  Shield,
  Cpu,
  Globe,
  Send,
  RotateCcw,
  Activity,
  Wifi,
  Clock,
  ChevronRight,
  Loader2,
  Terminal,
  Braces,
  Database,
  X,
  Mic,
} from "lucide-react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float, Environment, ContactShadows } from "@react-three/drei";
import VoiceAgent from "./components/VoiceAgent";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════
/** Interval between each thinking step animation in milliseconds. */
const THINKING_STEP_INTERVAL_MS = 1200;
/** Delay to let the thinking animation complete before transitioning. */
const ANIMATION_SETTLE_DELAY_MS = 3000;
/** Delay before transitioning from step 2 to step 3. */
const STEP_TRANSITION_DELAY_MS = 800;
/** Total number of RAG pipeline thinking steps (0-indexed max). */
const MAX_THINKING_STEPS = 3;
/** Duration before the error banner auto-dismisses in milliseconds. */
const ERROR_DISMISS_DELAY_MS = 8000;


// ═══════════════════════════════════════════════════════════════════════
// TRANSLATIONS (i18n)
// ═══════════════════════════════════════════════════════════════════════
const translations = {
  en: {
    // Nav
    systemOnline: "System: Online",
    latency: "Latency: 12ms",
    vectorReady: "Vector Store: Ready",
    fieldOps: "Field Ops Mode",
    // Header
    brand: "Reshapex",
    subtitle: "Zero-to-Demo Engine",
    tagline: "Autonomous RAG Deployment System",
    // Step 1
    uploadTitle: "Deploy Intelligence Source",
    uploadDesc: "Drag & drop PDFs, product catalogs, or technical manuals into the processing matrix.",
    browseFiles: "Browse Files",
    dropZoneHint: "Accepted: PDF up to 50MB",
    // Step 2
    processingTitle: "Document Loaded",
    processingDesc: "Ready to vectorize and deploy autonomous demo agent.",
    deployBtn: "Initialize Live Agent",
    processingBtn: "Vectorizing...",
    // Step 3
    deployed: "Agent Deployed",
    sourcesLoaded: "Sources Loaded:",
    salesTip: "Share your screen. Ask the agent a highly specific technical question from the client's catalog.",
    tipLabel: "Sales Rep Tip:",
    startOver: "Reset System",
    chatTitle: "Autonomous Agent",
    chatPlaceholder: "Ask a technical question...",
    sendBtn: "Send",
    // Voice
    voiceBtn: "Start Voice Demo",
    // Thinking steps
    thinkStep1: "Scanning PDF segments...",
    thinkStep2: "Vectorizing to globalThis...",
    thinkStep3: "Building RAG pipeline...",
    thinkStep4: "Agent initialized. Standing by.",
    // Initial message
    initialMsg: "System online. I have fully ingested the uploaded catalog. What would you like to know?",
    // Footer
    footerBrand: "High ArchyTech Solutions",
    footerDiv: "Autonomous Systems Division",
    footerRight: "All systems operational",
    // Core
    coreLabel: "HA Core",
    coreStatus: "Processing Matrix Active",
  },
  es: {
    systemOnline: "Sistema: En Línea",
    latency: "Latencia: 12ms",
    vectorReady: "Vector Store: Listo",
    fieldOps: "Modo Campo",
    brand: "Reshapex",
    subtitle: "Motor Zero-to-Demo",
    tagline: "Sistema Autónomo de Despliegue RAG",
    uploadTitle: "Desplegar Fuente de Inteligencia",
    uploadDesc: "Arrastra y suelta PDFs, catálogos de productos o manuales técnicos en la matriz de procesamiento.",
    browseFiles: "Buscar Archivos",
    dropZoneHint: "Aceptado: PDF hasta 50MB",
    processingTitle: "Documento Cargado",
    processingDesc: "Listo para vectorizar y desplegar agente autónomo de demostración.",
    deployBtn: "Inicializar Agente en Vivo",
    processingBtn: "Vectorizando...",
    deployed: "Agente Desplegado",
    sourcesLoaded: "Fuentes Cargadas:",
    salesTip: "Comparte tu pantalla. Hazle al agente una pregunta técnica altamente específica del catálogo del cliente.",
    tipLabel: "Consejo para el Rep:",
    startOver: "Reiniciar Sistema",
    chatTitle: "Agente Autónomo",
    chatPlaceholder: "Haz una pregunta técnica...",
    sendBtn: "Enviar",
    voiceBtn: "Iniciar Demo de Voz",
    thinkStep1: "Escaneando segmentos PDF...",
    thinkStep2: "Vectorizando en globalThis...",
    thinkStep3: "Construyendo pipeline RAG...",
    thinkStep4: "Agente inicializado. En espera.",
    initialMsg: "Sistema en línea. He procesado completamente el catálogo cargado. ¿Qué deseas saber?",
    footerBrand: "High ArchyTech Solutions",
    footerDiv: "División de Sistemas Autónomos",
    footerRight: "Todos los sistemas operativos",
    coreLabel: "Núcleo HA",
    coreStatus: "Matriz de Procesamiento Activa",
  },
};

// ═══════════════════════════════════════════════════════════════════════
// ANIMATION VARIANTS
// ═══════════════════════════════════════════════════════════════════════
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.05 },
  },
  exit: { opacity: 0, transition: { duration: 0.2 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
};

const scaleIn = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: "easeOut" } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } },
};

// ═══════════════════════════════════════════════════════════════════════
// 3D HIGH ARCHYTECH CORE (React Three Fiber + Drei)
// ═══════════════════════════════════════════════════════════════════════
function CoreOctahedron({ isActive }) {
  const meshRef = useRef();
  const wireRef = useRef();

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.getElapsedTime();
    meshRef.current.rotation.x = t * 0.3;
    meshRef.current.rotation.y = t * 0.5;
    if (wireRef.current) {
      wireRef.current.rotation.x = t * -0.2;
      wireRef.current.rotation.y = t * -0.4;
    }
  });

  return (
    <Float speed={2} rotationIntensity={0.3} floatIntensity={0.8}>
      <group>
        {/* Main Octahedron */}
        <mesh
          ref={meshRef}
          onPointerOver={() => { document.body.style.cursor = "pointer"; }}
          onPointerOut={() => { document.body.style.cursor = "default"; }}
        >
          <octahedronGeometry args={[1.2, 0]} />
          <meshPhysicalMaterial
            color={isActive ? "#FFD700" : "#BC13FE"}
            metalness={0.8}
            roughness={0.15}
            clearcoat={1}
            clearcoatRoughness={0.1}
            emissive={isActive ? "#FFD700" : "#BC13FE"}
            emissiveIntensity={isActive ? 0.4 : 0.2}
            transparent
            opacity={0.85}
          />
        </mesh>
        {/* Wireframe shell */}
        <mesh ref={wireRef}>
          <octahedronGeometry args={[1.7, 1]} />
          <meshPhysicalMaterial
            color="#BC13FE"
            metalness={0.9}
            roughness={0.1}
            wireframe
            transparent
            opacity={0.25}
          />
        </mesh>
      </group>
    </Float>
  );
}

function CoreScene({ isActive }) {
  return (
    <Canvas camera={{ position: [0, 0, 5], fov: 45 }} style={{ background: "transparent" }}>
      <ambientLight intensity={0.3} />
      <pointLight position={[5, 5, 5]} intensity={0.8} color="#BC13FE" />
      <pointLight position={[-5, -3, 3]} intensity={0.5} color="#FFD700" />
      <Environment preset="city" />
      <Suspense fallback={null}>
        <CoreOctahedron isActive={isActive} />
      </Suspense>
      <ContactShadows position={[0, -2, 0]} opacity={0.3} scale={6} blur={2.5} color="#BC13FE" />
    </Canvas>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// HIGH ARCHYTECH LOGO (from uploaded ha-logo.png)
// ═══════════════════════════════════════════════════════════════════════
function ArchytechLogo({ className = "w-8 h-8" }) {
  return (
    <img
      src="/ha-logo.png"
      alt="High ArchyTech Solutions"
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════
// THINKING STEPS COMPONENT
// ═══════════════════════════════════════════════════════════════════════
function ThinkingSteps({ steps, currentStep }) {
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: i <= currentStep ? 1 : 0.3, x: 0 }}
          transition={{ delay: i * 0.6, duration: 0.4 }}
          className="flex items-center gap-2 text-xs font-mono"
        >
          <div className={`w-1.5 h-1.5 rounded-full ${i < currentStep ? "bg-[#FFD700]" : i === currentStep ? "bg-[#BC13FE] animate-pulse" : "bg-[#333]"}`} />
          <span className={i <= currentStep ? "text-[#8A8A8A]" : "text-[#333]"}>
            {step}
          </span>
          {i < currentStep && <CheckCircle className="w-3 h-3 text-[#FFD700]" />}
        </motion.div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN APP COMPONENT
// ═══════════════════════════════════════════════════════════════════════
export default function App() {
  const [lang, setLang] = useState("en");
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(-1);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceAiMsgIdRef = useRef(null);
  const chatEndRef = useRef(null);
  const msgIdCounter = useRef(0);

  const t = translations[lang];

  /** Generates a monotonically increasing unique message ID. */
  const nextMsgId = () => {
    msgIdCounter.current += 1;
    return `msg-${msgIdCounter.current}`;
  };

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-dismiss error banner
  useEffect(() => {
    if (!errorMsg) return;
    const timer = setTimeout(() => setErrorMsg(null), ERROR_DISMISS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [errorMsg]);


  /**
   * Handles file selection from both drag-and-drop and the file input.
   * Advances the UI to step 2 (processing) when a file is selected.
   * @param {Event} e - The file input change event or drop event.
   */
  const handleFileUpload = (e) => {
    e.preventDefault();
    let selectedFile = null;
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      selectedFile = e.dataTransfer.files[0];
    } else if (e.target.files && e.target.files.length > 0) {
      selectedFile = e.target.files[0];
    }
    if (selectedFile) {
      setFile(selectedFile);
      setStep(2);
    }
  };

  /**
   * Uploads the selected PDF to /api/upload, runs the thinking step animation,
   * and transitions to the chat interface on success.
   * Displays an in-app error banner instead of browser alerts on failure.
   */
  const processDocument = async () => {
    if (!file) return;
    setIsProcessing(true);
    setErrorMsg(null);
    setThinkingStep(0);

    const thinkingInterval = setInterval(() => {
      setThinkingStep((prev) => {
        if (prev >= MAX_THINKING_STEPS) {
          clearInterval(thinkingInterval);
          return prev;
        }
        return prev + 1;
      });
    }, THINKING_STEP_INTERVAL_MS);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (response.ok) {
        // Wait for thinking animation to complete
        await new Promise((r) => setTimeout(r, ANIMATION_SETTLE_DELAY_MS));
        clearInterval(thinkingInterval);
        setThinkingStep(MAX_THINKING_STEPS);
        setIsProcessing(false);
        setMessages([{ role: "ai", text: t.initialMsg, id: nextMsgId() }]);
        setTimeout(() => setStep(3), STEP_TRANSITION_DELAY_MS);
      } else {
        clearInterval(thinkingInterval);
        setErrorMsg(data.error || "Failed to process document");
        setIsProcessing(false);
        setThinkingStep(-1);
      }
    } catch (error) {
      clearInterval(thinkingInterval);
      console.error("Error processing document:", error);
      setErrorMsg("An unexpected error occurred during processing.");
      setIsProcessing(false);
      setThinkingStep(-1);
    }
  };

  /**
   * Sends the current chat input to /api/chat and streams the AI response
   * into a new message bubble. Empty messages are silently ignored.
   * @param {Event} e - The form submission event.
   */
  const handleChat = async (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const currentInput = chatInput;
    const userMessage = { role: "user", text: currentInput, id: nextMsgId() };
    setMessages((prev) => [...prev, userMessage]);
    setChatInput("");

    const aiMsgId = nextMsgId();
    setMessages((prev) => [...prev, { role: "ai", text: "", id: aiMsgId }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMessage] }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Network response was not ok");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunkValue = decoder.decode(value);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === aiMsgId ? { ...msg, text: msg.text + chunkValue } : msg
            )
          );
        }
      }
    } catch (error) {
      console.error("Error connecting to chat:", error);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === aiMsgId ? { ...msg, text: `Error: ${error.message}` } : msg
        )
      );
    }
  };

  /**
   * Resets the entire application to the initial upload state.
   * Clears all messages, file selection, and processing state.
   */
  const handleReset = () => {
    setStep(1);
    setFile(null);
    setMessages([]);
    setThinkingStep(-1);
    setIsProcessing(false);
    setChatInput("");
    setErrorMsg(null);
    setVoiceOpen(false);
  };

  /**
   * Handles voice transcription events from the VoiceAgent.
   * Pipes spoken conversation into the main chat as regular message bubbles.
   * @param {"user"|"ai"} role - Who is speaking.
   * @param {string} text - The transcript text.
   */
  const handleVoiceTranscript = useCallback((role, text) => {
    if (!text || !text.trim()) return;

    if (role === "user") {
      // Each user utterance creates a new bubble
      const userMsg = { role: "user", text: text.trim(), id: nextMsgId() };
      setMessages((prev) => [...prev, userMsg]);
      // Reset so next AI response creates a fresh bubble
      voiceAiMsgIdRef.current = null;
    } else if (role === "ai") {
      // AI text streams in chunks — append to the current AI bubble
      if (!voiceAiMsgIdRef.current) {
        const aiId = nextMsgId();
        voiceAiMsgIdRef.current = aiId;
        setMessages((prev) => [...prev, { role: "ai", text: text, id: aiId }]);
      } else {
        const currentId = voiceAiMsgIdRef.current;
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === currentId ? { ...msg, text: msg.text + text } : msg
          )
        );
      }
    }
  }, []);

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F0F0F0] font-sans flex flex-col">
      {/* ═══ NAVIGATION ═══════════════════════════════════════ */}
      <nav className="w-full border-b border-[#BC13FE]/10 bg-[#0A0A0A]/90 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          {/* Left: Logo + Brand */}
          <div className="flex items-center gap-3">
            <ArchytechLogo className="w-7 h-7" />
            <div className="hidden sm:block">
              <span className="text-sm font-bold tracking-wide text-[#F0F0F0]">{t.brand}</span>
              <span className="text-xs text-[#555] ml-2 font-mono">| {t.subtitle}</span>
            </div>
          </div>

          {/* Center: Status Indicators */}
          <div className="hidden md:flex items-center gap-6 text-xs font-mono text-[#555]">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span>{t.systemOnline}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Activity className="w-3 h-3 text-[#BC13FE]" />
              <span>{t.latency}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Database className="w-3 h-3 text-[#FFD700]" />
              <span>{t.vectorReady}</span>
            </div>
          </div>

          {/* Right: Language Switcher + Step */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setLang(lang === "en" ? "es" : "en")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#BC13FE]/20 text-xs font-mono text-[#8A8A8A] hover:text-[#BC13FE] hover:border-[#BC13FE]/50 transition-all duration-300 cursor-pointer"
              aria-label="Toggle language"
            >
              <Globe className="w-3.5 h-3.5" />
              {lang === "en" ? "ES" : "EN"}
            </button>
            <div className="flex gap-1">
              {[1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={`h-1.5 w-8 rounded-full transition-all duration-500 ${
                    step >= s ? "bg-[#BC13FE] shadow-[0_0_8px_rgba(188,19,254,0.5)]" : "bg-[#1A1A1A]"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      </nav>

      {/* ═══ ERROR BANNER ═══════════════════════════════════════ */}
      <AnimatePresence>
        {errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm" role="alert">
              <span>{errorMsg}</span>
              <button
                onClick={() => setErrorMsg(null)}
                className="p-0.5 hover:text-red-300 transition-colors cursor-pointer"
                aria-label="Dismiss error"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ MAIN CONTENT ═════════════════════════════════════ */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        <AnimatePresence mode="wait">
          {/* ─── STEP 1: UPLOAD ─────────────────────────────── */}
          {step === 1 && (
            <motion.div
              key="step1"
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="grid grid-cols-1 lg:grid-cols-5 gap-6 min-h-[70vh] items-center"
            >
              {/* Left: Upload Zone */}
              <motion.div variants={itemVariants} className="lg:col-span-3">
                <div className="mb-6">
                  <h1 className="text-3xl sm:text-4xl font-bold mb-2">
                    <span className="text-[#BC13FE] glow-purple-text">{t.brand}</span>{" "}
                    <span className="text-[#555] font-light">{t.subtitle}</span>
                  </h1>
                  <p className="text-sm text-[#555] font-mono">{t.tagline}</p>
                </div>

                <label
                  htmlFor="file-upload"
                  className="block w-full glass-panel p-10 sm:p-14 text-center cursor-pointer hover:border-[#BC13FE]/40 transition-all duration-500 group relative overflow-hidden"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleFileUpload}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-[#BC13FE]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                  <div className="relative z-10">
                    <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-[#BC13FE]/10 flex items-center justify-center group-hover:bg-[#BC13FE]/20 transition-colors duration-300">
                      <UploadCloud className="w-8 h-8 text-[#BC13FE]" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2 text-[#F0F0F0]">{t.uploadTitle}</h3>
                    <p className="text-sm text-[#555] mb-6 max-w-md mx-auto">{t.uploadDesc}</p>
                    <div className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-[#BC13FE] text-white text-sm font-medium hover:bg-[#a30de0] transition-colors duration-300 shadow-[0_0_20px_rgba(188,19,254,0.3)]">
                      {t.browseFiles}
                      <ChevronRight className="w-4 h-4" />
                    </div>
                    <p className="text-xs text-[#333] mt-4 font-mono">{t.dropZoneHint}</p>
                  </div>
                  <input
                    id="file-upload"
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                </label>
              </motion.div>

              {/* Right: 3D Core */}
              <motion.div variants={itemVariants} className="lg:col-span-2 h-[300px] sm:h-[400px]">
                <div className="h-full glass-panel-sm relative overflow-hidden">
                  <CoreScene isActive={false} />
                  <div className="absolute bottom-4 left-4 right-4 text-center">
                    <p className="text-xs font-mono text-[#555]">{t.coreLabel}</p>
                    <p className="text-[10px] font-mono text-[#333]">{t.coreStatus}</p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}

          {/* ─── STEP 2: PROCESSING ────────────────────────── */}
          {step === 2 && (
            <motion.div
              key="step2"
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="grid grid-cols-1 lg:grid-cols-5 gap-6 min-h-[70vh] items-center"
            >
              {/* Left: File Info + Deploy */}
              <motion.div variants={itemVariants} className="lg:col-span-3">
                <div className="glass-panel p-8 sm:p-10">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 rounded-xl bg-[#FFD700]/10 flex items-center justify-center">
                      <FileText className="w-6 h-6 text-[#FFD700]" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold">{t.processingTitle}</h3>
                      <p className="text-xs text-[#555] font-mono">{file?.name}</p>
                    </div>
                  </div>

                  <p className="text-sm text-[#8A8A8A] mb-6">{t.processingDesc}</p>

                  {/* Thinking Steps */}
                  {isProcessing && (
                    <div className="mb-6 p-4 rounded-xl bg-[#0A0A0A]/80 border border-[#BC13FE]/10">
                      <div className="flex items-center gap-2 mb-3">
                        <Terminal className="w-3.5 h-3.5 text-[#BC13FE]" />
                        <span className="text-xs font-mono text-[#BC13FE]">RAG Pipeline</span>
                      </div>
                      <ThinkingSteps
                        steps={[t.thinkStep1, t.thinkStep2, t.thinkStep3, t.thinkStep4]}
                        currentStep={thinkingStep}
                      />
                    </div>
                  )}

                  <button
                    onClick={processDocument}
                    disabled={isProcessing}
                    className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer
                      bg-gradient-to-r from-[#BC13FE] to-[#8B0FBF] text-white hover:from-[#a30de0] hover:to-[#7a0da8]
                      disabled:opacity-50 disabled:cursor-not-allowed
                      shadow-[0_0_30px_rgba(188,19,254,0.2)] hover:shadow-[0_0_40px_rgba(188,19,254,0.35)]"
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {t.processingBtn}
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4" />
                        {t.deployBtn}
                      </>
                    )}
                  </button>
                </div>
              </motion.div>

              {/* Right: 3D Core (active) */}
              <motion.div variants={itemVariants} className="lg:col-span-2 h-[300px] sm:h-[400px]">
                <div className="h-full glass-panel-sm relative overflow-hidden">
                  <CoreScene isActive={isProcessing} />
                  <div className="absolute bottom-4 left-4 right-4 text-center">
                    <p className="text-xs font-mono text-[#BC13FE] pulse-glow">{t.coreLabel}</p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}

          {/* ─── STEP 3: LIVE DEMO ─────────────────────────── */}
          {step === 3 && (
            <motion.div
              key="step3"
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6"
            >
              {/* Left Panel: Status + Info */}
              <motion.div variants={itemVariants} className="lg:col-span-3 space-y-4">
                {/* Deployed Status */}
                <div className="glass-panel p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-2 h-2 rounded-full bg-[#FFD700] animate-pulse" />
                    <span className="text-sm font-semibold text-[#FFD700]">{t.deployed}</span>
                  </div>
                  <h4 className="text-xs font-mono text-[#555] mb-2">{t.sourcesLoaded}</h4>
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-[#0A0A0A]/60 border border-[#BC13FE]/10">
                    <FileText className="w-3.5 h-3.5 text-[#BC13FE]" />
                    <span className="text-xs text-[#8A8A8A] truncate">{file?.name}</span>
                  </div>
                </div>

                {/* Sales Tip */}
                <div className="glass-panel p-5 border-[#FFD700]/10">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-3.5 h-3.5 text-[#FFD700]" />
                    <span className="text-xs font-bold text-[#FFD700]">{t.tipLabel}</span>
                  </div>
                  <p className="text-xs text-[#555] leading-relaxed">{t.salesTip}</p>
                </div>

                {/* Voice Demo Section */}
                {voiceOpen ? (
                  <VoiceAgent
                    isOpen={voiceOpen}
                    onClose={() => setVoiceOpen(false)}
                    onTranscript={handleVoiceTranscript}
                    lang={lang}
                  />
                ) : (
                  <button
                    onClick={() => setVoiceOpen(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold
                      bg-gradient-to-r from-[#BC13FE] to-[#8B0FBF] text-white
                      hover:from-[#a30de0] hover:to-[#7a0da8] transition-all duration-300
                      shadow-[0_0_20px_rgba(188,19,254,0.2)] hover:shadow-[0_0_30px_rgba(188,19,254,0.4)] cursor-pointer"
                  >
                    <Mic className="w-4 h-4" />
                    {t.voiceBtn}
                  </button>
                )}

                {/* 3D Mini Core */}
                <div className="glass-panel-sm h-[180px] relative overflow-hidden">
                  <CoreScene isActive={true} />
                </div>

                {/* Reset */}
                <button
                  onClick={handleReset}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-mono text-[#555] border border-[#1A1A1A] hover:border-[#BC13FE]/30 hover:text-[#BC13FE] transition-all duration-300 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  {t.startOver}
                </button>
              </motion.div>

              {/* Right Panel: Chat Interface */}
              <motion.div variants={itemVariants} className="lg:col-span-9 flex flex-col h-[75vh] glass-panel overflow-hidden">
                {/* Chat Header */}
                <div className="px-5 py-3.5 border-b border-[#BC13FE]/10 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-[#BC13FE] animate-pulse" />
                    <Cpu className="w-4 h-4 text-[#BC13FE]" />
                    <span className="text-sm font-semibold">{t.chatTitle}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-[#333]">
                    <Braces className="w-3 h-3" />
                    RAG v2.0
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
                  {messages.map((msg) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3 }}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] sm:max-w-[75%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                          msg.role === "user"
                            ? "bg-[#BC13FE] text-white rounded-br-sm"
                            : "bg-[#141414] text-[#D0D0D0] border border-[#BC13FE]/10 rounded-bl-sm"
                        }`}
                      >
                        {msg.text || <span className="typing-cursor text-[#555]" />}
                      </div>
                    </motion.div>
                  ))}
                  <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <form onSubmit={handleChat} className="p-3 sm:p-4 border-t border-[#BC13FE]/10 flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={t.chatPlaceholder}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-[#0A0A0A] border border-[#1A1A1A] text-sm text-[#F0F0F0] placeholder-[#333]
                      focus:outline-none focus:border-[#BC13FE]/50 focus:shadow-[0_0_15px_rgba(188,19,254,0.1)]
                      transition-all duration-300"
                  />
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-xl bg-[#BC13FE] text-white text-sm font-medium
                      hover:bg-[#a30de0] transition-all duration-300 flex items-center gap-2
                      shadow-[0_0_15px_rgba(188,19,254,0.2)] cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{t.sendBtn}</span>
                  </button>
                </form>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* ═══ FOOTER ═══════════════════════════════════════════ */}
      <footer className="w-full border-t border-[#1A1A1A] py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ArchytechLogo className="w-4 h-4" />
            <span className="text-xs font-mono text-[#333]">
              {t.footerBrand} <span className="text-[#BC13FE]/50">|</span> {t.footerDiv}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-mono text-[#333]">
            <div className="w-1 h-1 rounded-full bg-green-600" />
            {t.footerRight}
          </div>
        </div>
      </footer>


    </div>
  );
}
