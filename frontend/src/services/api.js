const API_BASE = '/api';

export async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const token = localStorage.getItem('vas_token');
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  };
  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.body = JSON.stringify(config.body);
  }
  if (config.body instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  const response = await fetch(url, config);
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return response.json();
}

// System health (master admin)
export const systemAPI = {
  getHealth: () => request('/system/health'),
  controlSync: (action) => request(`/system/sync/${action}`, { method: 'POST' }),
};

// User Guide content (editable by the super admin)
export const guideAPI = {
  get: (section) => request(`/guide/${section}`),
  save: (section, content) => request(`/guide/${section}`, { method: 'PUT', body: { content } }),
};

// Services
export const servicesAPI = {
  getAll: () => request('/services'),
  getOne: (id) => request(`/services/${id}`),
  create: (data) => request('/services', { method: 'POST', body: data }),
  update: (id, data) => request(`/services/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/services/${id}`, { method: 'DELETE' }),
};

// Targets
export const targetsAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/targets?${qs}`);
  },
  getAchievement: (id) => request(`/targets/${id}/achievement`),
  create: (data) => request('/targets', { method: 'POST', body: data }),
  update: (id, data) => request(`/targets/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/targets/${id}`, { method: 'DELETE' }),
  // Allocation mode ('automatic' | 'manual') and month-by-month target amounts
  getAllocations: (id) => request(`/targets/${id}/allocations`),
  setAllocations: (id, data) => request(`/targets/${id}/allocations`, { method: 'PUT', body: data }),
};

// Revenue
export const revenueAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/revenue?${qs}`);
  },
  getSummary: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/revenue/summary?${qs}`);
  },
  getDailyTrend: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/revenue/daily-trend?${qs}`);
  },
  create: (data) => request('/revenue', { method: 'POST', body: data }),
  update: (id, data) => request(`/revenue/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/revenue/${id}`, { method: 'DELETE' }),
};

// Dashboard
export const dashboardAPI = {
  getKPIs: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dashboard/kpis?${qs}`);
  },
  getServiceAchievements: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dashboard/service-achievements?${qs}`);
  },
  getCategoryBreakdown: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dashboard/category-breakdown?${qs}`);
  },
  getMomGrowth: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dashboard/mom-growth?${qs}`);
  },
};

// Reports
export const reportsAPI = {
  getPerformance: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/performance?${qs}`);
  },
  getTrend: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/trend?${qs}`);
  },
  getMonthlyTrend: () => request('/reports/monthly-trend'),
};

// Imports
export const importsAPI = {
  preview: async (formData) => {
    const url = `${API_BASE}/imports/preview`;
    const token = localStorage.getItem('vas_token');
    const response = await fetch(url, { method: 'POST', body: formData, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || 'Preview failed');
    }
    return response.json();
  },
  confirm: (data) => request('/imports/confirm', { method: 'POST', body: data }),
  uploadRevenue: (formData) => {
    const url = `${API_BASE}/imports/revenue`;
    const token = localStorage.getItem('vas_token');
    return fetch(url, { method: 'POST', body: formData, headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(r => r.json());
  },
  getHistory: () => request('/imports/history'),
  getTemplate: () => request('/imports/template'),
  delete: (id) => request(`/imports/${id}`, { method: 'DELETE' }),
};

// Audit
export const auditAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/audit?${qs}`);
  },
};

// Partners (Excel-imported revenue data)
export const partnersAPI = {
  getSummary: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/partners/summary?${qs}`);
  },
  getTopPartners: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/partners/top-partners?${qs}`);
  },
  getMonths: () => request('/partners/months'),
  getPartners: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/partners/partners?${qs}`);
  },
  getRecords: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/partners/records?${qs}`);
  },
  getDashboardKPIs: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/partners/dashboard-kpis?${qs}`);
  },
  deleteMonth: (revenueMonth) => request(`/partners/month/${revenueMonth}`, { method: 'DELETE' }),
  update: (id, data) => request(`/partners/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/partners/${id}`, { method: 'DELETE' }),
};

// Roles
export const rolesAPI = {
  getAll: (params) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request(`/roles${qs ? `?${qs}` : ''}`);
  },
  getOne: (id) => request(`/roles/${id}`),
  create: (data) => request('/roles', { method: 'POST', body: data }),
  update: (id, data) => request(`/roles/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/roles/${id}`, { method: 'DELETE' }),
  getSectionAccess: (id) => request(`/roles/${id}/section-access`),
  setSectionAccess: (id, sections) => request(`/roles/${id}/section-access`, { method: 'PUT', body: { sections } }),
};

