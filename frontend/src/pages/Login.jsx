import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Eye, EyeOff, LogIn, AlertCircle, Shield, Activity, Bell, Bot, ArrowRight, LogOut } from 'lucide-react';
import toast from 'react-hot-toast';

/* ── Animated background particles ─────────────────────────────────────────── */
function AnimatedBackground() {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId;
    const particles = [];
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 60; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        size: Math.random() * 3 + 2,
        alpha: Math.random() * 0.3 + 0.1,
      });
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(22, 163, 74, ${p.alpha * 0.8})`;
        ctx.fill();
      });
      // Draw connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 200) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(22, 163, 74, ${0.25 * (1 - dist / 200)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
      animId = requestAnimationFrame(draw);
    }
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />;
}

/* ── Capabilities ticker (no figures) ─────────────────────────────────────── */
function LiveTicker() {
  const items = ['Revenue Monitoring', 'Target Management', 'Goal Cascading', 'Action Notes', 'VAS AI Assistant', 'Executive Reports', 'Staff Feedback', 'Secure Access'];
  return (
    <div className="flex gap-8 overflow-hidden">
      {[...items, ...items].map((item, i) => (
        <div key={i} className="flex items-center gap-8 whitespace-nowrap text-xs font-semibold">
          <span className="text-gray-600">{item}</span>
          <span className="text-green-300">•</span>
        </div>
      ))}
    </div>
  );
}

/* ── Feature tile for left panel (functional, no numbers) ─────────────────── */
function FeatureTile({ icon: Icon, title, desc, lightBg, textColor }) {
  return (
    <div className="bg-white/80 backdrop-blur rounded-xl border border-green-100 p-4 hover:shadow-md hover:border-green-200 transition-all duration-300">
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-lg ${lightBg} flex items-center justify-center shrink-0`}>
          <Icon size={20} className={textColor} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900">{title}</p>
          <p className="text-xs text-gray-500 leading-snug mt-0.5">{desc}</p>
        </div>
      </div>
    </div>
  );
}

/* ── Pulse ring animation ──────────────────────────────────────────────────── */
function PulseRing() {
  return (
    <div className="relative">
      <div className="absolute inset-0 bg-green-500 rounded-full animate-ping opacity-20" />
      <div className="absolute inset-1 bg-green-500 rounded-full animate-pulse opacity-40" />
      <div className="relative w-3 h-3 bg-green-500 rounded-full" />
    </div>
  );
}

/* ── Section picker shown when a user can reach more than one section ─────── */
const SECTION_OPTIONS = {
  VAS: {
    label: 'VAS Section',
    desc: 'Dashboard, Revenue, Targets, Services, Reports',
    accent: 'from-green-600 to-emerald-600',
    dot: 'bg-green-500',
    hover: 'hover:border-green-400 hover:shadow-green-100',
    text: 'text-green-600',
  },
  INDIRECT_CHANNEL: {
    label: 'Indirect Channel',
    desc: 'Channel Dashboard, Batch & Single Import, Channel Reports',
    accent: 'from-blue-600 to-indigo-600',
    dot: 'bg-blue-500',
    hover: 'hover:border-blue-400 hover:shadow-blue-100',
    text: 'text-blue-600',
  },
};

