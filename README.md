# ⚡ Project Zero-to-Demo

### The High ArchyTech Sales Velocity Engine

---

## 🎯 Executive Overview

**Project Zero-to-Demo** is a high-performance, internal RAG (Retrieval-Augmented Generation) engine engineered to eliminate **"Time-to-Demo"** friction in Enterprise AI sales cycles. Designed specifically for the **Reshapex** ecosystem, this application allows sales representatives to instantly transform complex industrial PDFs (catalogs, RFPs, BOMs) into live, conversational agents in **under 5 minutes**.

---

## 🛠 Technical Architecture

We have prioritized **Middleware Elimination** and **Millisecond Load Times** to ensure a frictionless user experience.

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js (App Router) + Tailwind CSS | Streamlined, drag-and-drop interface |
| **Orchestration** | LangChain | Sophisticated document chunking and context injection |
| **Vector Engine** | Stateless In-Memory Vector Store (`globalThis`) | Zero-dependency embedding storage |
| **Inference** | Google Gemini (`gemini-1.5-flash`) | Cost-effective, high-speed technical retrieval |
| **Ingestion** | `pdf-parse` | Deterministic text extraction from complex industrial schematics |
| **3D Visualization** | React Three Fiber + Drei | Premium interactive command center aesthetic |

---

## 🛡 Security: Zero-Retention Architecture

This application is built with an **Ephemeral Data Policy**. Unlike standard RAG implementations that require persistent third-party databases (e.g., Pinecone), Project Zero-to-Demo processes data **entirely in-memory**.

- **Non-Persistent** — All vector embeddings are stored in volatile memory and are purged upon session termination.
- **Privacy-First** — This architecture ensures that sensitive, proprietary industrial data is never stored on external servers, providing a **"Zero-Leakage"** guarantee for enterprise prospects.

---

## 🚀 Sales Impact

- **Reclaim Engineering Hours** — Transitions the demo process from a "Dev-Heavy" task to a **"Sales-Led"** activity.
- **Eliminate Overhead** — Bypasses expensive infrastructure subscriptions through custom, proprietary code.
- **Deterministic Accuracy** — Utilizes a specialized "Industrial Oracle" system prompt to ensure **zero hallucinations** in technical environments.

---

## ⚙️ Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Google Gemini API Key](https://aistudio.google.com/apikey)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/reshapex-zero-to-demo.git
cd reshapex-zero-to-demo

# 2. Install dependencies
npm install

# 3. Configure your API key
cp .env.example .env.local
# Edit .env.local and replace the placeholder with your real Gemini key

# 4. Run the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to launch the command center.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm start` | Serve production build |
| `npm test` | Run all 42 tests |
| `npm run test:coverage` | Run tests with coverage report (89%+ enforced) |

---

## 🔐 Environment Security

> ⚠️ **NEVER commit `.env.local` to version control.**

| File | Contains Secrets? | Committed? |
|------|:-:|:-:|
| `.env.local` | ✅ Yes | ❌ **Never** |
| `.env.example` | ❌ Placeholders only | ✅ Yes |

---

## 📁 Project Structure

```
src/
├── app/
│   ├── page.jsx            # Command center (upload → process → chat)
│   ├── layout.jsx           # Root layout with SEO metadata
│   ├── globals.css          # Design system (obsidian, glassmorphism)
│   └── api/
│       ├── chat/route.js    # RAG chat endpoint (streaming)
│       └── upload/route.js  # PDF upload & vectorization
├── lib/
│   └── vectorStore.js       # Ephemeral in-memory vector store singleton
└── __tests__/               # 42 tests across 4 test suites
```

---

## 🌐 Deploy on Vercel

1. Push to GitHub
2. Import the repo on [Vercel](https://vercel.com/new)
3. Add `GOOGLE_API_KEY` as an environment variable in the Vercel dashboard
4. Deploy

---

**High ArchyTech Solutions** — Autonomous Systems Division  
*Proprietary. All rights reserved.*