// Permissions
export const permissionsAPI = {
  getAll: () => request('/permissions'),
  create: (data) => request('/permissions', { method: 'POST', body: data }),
  delete: (id) => request(`/permissions/${id}`, { method: 'DELETE' }),
};

// Users
export const usersAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/users?${qs}`);
  },
  getOne: (id) => request(`/users/${id}`),
  create: (data) => request('/users', { method: 'POST', body: data }),
  update: (id, data) => request(`/users/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/users/${id}`, { method: 'DELETE' }),
  // Section-specific role assignments
  getSections: (id) => request(`/users/${id}/sections`),
  setSection: (id, data) => request(`/users/${id}/sections`, { method: 'POST', body: data }),
  removeSection: (id, section) => request(`/users/${id}/sections/${section}`, { method: 'DELETE' }),
  // Every per-section assignment at once (super admin view)
  getAllSectionAssignments: () => request('/users/section-assignments'),
};

// Action Notes (revenue enhancement tracking)
export const actionsAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/actions?${qs}`);
  },
  getOne: (id) => request(`/actions/${id}`),
  create: (data) => request('/actions', { method: 'POST', body: data }),
  update: (id, data) => request(`/actions/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/actions/${id}`, { method: 'DELETE' }),
  transition: (id, data) => request(`/actions/${id}/transition`, { method: 'POST', body: data }),
  toggleCausedChange: (id, value) => request(`/actions/${id}/caused-change`, { method: 'PATCH', body: { action_caused_change: value } }),
  // Replies / discussion (assigner + assigned users) — optional task_id for per-task threads
  getReplies: (id, taskId) => {
    const qs = taskId ? `?task_id=${taskId}` : '';
    return request(`/actions/${id}/replies${qs}`);
  },
  addReply: (id, data) => request(`/actions/${id}/replies`, { method: 'POST', body: data }),
};

// Alerts (target tracking & alerting)
export const alertsAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/alerts?${qs}`);
  },
  getActive: () => request('/alerts/active'),
};

// Alert Feedback
export const alertFeedbackAPI = {
  getByService: (serviceName) => request(`/alert-feedback?service_name=${encodeURIComponent(serviceName)}`),
  getSummary: () => request('/alert-feedback/summary'),
  create: (data) => request('/alert-feedback', { method: 'POST', body: data }),
  update: (id, data) => request(`/alert-feedback/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/alert-feedback/${id}`, { method: 'DELETE' }),
  // Reactions
  getReactions: (feedbackId) => request(`/alert-feedback/${feedbackId}/reactions`),
  toggleReaction: (feedbackId, data) => request(`/alert-feedback/${feedbackId}/reactions`, { method: 'POST', body: data }),
  // Replies
  getReplies: (feedbackId) => request(`/alert-feedback/${feedbackId}/replies`),
  addReply: (feedbackId, data) => request(`/alert-feedback/${feedbackId}/replies`, { method: 'POST', body: data }),
};

// SMS
export const smsAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/sms?${qs}`);
  },
  getStats: () => request('/sms/stats'),
  getOne: (id) => request(`/sms/${id}`),
  send: (data) => request('/sms/send', { method: 'POST', body: data }),
  importAndSend: (data) => request('/sms/import-and-send', { method: 'POST', body: data }),
  delete: (id) => request(`/sms/${id}`, { method: 'DELETE' }),
  getUsers: () => request('/sms/users'),
};

// Action Tasks
export const actionTasksAPI = {
  getByAction: (actionId) => request(`/action-tasks/action/${actionId}`),
  create: (data) => request('/action-tasks', { method: 'POST', body: data }),
  update: (id, data) => request(`/action-tasks/${id}`, { method: 'PUT', body: data }),
  updateStatus: (id, status) => request(`/action-tasks/${id}/status`, { method: 'PATCH', body: { status } }),
  delete: (id) => request(`/action-tasks/${id}`, { method: 'DELETE' }),
  getSummary: (actionId) => request(`/action-tasks/summary/${actionId}`),
};

