import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Reshapex | Zero-to-Demo RAG Engine — High ArchyTech Solutions",
  description:
    "Enterprise-grade autonomous RAG deployment system. Upload a PDF catalog and spawn a live AI sales agent in under 30 seconds. Built by High ArchyTech Solutions.",
  keywords: ["RAG", "AI agent", "PDF chatbot", "industrial OEM", "autonomous systems"],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
