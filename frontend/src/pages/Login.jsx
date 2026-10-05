import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import PuzzleCaptcha from '../components/PuzzleCaptcha';
import { Eye, EyeOff, LogIn, AlertCircle, Shield, ArrowRight, LogOut, Mail, Lock } from 'lucide-react';
import toast from 'react-hot-toast';

/* ── Animated background mesh (faint green nodes/lines on white) ───────────── */
/* Sizes to its container so it works full-page or panel-wide.                  */
function AnimatedBackground() {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId;
    const particles = [];
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width || window.innerWidth));
      canvas.height = Math.max(1, Math.round(rect.height || window.innerHeight));
    };
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
  const [captchaKey, setCaptchaKey] = useState(0);
  const captchaAnswerRef = useRef(null);
  const { login, logout, pendingSectionChoice, chooseSection, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const cap = captchaAnswerRef.current;
    if (!cap) {
      setError('Please complete the security puzzle first');
      setCaptchaKey(k => k + 1);
      return;
    }
    setLoading(true);
    try {
      const data = await login(email, password, cap);
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
      // A failed attempt consumes the puzzle (server-side one-shot) — always get
      // a fresh one so the retry can never reuse a spent challenge.
      setCaptchaKey(k => k + 1);
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
    <div className="min-h-screen bg-white flex justify-center relative overflow-hidden p-4 sm:p-6">
      {/* Logo — top-left corner (md+ only; mobile shows it above the wordmark) */}
      <div className="hidden md:block absolute top-5 left-5 sm:top-7 sm:left-8 z-10">
        <img src="/ethio-telecom-logo.png" alt="Ethio Telecom" className="h-10 sm:h-11" />
      </div>

      {/* Faint animated mesh on white */}
      <AnimatedBackground />

      {/* Centered login column — m-auto centers when it fits, top-aligns when tall */}
      <div className="w-full max-w-3xl relative z-10 m-auto">
        {/* Brand header */}
        <div className="text-center mb-8 login-fade-up">
          <img src="/ethio-telecom-logo.png" alt="Ethio Telecom" className="h-12 mx-auto mb-4 md:hidden" />
          <h1 className="text-2xl font-black text-gray-900 leading-tight">
            VAS{' '}
            <span className="bg-gradient-to-r from-green-600 to-emerald-500 bg-clip-text text-transparent">
              Performance
            </span>{' '}
            <span className="text-gray-400">Tracker</span>
          </h1>
          <p className="text-[11px] text-gray-400 mt-1.5 tracking-[0.2em] uppercase">Ethio Telecom — VAS Section</p>
        </div>

        {/* Login Card — split: credentials left, security check right */}
        <div className="relative bg-white/85 backdrop-blur-xl rounded-3xl border border-gray-100 ring-1 ring-gray-100 shadow-2xl shadow-green-900/10 overflow-hidden login-fade-up-late">
          <div className="absolute top-0 inset-x-10 h-px bg-gradient-to-r from-transparent via-green-400/70 to-transparent" />

          <form onSubmit={handleSubmit} className="md:grid md:grid-cols-[1fr_18rem]">
            {/* Left — credentials */}
            <div className="p-8 sm:p-10 md:pb-3">
              <div className="mb-8">
                <div className="inline-flex items-center gap-2.5 mb-4 bg-green-50 border border-green-100 rounded-full pl-1.5 pr-3.5 py-1.5">
                  <div className="w-6 h-6 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center shadow-sm shadow-green-500/40">
                    <LogIn size={13} className="text-white" />
                  </div>
                  <span className="text-[11px] text-green-700 font-bold tracking-[0.15em] uppercase">Secure Login</span>
                </div>
                <h2 className="text-[28px] leading-8 font-extrabold text-gray-900 mb-1.5">Welcome Back</h2>
                <p className="text-sm text-gray-500">Sign in to access your VAS monitoring dashboard</p>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-6 flex items-center gap-2 text-sm">
                  <AlertCircle size={18} />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-5">
                {/* Email */}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Email or Username</label>
                  <div className="relative">
                    <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      name="username"
                      autoComplete="username"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
                      placeholder="admin@ethiotelecom.et"
                      required
                      className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 text-sm focus:bg-white focus:ring-2 focus:ring-green-500/70 focus:border-green-500 outline-none transition-all"
                    />
                  </div>
                </div>

                {/* Password */}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Password</label>
                  <div className="relative">
                    <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      name="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
                      placeholder="Enter your password"
                      required
                      className="w-full pl-10 pr-12 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 text-sm focus:bg-white focus:ring-2 focus:ring-green-500/70 focus:border-green-500 outline-none transition-all"
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
              </div>
            </div>

            {/* Right — security check panel (stacked below credentials on small screens) */}
            <div className="mt-6 md:mt-0 md:col-start-2 md:row-start-1 md:row-span-2 border-t md:border-t-0 md:border-l border-green-100/70 bg-gradient-to-b from-green-50/90 to-emerald-50/50 px-6 py-8 flex flex-col items-center justify-center">
              <div className="w-full">
                <PuzzleCaptcha answerRef={captchaAnswerRef} refreshKey={captchaKey} />
              </div>
              <p className="text-[11px] text-gray-400 text-center mt-4 leading-snug max-w-[15rem]">
                One quick puzzle keeps automated bots out of the system.
              </p>
            </div>

            {/* Left — submit */}
            <div className="px-8 sm:px-10 pb-8 sm:pb-10 md:pt-3 md:col-start-1 md:row-start-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-semibold py-3.5 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-green-600/30 hover:shadow-xl hover:shadow-green-600/40 hover:-translate-y-0.5 active:translate-y-0"
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
            </div>
          </form>

          {/* Footer */}
          <div className="border-t border-gray-100 px-8 sm:px-10 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
              </span>
              <span className="text-xs text-gray-500">System Status: <span className="text-green-600 font-semibold">Operational</span></span>
            </div>
            <span className="text-[10px] text-gray-400 font-medium tracking-wide uppercase">Ethio Telecom VAS</span>
          </div>
        </div>

        {/* Time */}
        <div className="mt-6 text-center">
          <p className="text-[11px] text-gray-400 font-mono">
            {currentTime.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            {' '}
            {currentTime.toLocaleTimeString('en-US', { hour12: false })}
          </p>
        </div>
      </div>
    </div>
  );
}
