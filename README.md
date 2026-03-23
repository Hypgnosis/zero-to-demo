# Reshapex — Zero-to-Demo RAG Engine

> **Enterprise-grade autonomous RAG deployment system.**  
> Upload a PDF catalog and spawn a live AI sales agent in under 30 seconds.  
> Built by [High ArchyTech Solutions](https://higharchytech.com).

![Reshapex Dashboard](public/ha-logo.png)

---

## ✨ Features

- **📄 PDF Upload & Vectorization** — Drag & drop any product catalog, auto-chunked and embedded via Google Gemini
- **🤖 Live RAG Chat Agent** — Streamed AI responses grounded in your uploaded documents
- **🌐 Bilingual (EN/ES)** — One-click language toggle with full i18n support
- **🎨 Premium Design** — Obsidian dark theme, glassmorphism, cyber purple/amber gold palette
- **🔮 3D Visualizer** — React Three Fiber octahedron with `meshPhysicalMaterial`, real-time animations
- **⚡ Thinking Steps** — Animated RAG pipeline visualization (parse → embed → index → deploy)
- **🧪 42 Tests / 89%+ Coverage** — Full TDD with Vitest + React Testing Library

---

## 🚀 Quick Start

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
# Edit .env.local and replace your_google_api_key_here with your real key

# 4. Run the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard.

---

## 🔐 Security

> **⚠️ NEVER commit `.env.local` to version control.**

The `.gitignore` is configured to block **all** `.env*` files except `.env.example` (which contains only placeholder values). Your Gemini API key stays local.

| File | Contains Secrets? | Committed? |
|------|:-:|:-:|
| `.env.local` | ✅ Yes | ❌ **Never** |
| `.env.example` | ❌ Placeholders only | ✅ Yes |

---

## 📁 Project Structure

```
src/
├── app/
│   ├── page.jsx          # Main dashboard (upload → process → chat)
│   ├── layout.jsx         # Root layout with SEO metadata
│   ├── globals.css        # Design system (CSS variables, glassmorphism)
│   └── api/
│       ├── chat/route.js  # RAG chat endpoint (streaming)
│       └── upload/route.js # PDF upload & vectorization
├── lib/
│   └── vectorStore.js     # In-memory vector store singleton
└── __tests__/             # 42 tests across 4 test files
```

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage report
npm run test:coverage
```

**Coverage thresholds (enforced):** 80% statements, branches, functions, and lines.

---

## 🏗️ Production Build

```bash
npm run build
npm start
```

---

## 🌐 Deploy on Vercel

1. Push to GitHub
2. Import the repo on [Vercel](https://vercel.com/new)
3. Add `GOOGLE_API_KEY` as an environment variable in the Vercel dashboard
4. Deploy — done!

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| 3D | React Three Fiber + Drei |
| Animations | Framer Motion |
| AI/RAG | LangChain + Google Gemini |
| Styling | Tailwind CSS 4 |
| Testing | Vitest + React Testing Library |
| Icons | Lucide React |

---

## 📄 License

Proprietary — High ArchyTech Solutions. All rights reserved.
