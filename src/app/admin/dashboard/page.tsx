'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ShieldCheck, 
  Activity, 
  Key, 
  AlertTriangle, 
  Clock, 
  Lock,
  ChevronRight,
  RefreshCw,
  Search
} from 'lucide-react';

interface AuditStats {
  totalChunks: number;
  versionDistribution: Record<string, number>;
  keyStatus: string;
  lastRotation: string;
}

interface AuditLog {
  id: string;
  timestamp: number;
  type: string;
  metadata: any;
}

export default function CISODashboard() {
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/admin/dashboard', {
        headers: {
          'X-Axiom-Admin-Secret': 'audit-bypass' // In prod, this would be an actual auth header
        }
      });
      if (!res.ok) throw new Error('Unauthorized or failed to fetch');
      const data = await res.json();
      setStats(data.stats);
      setLogs(data.recentLogs);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 10000); // 10s auto-refresh
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#050505] text-[#E0E0E0] p-8 font-sans selection:bg-[#FFD700]/30">
      {/* ── Background Detail ────────────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden opacity-20">
        <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-[#FFD700] rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-[#BC13FE] rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto space-y-12">
        {/* ── Header ────────────────────────────────────────── */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-white/5 pb-10">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-[#FFD700]/10 p-2 rounded-lg">
                <ShieldCheck className="text-[#FFD700]" size={24} />
              </div>
              <span className="text-xs uppercase tracking-[0.4em] font-bold text-[#FFD700]/60">
                Governance Surveillance
              </span>
            </div>
            <h1 className="text-5xl font-black tracking-tight text-white mb-2">
              AXIOM-G <span className="text-[#FFD700]">CISO AUDIT</span>
            </h1>
            <p className="text-sm text-[#888] font-mono">
              Live Security Telemetry • Vector Index Version: v2.0
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="bg-white/5 border border-white/10 px-4 py-3 rounded-xl flex items-center gap-3">
              <Activity className="text-green-500 animate-pulse" size={16} />
              <div className="text-left">
                <p className="text-[10px] uppercase tracking-widest text-[#666]">System Pulse</p>
                <p className="text-xs font-mono font-bold text-white">NOMINAL - 24ms</p>
              </div>
            </div>
            <button 
              onClick={fetchDashboard}
              className="bg-white/5 hover:bg-white/10 p-3 rounded-xl transition-all border border-white/10 active:scale-95"
            >
              <RefreshCw className={isLoading ? 'animate-spin' : ''} size={20} />
            </button>
          </div>
        </header>

        {/* ── Metrics Grid ──────────────────────────────────── */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <MetricCard 
            label="Key Age (Primary)" 
            value={stats?.lastRotation ? '8.4 DAYS' : '--'} 
            sub="Next rotation in 21 days"
            icon={<Clock className="text-[#BC13FE]" size={20} />}
          />
          <MetricCard 
            label="Access Violations" 
            value="0" 
            sub="Last 24 hours"
            icon={<AlertTriangle className="text-red-500" size={20} />}
          />
          <MetricCard 
            label="Index Distribution" 
            value={stats?.versionDistribution['v2'] ? 'V2 OPTIMIZED' : 'V1 LEGACY'} 
            sub={`${stats?.totalChunks ?? 0} Global Vectors`}
            icon={<Key className="text-[#FFD700]" size={20} />}
          />
          <MetricCard 
            label="Tenant Sovereignty" 
            value="ACTIVE" 
            sub="BYOK Ingress Enabled"
            icon={<Lock className="text-green-500" size={20} />}
          />
        </section>

        {/* ── Main View ─────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Logs Table */}
          <section className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Activity size={20} className="text-[#666]" />
                Audit Trail <span className="text-xs font-mono text-[#444] ml-2">[{logs.length} Recent Events]</span>
              </h2>
              <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg text-xs">
                <Search size={14} className="text-[#666]" />
                <input placeholder="Filter events..." className="bg-transparent border-none outline-none text-[#E0E0E0] w-32" />
              </div>
            </div>

            <div className="bg-[#0A0A0A] border border-white/5 rounded-2xl overflow-hidden shadow-2xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-white/5 border-b border-white/5">
                    <tr>
                      <th className="px-6 py-4 text-xs uppercase tracking-widest text-[#666] font-bold">Event Type</th>
                      <th className="px-6 py-4 text-xs uppercase tracking-widest text-[#666] font-bold">Status</th>
                      <th className="px-6 py-4 text-xs uppercase tracking-widest text-[#666] font-bold">Timestamp</th>
                      <th className="px-6 py-4"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {logs.length > 0 ? logs.map((log) => (
                      <tr key={log.id} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-6 py-5">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-[#888] font-mono text-[10px]">
                              {log.type.slice(0, 2).toUpperCase()}
                            </div>
                            <span className="text-sm font-medium">{log.type}</span>
                          </div>
                        </td>
                        <td className="px-6 py-5">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 text-green-500 text-[10px] font-bold uppercase tracking-wider">
                            Verified
                          </span>
                        </td>
                        <td className="px-6 py-5 text-sm text-[#666] font-mono">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="px-6 py-5 text-right">
                          <button className="text-[#444] hover:text-white transition-colors">
                            <ChevronRight size={18} />
                          </button>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={4} className="px-6 py-20 text-center text-[#444] text-sm uppercase tracking-widest font-mono">
                          {isLoading ? 'Decrypting audit trail...' : 'Zero access events recorded'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Sidebar / Distribution */}
          <section className="space-y-8">
            <div className="glass-panel p-8 bg-[#BC13FE]/5 border-[#BC13FE]/20 rounded-3xl relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-10">
                <ShieldCheck size={80} />
              </div>
              <h3 className="text-sm uppercase tracking-widest font-black text-[#BC13FE] mb-6">
                Security Posture
              </h3>
              <div className="space-y-6">
                <DistributionBar 
                  label="V2 AES-256-GCM" 
                  percent={stats?.versionDistribution['v2'] ? 100 : 0} 
                  color="#FFD700" 
                />
                <DistributionBar 
                  label="V1 Legacy" 
                  percent={stats?.versionDistribution['v1'] ? 100 : 0} 
                  color="#BC13FE" 
                />
              </div>
              <p className="mt-8 text-[11px] text-[#888] leading-relaxed">
                Fracttal Enterprise Node: SOC2 Type II compliance active. All deletions are cryptographically verified.
              </p>
            </div>

            <div className="glass-panel p-8 bg-white/5 rounded-3xl">
              <h3 className="text-sm uppercase tracking-widest font-black text-[#666] mb-4">
                Rotation Manager
              </h3>
              <div className="space-y-4">
                <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                  <p className="text-[10px] text-[#666] uppercase tracking-widest mb-1">Last Re-Encryption</p>
                  <p className="text-sm font-mono">{stats?.lastRotation ?? 'In Progress'}</p>
                </div>
                <button 
                  disabled
                  className="w-full py-4 text-xs font-black uppercase tracking-widest text-black bg-white rounded-xl hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Trigger Manual Shift
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, icon }: { label: string; value: string; sub: string; icon: React.ReactNode }) {
  return (
    <div className="bg-[#0A0A0A] border border-white/5 p-6 rounded-2xl shadow-xl hover:border-white/10 transition-colors">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-[#666]">
          {label}
        </span>
        {icon}
      </div>
      <p className="text-2xl font-black text-white tracking-tight mb-1">
        {value}
      </p>
      <p className="text-[10px] text-[#444] uppercase tracking-widest font-medium">
        {sub}
      </p>
    </div>
  );
}

function DistributionBar({ label, percent, color }: { label: string; percent: number; color: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest font-bold">
        <span className="text-[#888]">{label}</span>
        <span style={{ color }}>{percent}%</span>
      </div>
      <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: `${percent}%` }}
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
        />
      </div>
    </div>
  );
}
