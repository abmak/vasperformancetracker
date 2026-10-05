import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

const API_BASE = '/api';

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const config = {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  };
  if (config.body && typeof config.body === 'object') config.body = JSON.stringify(config.body);
  const response = await fetch(url, config);
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return response.json();
}

// A user who can reach more than one section is asked which one to enter after
// signing in. The flag is persisted so a reload mid-prompt does not skip it.
const SECTION_PROMPT_KEY = 'vas_section_prompt';

/**
 * isMasterAdminRole — the master admin is the role with GLOBAL scope.
 *
 * Scope lives on the role (roles.scope), so renaming a role — or creating a second
 * master admin role — never changes who administers every section.
 */
export function isMasterAdminRole(userData) {
  return userData?.role_scope === 'GLOBAL';
}

function needsSectionChoice(userData) {
  // The master admin administers every section and is not asked
  if (isMasterAdminRole(userData)) return false;
  return Array.isArray(userData?.available_sections) && userData.available_sections.length > 1;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingSectionChoice, setPendingSectionChoice] = useState(false);

  function markPendingSectionChoice(pending) {
    setPendingSectionChoice(pending);
    if (pending) localStorage.setItem(SECTION_PROMPT_KEY, '1');
    else localStorage.removeItem(SECTION_PROMPT_KEY);
  }

  // On mount, check for stored token
  useEffect(() => {
    const stored = localStorage.getItem('vas_token');
    const storedUser = localStorage.getItem('vas_user');
    if (stored && storedUser) {
      setToken(stored);
      let parsedUser = null;
      try {
        parsedUser = JSON.parse(storedUser);
        setUser(parsedUser);
      } catch {}
      if (needsSectionChoice(parsedUser) && localStorage.getItem(SECTION_PROMPT_KEY) === '1') {
        setPendingSectionChoice(true);
      }
      // Verify token is still valid
      verifyToken(stored);
    } else {
      localStorage.removeItem(SECTION_PROMPT_KEY);
      setLoading(false);
    }
  }, []);

  async function verifyToken(t) {
    try {
      const data = await request('/auth/me', {
        headers: { Authorization: `Bearer ${t}` },
      });
      setUser(data.user);
      localStorage.setItem('vas_user', JSON.stringify(data.user));
    } catch {
      // Token invalid — clear
      setToken(null);
      setUser(null);
      localStorage.removeItem('vas_token');
      localStorage.removeItem('vas_user');
      markPendingSectionChoice(false);
    }
    setLoading(false);
  }

  async function login(email, password, captcha) {
    const data = await request('/auth/login', {
      method: 'POST',
      body: {
        email,
        password,
        captcha_id: captcha?.captcha_id,
        captcha_x: captcha?.captcha_x,
      },
    });
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('vas_token', data.token);
    localStorage.setItem('vas_user', JSON.stringify(data.user));
    markPendingSectionChoice(needsSectionChoice(data.user));
    return data;
  }

  function logout() {
    setToken(null);
    setUser(null);
    localStorage.removeItem('vas_token');
    localStorage.removeItem('vas_user');
    markPendingSectionChoice(false);
  }

  function updateUser(updates) {
    const updated = { ...user, ...updates };
    setUser(updated);
    localStorage.setItem('vas_user', JSON.stringify(updated));
  }

  async function changePassword(currentPassword, newPassword) {
    const data = await request('/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { current_password: currentPassword, new_password: newPassword },
    });
    return data;
  }

  async function uploadAvatar(base64Data) {
    const data = await request('/auth/upload-avatar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { avatar_data: base64Data },
    });
    updateUser({ avatar_url: data.avatar_url });
    return data;
  }

  async function removeAvatar() {
    await request('/auth/remove-avatar', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    updateUser({ avatar_url: null });
  }

  function hasPermission(permissionName) {
    if (!user || !user.permissions) return false;
    return user.permissions.some(p => p.name === permissionName);
  }

  function hasAnyPermission(...names) {
    return names.some(n => hasPermission(n));
  }

  async function swapSection(targetSection) {
    const data = await request('/auth/swap-section', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { target_section: targetSection },
    });
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('vas_token', data.token);
    localStorage.setItem('vas_user', JSON.stringify(data.user));
    return data;
  }

  // Enter the section chosen at sign-in, then clear the pending prompt.
  async function chooseSection(targetSection) {
    const data = await swapSection(targetSection);
    markPendingSectionChoice(false);
    return data;
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, pendingSectionChoice, isMasterAdmin: isMasterAdminRole(user), login, logout, updateUser, changePassword, uploadAvatar, removeAvatar, hasPermission, hasAnyPermission, swapSection, chooseSection }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { request };
