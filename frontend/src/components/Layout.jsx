import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { chatAPI, notificationsAPI, alertsAPI } from '../services/api';
import toast from 'react-hot-toast';
import {
  LayoutDashboard,
  Target,
  DollarSign,
  Upload,
  FileBarChart,
  ClipboardList,
  Building2,
  Menu,
  X,
  Users,
  Lightbulb,
  Tag,
  Shield,
  UserCog,
  LogOut,
  ChevronDown,
  Bell,
  MessageSquare,
  MessageCircle,
  Bot,
  BarChart3,
  Eye,
  EyeOff,
  Layers,
  Activity,
  BookOpen,
} from 'lucide-react';

const vasNavItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', permission: 'dashboard.view' },
  { to: '/partners', icon: Users, label: 'Partner Revenue', permission: 'partners.view' },
  { to: '/services', icon: Building2, label: 'VAS Services', permission: 'services.view' },
  { to: '/categories', icon: Tag, label: 'Categories', permission: 'categories.view' },
  { to: '/targets', icon: Target, label: 'Revenue Targets', permission: 'targets.view' },
  { to: '/revenue', icon: DollarSign, label: 'Revenue Data', permission: 'revenue.view' },
  { to: '/actions', icon: Lightbulb, label: 'Action Notes', permission: 'actions.view' },
  { to: '/goals', icon: Layers, label: 'Goal Cascading', permission: 'targets.view' },
  { to: '/alerts', icon: Bell, label: 'Revenue Alerts', permission: 'alerts.view' },
  { to: '/messages', icon: MessageSquare, label: 'Messages', permission: 'messages.view' },
  { to: '/chat', icon: MessageCircle, label: 'Chat', permission: 'chat.view' },
  { to: '/ai', icon: Bot, label: 'VAS AI Assistant', permission: 'ai.view', highlight: true },
  { to: '/ai-usage', icon: BarChart3, label: 'AI Usage Report', permission: 'ai_usage.view' },
  { to: '/roles', icon: Shield, label: 'Roles', permission: 'roles.view' },
  { to: '/users', icon: UserCog, label: 'Users', permission: 'users.view' },
  { to: '/import', icon: Upload, label: 'Excel Import', permission: 'import.view' },
  { to: '/reports', icon: FileBarChart, label: 'Reports', permission: 'reports.view' },
  { to: '/audit', icon: ClipboardList, label: 'Audit Trail', permission: 'audit.view' },
  { to: '/guide', icon: BookOpen, label: 'User Guide' },
];

const channelNavItems = [
  { to: '/channel', icon: LayoutDashboard, label: 'Channel Dashboard', permission: 'channel_dashboard.view' },
  // The registry is its own grant: any of the six channel_entities permissions
  // (view / edit / delete, each also in an *_own strength) opens it. What the
  // visitor sees inside is narrowed by which ones they hold.
  { to: '/channel/registry', icon: ClipboardList, label: 'Entity Registry', anyPermission: [
    'channel_entities.view', 'channel_entities.view_own',
    'channel_entities.edit', 'channel_entities.edit_own',
    'channel_entities.delete', 'channel_entities.delete_own',
  ] },
  { to: '/channel/import-batch', icon: Upload, label: 'Batch Import', permission: 'channel_import.batch' },
  { to: '/channel/import-single', icon: Users, label: 'Single Registration', permission: 'channel_import.single' },
  { to: '/channel/reports', icon: FileBarChart, label: 'Channel Reports', permission: 'channel_reports.view' },
  { to: '/messages', icon: MessageSquare, label: 'Messages', permission: 'channel_messages.view' },
  { to: '/chat', icon: MessageCircle, label: 'Chat', permission: 'channel_chat.view' },
  { to: '/users', icon: UserCog, label: 'Users', permission: 'channel_users.view' },
  { to: '/roles', icon: Shield, label: 'Roles', permission: 'channel_roles.view' },
  { to: '/audit', icon: ClipboardList, label: 'Audit Trail', permission: 'channel_audit.view' },
  { to: '/guide', icon: BookOpen, label: 'User Guide' },
];