function SectionChooser({ user, error, choosing, onChoose, onSignOut }) {
  const sections = user?.available_sections || [];

  return (
    <div className="min-h-screen bg-white relative overflow-hidden flex items-center justify-center p-6">
      <AnimatedBackground />
      <div className="relative z-10 w-full max-w-2xl">
        <div className="text-center mb-8">
          <img src="/ethio-telecom-logo.png" alt="Ethio Telecom" className="h-12 mx-auto mb-4" />
          <h1 className="text-2xl font-black text-gray-900">Choose Your Section</h1>
          <p className="text-sm text-gray-500 mt-1">
            Welcome back{user?.full_name ? `, ${user.full_name.split(' ')[0]}` : ''} — your account can access more
            than one section. Pick the one you want to work in.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-6 flex items-center gap-2 text-sm">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-4">
          {sections.map((section) => {
            const opt = SECTION_OPTIONS[section] || {
              label: section,
              desc: 'Open this section',
              accent: 'from-gray-600 to-gray-700',
              dot: 'bg-gray-400',
              hover: 'hover:border-gray-400 hover:shadow-gray-100',
              text: 'text-gray-600',
            };
            const busy = choosing === section;
            return (
              <button
                key={section}
                type="button"
                onClick={() => onChoose(section)}
                disabled={!!choosing}
                className={`group text-left bg-white rounded-2xl border-2 border-gray-200 p-6 shadow-lg transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${opt.hover}`}
              >
                <div className={`w-11 h-11 rounded-xl bg-gradient-to-r ${opt.accent} flex items-center justify-center mb-4`}>
                  <Shield size={20} className="text-white" />
                </div>
                <p className="font-bold text-gray-900 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${opt.dot}`} />
                  {opt.label}
                </p>
                <p className="text-xs text-gray-500 mt-1 leading-snug">{opt.desc}</p>
                <p className={`mt-4 text-xs font-semibold inline-flex items-center gap-1 ${opt.text}`}>
                  {busy ? 'Entering…' : 'Enter section'}
                  <ArrowRight size={12} className="group-hover:translate-x-0.5 transition-transform" />
                </p>
              </button>
            );
          })}
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          You can switch to the other section any time from the header.
        </p>
        <div className="text-center mt-3">
          <button
            type="button"
            onClick={onSignOut}
            disabled={!!choosing}
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-green-600 transition disabled:opacity-50"
          >
            <LogOut size={12} /> Sign in as someone else
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Login Component ──────────────────────────────────────────────────── */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [choosing, setChoosing] = useState(null);
  const { login, logout, pendingSectionChoice, chooseSection, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(email, password);
      toast.success('Welcome back!');
      // Multi-section accounts pick where to go first — the page switches to the
      // chooser and navigate() happens once a section is selected. The master admin
      // (GLOBAL scope) administers every section and is never asked.
      if (data.user.role_scope !== 'GLOBAL'
        && Array.isArray(data.user.available_sections) && data.user.available_sections.length > 1) return;
      navigate(data.user.role_scope === 'GLOBAL'
        ? '/admin/users'
        : data.user.section === 'INDIRECT_CHANNEL' ? '/channel' : '/dashboard');
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleChoose = async (section) => {
    setError('');
    setChoosing(section);
    try {
      await chooseSection(section);
      toast.success(section === 'INDIRECT_CHANNEL' ? 'Entering Indirect Channel' : 'Entering VAS Section');
      navigate(section === 'INDIRECT_CHANNEL' ? '/channel' : '/dashboard');
    } catch (err) {
      setError(err.message || 'Could not open that section');
    } finally {
      setChoosing(null);
    }
  };

  if (pendingSectionChoice && user) {
    return (
      <SectionChooser
        user={user}
        error={error}
        choosing={choosing}
        onChoose={handleChoose}
        onSignOut={() => { logout(); setError(''); }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-white flex relative overflow-hidden">
      <AnimatedBackground />

      {/* Left Panel — Branding & Stats */}
      <div className="hidden lg:flex lg:w-1/2 relative z-10 flex-col justify-between p-10">
        <div>
          {/* Logo */}
          <div className="flex items-center gap-3 mb-16">
            <img src="/ethio-telecom-logo.png" alt="Ethio Telecom" className="h-12" />
            <div className="w-px h-8 bg-gray-300" />
            <div>
              <h2 className="text-gray-900 font-bold text-lg tracking-wide">Ethio Telecom</h2>
              <p className="text-green-600 text-xs tracking-widest uppercase">VAS Section</p>
            </div>
          </div>

          {/* Title */}
          <h1 className="text-5xl font-black text-gray-900 leading-tight mb-4">
            <span className="block">VAS</span>
            <span className="block bg-gradient-to-r from-green-600 to-emerald-500 bg-clip-text text-transparent">
              Performance
            </span>
            <span className="block text-3xl text-gray-500 font-light mt-2">Tracker</span>
          </h1>
          <p className="text-gray-500 text-sm max-w-md leading-relaxed mb-10">
            Real-time monitoring system for Value Added Services revenue tracking,
            target management, and performance analytics across Ethio Telecom.
          </p>

          {/* Capabilities */}
          <div className="grid grid-cols-2 gap-3 max-w-lg">
            <FeatureTile icon={Activity} title="Real-Time Monitoring" desc="Live tracking across every VAS service" lightBg="bg-green-50" textColor="text-green-700" />
            <FeatureTile icon={Bell} title="Revenue Alerts" desc="Critical, warning & on-track statuses" lightBg="bg-blue-50" textColor="text-blue-700" />
            <FeatureTile icon={Bot} title="VAS AI Assistant" desc="Ask anything, get instant insights" lightBg="bg-emerald-50" textColor="text-emerald-700" />
            <FeatureTile icon={Shield} title="Secure by Design" desc="Role-based access & full audit trail" lightBg="bg-amber-50" textColor="text-amber-700" />
          </div>
        </div>

        {/* Bottom ticker */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <PulseRing />
            <span className="text-xs text-green-600 font-medium">LIVE MONITORING</span>
          </div>
          <div className="flex-1 overflow-hidden opacity-50">
            <LiveTicker />
          </div>
        </div>
      </div>

      {/* Right Panel — Login Form */}
      <div className="w-full lg:w-1/2 relative z-10 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          {/* Mobile Logo */}
          <div className="lg:hidden text-center mb-8">
            <img src="/ethio-telecom-logo.png" alt="Ethio Telecom" className="h-12 mx-auto mb-4" />
            <h1 className="text-2xl font-black text-gray-900">VAS Performance Tracker</h1>
          </div>

          {/* Login Card */}
          <div className="bg-white rounded-2xl border border-gray-200 p-8 shadow-2xl">
            {/* Header */}
            <div className="mb-8">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center">
                  <LogIn size={16} className="text-green-600" />
                </div>
                <span className="text-xs text-green-600 font-medium tracking-wider uppercase">Login</span>
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Welcome Back</h2>
              <p className="text-sm text-gray-500">Sign in to access your VAS monitoring dashboard</p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-6 flex items-center gap-2 text-sm">
                <AlertCircle size={18} />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Email */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-2 uppercase tracking-wider">Email or Username</label>
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
                  placeholder="admin@ethiotelecom.et"
                  required
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-2 uppercase tracking-wider">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
                    placeholder="Enter your password"
                    required
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {/* Forgot Password */}
              <div className="flex items-center justify-end">
                <Link to="/forgot-password" className="text-sm text-green-600 hover:text-green-700 font-medium transition">
                  Forgot password?
                </Link>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-semibold py-3.5 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-green-500/25"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <LogIn size={18} />
                    Sign In
                  </>
                )}
              </button>
            </form>

            {/* Footer */}
            <div className="mt-6 pt-6 border-t border-gray-100 text-center">
              <div className="flex items-center justify-center gap-2">
                <PulseRing />
                <span className="text-xs text-gray-500">System Status: <span className="text-green-600 font-medium">Operational</span></span>
              </div>
            </div>
          </div>

          {/* Time */}
          <div className="mt-6 text-center">
            <p className="text-xs text-gray-400 font-mono">
              {currentTime.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              {' '}
              {currentTime.toLocaleTimeString('en-US', { hour12: false })}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
