import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DateFilterProvider } from './context/DateFilterContext';
import Layout from './components/Layout';
import Home from './pages/Home';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Services from './pages/Services';
import Targets from './pages/Targets';
import Revenue from './pages/Revenue';
import Import from './pages/Import';
import Reports from './pages/Reports';
import ChannelDashboard from './pages/ChannelDashboard';
import ChannelRegistry from './pages/ChannelRegistry';
import ChannelBatchImport from './pages/ChannelBatchImport';
import ChannelSingleImport from './pages/ChannelSingleImport';
import ChannelReports from './pages/ChannelReports';
import AuditTrail from './pages/AuditTrail';
import PartnerRevenue from './pages/PartnerRevenue';
import ActionNotes from './pages/ActionNotes';
import GoalCascade from './pages/GoalCascade';
import Categories from './pages/Categories';
import Roles from './pages/Roles';
import Users from './pages/Users';
import SuperAdminUsers from './pages/SuperAdminUsers';
import Alerts from './pages/Alerts';
import Messages from './pages/Messages';
import Chat from './pages/Chat';
import AIAssistant from './pages/AIAssistant';
import AIUsageReport from './pages/AIUsageReport';

// Protected route wrapper
function ProtectedRoute({ children }) {
  const { user, loading, pendingSectionChoice } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  // A section must be chosen before the app opens, so deep links cannot skip it
  if (pendingSectionChoice) return <Navigate to="/login" replace />;
  return children;
}

// The master admin (a GLOBAL-scope role) runs user administration, role/permission
// management and the audit trail. Every other route redirects to SUPER_ADMIN_HOME.
const SUPER_ADMIN_HOME = '/admin/users';
const SUPER_ADMIN_PATHS = [SUPER_ADMIN_HOME, '/roles', '/audit'];

function SuperAdminScope({ children }) {
  const { isMasterAdmin, user } = useAuth();
  const location = useLocation();
  // Only restrict to admin routes when the master admin hasn't entered a specific section.
  // Once they swap into VAS or INDIRECT_CHANNEL, they should see that section's pages.
  if (isMasterAdmin && user?.section === null) {
    const allowed = SUPER_ADMIN_PATHS.some(
      (p) => location.pathname === p || location.pathname.startsWith(`${p}/`)
    );
    if (!allowed) return <Navigate to={SUPER_ADMIN_HOME} replace />;
  }
  return children;
}

// Section guard — redirects to /dashboard if user section doesn't match
function SectionGuard({ children, sections }) {
  const { user, isMasterAdmin } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // The master admin and cross-section users can access everything
  if (user.section === null || isMasterAdmin) return children;
  if (sections && !sections.includes(user.section)) return <Navigate to="/dashboard" replace />;
  return children;
}

// Public route — redirect logged-in users to their section dashboard
function PublicRoute({ children }) {
  const { user, isMasterAdmin, loading, pendingSectionChoice } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }
  // While a section choice is pending the sign-in page keeps rendering the picker
  if (user && !pendingSectionChoice) {
    // The master admin lands in user administration; IC users in the channel
    // dashboard, VAS users in the VAS dashboard
    const dest = isMasterAdmin && !user.section
      ? SUPER_ADMIN_HOME
      : user.section === 'INDIRECT_CHANNEL' ? '/channel' : '/dashboard';
    return <Navigate to={dest} replace />;
  }
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <DateFilterProvider>
      <AuthProvider>
        <Toaster position="top-right" />
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute><SuperAdminScope><Layout /></SuperAdminScope></ProtectedRoute>}>
            <Route path="/admin/users" element={<SuperAdminUsers />} />
            <Route path="/dashboard" element={<SectionGuard><Dashboard /></SectionGuard>} />
            <Route path="/channel" element={<SectionGuard sections={['INDIRECT_CHANNEL']}><ChannelDashboard /></SectionGuard>} />
            <Route path="/channel/registry" element={<SectionGuard sections={['INDIRECT_CHANNEL']}><ChannelRegistry /></SectionGuard>} />
            <Route path="/channel/import-batch" element={<SectionGuard sections={['INDIRECT_CHANNEL']}><ChannelBatchImport /></SectionGuard>} />
            <Route path="/channel/import-single" element={<SectionGuard sections={['INDIRECT_CHANNEL']}><ChannelSingleImport /></SectionGuard>} />
            <Route path="/channel/reports" element={<SectionGuard sections={['INDIRECT_CHANNEL']}><ChannelReports /></SectionGuard>} />
            <Route path="/services" element={<Services />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/roles" element={<Roles />} />
            <Route path="/users" element={<Users />} />
            <Route path="/targets" element={<Targets />} />
            <Route path="/revenue" element={<Revenue />} />
            <Route path="/import" element={<Import />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/audit" element={<AuditTrail />} />
            <Route path="/partners" element={<PartnerRevenue />} />
            <Route path="/actions" element={<ActionNotes />} />
            <Route path="/goals" element={<GoalCascade />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/ai" element={<AIAssistant />} />
            <Route path="/ai-usage" element={<AIUsageReport />} />
          </Route>

          {/* Catch all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
      </DateFilterProvider>
    </BrowserRouter>
  );
}