// The master admin runs population administration, role/permission management and
// the audit trail, so their sidebar deliberately exposes no other module.
const superAdminNavItems = [
  { to: '/admin/users', icon: UserCog, label: 'User Management', permission: 'users.view' },
  { to: '/roles', icon: Shield, label: 'Roles & Permissions', permission: 'roles.view' },
  { to: '/audit', icon: ClipboardList, label: 'Audit Trail', permission: 'audit.view' },
  { to: '/admin/system-health', icon: Activity, label: 'System Health' },
  { to: '/guide', icon: BookOpen, label: 'User Guide' },
];

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notifUnread, setNotifUnread] = useState(0);
  const  { user, isMasterAdmin, logout, hasPermission, hasAnyPermission, updateUser, changePassword, uploadAvatar, removeAvatar, swapSection } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isChatPage = location.pathname === '/chat';
  // Only offer the sections this account is actually allowed to enter
  const canEnter = (section) =>
    !Array.isArray(user?.available_sections) || user.available_sections.includes(section);
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);
  const [swapping, setSwapping] = useState(false);

  // Determine nav items:
  // - Master admin with no section selected → admin console
  // - Master admin who swapped into a section → that section's nav
  // - Regular user → their section's nav
  const isIC = user?.section === 'INDIRECT_CHANNEL';
  const isGlobalAdmin = isMasterAdmin && user?.section === null;
  const navItems = isGlobalAdmin ? superAdminNavItems : (isIC ? channelNavItems : vasNavItems);

  async function handleSectionSwap(targetSection) {
    setSwapping(true);
    try {
      await swapSection(targetSection);
      setSectionMenuOpen(false);
      if (targetSection === null) {
        toast.success('Switched to Administration view');
        navigate('/admin/users');
      } else {
        toast.success('Switched to ' + (targetSection === 'VAS' ? 'VAS' : 'Indirect Channel') + ' section');
        if (targetSection === 'INDIRECT_CHANNEL') {
          navigate('/channel');
        } else {
          navigate('/dashboard');
        }
      }
    } catch (err) {
      toast.error('Failed to switch section: ' + err.message);
    }
    setSwapping(false);
  }

  // Poll unread messages every 10 seconds
  useEffect(() => {
    if (!user?.id) return;
    const fetchUnread = async () => {
      try {
        const data = await chatAPI.getUnread(user.id);
        setUnreadCount((data.direct || 0) + (data.groups || 0));
      } catch (err) { /* ignore */ }
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 10000);
    return () => clearInterval(interval);
  }, [user?.id]);

  // Poll critical service count for the Revenue Alerts badge every 30 seconds
  useEffect(() => {
    if (!user?.id) return;
    const fetchCritical = async () => {
      try {
        const data = await alertsAPI.getAll();
        setCriticalCount(data?.summary?.critical || 0);
      } catch (err) { /* ignore */ }
    };
    fetchCritical();
    const interval = setInterval(fetchCritical, 30000);
    return () => clearInterval(interval);
  }, [user?.id]);

  // Poll notifications every 20 seconds + on open.
  // Scoped to the section the user is currently in so the bell never shows
  // another section's notifications; reloads when the section is swapped.
  async function loadNotifications() {
    if (!user?.id) return;
    try {
      const data = await notificationsAPI.getAll(user.id, user.section);
      setNotifications(data.notifications || []);
      setNotifUnread(data.unread || 0);
    } catch (err) { /* ignore */ }
  }
  useEffect(() => {
    if (!user?.id) return;
    loadNotifications();
    const interval = setInterval(loadNotifications, 20000);
    return () => clearInterval(interval);
  }, [user?.id, user?.section]);

  async function handleOpenNotification(n) {
    setNotifOpen(false);
    if (n.is_read !== 1) {
      try {
        await notificationsAPI.markRead(n.id, user.id);
        setNotifUnread(u => Math.max(0, u - 1));
        setNotifications(list => list.map(x => (x.id === n.id ? { ...x, is_read: 1 } : x)));
      } catch (err) { /* ignore */ }
    }
    navigate(n.link || '/actions');
  }

  async function handleMarkAllRead() {
    try {
      await notificationsAPI.markAllRead(user.id, user.section);
      setNotifUnread(0);
      setNotifications(list => list.map(x => ({ ...x, is_read: 1 })));
    } catch (err) { /* ignore */ }
  }

  const userInitial = user?.full_name?.charAt(0)?.toUpperCase() || user?.username?.charAt(0)?.toUpperCase() || 'U';

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`bg-gradient-to-b from-white via-white to-slate-50 text-gray-700 flex flex-col transition-all duration-300 border-r border-gray-200 shadow-sm ${
          sidebarOpen ? 'w-64' : 'w-16'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200">
          {sidebarOpen ? (
            <div className="flex items-center gap-3">
              <div className="vas-logo">
                <div className="vas-logo-inner">
                  <span className="vas-logo-text">
                    {isIC ? (
                      <><span className="vas-letter">I</span><span className="vas-letter">D</span><span className="vas-letter">C</span></>
                    ) : isGlobalAdmin ? (
                      <><span className="vas-letter">A</span><span className="vas-letter">D</span><span className="vas-letter">M</span></>
                    ) : (
                      <><span className="vas-letter">V</span><span className="vas-letter">A</span><span className="vas-letter">S</span></>
                    )}
                  </span>
                  <span className="vas-cursor"></span>
                </div>
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] font-bold tracking-[0.2em] uppercase text-gray-800">{isIC ? 'Performance' : isGlobalAdmin ? 'Administration' : 'Performance'}</span>
                <span className="text-[9px] font-medium tracking-[0.15em] uppercase text-gray-400">{isIC ? 'Real-Time Monitoring' : isGlobalAdmin ? 'Control Panel' : 'Real-Time Monitoring'}</span>
              </div>
            </div>
          ) : (
            <div className="vas-logo mx-auto">
              <div className="vas-logo-inner">
                <span className="vas-logo-text">
                  <span className="vas-letter">{isIC ? 'I' : isGlobalAdmin ? 'A' : 'V'}</span>
                </span>
              </div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            {sidebarOpen ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
          {navItems.filter(item =>
            (!item.permission || hasPermission(item.permission)) &&
            // anyPermission items open for the master admin and for any role
            // holding at least one of the listed grants.
            (!item.anyPermission || isMasterAdmin || item.anyPermission.some(p => hasPermission(p)))
          ).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              // "/channel" is a prefix of /channel/reports, /channel/import-batch…
              // Without `end` it would stay highlighted on every channel page.
              end={item.to === '/dashboard' || item.to === '/channel'}
              className={({ isActive }) =>
                `relative flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 ${
                  isActive
                    ? 'bg-gradient-to-r from-emerald-500 to-green-600 text-white shadow-md shadow-emerald-500/25'
                    : item.highlight
                      ? 'text-emerald-700 bg-gradient-to-r from-emerald-50 to-teal-50 ring-1 ring-emerald-100 hover:ring-emerald-200'
                      : 'text-gray-600 hover:bg-gray-100/80 hover:text-gray-900'
                }`
              }
            >
              <item.icon size={18} />
              {sidebarOpen && <span>{item.label}</span>}
              {!sidebarOpen && item.to === '/chat' && unreadCount > 0 && (
                <span className="absolute right-1 top-1 w-2 h-2 bg-red-500 rounded-full" />
              )}
              {item.to === '/chat' && unreadCount > 0 && (
                <span className={`ml-auto px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full font-bold min-w-[20px] text-center ${!sidebarOpen ? 'absolute -top-1 -right-1 min-w-[16px] text-[10px] p-0 h-4 flex items-center justify-center' : ''}`}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
              {!sidebarOpen && item.to === '/alerts' && criticalCount > 0 && (
                <span className="absolute right-1 top-1 w-2 h-2 bg-rose-500 rounded-full" />
              )}
              {item.to === '/alerts' && criticalCount > 0 && (
                <span className={`ml-auto px-1.5 py-0.5 bg-rose-500 text-white text-xs rounded-full font-bold min-w-[20px] text-center ${!sidebarOpen ? 'absolute -top-1 -right-1 min-w-[16px] text-[10px] p-0 h-4 flex items-center justify-center' : ''}`}>
                  {criticalCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User Info at Bottom */}
        {sidebarOpen && (
          <div className="p-4 border-t border-gray-100">
            <div className="flex items-center gap-3">
              {user?.avatar_url ? (
                <img src={user.avatar_url} alt="Avatar" className="w-8 h-8 rounded-full object-cover border border-gray-200" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center text-sm font-semibold text-white shadow-sm ring-2 ring-white">
                  {userInitial}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user?.full_name || user?.username}</p>
                <p className="text-xs text-gray-400 truncate">{user?.role_name || 'User'}</p>
              </div>
              <button
                onClick={logout}
                className="p-1.5 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                title="Logout"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Collapsed: just show logout icon */}
        {!sidebarOpen && (
          <div className="p-2 border-t border-white/10 flex justify-center">
            <button
              onClick={logout}
              className="p-2 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
              title="Logout"
            >
              <LogOut size={18} />
            </button>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-16 bg-white/80 backdrop-blur border-b border-gray-200 flex items-center px-6 justify-between shadow-sm">
          <div className="flex items-center gap-2 text-sm text-gray-500">              <div className="flex items-center gap-2">
              <img src="/ethio-telecom-logo.png" alt="Ethio Telecom" className="h-10" />
              <div className="w-px h-5 bg-gray-300"></div>
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              <span className="text-sm font-semibold tracking-wide text-gray-800">{isGlobalAdmin ? 'User Administration' : isIC ? 'Indirect Channel' : 'VAS Performance Tracker'}</span>
              <span className="text-[10px] font-medium text-green-600 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">LIVE</span>
              {(user?.section === null || hasPermission('sections.swap') || isMasterAdmin) && (
                <>
                  <div className="w-px h-5 bg-gray-300" />
                  <div className="relative">
                    <button onClick={() => setSectionMenuOpen(!sectionMenuOpen)}
                      className="flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs font-medium text-blue-700 hover:bg-blue-100 transition">
                      {user?.section === null ? (isMasterAdmin ? 'Administration' : 'All Sections') : user?.section === 'INDIRECT_CHANNEL' ? 'Channel' : 'VAS'}
                      <ChevronDown size={12} />
                    </button>
                    {sectionMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setSectionMenuOpen(false)} />
                        <div className="absolute left-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-20">
                          <div className="p-2">
                            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-2 py-1">Switch Section</p>
                            {isMasterAdmin && (
                              <button onClick={() => handleSectionSwap(null)} disabled={swapping}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition hover:bg-gray-50 disabled:opacity-50">
                                <Shield size={14} className="text-purple-500" />
                                Administration
                                {user?.section === null && <span className="ml-auto text-xs text-purple-600 font-medium">Current</span>}
                              </button>
                            )}
                            {canEnter('VAS') && (
                              <button onClick={() => handleSectionSwap('VAS')} disabled={swapping}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition hover:bg-gray-50 disabled:opacity-50">
                                <div className="w-2 h-2 rounded-full bg-green-500" />
                                VAS Section
                                {user?.section === 'VAS' && <span className="ml-auto text-xs text-green-600 font-medium">Current</span>}
                              </button>
                            )}
                            {canEnter('INDIRECT_CHANNEL') && (
                              <button onClick={() => handleSectionSwap('INDIRECT_CHANNEL')} disabled={swapping}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition hover:bg-gray-50 disabled:opacity-50">
                                <div className="w-2 h-2 rounded-full bg-blue-500" />
                                Indirect Channel
                                {user?.section === 'INDIRECT_CHANNEL' && <span className="ml-auto text-xs text-blue-600 font-medium">Current</span>}
                              </button>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500 hidden md:block">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </span>

            {/* Notifications bell */}
            <div className="relative">
              <button
                onClick={() => { setNotifOpen(!notifOpen); if (!notifOpen) loadNotifications(); }}
                className="relative p-2 hover:bg-gray-100 rounded-lg transition"
                title="Notifications"
              >
                <Bell size={18} className="text-gray-600" />
                {notifUnread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {notifUnread > 99 ? '99+' : notifUnread}
                  </span>
                )}
              </button>

              {notifOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setNotifOpen(false)} />
                  <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-gray-200 z-20">
                    <div className="p-3 border-b border-gray-100 flex items-center justify-between">
                      <p className="text-sm font-semibold text-gray-800">Notifications</p>
                      {notifUnread > 0 && (
                        <button onClick={handleMarkAllRead} className="text-[11px] text-blue-600 hover:text-blue-700 font-medium">
                          Mark all read
                        </button>
                      )}
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                      {notifications.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-8">No notifications</p>
                      ) : notifications.map(n => (
                        <button
                          key={n.id}
                          onClick={() => handleOpenNotification(n)}
                          className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 border-b border-gray-50 transition ${n.is_read === 1 ? 'opacity-60' : ''}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${n.is_read === 1 ? 'bg-gray-300' : 'bg-blue-500'}`} />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-gray-800">{n.title}</p>
                              <p className="text-[11px] text-gray-600 mt-0.5 line-clamp-2 break-words">{n.message}</p>
                              {n.action_title && <p className="text-[10px] text-blue-600 mt-0.5 truncate">📋 {n.action_title}</p>}
                              <p className="text-[10px] text-gray-400 mt-0.5">{n.created_at ? new Date(n.created_at).toLocaleString() : ''}</p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* User dropdown */}
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 hover:bg-gray-100 rounded-lg px-2 py-1 transition"
              >
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt="Avatar" className="w-8 h-8 rounded-full object-cover border border-gray-200" />
                ) : (
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-sm font-semibold">
                    {userInitial}
                  </div>
                )}
                <span className="text-sm font-medium text-gray-700 hidden md:block">
                  {user?.full_name || user?.username}
                </span>
                <ChevronDown size={14} className="text-gray-400" />
              </button>

              {userMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-20">
                    <div className="p-3 border-b border-gray-100">
                      <p className="text-sm font-medium text-gray-800">{user?.full_name}</p>
                      <p className="text-xs text-gray-500">{user?.email}</p>
                      <span className="inline-block mt-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">
                        {user?.role_name || 'User'}
                      </span>
                    </div>
                    <div className="p-1">
                      <button
                        onClick={() => {
                          setUserMenuOpen(false);
                          setProfileOpen(true);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md transition"
                      >
                        <UserCog size={16} />
                        My Profile
                      </button>
                      <button
                        onClick={() => {
                          setUserMenuOpen(false);
                          logout();
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-md transition"
                      >
                        <LogOut size={16} />
                        Sign Out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-hidden bg-gray-50 flex flex-col">
          {isChatPage ? (
            <div className="flex-1 overflow-hidden">
              <Outlet />
            </div>
          ) : (
            <div className="flex-1 overflow-auto p-6">
              <Outlet />
            </div>
          )}
        </main>
      </div>

      {/* Profile Modal */}
      {profileOpen && (
        <ProfileModal user={user} onClose={() => setProfileOpen(false)} updateUser={updateUser} changePassword={changePassword} uploadAvatar={uploadAvatar} removeAvatar={removeAvatar} />
      )}
    </div>
  );
}

function ProfileModal({ user, onClose, updateUser, changePassword, uploadAvatar, removeAvatar }) {
  const [tab, setTab] = useState('profile');
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [saving, setSaving] = useState(false);
  const [showCurrentPwd, setShowCurrentPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [preview, setPreview] = useState(user?.avatar_url || null);
  const fileInputRef = useRef(null);

  function handleAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1 * 1024 * 1024) {
      toast.error('Image must be under 1MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPreview(ev.target.result);
    };
    reader.readAsDataURL(file);
  }

  async function handleSaveAvatar() {
    if (!preview) return;
    setSaving(true);
    try {
      await uploadAvatar(preview);
      toast.success('Profile picture updated!');
    } catch (err) {
      toast.error(err.message);
    }
    setSaving(false);
  }

  async function handleRemoveAvatar() {
    setSaving(true);
    try {
      await removeAvatar();
      setPreview(null);
      toast.success('Profile picture removed');
    } catch (err) {
      toast.error(err.message);
    }
    setSaving(false);
  }

  async function handleChangePassword() {
    if (!currentPwd || !newPwd) {
      toast.error('Please fill in both password fields');
      return;
    }
    if (newPwd !== confirmPwd) {
      toast.error('New passwords do not match');
      return;
    }
    if (newPwd.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setSaving(true);
    try {
      await changePassword(currentPwd, newPwd);
      toast.success('Password changed successfully!');
      setCurrentPwd('');
      setNewPwd('');
      setConfirmPwd('');
    } catch (err) {
      toast.error(err.message);
    }
    setSaving(false);
  }

  const userInitial = user?.full_name?.charAt(0)?.toUpperCase() || 'U';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">My Profile</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg">
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100">
          <button onClick={() => setTab('profile')} className={`flex-1 py-3 text-sm font-medium transition ${tab === 'profile' ? 'text-green-600 border-b-2 border-green-600' : 'text-gray-500 hover:text-gray-700'}`}>
            Profile Picture
          </button>
          <button onClick={() => setTab('password')} className={`flex-1 py-3 text-sm font-medium transition ${tab === 'password' ? 'text-green-600 border-b-2 border-green-600' : 'text-gray-500 hover:text-gray-700'}`}>
            Change Password
          </button>
        </div>

        <div className="p-6">
          {tab === 'profile' ? (
            <div className="space-y-5">
              {/* Avatar Preview */}
              <div className="flex flex-col items-center gap-4">
                {preview ? (
                  <img src={preview} alt="Avatar" className="w-24 h-24 rounded-full object-cover border-4 border-green-100 shadow-lg" />
                ) : (
                  <div className="w-24 h-24 bg-green-500 rounded-full flex items-center justify-center text-3xl font-bold text-white shadow-lg">
                    {userInitial}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => fileInputRef.current?.click()} className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition">
                    Upload Photo
                  </button>
                  {preview && (
                    <button onClick={handleRemoveAvatar} className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition">
                      Remove
                    </button>
                  )}
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarChange} className="hidden" />
                {preview && preview !== user?.avatar_url && (
                  <button onClick={handleSaveAvatar} disabled={saving} className="w-full py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition disabled:opacity-50">
                    {saving ? 'Saving...' : 'Save Profile Picture'}
                  </button>
                )}
              </div>

              {/* User Info (read-only) */}
              <div className="space-y-3 pt-4 border-t border-gray-100">
                <div>
                  <label className="text-xs text-gray-500">Full Name</label>
                  <p className="text-sm font-medium text-gray-900">{user?.full_name}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Email</label>
                  <p className="text-sm font-medium text-gray-900">{user?.email}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Role</label>
                  <p className="text-sm font-medium text-gray-900">{user?.role_name || 'User'}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Department</label>
                  <p className="text-sm font-medium text-gray-900">{user?.department || 'VAS Division'}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Current Password</label>
                <div className="relative">
                  <input type={showCurrentPwd ? 'text' : 'password'} value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} placeholder="Enter current password" className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none pr-10" />
                  <button type="button" onClick={() => setShowCurrentPwd(!showCurrentPwd)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showCurrentPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                <div className="relative">
                  <input type={showNewPwd ? 'text' : 'password'} value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="Enter new password (min 6 chars)" className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none pr-10" />
                  <button type="button" onClick={() => setShowNewPwd(!showNewPwd)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showNewPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
                <input type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} placeholder="Confirm new password" className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none" />
              </div>
              <button onClick={handleChangePassword} disabled={saving} className="w-full py-2.5 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition disabled:opacity-50">
                {saving ? 'Changing...' : 'Change Password'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