// Goal Cascade
export const goalCascadeAPI = {
  getAll: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/goal-cascade?${qs}`);
  },
  getOne: (id, params) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request(`/goal-cascade/${id}${qs ? `?${qs}` : ''}`);
  },
  create: (data) => request('/goal-cascade', { method: 'POST', body: data }),
  update: (id, data) => request(`/goal-cascade/${id}`, { method: 'PUT', body: data }),
  delete: (id) => request(`/goal-cascade/${id}`, { method: 'DELETE' }),
  autoGenerate: (data) => request('/goal-cascade/auto-generate', { method: 'POST', body: data }),
  refreshAchievements: (data) => request('/goal-cascade/refresh-achievements', { method: 'POST', body: data }),
};

// Exports
export const exportsAPI = {
  downloadPPTX: async (params) => {
    const token = localStorage.getItem('vas_token');
    const qs = new URLSearchParams({ ...params, token }).toString();
    window.open(`${API_BASE}/exports/pptx?${qs}`, '_blank');
  },
};

// Chat
export const chatAPI = {
  getContacts: () => request('/chat/contacts'),
  getConversations: (userId) => request(`/chat/conversations?user_id=${userId}`),
  getMessages: (userId, otherUserId) => request(`/chat/messages?user_id=${userId}&other_user_id=${otherUserId}`),
  sendMessage: (data) => request('/chat/send', { method: 'POST', body: data }),
  getGroups: (userId) => request(`/chat/groups?user_id=${userId}`),
  getAllGroups: () => request('/chat/groups'),
  getGroup: (id) => request(`/chat/groups/${id}`),
  createGroup: (data) => request('/chat/groups', { method: 'POST', body: data }),
  updateGroup: (id, data) => request(`/chat/groups/${id}`, { method: 'PUT', body: data }),
  deleteGroup: (id) => request(`/chat/groups/${id}`, { method: 'DELETE' }),
  addGroupMembers: (groupId, userIds) => request(`/chat/groups/${groupId}/members`, { method: 'POST', body: { user_ids: userIds } }),
  removeGroupMember: (groupId, userId) => request(`/chat/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),
  getGroupMessages: (groupId) => request(`/chat/groups/${groupId}/messages`),
  sendGroupMessage: (groupId, data) => request(`/chat/groups/${groupId}/messages`, { method: 'POST', body: data }),
  getUnread: (userId) => request(`/chat/unread/${userId}`),
  sendTyping: (data) => request('/chat/typing', { method: 'POST', body: data }),
  getTyping: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/chat/typing?${qs}`);
  },
  deleteMessage: (messageId, senderId) => request(`/chat/messages/${messageId}?sender_id=${senderId}`, { method: 'DELETE' }),
  uploadMedia: async (formData) => {
    const url = `${API_BASE}/chat/upload`;
    const token = localStorage.getItem('vas_token');
    const response = await fetch(url, { method: 'POST', body: formData, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      let message = 'Upload failed';
      try { const data = await response.json(); if (data && data.error) message = data.error; } catch { /* ignore */ }
      throw new Error(message);
    }
    return response.json();
  },
};

// Notifications (action assignments, replies, …)
// `section` scopes the bell to the section the user is currently in, so VAS work
// never surfaces while viewing the Indirect Channel section and vice versa.
// Omit it (null/undefined) to see every section (used by cross-section accounts).
export const notificationsAPI = {
  getAll: (userId, section) => request(`/notifications?user_id=${userId}${section ? `&section=${section}` : ''}`),
  getUnreadCount: (userId, section) => request(`/notifications/unread-count?user_id=${userId}${section ? `&section=${section}` : ''}`),
  markRead: (id, userId) => request(`/notifications/${id}/read`, { method: 'PATCH', body: { user_id: userId } }),
  markAllRead: (userId, section) => request('/notifications/read-all', { method: 'POST', body: { user_id: userId, section: section || null } }),
};

// AI Usage Report
export const aiUsageAPI = {
  getReport: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/ai/usage-report?${qs}`);
  },
  getApiKeys: () => request('/ai/api-keys'),
};

// Auth — section swap (admin only)
export const authSwapAPI = {
  swapSection: (targetSection) => request('/auth/swap-section', {
    method: 'POST',
    body: { target_section: targetSection },
  }),
};

