import { useState, useEffect, useRef } from 'react';
import { Plus, Edit2, Trash2, X, Check, Shield, Users, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { rolesAPI, permissionsAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';

const emptyRole = { name: '', description: '', is_default: false, permission_ids: [], scope: 'VAS', sections: [] };

// Role scope decides which sections a role is confined to, or whether it administers
// every section (GLOBAL = the master admin) or belongs to several of them at once
// (MULTI_SECTION = "Different Sections").
const SCOPE_LABELS = {
  GLOBAL: { label: 'All Sections (Master Admin)', badge: 'bg-red-100 text-red-700' },
  MULTI_SECTION: { label: 'Different Sections', badge: 'bg-purple-100 text-purple-700' },
  VAS: { label: 'VAS Section', badge: 'bg-green-100 text-green-700' },
  INDIRECT_CHANNEL: { label: 'Indirect Channel', badge: 'bg-blue-100 text-blue-700' },
};

const SECTION_NAMES = { VAS: 'VAS Section', INDIRECT_CHANNEL: 'Indirect Channel' };
const sectionNames = (list) => list.map(s => SECTION_NAMES[s] || s).join(' + ');

// sections.swap is what lets a role cross between sections, which is an all-sections
// concern — the master admin's alone. Drop it (and any module it empties) from the
// permission picker for everyone else.
function withoutSectionSwap(grouped) {
  return Object.fromEntries(
    Object.entries(grouped)
      .map(([module, perms]) => [module, perms.filter(p => p.name !== 'sections.swap')])
      .filter(([, perms]) => perms.length > 0)
  );
}

export default function Roles() {
  const { user, hasAnyPermission, isMasterAdmin } = useAuth();
  // The Indirect Channel section mirrors these permissions as channel_roles.*
  const canEdit = hasAnyPermission('roles.edit', 'channel_roles.edit');
  const canDelete = hasAnyPermission('roles.delete', 'channel_roles.delete');
  const canCreate = hasAnyPermission('roles.create', 'channel_roles.create');
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [permGrouped, setPermGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyRole);
  const [expandedModules, setExpandedModules] = useState({});
  const [saving, setSaving] = useState(false);
  const [sectionAccess, setSectionAccess] = useState([]);
  const [sectionError, setSectionError] = useState('');
  const [sectionsError, setSectionsError] = useState('');
  // Snapshot of what the role looked like when the modal opened, so legacy roles
  // (section access with no permissions) can still be edited.
  const [initialSectionAccess, setInitialSectionAccess] = useState([]);
  const [initialPermissionIds, setInitialPermissionIds] = useState([]);
  // Scrolls the Section Access panel into view when its validation blocks the save.
  const swapPanelRef = useRef(null);

  useEffect(() => { loadData(); }, []);

  // When section is null (admin mode / cross-section), no filter is sent
  // and the backend returns all sections. Otherwise scope to the user's section.
  const sectionFilter = user?.section || undefined;

  async function loadData() {
    try {
      const [rolesData, permsData] = await Promise.all([
        rolesAPI.getAll(sectionFilter ? { section: sectionFilter } : {}),
        permissionsAPI.getAll(),
      ]);
      setRoles(rolesData);
      setPermissions(isMasterAdmin ? permsData.all : permsData.all.filter(p => p.name !== 'sections.swap'));
      setPermGrouped(isMasterAdmin ? permsData.grouped : withoutSectionSwap(permsData.grouped));
    } catch (err) {
      toast.error('Failed to load data');
    }
    setLoading(false);
  }

  // A module belongs to whichever section its permissions declare.
  const moduleSection = (module) => permGrouped[module]?.[0]?.section || 'VAS';

  function openCreate() {
    setForm({ ...emptyRole, scope: user?.section || 'VAS' });
    setEditingId(null);
    setExpandedModules({});
    setSectionAccess([]);
    setSectionError('');
    setSectionsError('');
    setInitialSectionAccess([]);
    setInitialPermissionIds([]);
    setShowModal(true);
  }

  async function openEdit(role) {
    try {
      const [fullRole, accessData] = await Promise.all([
        rolesAPI.getOne(role.id),
        // Section access is master-admin-only territory — nobody else reads it.
        isMasterAdmin ? rolesAPI.getSectionAccess(role.id) : Promise.resolve([]),
      ]);
      setForm({
        name: fullRole.name,
        description: fullRole.description || '',
        is_default: !!fullRole.is_default,
        permission_ids: fullRole.permissions.map(p => p.id),
        scope: fullRole.scope || 'VAS',
        sections: fullRole.sections || [],
      });
      setEditingId(role.id);
      setSectionAccess(accessData);
      setSectionError('');
      setSectionsError('');
      setInitialSectionAccess(accessData);
      setInitialPermissionIds(fullRole.permissions.map(p => p.id));
      // Expand all modules that have selected permissions
      const expanded = {};
      fullRole.permissions.forEach(p => { expanded[p.module] = true; });
      setExpandedModules(expanded);
      setShowModal(true);
    } catch (err) {
      toast.error('Failed to load role details');
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();

    // A role that can swap sections needs real access in every section it can reach:
    // at least one section to swap to, and at least one permission inside each of them.
    const sectionsSwapPerm = permissions.find(p => p.name === 'sections.swap');
    // A multi-section role already owns its sections outright, so sections.swap has
    // no meaning for it — the swap check (and its UI, which is hidden for this
    // scope) only applies to the other scopes.
    const grantsSwap = isMasterAdmin
      && form.scope !== 'MULTI_SECTION'
      && !!sectionsSwapPerm
      && form.permission_ids.includes(sectionsSwapPerm.id);

    // Which permission ids belong to a section — read from permissions.section, the
    // authoritative column, rather than inferring it from the module name.
    const permissionIdsForSection = (section) =>
      Object.entries(permGrouped)
        .filter(([module]) => moduleSection(module) === section)
        .flatMap(([, perms]) => perms.map(p => p.id));

    const SECTION_LABELS = { VAS: 'VAS Section', INDIRECT_CHANNEL: 'Indirect Channel' };

    // A role scoped to different sections must hold real permissions in each of
    // them: users enter a section with nothing to do there otherwise.
    if (form.scope === 'MULTI_SECTION') {
      if (form.sections.length === 0) {
        const message = 'Choose at least one section for a role scoped to different sections.';
        setSectionsError(message);
        toast.error(message);
        return; // do not save
      }
      const emptyForSection = form.sections.find(
        (section) => !permissionIdsForSection(section).some(id => form.permission_ids.includes(id))
      );
      if (emptyForSection) {
        const message = `Please choose at least one permission for ${SECTION_LABELS[emptyForSection] || emptyForSection} — this role is scoped to that section.`;
        setSectionsError(message);
        toast.error(message);
        return; // do not save
      }
    }
    setSectionsError('');

    if (grantsSwap) {
      if (sectionAccess.length === 0) {
        const message = 'This role can swap sections (sections.swap) — tick at least one section in the “🔄 Section Access” panel at the bottom of this form.';
        setSectionError(message);
        toast.error(message);
        swapPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return; // do not save
      }

      // Every selected section must have at least one permission, otherwise the user
      // swaps into that section with nothing to do there. Sections that were already
      // empty when the modal opened (legacy data) are left alone so they stay editable.
      const emptySection = sectionAccess.find((section) => {
        const candidates = permissionIdsForSection(section);
        if (candidates.length === 0) return false; // this section defines no permissions
        if (candidates.some((id) => form.permission_ids.includes(id))) return false;
        return !(initialSectionAccess.includes(section) &&
          !candidates.some((id) => initialPermissionIds.includes(id)));
      });
      if (emptySection) {
        const message = `Please choose at least one permission for ${SECTION_LABELS[emptySection] || emptySection} — select at least one permission from that section's list.`;
        setSectionError(message);
        toast.error(message);
        return; // do not save
      }
    }
    setSectionError('');

    setSaving(true);
    try {
      // A multi-section role belongs to its sections already; strip the meaningless
      // sections.swap permission from what is saved so it never blocks or misleads.
      const payload = form.scope === 'MULTI_SECTION' && sectionsSwapPerm
        ? { ...form, permission_ids: form.permission_ids.filter(id => id !== sectionsSwapPerm.id) }
        : form;
      // A multi-section role keeps its sections in the same table the section-access
      // control writes, so for it the role update above is the only writer —
      // clearing here would wipe the sections that were just saved.
      const managesSwapAccess = isMasterAdmin && form.scope !== 'MULTI_SECTION';

      if (editingId) {
        await rolesAPI.update(editingId, payload);
        // Only the master admin owns section access; for anyone else the update
        // above must stand on its own rather than 403 on an untouched endpoint.
        if (managesSwapAccess) {
          // Clear section access if sections.swap is not assigned
          await rolesAPI.setSectionAccess(editingId, grantsSwap ? sectionAccess : []);
        }
        toast.success('Role updated');
      } else {
        const newRole = await rolesAPI.create(payload);
        // Persist section access for the new role too
        if (managesSwapAccess && grantsSwap) {
          await rolesAPI.setSectionAccess(newRole.id, sectionAccess);
        }
        toast.success('Role created');
        setEditingId(newRole.id);
      }
      setShowModal(false);
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
    setSaving(false);
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete role "${name}"?`)) return;
    try {
      await rolesAPI.delete(id);
      toast.success('Role deleted');
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function toggleModule(module) {
    setExpandedModules(prev => ({ ...prev, [module]: !prev[module] }));
  }

  function togglePermission(permId) {
    setSectionError('');
    setForm(prev => {
      const ids = prev.permission_ids.includes(permId)
        ? prev.permission_ids.filter(id => id !== permId)
        : [...prev.permission_ids, permId];
      return { ...prev, permission_ids: ids };
    });
  }

  function toggleScopeSection(section) {
    setSectionsError('');
    setForm(prev => ({
      ...prev,
      sections: prev.sections.includes(section)
        ? prev.sections.filter(s => s !== section)
        : [...prev.sections, section],
    }));
  }

  function toggleSectionAccess(section) {
    setSectionError('');
    setSectionAccess(prev =>
      prev.includes(section)
        ? prev.filter(s => s !== section)
        : [...prev, section]
    );
  }

  function toggleModuleAll(module) {
    setSectionError('');
    const modulePerms = permGrouped[module] || [];
    const moduleIds = modulePerms.map(p => p.id);
    const allSelected = moduleIds.every(id => form.permission_ids.includes(id));
    setForm(prev => {
      let ids;
      if (allSelected) {
        ids = prev.permission_ids.filter(id => !moduleIds.includes(id));
      } else {
        ids = [...new Set([...prev.permission_ids, ...moduleIds])];
      }
      return { ...prev, permission_ids: ids };
    });
  }

  const MODULE_LABELS = {
    dashboard: '📊 Dashboard',
    services: '🏢 VAS Services',
    categories: '🏷️ Categories',
    targets: '🎯 Revenue Targets',
    revenue: '💰 Revenue Data',
    partners: '👥 Partner Revenue',
    actions: '💡 Action Notes',
    alerts: '🔔 Revenue Alerts',
    import: '📤 Excel Import',
    reports: '📋 Reports',
    audit: '📜 Audit Trail',
    messages: '✉️ Messages',
    chat: '💬 Chat',
    ai: '🤖 AI Assistant',
    ai_usage: '📈 AI Usage Report',
    users: '👤 User Management',
    roles: '🛡️ Role Management',
    channel_dashboard: '📊 Channel Dashboard',
    channel_import: '📤 Channel Import',
    channel_reports: '📋 Channel Reports',
    channel_entities: '🗂️ Channel Data (Edit / Delete)',
    channel_users: '👤 Channel Users',
    channel_roles: '🛡️ Channel Roles',
    channel_audit: '📜 Channel Audit Trail',
    channel_chat: '💬 Channel Chat',
    channel_messages: '✉️ Channel Messages',
    sections: '🔄 Section Management',
  };

  // Determine which modules to show based on section
  const isIC = user?.section === 'INDIRECT_CHANNEL';

  // A multi-section role owns its sections outright, so sections.swap is noise —
  // hide it from the picker instead of letting it trigger the swap-access check.
  const displayPermGrouped = form.scope === 'MULTI_SECTION' ? withoutSectionSwap(permGrouped) : permGrouped;

  // Group modules by the section their permissions declare.
  const vasModules = Object.entries(displayPermGrouped).filter(([module]) => moduleSection(module) === 'VAS');
  const icModules = Object.entries(displayPermGrouped).filter(([module]) => moduleSection(module) === 'INDIRECT_CHANNEL');
  const sharedModules = Object.entries(displayPermGrouped).filter(([module]) => moduleSection(module) === 'SHARED');

  // Build the display list based on section
  let displaySections = [];
  if (isIC) {
    displaySections = [
      { label: 'Indirect Channel', badge: 'bg-blue-100 text-blue-700', modules: icModules },
      ...sharedModules.length ? [{ label: 'Shared', badge: 'bg-purple-100 text-purple-700', modules: sharedModules }] : [],
    ];
  } else if (!user?.section) {
    // Admin mode (section=null): show every section's permissions, grouped
    displaySections = [
      { label: 'VAS Section', badge: 'bg-green-100 text-green-700', modules: vasModules },
      { label: 'Indirect Channel', badge: 'bg-blue-100 text-blue-700', modules: icModules },
      ...sharedModules.length ? [{ label: 'Shared', badge: 'bg-purple-100 text-purple-700', modules: sharedModules }] : [],
    ];
  } else {
    // VAS section or filtered: show VAS modules
    displaySections = [
      { label: 'VAS Section', badge: 'bg-green-100 text-green-700', modules: vasModules },
      ...sharedModules.length ? [{ label: 'Shared', badge: 'bg-purple-100 text-purple-700', modules: sharedModules }] : [],
    ];
  }

  // Also keep flat filteredPermGrouped for backward compat with toggleModuleAll
  const filteredPermGrouped = Object.fromEntries(
    displaySections.flatMap(s => s.modules)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Role Management</h1>
          <p className="text-sm text-gray-500">Configure roles and assign permissions to control system access</p>
        </div>
        {canCreate && (
          <button onClick={openCreate} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition">
            <Plus size={16} /> Add Role
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {roles.map((role) => (
            <div key={role.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white text-sm font-bold ${
                    role.scope === 'GLOBAL' ? 'bg-red-500' :
                    role.scope === 'MULTI_SECTION' ? 'bg-purple-500' :
                    role.scope === 'INDIRECT_CHANNEL' ? 'bg-blue-500' :
                    role.permission_count > 0 ? 'bg-green-500' : 'bg-gray-500'
                  }`}>
                    <Shield size={18} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                      {role.name}
                      {role.is_default ? <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">Default</span> : null}
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${(SCOPE_LABELS[role.scope] || SCOPE_LABELS.VAS).badge}`}
                        title="Role scope — decides which sections this role is confined to"
                      >
                        {role.scope === 'GLOBAL' ? '🌐 ' : ''}{role.scope === 'MULTI_SECTION' ? '🧩 ' : ''}{(SCOPE_LABELS[role.scope] || SCOPE_LABELS.VAS).label}
                      </span>
                      {role.scope === 'MULTI_SECTION' && role.sections ? (
                        <span className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded" title="Sections this role belongs to">
                          {sectionNames(role.sections.split(','))}
                        </span>
                      ) : null}
                    </h3>
                    <span className="text-xs text-gray-500">
                      {role.permission_count || 0} permissions · {role.user_count || 0} users
                    </span>
                  </div>
                </div>
                <div className="flex gap-1">
                  {canEdit && (
                    <button onClick={() => openEdit(role)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-600">
                      <Edit2 size={14} />
                    </button>
                  )}
                  {canDelete && (
                    <button onClick={() => handleDelete(role.id, role.name)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-600">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
              {role.description && <p className="text-sm text-gray-600 mb-3">{role.description}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-6 pb-4 border-b">
              <h2 className="text-lg font-semibold">{editingId ? 'Edit Role' : 'Add New Role'}</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 overflow-auto p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role Name *</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., Senior Analyst"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  rows={2}
                  placeholder="Brief description of this role"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600"
                />
                <label className="text-sm text-gray-700">Set as default role (assigned to new users)</label>
              </div>

              {/* Scope — only the master admin can hand out GLOBAL scope */}
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  🌐 Role Scope — which sections does this role belong to?
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  A section-scoped role is confined to that section. <strong>All Sections</strong> makes it a master
                  admin role: it manages users, roles and permissions across every section.{' '}
                  <strong>Different Sections</strong> lets one role belong to several sections at once — inside each
                  of them the user gets only the permissions you tick from that section's list.
                </p>
                <select
                  value={form.scope || 'VAS'}
                  onChange={(e) => setForm({ ...form, scope: e.target.value })}
                  disabled={!isMasterAdmin}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-amber-500 focus:border-amber-500 disabled:bg-gray-100 disabled:text-gray-500"
                >
                  <option value="VAS">VAS Section</option>
                  <option value="INDIRECT_CHANNEL">Indirect Channel</option>
                  {isMasterAdmin && <option value="MULTI_SECTION">Different Sections</option>}
                  {isMasterAdmin && <option value="GLOBAL">All Sections (Master Admin)</option>}
                </select>

                {isMasterAdmin && form.scope === 'MULTI_SECTION' && (
                  <div className={`mt-3 p-3 bg-white border rounded-lg ${sectionsError ? 'border-red-300' : 'border-amber-200'}`}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      🧩 Sections this role belongs to
                    </label>
                    <p className="text-xs text-gray-500 mb-2">
                      The user can enter each section you tick, and in each one gets only the permissions of that
                      section. Every ticked section needs at least one permission below.
                    </p>
                    <div className="flex flex-wrap gap-4">
                      {Object.entries(SECTION_NAMES).map(([value, label]) => (
                        <label key={value} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.sections.includes(value)}
                            onChange={() => toggleScopeSection(value)}
                            className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                          />
                          <span className="text-sm text-gray-800">{label}</span>
                        </label>
                      ))}
                    </div>
                    {sectionsError && (
                      <p className="mt-2 flex items-center gap-1 text-xs font-medium text-red-600">
                        <AlertCircle size={13} /> {sectionsError}
                      </p>
                    )}
                  </div>
                )}

                {!isMasterAdmin && (
                  <p className="mt-2 text-[11px] text-gray-500">
                    {user?.section === 'INDIRECT_CHANNEL'
                      ? 'Roles you create are automatically scoped to Indirect Channel.'
                      : 'Roles you create are automatically scoped to your section.'}
                  </p>
                )}
              </div>

              {/* Permissions */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Permissions ({form.permission_ids.length} selected)
                </label>
                <div className="border border-gray-200 rounded-lg divide-y">
                  {displaySections.map((section) => (
                    <div key={section.label}>
                      {/* Section Header */}
                      <div className="px-3 py-2 bg-gray-50 flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${section.badge}`}>
                          {section.label}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {section.modules.length} module{section.modules.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {/* Modules in this section */}
                      {section.modules.map(([module, perms]) => {
                        const moduleIds = perms.map(p => p.id);
                        const selectedCount = moduleIds.filter(id => form.permission_ids.includes(id)).length;
                        const allSelected = selectedCount === moduleIds.length;
                        const someSelected = selectedCount > 0 && !allSelected;

                        return (
                          <div key={module}>
                            <div
                              className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50"
                              onClick={() => toggleModule(module)}
                            >
                              <div className="flex items-center gap-2">
                                {expandedModules[module] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <span className="text-sm font-medium text-gray-800">
                                  {MODULE_LABELS[module] || module}
                                </span>
                                <span className="text-xs text-gray-400">
                                  {selectedCount}/{moduleIds.length}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleModuleAll(module); }}
                                className={`text-xs px-2 py-0.5 rounded ${
                                  allSelected ? 'bg-green-100 text-green-700' :
                                  someSelected ? 'bg-yellow-100 text-yellow-700' :
                                  'bg-gray-100 text-gray-500'
                                }`}
                              >
                                {allSelected ? 'All' : someSelected ? 'Some' : 'None'}
                              </button>
                            </div>
                            {expandedModules[module] && (
                              <div className="px-6 py-2 bg-gray-50 grid grid-cols-2 gap-2">
                                {perms.map(perm => (
                                  <label key={perm.id} className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={form.permission_ids.includes(perm.id)}
                                      onChange={() => togglePermission(perm.id)}
                                      className="rounded border-gray-300 text-blue-600"
                                    />
                                    <span className="text-xs text-gray-700">{perm.description || perm.name}</span>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {/* Section Access — master admin only, and only when this role is granted sections.swap. A
                  multi-section role already owns its sections, so it does not need this control. */}
              {isMasterAdmin && form.scope !== 'MULTI_SECTION' && form.permission_ids.includes(permissions.find(p => p.name === 'sections.swap')?.id) && (
                <div ref={swapPanelRef} className={`mt-4 p-4 border rounded-lg ${sectionError ? 'bg-red-50 border-red-300' : 'bg-purple-50 border-purple-200'}`}>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    🔄 Section Access — Which sections can this role swap to?
                  </label>
                  <p className="text-xs text-gray-500 mb-3">Select at least one section. Users with this role will only be able to switch to the checked sections.</p>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-gray-200 hover:border-green-300 transition">
                      <input
                        type="checkbox"
                        checked={sectionAccess.includes('VAS')}
                        onChange={() => toggleSectionAccess('VAS')}
                        className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                      />
                      <div>
                        <span className="text-sm font-medium text-gray-800">VAS Section</span>
                        <p className="text-[10px] text-gray-400">Dashboard, Revenue, Targets, etc.</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-gray-200 hover:border-blue-300 transition">
                      <input
                        type="checkbox"
                        checked={sectionAccess.includes('INDIRECT_CHANNEL')}
                        onChange={() => toggleSectionAccess('INDIRECT_CHANNEL')}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div>
                        <span className="text-sm font-medium text-gray-800">Indirect Channel</span>
                        <p className="text-[10px] text-gray-400">Channel Dashboard, Import, etc.</p>
                      </div>
                    </label>
                  </div>
                  {sectionError && (
                    <p className="mt-3 flex items-center gap-1 text-xs font-medium text-red-600">
                      <AlertCircle size={13} /> {sectionError}
                    </p>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2 sticky bottom-0 bg-white py-4 border-t">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-1 disabled:opacity-50">
                  <Check size={14} /> {editingId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