// Indirect Channel — dashboard, entities, imports
export const channelAPI = {
  getMeta: () => request('/channel/meta'),
  getKPIs: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/dashboard/kpis?${qs}`);
  },
  getMatrix: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/dashboard/matrix?${qs}`);
  },
  getTrend: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/dashboard/trend?${qs}`);
  },
  getTopDistributors: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/dashboard/top-distributors?${qs}`);
  },
  getGeo: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/dashboard/geo?${qs}`);
  },
  getGpsPoints: () => request('/channel/dashboard/gps-points'),
  getEntities: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/entities?${qs}`);
  },
  getEntity: (id) => request(`/channel/entities/${id}`),
  lookupEntity: (mobile) => request(`/channel/entities/lookup?mobile=${encodeURIComponent(mobile)}`),
  verifyTin: (tin) => request(`/channel/tin-verify/${encodeURIComponent(tin)}`),
  // Preview-only verify for the edit/consent flow: the official photo is NOT
  // stored until the user explicitly consents to replacing it.
  verifyTinPreview: (tin) => request(`/channel/tin-verify/${encodeURIComponent(tin)}?store_photo=0`),
  verifyEntityTin: (id, data) => request(`/channel/entities/${id}/verify-tin`, { method: 'POST', body: data }),
  batchVerifyTins: (data) => request('/channel/tin-verify/batch', { method: 'POST', body: data }),
  // Records a batch run could touch — feeds the batch modal's record picker.
  batchVerifyCandidates: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/channel/tin-verify/candidates?${qs}`);
  },
  // Manager photo upload: { tin, photo_base64, content_type? } — JSON, since
  // the photo arrives from a FileReader as base64 (no multipart needed).
  uploadPhoto: (data) => request('/channel/photo', { method: 'POST', body: data }),
  getPhotoMeta: (tin) => request(`/channel/photo/${encodeURIComponent(tin)}/meta`),
  // Closed lists for the registration form's upline pickers (level 1 or 2),
  // each entry carrying enough profile to fill the form in from the selection.
  getEntityOptions: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/entities/select-options${qs ? `?${qs}` : ''}`);
  },
  // Per-level report: Distributor (1), Sub-Distributor (2), Retailer (3).
  getLevelReport: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/reports/level?${qs}`);
  },
  // Retailer coverage: retailers by area, the areas still without one, and how
  // many uplines hold a retailer.
  getRetailerCoverage: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/reports/retailer-coverage?${qs}`);
  },
  // Correct what a Sub-Distributor or Retailer holds right now, from the report
  // list, without re-importing a workbook.
  setStockBalance: (id, data) => request(`/channel/entities/${id}/stock-balance`, { method: 'PUT', body: data }),
  createEntity: (data) => request('/channel/entities', { method: 'POST', body: data }),
  updateEntity: (id, data) => request(`/channel/entities/${id}`, { method: 'PUT', body: data }),
  deleteEntity: (id, force) => request(`/channel/entities/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' }),
  previewImport: async (formData) => {
    const url = `${API_BASE}/channel/imports/preview`;
    const token = localStorage.getItem('vas_token');
    const response = await fetch(url, { method: 'POST', body: formData, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      let message = 'Import preview failed';
      try { const data = await response.json(); if (data && data.error) message = data.error; } catch { /* ignore */ }
      throw new Error(message);
    }
    return response.json();
  },
  confirmImport: (data) => request('/channel/imports/confirm', { method: 'POST', body: data }),

  // Import history — list committed/staged batches
  getImportHistory: () => request('/channel/imports'),
  getImportErrors: (id, params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request(`/channel/imports/${id}/errors${qs ? `?${qs}` : ''}`);
  },
  updateImport: (id, data) => request(`/channel/imports/${id}`, { method: 'PUT', body: data }),
  deleteImport: (id) => request(`/channel/imports/${id}`, { method: 'DELETE' }),
  // Clears every imported user and all import history (master admin only).
  clearImportedData: () => request('/channel/imports/registry', { method: 'DELETE' }),

  // Binary template download — fetch with the auth header, then save the blob.
  // Pass a level (1, 2 or 3) to get a single-level workbook; omit for the combined template.
  downloadTemplate: async (level) => {
    const token = localStorage.getItem('vas_token');
    const qs = level ? `?level=${level}` : '';
    const response = await fetch(`${API_BASE}/channel/imports/template${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      let message = 'Template download failed';
      try { const data = await response.json(); if (data && data.error) message = data.error; } catch { /* ignore */ }
      throw new Error(message);
    }
    return response.blob();
  },
};
